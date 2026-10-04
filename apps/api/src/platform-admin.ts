import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pool, tx, audit } from "../../../packages/db/src/index.js";
import type { Actor } from "./auth.js";

type ActorFn = (req: FastifyRequest) => Promise<Actor>;

async function requirePlatformAdmin(actor: Actor) {
  if (!actor.userId)
    throw Object.assign(new Error("User session required"), { statusCode: 403 });
  const row = await pool.query(
    "SELECT platform_admin FROM users WHERE id=$1 AND NOT disabled",
    [actor.userId],
  );
  if (!row.rowCount || !row.rows[0].platform_admin)
    throw Object.assign(new Error("Platform administrator required"), {
      statusCode: 403,
    });
}

export function registerPlatformAdmin(
  app: FastifyInstance,
  deps: { actor: ActorFn },
) {
  app.get("/v1/admin/runtimes", async (req) => {
    const a = await deps.actor(req);
    await requirePlatformAdmin(a);
    return {
      items: (
        await pool.query(
          `SELECT r.id,r.language,r.version,r.enabled,r.updated_at,r.updated_by,
                  u.email AS updated_by_email
             FROM runtimes r
             LEFT JOIN users u ON u.id=r.updated_by
            ORDER BY r.language,r.version`,
        )
      ).rows,
    };
  });

  app.patch("/v1/admin/runtimes/:id", async (req) => {
    const a = await deps.actor(req);
    await requirePlatformAdmin(a);
    const { id } = z.object({ id: z.string().min(1).max(120) }).parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);

    return tx(async (client) => {
      const current = (
        await client.query(
          "SELECT id,language,version,enabled FROM runtimes WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!current)
        throw Object.assign(new Error("Runtime not found"), { statusCode: 404 });

      const updated = (
        await client.query(
          `UPDATE runtimes
              SET enabled=$2,updated_at=now(),updated_by=$3
            WHERE id=$1
            RETURNING id,language,version,enabled,updated_at,updated_by`,
          [id, enabled, a.userId],
        )
      ).rows[0];
      await audit(client, "platform.runtime.toggle", a.userId ?? null, id, {
        previousEnabled: current.enabled,
        enabled,
        language: current.language,
        version: current.version,
      });
      return updated;
    });
  });
}
