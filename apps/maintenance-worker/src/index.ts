import Fastify from "fastify";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { pool } from "../../../packages/db/src/index.js";
import {
  objectStorage,
  objectStorageEnabled,
} from "../../../packages/shared/src/object-storage.js";
import { structuredLog } from "../../../packages/shared/src/observability.js";

const artifactRetentionDays = Math.max(
  1,
  Number.parseInt(process.env.ARTIFACT_RETENTION_DAYS || "30", 10) || 30,
);
const compileCacheRetentionDays = Math.max(
  1,
  Number.parseInt(process.env.COMPILE_CACHE_RETENTION_DAYS || "14", 10) || 14,
);
const batchSize = Math.min(
  500,
  Math.max(1, Number.parseInt(process.env.STORAGE_GC_BATCH_SIZE || "100", 10) || 100),
);
const intervalMs = Math.max(
  10_000,
  Number.parseInt(process.env.STORAGE_GC_INTERVAL_MS || "60000", 10) || 60_000,
);

const storage = objectStorageEnabled() ? objectStorage() : undefined;
if (storage) await storage.ensureBucket();

let stopping = false;
let healthy = true;
let executing: Promise<void> | undefined;
const registry = new Registry();
collectDefaultMetrics({ register: registry });
const gcRuns = new Counter({
  name: "codearena_storage_gc_runs_total",
  help: "Storage garbage collection runs by outcome",
  labelNames: ["outcome"],
  registers: [registry],
});
const gcDeleted = new Counter({
  name: "codearena_storage_gc_deleted_total",
  help: "Deleted storage records by kind",
  labelNames: ["kind"],
  registers: [registry],
});
const gcBacklog = new Gauge({
  name: "codearena_storage_gc_backlog",
  help: "Storage records currently eligible for garbage collection",
  labelNames: ["kind"],
  registers: [registry],
});

async function deleteArtifacts() {
  if (!storage) return 0;
  const rows = (
    await pool.query(
      `SELECT id,object_key
       FROM artifacts
       WHERE created_at < now() - ($1::int * interval '1 day')
       ORDER BY created_at,id
       LIMIT $2`,
      [artifactRetentionDays, batchSize],
    )
  ).rows as { id: string; object_key: string }[];
  let deleted = 0;
  for (const row of rows) {
    try {
      await storage.remove(row.object_key);
      const result = await pool.query("DELETE FROM artifacts WHERE id=$1", [row.id]);
      if (result.rowCount) deleted += 1;
    } catch (error) {
      structuredLog(
        "maintenance-worker",
        {
          event: "artifact_gc_delete_failed",
          artifactId: row.id,
          objectKey: row.object_key,
          error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        },
        "error",
      );
    }
  }
  return deleted;
}

async function deleteCompilationCache() {
  if (!storage) return 0;
  const rows = (
    await pool.query(
      `SELECT cache_key,object_key
       FROM compilation_cache
       WHERE last_used_at < now() - ($1::int * interval '1 day')
       ORDER BY last_used_at,cache_key
       LIMIT $2`,
      [compileCacheRetentionDays, batchSize],
    )
  ).rows as { cache_key: string; object_key: string }[];
  let deleted = 0;
  for (const row of rows) {
    try {
      await storage.remove(row.object_key);
      const result = await pool.query(
        "DELETE FROM compilation_cache WHERE cache_key=$1 AND last_used_at < now() - ($2::int * interval '1 day')",
        [row.cache_key, compileCacheRetentionDays],
      );
      if (result.rowCount) deleted += 1;
    } catch (error) {
      structuredLog(
        "maintenance-worker",
        {
          event: "compile_cache_gc_delete_failed",
          cacheKey: row.cache_key,
          objectKey: row.object_key,
          error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        },
        "error",
      );
    }
  }
  return deleted;
}

async function tick() {
  const [artifactEligible, cacheEligible] = await Promise.all([
    pool.query(
      "SELECT count(*)::int AS count FROM artifacts WHERE created_at < now() - ($1::int * interval '1 day')",
      [artifactRetentionDays],
    ),
    pool.query(
      "SELECT count(*)::int AS count FROM compilation_cache WHERE last_used_at < now() - ($1::int * interval '1 day')",
      [compileCacheRetentionDays],
    ),
  ]);
  gcBacklog.set({ kind: "artifact" }, artifactEligible.rows[0].count);
  gcBacklog.set({ kind: "compile_cache" }, cacheEligible.rows[0].count);
  const [artifacts, cache] = await Promise.all([
    deleteArtifacts(),
    deleteCompilationCache(),
  ]);
  gcDeleted.inc({ kind: "artifact" }, artifacts);
  gcDeleted.inc({ kind: "compile_cache" }, cache);
}

const health = Fastify();
health.get("/health/live", async () => ({ status: "ok" }));
health.get("/health/ready", async (_req, reply) => {
  if (!healthy || stopping) reply.code(503);
  return {
    status: healthy && !stopping ? "ready" : "unavailable",
    artifactRetentionDays,
    compileCacheRetentionDays,
    batchSize,
  };
});
health.get("/metrics", async (_req, reply) =>
  reply.type(registry.contentType).send(await registry.metrics()),
);
await health.listen({ port: 4400, host: "0.0.0.0" });

const run = () => {
  if (executing || stopping) return;
  executing = tick()
    .then(() => {
      healthy = true;
      gcRuns.inc({ outcome: "success" });
    })
    .catch((error) => {
      healthy = false;
      gcRuns.inc({ outcome: "failure" });
      structuredLog(
        "maintenance-worker",
        {
          event: "storage_gc_tick_failed",
          error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        },
        "error",
      );
    })
    .finally(() => {
      executing = undefined;
    });
};
run();
const timer = setInterval(run, intervalMs);

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
