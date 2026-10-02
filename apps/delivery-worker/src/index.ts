import Fastify from "fastify";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { pool } from "../../../packages/db/src/index.js";
import { deliverMail } from "./mail.js";
import { deliverWebhooks } from "./webhooks.js";
import { structuredLog } from "../../../packages/shared/src/observability.js";

let stopping = false;
let healthy = true;
let executing: Promise<void> | undefined;
const registry = new Registry();
collectDefaultMetrics({ register: registry });
const deliveries = new Counter({
  name: "codearena_delivery_ticks_total",
  help: "Delivery worker ticks by outcome",
  labelNames: ["outcome"],
  registers: [registry],
});
const backlog = new Gauge({
  name: "codearena_delivery_backlog",
  help: "Pending delivery rows",
  labelNames: ["kind"],
  registers: [registry],
});

async function tick() {
  const [webhookPending, mailPending] = await Promise.all([
    pool.query(
      "SELECT count(*)::int AS count FROM webhook_deliveries WHERE status IN ('pending','delivering') AND next_attempt_at<=now()",
    ),
    pool.query(
      "SELECT count(*)::int AS count FROM mail_outbox WHERE status IN ('pending','delivering') AND next_attempt_at<=now()",
    ),
  ]);
  backlog.set({ kind: "webhook" }, webhookPending.rows[0].count);
  backlog.set({ kind: "mail" }, mailPending.rows[0].count);
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
await health.listen({ port: 4300, host: "0.0.0.0" });

const timer = setInterval(() => {
  if (executing || stopping) return;
  executing = tick()
    .then(() => {
      healthy = true;
      deliveries.inc({ outcome: "success" });
    })
    .catch((error) => {
      healthy = false;
      deliveries.inc({ outcome: "failure" });
      structuredLog(
        "delivery-worker",
        {
          event: "delivery_tick_failed",
          error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        },
        "error",
      );
    })
    .finally(() => {
      executing = undefined;
    });
}, 1000);

for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    void (async () => {
      stopping = true;
      clearInterval(timer);
      await executing;
      await health.close();
      await pool.end();
    })();
  });
