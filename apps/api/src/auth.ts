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
export type Actor = {
  userId?: string;
  projectId?: string;
  apiKeyId?: string;
  scopes?: string[];
};
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
    "SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT u.disabled",
    [payload.sid, payload.sub],
  );
  if (!valid.rowCount)
    throw Object.assign(new Error("Session revoked"), { statusCode: 401 });
  return { userId: payload.sub };
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
  const issue = async (userId: string) => {
    const refresh = randomBytes(32).toString("base64url");
    const row = await pool.query(
      "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days') RETURNING id",
      [userId, hash(refresh)],
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
      return issue(id);
    },
  );
  app.post(
    "/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const b = credentials.parse(req.body);
      const u = (
        await pool.query("SELECT * FROM users WHERE email=$1", [b.email])
      ).rows[0];
      if (
        !u ||
        u.disabled ||
        !(await argon2.verify(u.password_hash, b.password))
      )
        throw Object.assign(new Error("Invalid credentials"), {
          statusCode: 401,
        });
      await tx((c) => audit(c, "auth.login", u.id, u.id));
      return issue(u.id);
    },
  );
  app.post("/v1/auth/refresh", async (req) => {
    const b = z.object({ refreshToken: z.string().max(256) }).parse(req.body);
    const refresh = randomBytes(32).toString("base64url");
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
      return (
        await c.query(
          "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3) RETURNING id,user_id",
          [old.rows[0].user_id, hash(refresh), old.rows[0].expires_at],
        )
      ).rows[0];
    });
    return {
      accessToken: app.jwt.sign(
        { sub: row.user_id, sid: row.id },
        { expiresIn: "15m" },
      ),
      refreshToken: refresh,
    };
  });
  app.post("/v1/auth/logout", async (req) => {
    const a = await actor(req);
    await pool.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [
      a.userId,
    ]);
    return { ok: true };
  });
  registerChallengeAuthoring(app, { actor, authorize });
}
