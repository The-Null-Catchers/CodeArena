import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import argon2 from "argon2";
import { tx } from "../../../packages/db/src/index.js";
import { encryptSecret } from "../../delivery-worker/src/webhooks.js";
import { hash } from "./auth.js";
export async function enqueueAuthMail(
  c: pg.PoolClient,
  userId: string,
  email: string,
  purpose: "verify" | "reset",
) {
  const token = randomBytes(32).toString("base64url");
  await c.query(
    "INSERT INTO auth_tokens(user_id,token_hash,purpose,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')",
    [userId, hash(token), purpose],
  );
  const url = `${process.env.WEB_ORIGIN || "http://localhost:3000"}/account/${purpose}?token=${encodeURIComponent(token)}`;
  await c.query(
    "INSERT INTO mail_outbox(recipient,subject,encrypted_body) VALUES($1,$2,$3)",
    [
      email,
      purpose === "verify"
        ? "Verify your CodeArena email"
        : "Reset your CodeArena password",
      encryptSecret(
        `Open this link within 30 minutes:\n${url}\n\nIf you did not request this, ignore this email.`,
      ),
    ],
  );
}
export function registerEmail(app: FastifyInstance) {
  app.post(
    "/v1/auth/forgot-password",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      const b = z
        .object({
          email: z
            .string()
            .email()
            .transform((x) => x.toLowerCase()),
        })
        .parse(req.body);
      await tx(async (c) => {
        const u = (
          await c.query(
            "SELECT id,email FROM users WHERE email=$1 AND NOT disabled",
            [b.email],
          )
        ).rows[0];
        if (u) await enqueueAuthMail(c, u.id, u.email, "reset");
      });
      return { message: "If the account exists, a reset link will be sent." };
    },
  );
  app.post("/v1/auth/verify-email", async (req) => {
    const b = z.object({ token: z.string().min(20).max(128) }).parse(req.body);
    await tx(async (c) => {
      const token = (
        await c.query(
          "UPDATE auth_tokens SET consumed_at=now() WHERE token_hash=$1 AND purpose='verify' AND consumed_at IS NULL AND expires_at>now() RETURNING user_id",
          [hash(b.token)],
        )
      ).rows[0];
      if (!token)
        throw Object.assign(new Error("Invalid or expired token"), {
          statusCode: 400,
        });
      await c.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [
        token.user_id,
      ]);
    });
    return { ok: true };
  });
  app.post("/v1/auth/reset-password", async (req) => {
    const b = z
      .object({
        token: z.string().min(20).max(128),
        password: z.string().min(12).max(128),
      })
      .parse(req.body);
    const password = await argon2.hash(b.password, { type: argon2.argon2id });
    await tx(async (c) => {
      const token = (
        await c.query(
          "UPDATE auth_tokens SET consumed_at=now() WHERE token_hash=$1 AND purpose='reset' AND consumed_at IS NULL AND expires_at>now() RETURNING user_id",
          [hash(b.token)],
        )
      ).rows[0];
      if (!token)
        throw Object.assign(new Error("Invalid or expired token"), {
          statusCode: 400,
        });
      await c.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
        token.user_id,
        password,
      ]);
      await c.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [
        token.user_id,
      ]);
      await c.query(
        "UPDATE auth_tokens SET consumed_at=now() WHERE user_id=$1 AND purpose='reset'",
        [token.user_id],
      );
    });
    return { ok: true };
  });
}
