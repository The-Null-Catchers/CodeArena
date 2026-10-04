import { roleCan } from "../../../packages/shared/src/domain.js";
import { enqueueAuthMail } from "./email.js";
import { registerChallengeAuthoring } from "./challenge-authoring.js";
import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pool, tx, audit } from "../../../packages/db/src/index.js";

export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const MAX_FAILED_LOGINS = 5;
const LOGIN_LOCK_SECONDS = 15 * 60;

export type Actor = {
  userId?: string;
  sessionId?: string;
  projectId?: string;
  apiKeyId?: string;
  scopes?: string[];
};

function sessionMetadata(req: FastifyRequest) {
  return {
    userAgent: String(req.headers["user-agent"] || "").slice(0, 256),
    ipHash: hash(req.ip || "unknown"),
  };
}

export async function actor(req: FastifyRequest): Promise<Actor> {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  if (!token)
    throw Object.assign(new Error("Authentication required"), {
      statusCode: 401,
    });
  if (token.startsWith("ca_")) {
    const k = (
      await pool.query(
        "UPDATE api_keys SET last_used_at=now() WHERE secret_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) RETURNING id,project_id,scopes",
        [hash(token)],
      )
    ).rows[0];
    if (!k)
      throw Object.assign(new Error("Invalid API key"), { statusCode: 401 });
    return { apiKeyId: k.id, projectId: k.project_id, scopes: k.scopes };
  }
  const payload = await req.jwtVerify<{ sub: string; sid: string }>();
  const valid = await pool.query(
    `UPDATE sessions s
       SET last_seen_at=CASE
         WHEN s.last_seen_at < now()-interval '5 minutes' THEN now()
         ELSE s.last_seen_at
       END
      FROM users u
     WHERE s.id=$1 AND s.user_id=$2 AND u.id=s.user_id
       AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT u.disabled
     RETURNING s.id`,
    [payload.sid, payload.sub],
  );
  if (!valid.rowCount)
    throw Object.assign(new Error("Session revoked"), { statusCode: 401 });
  return { userId: payload.sub, sessionId: payload.sid };
}

export async function authorize(
  a: Actor,
  projectId: string,
  scope: string,
  admin = false,
) {
  if (a.projectId) {
    if (a.projectId !== projectId || !a.scopes?.includes(scope) || admin)
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    return;
  }
  const m = (
    await pool.query(
      "SELECT m.role FROM memberships m JOIN projects p ON p.organization_id=m.organization_id WHERE p.id=$1 AND m.user_id=$2",
      [projectId, a.userId],
    )
  ).rows[0];
  if (
    !m ||
    !roleCan(m.role, scope.endsWith(":create") || scope.endsWith(":write")) ||
    (admin && !["owner", "admin"].includes(m.role))
  )
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
}

export async function registerAuth(app: FastifyInstance) {
  const credentials = z
    .object({
      email: z
        .string()
        .email()
        .max(254)
        .transform((x) => x.toLowerCase()),
      password: z.string().min(12).max(128),
    })
    .strict();

  // Keep unknown-account password verification on the same expensive path as
  // known accounts so login timing does not become a useful enumeration signal.
  const dummyPasswordHash = await argon2.hash(
    randomBytes(32).toString("base64url"),
    { type: argon2.argon2id },
  );

  const issue = async (req: FastifyRequest, userId: string) => {
    const refresh = randomBytes(32).toString("base64url");
    const meta = sessionMetadata(req);
    const row = await pool.query(
      `INSERT INTO sessions(user_id,token_hash,expires_at,user_agent,ip_hash,last_seen_at)
       VALUES($1,$2,now()+interval '30 days',$3,$4,now()) RETURNING id`,
      [userId, hash(refresh), meta.userAgent, meta.ipHash],
    );
    return {
      accessToken: app.jwt.sign(
        { sub: userId, sid: row.rows[0].id },
        { expiresIn: "15m" },
      ),
      refreshToken: refresh,
    };
  };

  app.post(
    "/v1/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = credentials.parse(req.body);
      const passwordHash = await argon2.hash(b.password, {
        type: argon2.argon2id,
      });
      const id = await tx(async (c) => {
        const u = await c.query(
          "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
          [b.email, passwordHash],
        );
        const o = await c.query(
          "INSERT INTO organizations(name) VALUES($1) RETURNING id",
          [b.email.split("@")[0] + "'s workspace"],
        );
        await c.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
          o.rows[0].id,
          u.rows[0].id,
        ]);
        await c.query(
          "INSERT INTO projects(organization_id,name) VALUES($1,'Default Project')",
          [o.rows[0].id],
        );
        await enqueueAuthMail(c, u.rows[0].id, b.email, "verify");
        await audit(c, "user.register", u.rows[0].id, u.rows[0].id);
        return u.rows[0].id;
      });
      reply.code(201);
      return issue(req, id);
    },
  );

  app.post(
    "/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = credentials.parse(req.body);
      const existing = (
        await pool.query("SELECT id FROM users WHERE email=$1", [b.email])
      ).rows[0];
      if (!existing) {
        await argon2.verify(dummyPasswordHash, b.password);
        throw Object.assign(new Error("Invalid credentials"), {
          statusCode: 401,
        });
      }

      const outcome = await tx(async (c) => {
        const u = (
          await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
            existing.id,
          ])
        ).rows[0];
        if (!u || u.disabled) {
          if (u?.password_hash) await argon2.verify(u.password_hash, b.password);
          return { kind: "invalid" as const };
        }

        const now = Date.now();
        const lockedUntil = u.login_locked_until
          ? new Date(u.login_locked_until).getTime()
          : 0;
        if (lockedUntil > now) {
          return {
            kind: "locked" as const,
            retryAfter: Math.max(1, Math.ceil((lockedUntil - now) / 1000)),
          };
        }

        const ok = await argon2.verify(u.password_hash, b.password);
        if (!ok) {
          const nextFailures = Number(u.failed_login_count || 0) + 1;
          if (nextFailures >= MAX_FAILED_LOGINS) {
            await c.query(
              `UPDATE users
                  SET failed_login_count=0,
                      login_locked_until=now()+interval '15 minutes',
                      last_failed_login_at=now()
                WHERE id=$1`,
              [u.id],
            );
            await audit(c, "auth.login_locked", u.id, u.id, {
              durationSeconds: LOGIN_LOCK_SECONDS,
            });
            return {
              kind: "locked" as const,
              retryAfter: LOGIN_LOCK_SECONDS,
            };
          }
          await c.query(
            `UPDATE users
                SET failed_login_count=$2,
                    login_locked_until=NULL,
                    last_failed_login_at=now()
              WHERE id=$1`,
            [u.id, nextFailures],
          );
          return { kind: "invalid" as const };
        }

        await c.query(
          `UPDATE users
              SET failed_login_count=0,
                  login_locked_until=NULL,
                  last_failed_login_at=NULL
            WHERE id=$1`,
          [u.id],
        );
        await audit(c, "auth.login", u.id, u.id);
        return { kind: "ok" as const, userId: u.id as string };
      });

      if (outcome.kind === "locked") {
        reply.header("Retry-After", String(outcome.retryAfter));
        throw Object.assign(new Error("Login temporarily locked"), {
          statusCode: 429,
        });
      }
      if (outcome.kind !== "ok")
        throw Object.assign(new Error("Invalid credentials"), {
          statusCode: 401,
        });
      return issue(req, outcome.userId);
    },
  );

  app.post("/v1/auth/refresh", async (req) => {
    const b = z.object({ refreshToken: z.string().max(256) }).parse(req.body);
    const refresh = randomBytes(32).toString("base64url");
    const meta = sessionMetadata(req);
    const row = await tx(async (c) => {
      const old = await c.query(
        "SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND NOT u.disabled FOR UPDATE OF s",
        [hash(b.refreshToken)],
      );
      if (
        !old.rowCount ||
        old.rows[0].revoked_at ||
        new Date(old.rows[0].expires_at).getTime() < Date.now()
      )
        throw Object.assign(new Error("Invalid refresh token"), {
          statusCode: 401,
        });
      await c.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
        old.rows[0].id,
      ]);
      const replacement = (
        await c.query(
          `INSERT INTO sessions(user_id,token_hash,expires_at,user_agent,ip_hash,last_seen_at)
           VALUES($1,$2,$3,$4,$5,now()) RETURNING id,user_id`,
          [
            old.rows[0].user_id,
            hash(refresh),
            old.rows[0].expires_at,
            meta.userAgent,
            meta.ipHash,
          ],
        )
      ).rows[0];
      await audit(c, "auth.refresh", replacement.user_id, replacement.id);
      return replacement;
    });
    return {
      accessToken: app.jwt.sign(
        { sub: row.user_id, sid: row.id },
        { expiresIn: "15m" },
      ),
      refreshToken: refresh,
    };
  });

  app.get("/v1/auth/sessions", async (req) => {
    const a = await actor(req);
    const rows = await pool.query(
      `SELECT id,user_agent,created_at,last_seen_at,expires_at
         FROM sessions
        WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()
        ORDER BY created_at DESC`,
      [a.userId],
    );
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        current: row.id === a.sessionId,
      })),
    };
  });

  app.delete("/v1/auth/sessions/:id", async (req) => {
    const a = await actor(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await pool.query(
      `UPDATE sessions SET revoked_at=now()
        WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL
        RETURNING id`,
      [id, a.userId],
    );
    if (!row.rowCount)
      throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    await tx((c) => audit(c, "auth.session_revoke", a.userId, id));
    return { ok: true, current: id === a.sessionId };
  });

  app.post("/v1/auth/logout", async (req) => {
    const a = await actor(req);
    await pool.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
      a.sessionId,
    ]);
    return { ok: true };
  });

  app.post("/v1/auth/logout-all", async (req) => {
    const a = await actor(req);
    await pool.query(
      "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
      [a.userId],
    );
    return { ok: true };
  });

  registerChallengeAuthoring(app, { actor, authorize });
}
