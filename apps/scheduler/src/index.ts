import { deliverMail } from "./mail.js";
import Fastify from "fastify";
import { Queue } from "bullmq";
import { Registry, Gauge, collectDefaultMetrics } from "prom-client";
import { pool, tx } from "../../../packages/db/src/index.js";
import {
  redis,
  publish,
  transition,
} from "../../../packages/shared/src/events.js";
import { deliverWebhooks } from "./webhooks.js";
import { tenantConcurrencyAvailable } from "../../../packages/shared/src/admission-budget.js";
const queues = new Map<string, Queue>();
function queue(id: string) {
  if (!queues.has(id))
    queues.set(
      id,
      new Queue(`execute-${id}`, {
        connection: redis as any,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 1000 },
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      }),
    );
  return queues.get(id)!;
}
let stopping = false,
  healthy = true;
const registry = new Registry();
collectDefaultMetrics({ register: registry });
const depth = new Gauge({
  name: "codearena_queue_depth",
  help: "Pending submissions",
  registers: [registry],
});
async function tick() {
  await tx(async (c) => {
    // One transaction serializes reservations across scheduler replicas. No Redis-only quota counters.
    await c.query("SELECT pg_advisory_xact_lock(908302)");
    await c.query(
      "UPDATE workers SET status='offline' WHERE last_heartbeat<now()-interval '15 seconds' AND status<>'offline'",
    );
    const stale = await c.query(
      "SELECT s.* FROM submissions s JOIN workers w ON w.id=s.worker_id WHERE s.state IN ('scheduled','preparing','compiling','running','judging') AND (w.status='offline' OR s.lease_until<now()) FOR UPDATE OF s SKIP LOCKED",
    );
    for (const s of stale.rows) {
      await transition(
        c,
        s.id,
        s.cancel_requested ? "cancelled" : s.attempt >= 3 ? "failed" : "queued",
        s.attempt >= 3
          ? "Retry budget exhausted"
          : "Worker lease expired; execution interrupted",
        undefined,
        undefined,
        { previousWorker: s.worker_id, attempt: s.attempt },
      );
      await c.query(
        "UPDATE submissions SET worker_id=NULL,lease_until=NULL WHERE id=$1",
        [s.id],
      );
      await c.query("DELETE FROM dispatch_outbox WHERE submission_id=$1", [
        s.id,
      ]);
    }
    const pending = await c.query(
      "SELECT * FROM submissions WHERE state='queued' AND NOT cancel_requested ORDER BY created_at - CASE priority WHEN 'system' THEN interval '90 seconds' WHEN 'high' THEN interval '60 seconds' WHEN 'normal' THEN interval '30 seconds' ELSE interval '0 seconds' END, id LIMIT 100 FOR UPDATE SKIP LOCKED",
    );
    for (const s of pending.rows) {
      const tenant = (
        await c.query(
          "SELECT p.max_concurrent,count(a.id)::int AS active FROM projects p LEFT JOIN submissions a ON a.project_id=p.id AND a.state IN ('scheduled','preparing','compiling','running','judging') WHERE p.id=$1 GROUP BY p.max_concurrent",
          [s.project_id],
        )
      ).rows[0];
      if (
        !tenant ||
        !tenantConcurrencyAvailable(tenant.active, tenant.max_concurrent)
      )
        continue;
      const w = (
        await c.query(
          "SELECT w.id,w.slots,count(s.id)::int AS active FROM workers w JOIN worker_runtimes wr ON wr.worker_id=w.id AND wr.runtime_id=$1 JOIN runtimes r ON r.id=wr.runtime_id AND r.enabled LEFT JOIN submissions s ON s.worker_id=w.id AND s.state IN ('scheduled','preparing','compiling','running','judging') WHERE ($2::text IS NULL OR wr.image_id=$2) AND wr.image_id IS NOT NULL AND w.status='online' AND w.last_heartbeat>now()-interval '15 seconds' GROUP BY w.id HAVING count(s.id)<w.slots ORDER BY count(s.id)::float/w.slots,w.id LIMIT 1",
          [s.runtime_id, s.runtime_image_id],
        )
      ).rows[0];
      if (!w) continue;
      await c.query(
        "UPDATE submissions SET worker_id=$2,attempt=attempt+1,lease_until=now()+interval '20 seconds' WHERE id=$1",
        [s.id, w.id],
      );
      await transition(
        c,
        s.id,
        "scheduled",
        "Least-loaded compatible worker reserved",
        w.id,
        s.attempt + 1,
      );
      await c.query(
        "INSERT INTO dispatch_outbox(submission_id,worker_id,attempt) VALUES($1,$2,$3) ON CONFLICT(submission_id) DO UPDATE SET worker_id=excluded.worker_id,attempt=excluded.attempt",
        [s.id, w.id, s.attempt + 1],
      );
    }
  });
  for (const d of (
    await pool.query(
      "SELECT * FROM dispatch_outbox ORDER BY created_at LIMIT 100",
    )
  ).rows) {
    await queue(d.worker_id).add(
      "execute",
      { id: d.submission_id, attempt: d.attempt },
      { jobId: `${d.submission_id}-${d.attempt}` },
    );
    await pool.query(
      "DELETE FROM dispatch_outbox WHERE submission_id=$1 AND attempt=$2",
      [d.submission_id, d.attempt],
    );
    await publish(d.submission_id, "state", {
      state: "scheduled",
      workerId: d.worker_id,
    });
  }
  depth.set(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM submissions WHERE state='queued'",
        )
      ).rows[0].count,
    ),
  );
  await deliverWebhooks();
  await deliverMail();
}
const health = Fastify();
health.get("/health/live", async () => ({ status: "ok" }));
health.get("/health/ready", async (_req, reply) => {
  if (!healthy || stopping) reply.code(503);
  return { status: healthy && !stopping ? "ready" : "unavailable" };
});
health.get("/metrics", async (_req, reply) =>
  reply.type(registry.contentType).send(await registry.metrics()),
);
await health.listen({ port: 4200, host: "0.0.0.0" });
let executing: Promise<void> | undefined;
const timer = setInterval(() => {
  if (executing || stopping) return;
  executing = tick()
    .then(() => {
      healthy = true;
    })
    .catch((e) => {
      healthy = false;
      console.error(JSON.stringify({ service: "scheduler", error: e.message }));
    })
    .finally(() => {
      executing = undefined;
    });
}, 500);
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    void (async () => {
      stopping = true;
      clearInterval(timer);
      await executing;
      await Promise.all([...queues.values()].map((q) => q.close()));
      await health.close();
      await pool.end();
      await redis.quit();
    })();
  });
