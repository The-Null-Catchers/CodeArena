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

  app.get("/v1/admin/analytics", async (req) => {
    const a = await deps.actor(req);
    await requirePlatformAdmin(a);
    const { hours } = z
      .object({ hours: z.coerce.number().int().min(1).max(168).default(24) })
      .parse(req.query);

    const [summary, throughput, runtimes, projects] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS submissions,
                count(*) FILTER (WHERE s.state='completed')::int AS completed,
                count(*) FILTER (WHERE s.state='failed')::int AS failed,
                count(*) FILTER (WHERE s.state='timed_out')::int AS timed_out,
                count(*) FILTER (WHERE sr.verdict='accepted')::int AS accepted,
                coalesce(sum(ur.cpu_ms),0)::bigint AS cpu_ms,
                coalesce(sum(ur.wall_ms),0)::bigint AS wall_ms,
                percentile_cont(0.50) WITHIN GROUP (ORDER BY sr.wall_ms)::float8 AS wall_p50_ms,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY sr.wall_ms)::float8 AS wall_p95_ms,
                percentile_cont(0.99) WITHIN GROUP (ORDER BY sr.wall_ms)::float8 AS wall_p99_ms,
                percentile_cont(0.50) WITHIN GROUP (ORDER BY sr.cpu_ms)::float8 AS cpu_p50_ms,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY sr.cpu_ms)::float8 AS cpu_p95_ms,
                percentile_cont(0.99) WITHIN GROUP (ORDER BY sr.cpu_ms)::float8 AS cpu_p99_ms
           FROM submissions s
           LEFT JOIN submission_results sr ON sr.submission_id=s.id
           LEFT JOIN usage_records ur ON ur.submission_id=s.id
          WHERE s.created_at >= now()-($1::int * interval '1 hour')`,
        [hours],
      ),
      pool.query(
        `SELECT date_trunc('hour',created_at) AS bucket,
                count(*)::int AS submissions,
                count(*) FILTER (WHERE state='completed')::int AS completed,
                count(*) FILTER (WHERE state IN ('failed','timed_out'))::int AS unsuccessful
           FROM submissions
          WHERE created_at >= now()-($1::int * interval '1 hour')
          GROUP BY 1
          ORDER BY 1`,
        [hours],
      ),
      pool.query(
        `SELECT s.runtime_id,
                r.language,
                r.version,
                count(*)::int AS submissions,
                count(*) FILTER (WHERE sr.verdict='accepted')::int AS accepted,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY sr.wall_ms)::float8 AS wall_p95_ms
           FROM submissions s
           JOIN runtimes r ON r.id=s.runtime_id
           LEFT JOIN submission_results sr ON sr.submission_id=s.id
          WHERE s.created_at >= now()-($1::int * interval '1 hour')
          GROUP BY s.runtime_id,r.language,r.version
          ORDER BY submissions DESC,s.runtime_id
          LIMIT 10`,
        [hours],
      ),
      pool.query(
        `SELECT p.id,p.name,
                count(s.id)::int AS submissions,
                count(s.id) FILTER (WHERE sr.verdict='accepted')::int AS accepted,
                coalesce(sum(ur.cpu_ms),0)::bigint AS cpu_ms,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY sr.wall_ms)::float8 AS wall_p95_ms
           FROM projects p
           JOIN submissions s ON s.project_id=p.id
           LEFT JOIN submission_results sr ON sr.submission_id=s.id
           LEFT JOIN usage_records ur ON ur.submission_id=s.id
          WHERE s.created_at >= now()-($1::int * interval '1 hour')
          GROUP BY p.id,p.name
          ORDER BY submissions DESC,p.name
          LIMIT 10`,
        [hours],
      ),
    ]);

    const totals = summary.rows[0];
    const submissionCount = Number(totals.submissions || 0);
    return {
      windowHours: hours,
      generatedAt: new Date().toISOString(),
      summary: {
        ...totals,
        successRate:
          submissionCount > 0
            ? Number(totals.accepted || 0) / submissionCount
            : 0,
        failureRate:
          submissionCount > 0
            ? (Number(totals.failed || 0) + Number(totals.timed_out || 0)) /
              submissionCount
            : 0,
        throughputPerHour: submissionCount / hours,
      },
      throughput: throughput.rows,
      runtimes: runtimes.rows,
      projects: projects.rows,
    };
  });
}
