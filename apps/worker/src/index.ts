import { hostname } from "node:os";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { Worker } from "bullmq";
import { Registry, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import { config } from "../../../packages/config/src/index.js";
import { pool, tx } from "../../../packages/db/src/index.js";
import {
  redis,
  createWorkerConnection,
  publish,
  publishControlEvent,
  controlPlaneStream,
  transition,
} from "../../../packages/shared/src/events.js";
import { structuredLog } from "../../../packages/shared/src/observability.js";
import { DockerBackend } from "../../../packages/shared/src/sandbox.js";
import {
  runtimes,
  getRuntime,
  snapshotRuntime,
  runtimeImage,
} from "../../../packages/shared/src/runtimes.js";
import { judge, terminal } from "../../../packages/shared/src/domain.js";
import {
  objectStorage,
  objectStorageEnabled,
} from "../../../packages/shared/src/object-storage.js";
const controllers = new Map<string, AbortController>();
const backend = new DockerBackend();
await backend.check();
const storage = objectStorageEnabled() ? objectStorage() : undefined;
if (storage) await storage.ensureBucket();
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
if (config.WORKER_SLOTS * 512 > config.WORKER_MEMORY_MB - 512)
  throw new Error(
    "Worker capacity must reserve 512 MB per slot plus host headroom",
  );
// A session advisory lock prevents two live processes owning the same worker identity.
let identityLost = false;
const identity = await pool.connect();
const lock = await identity.query(
  "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
  [config.WORKER_ID],
);
if (!lock.rows[0].ok) throw new Error("WORKER_ID_ALREADY_ACTIVE");
identity.on("error", () => {
  identityLost = true;
  for (const c of controllers.values()) c.abort();
  process.exitCode = 1;
});
const available: string[] = [];
const availableImages = new Map<string, string>();
for (const r of runtimes) {
  try {
    const image = await backend.docker
      .getImage(
        process.env[`RUNTIME_IMAGE_${r.language.toUpperCase()}`] || r.image,
      )
      .inspect();
    available.push(r.id);
    availableImages.set(r.id, image.Id);
  } catch {
    /* unavailable images are never advertised */
  }
}
if (!available.length)
  throw new Error("Build runtime images before starting worker");
await tx(async (c) => {
  await c.query(
    "INSERT INTO workers(id,status,slots,memory_mb,hostname) VALUES($1,'online',$2,$3,$4) ON CONFLICT(id) DO UPDATE SET status='online',slots=excluded.slots,memory_mb=excluded.memory_mb,hostname=excluded.hostname,last_heartbeat=now()",
    [
      config.WORKER_ID,
      config.WORKER_SLOTS,
      config.WORKER_MEMORY_MB,
      hostname(),
    ],
  );
  await c.query("DELETE FROM worker_runtimes WHERE worker_id=$1", [
    config.WORKER_ID,
  ]);
  for (const id of available)
    await c.query(
      "INSERT INTO worker_runtimes(worker_id,runtime_id,image_id) VALUES($1,$2,$3)",
      [config.WORKER_ID, id, availableImages.get(id)],
    );
});
await publishControlEvent(controlPlaneStream, "worker.online", {
  workerId: config.WORKER_ID,
  slots: config.WORKER_SLOTS,
  memoryMb: config.WORKER_MEMORY_MB,
  hostname: hostname(),
  runtimes: available,
});
structuredLog("worker", {
  event: "worker.online",
  workerId: config.WORKER_ID,
  slots: config.WORKER_SLOTS,
  runtimes: available,
});
const registry = new Registry();
collectDefaultMetrics({ register: registry });
const active = new Gauge({
  name: "codearena_worker_active",
  help: "Active sandbox slots",
  registers: [registry],
});
const duration = new Histogram({
  name: "codearena_execution_seconds",
  help: "Execution duration",
  registers: [registry],
});
let draining = false;
let healthy = true;
const queueConnection = createWorkerConnection();
let heartRunning = false;
const heart = setInterval(() => {
  if (heartRunning) return;
  heartRunning = true;
  void (async () => {
    if (identityLost) throw new Error("WORKER_IDENTITY_LOST");
    await pool.query(
      "UPDATE workers SET last_heartbeat=now(),status=CASE WHEN status='draining' THEN status ELSE $2 END WHERE id=$1",
      [config.WORKER_ID, draining ? "draining" : "online"],
    );
    await pool.query(
      "UPDATE submissions SET lease_until=now()+interval '20 seconds' WHERE worker_id=$1 AND id=ANY($2::uuid[]) AND state IN ('preparing','compiling','running','judging')",
      [config.WORKER_ID, [...controllers.keys()]],
    );
    // Cancellation and lease renewal must still work while Redis is unavailable.
    const cancelled = await pool.query(
      "SELECT id FROM submissions WHERE id=ANY($1::uuid[]) AND cancel_requested",
      [[...controllers.keys()]],
    );
    for (const row of cancelled.rows) controllers.get(row.id)?.abort();
    healthy = await redis
      .ping()
      .then(() => queueConnection.status === "ready")
      .catch(() => false);
  })()
    .catch(() => {
      healthy = false;
      for (const c of controllers.values()) c.abort();
    })
    .finally(() => {
      heartRunning = false;
    });
}, 3000);
await backend.reap(config.WORKER_ID, new Set());
const worker = new Worker(
  `execute-${config.WORKER_ID}`,
  async (job) => {
    const { id, attempt } = job.data as { id: string; attempt: number };
    const controller = new AbortController();
    let s: any;
    const claimed = await tx(async (c) => {
      s = (
        await c.query("SELECT * FROM submissions WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (
        !s ||
        s.state !== "scheduled" ||
        s.worker_id !== config.WORKER_ID ||
        s.attempt !== attempt
      )
        return false;
      const fleet = (
        await c.query("SELECT status FROM workers WHERE id=$1 FOR UPDATE", [
          config.WORKER_ID,
        ])
      ).rows[0];
      if (draining || identityLost || fleet?.status !== "online") {
        await transition(c, id, "queued", "Worker unavailable before claim");
        await c.query(
          "UPDATE submissions SET worker_id=NULL,lease_until=NULL WHERE id=$1",
          [id],
        );
        return false;
      }
      if (!s.runtime_image_id) {
        const [language, version] = s.runtime_id.split(":");
        const definition = snapshotRuntime(
          getRuntime(language, version),
          availableImages.get(s.runtime_id)!,
        );
        await c.query(
          "UPDATE submissions SET runtime_image_id=$2,runtime_definition=$3,runtime_snapshot_origin='legacy-first-claim' WHERE id=$1",
          [id, definition.image, JSON.stringify(definition)],
        );
        s.runtime_image_id = definition.image;
        s.runtime_definition = definition;
      }
      await c.query(
        "UPDATE submissions SET lease_until=now()+interval '20 seconds' WHERE id=$1",
        [id],
      );
      return transition(
        c,
        id,
        "preparing",
        "Worker accepted job",
        config.WORKER_ID,
        attempt,
      );
    });
    if (!claimed) return;
    controllers.set(id, controller);
    active.set(controllers.size);
    let pending: { kind: string; text: string }[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      const chunks = pending;
      pending = [];
      pendingBytes = 0;
      for (const chunk of chunks)
        await publish(id, "output", chunk).catch(() => {});
    };
    const ticker = setInterval(() => {
      void flush();
    }, 150);
    const phase = async (state: "compiling" | "running") => {
      if (s.phase === state || s.phase === "running") return;
      const changed = await tx((c) =>
        transition(c, id, state, `Sandbox ${state}`, config.WORKER_ID, attempt),
      );
      if (changed) {
        s.phase = state;
        await publish(id, "state", { state });
      }
    };
    try {
      if (s.cancel_requested) controller.abort();
      const r = s.runtime_definition;
      if (
        !r ||
        r.id !== s.runtime_id ||
        r.image !== s.runtime_image_id ||
        runtimeImage(r) !== s.runtime_image_id
      )
        throw new Error("INVALID_RUNTIME_SNAPSHOT");
      const cases =
        s.mode === "challenge"
          ? (
              await pool.query(
                "SELECT t.*,t.test_case_id AS id,$2::text AS judge FROM submission_test_cases t WHERE t.submission_id=$1 ORDER BY position LIMIT 100",
                [s.id, s.judge_strategy],
              )
            ).rows
          : [{ stdin: s.stdin, expected: "", weight: 1 }];
      if (!cases.length) throw new Error("CHALLENGE_HAS_NO_TESTS");
      const sourceSha = digest(s.source);
      const compileFingerprint = r.compile
        ? digest(
            JSON.stringify({
              runtimeId: r.id,
              image: r.image,
              compile: r.compile,
              cacheFiles: r.cacheFiles,
              environment: r.environment,
            }),
          )
        : undefined;
      const cacheKey =
        r.compile && compileFingerprint
          ? digest(`${sourceSha}:${compileFingerprint}`)
          : undefined;
      let compiledArtifact: Buffer | undefined;
      let cachePersisted = false;
      if (storage && cacheKey) {
        const cached = (
          await pool.query(
            "SELECT object_key,size_bytes,sha256 FROM compilation_cache WHERE cache_key=$1",
            [cacheKey],
          )
        ).rows[0];
        if (cached) {
          try {
            const object = await storage.get(cached.object_key);
            if (
              object.size !== Number(cached.size_bytes) ||
              digest(object.body) !== cached.sha256
            )
              throw new Error("COMPILE_CACHE_INTEGRITY_MISMATCH");
            compiledArtifact = object.body;
            cachePersisted = true;
            await pool.query(
              "UPDATE compilation_cache SET last_used_at=now() WHERE cache_key=$1",
              [cacheKey],
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "UNKNOWN_CACHE_ERROR";
            if (
              message === "Artifact not found" ||
              message === "COMPILE_CACHE_INTEGRITY_MISMATCH"
            )
              await pool.query(
                "DELETE FROM compilation_cache WHERE cache_key=$1",
                [cacheKey],
              );
            console.error(
              JSON.stringify({
                service: "worker",
                event: "compile_cache_read_failed",
                submission_id: id,
                worker_id: config.WORKER_ID,
                cache_key: cacheKey,
                invalidated:
                  message === "Artifact not found" ||
                  message === "COMPILE_CACHE_INTEGRITY_MISMATCH",
                error: message,
              }),
            );
          }
        }
      }
      let final: any;
      const testResults: any[] = [];
      const totalWeight = cases.reduce(
        (sum: number, test: any) => sum + test.weight,
        0,
      );
      let score = 0,
        totalWall = 0,
        totalCpu = 0,
        peak = 0;
      for (const test of cases) {
        if (controller.signal.aborted) break;
        const result = await backend.run(
          r,
          s.source,
          test.stdin,
          {
            ...s.limits,
            wallTimeMs: Math.min(
              s.limits.wallTimeMs,
              test.wall_time_ms ?? s.limits.wallTimeMs,
            ),
            memoryMb: Math.min(
              s.limits.memoryMb,
              test.memory_mb ?? s.limits.memoryMb,
            ),
          },
          controller.signal,
          (kind, text) => {
            if (s.mode === "challenge") return;
            if (pendingBytes + Buffer.byteLength(text) > 16384) return;
            pendingBytes += Buffer.byteLength(text);
            const last = pending.at(-1);
            if (last?.kind === kind) last.text += text;
            else pending.push({ kind, text });
          },
          phase,
          {
            "codearena.worker": config.WORKER_ID,
            "codearena.submission": id,
            "codearena.attempt": String(attempt),
          },
          compiledArtifact,
        );
        if (!compiledArtifact && result.compiledArtifact) {
          compiledArtifact = result.compiledArtifact;
          if (storage && cacheKey && compileFingerprint && !cachePersisted) {
            try {
              const artifactSha = digest(compiledArtifact);
              const objectKey = `compilation-cache/${cacheKey}/${artifactSha}.tar`;
              const stored = await storage.put(
                objectKey,
                compiledArtifact,
                "application/x-tar",
              );
              const inserted = await pool.query(
                "INSERT INTO compilation_cache(cache_key,runtime_id,runtime_image_id,source_sha256,compile_fingerprint,object_key,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(cache_key) DO NOTHING RETURNING cache_key",
                [
                  cacheKey,
                  r.id,
                  r.image,
                  sourceSha,
                  compileFingerprint,
                  stored.key,
                  stored.size,
                  stored.sha256,
                ],
              );
              if (!inserted.rowCount) {
                const winner = (
                  await pool.query(
                    "SELECT object_key FROM compilation_cache WHERE cache_key=$1",
                    [cacheKey],
                  )
                ).rows[0];
                if (winner?.object_key && winner.object_key !== stored.key)
                  await storage.remove(stored.key);
              }
              cachePersisted = true;
            } catch (error) {
              console.error(
                JSON.stringify({
                  service: "worker",
                  event: "compile_cache_write_failed",
                  submission_id: id,
                  worker_id: config.WORKER_ID,
                  cache_key: cacheKey,
                  error:
                    error instanceof Error
                      ? error.message
                      : "UNKNOWN_CACHE_ERROR",
                }),
              );
            }
          }
        }
        totalWall += result.wallMs;
        totalCpu += result.cpuMs;
        peak = Math.max(peak, result.peakMemoryBytes);
        let verdict = result.verdict;
        if (
          s.mode === "challenge" &&
          verdict === "accepted" &&
          !judge(result.stdout, test.expected, test.judge)
        )
          verdict = "wrong_answer";
        testResults.push({
          id: test.id,
          verdict,
          wallMs: result.wallMs,
          peak: result.peakMemoryBytes,
        });
        if (verdict === "accepted") score += test.weight;
        if (!final || final.verdict === "accepted")
          final = { ...result, verdict };
        if (totalWall > 120000 && testResults.length < cases.length) {
          final.verdict = "time_limit_exceeded";
          break;
        }
      }
      await flush();
      const cancel = (
        await pool.query(
          "SELECT cancel_requested FROM submissions WHERE id=$1",
          [id],
        )
      ).rows[0]?.cancel_requested;
      const end = controller.signal.aborted
        ? cancel
          ? "cancelled"
          : "failed"
        : final.verdict === "time_limit_exceeded"
          ? "timed_out"
          : final.verdict === "internal_error"
            ? "failed"
            : "completed";
      if (
        s.mode === "challenge" &&
        !controller.signal.aborted &&
        s.phase === "running"
      )
        await tx((c) =>
          transition(
            c,
            id,
            "judging",
            "Comparing protected test outputs",
            config.WORKER_ID,
            attempt,
          ),
        );
      let compileLogArtifact:
        | {
            key: string;
            size: number;
            sha256: string;
            contentType: string;
          }
        | undefined;
      if (storage && final?.compileOutput) {
        try {
          const body = Buffer.from(final.compileOutput, "utf8");
          if (body.byteLength <= 10 * 1024 * 1024)
            compileLogArtifact = await storage.put(
              `submissions/${id}/compile-output.txt`,
              body,
              "text/plain; charset=utf-8",
            );
        } catch (error) {
          console.error(
            JSON.stringify({
              service: "worker",
              event: "artifact_store_failed",
              submission_id: id,
              worker_id: config.WORKER_ID,
              kind: "compile_log",
              error:
                error instanceof Error ? error.message : "UNKNOWN_ARTIFACT_ERROR",
            }),
          );
        }
      }
      await tx(async (c) => {
        const row = (
          await c.query("SELECT * FROM submissions WHERE id=$1 FOR UPDATE", [
            id,
          ])
        ).rows[0];
        if (
          row.worker_id !== config.WORKER_ID ||
          row.attempt !== attempt ||
          terminal.has(row.state)
        )
          return;
        const result = final || {
          verdict: "internal_error",
          stdout: "",
          stderr: "",
          compileOutput: "",
          exitCode: null,
          outputTruncated: false,
          imageId: "",
        };
        await c.query(
          "INSERT INTO submission_results(submission_id,verdict,stdout,stderr,compile_output,exit_code,wall_ms,cpu_ms,peak_memory_bytes,output_truncated,score) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING",
          [
            id,
            result.verdict,
            s.mode === "challenge" ? "" : result.stdout,
            s.mode === "challenge" ? "" : result.stderr,
            result.compileOutput,
            result.exitCode,
            totalWall,
            totalCpu,
            peak,
            result.outputTruncated,
            totalWeight ? (100 * score) / totalWeight : 0,
          ],
        );
        for (const t of testResults)
          if (t.id)
            await c.query(
              "INSERT INTO test_results(submission_id,test_case_id,verdict,wall_ms,peak_memory_bytes) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
              [id, t.id, t.verdict, t.wallMs, t.peak],
            );
        if (compileLogArtifact)
          await c.query(
            "INSERT INTO artifacts(submission_id,project_id,kind,object_key,filename,mime_type,size_bytes,sha256) VALUES($1,$2,'compile_log',$3,'compile-output.txt',$4,$5,$6) ON CONFLICT(object_key) DO NOTHING",
            [
              id,
              s.project_id,
              compileLogArtifact.key,
              compileLogArtifact.contentType,
              compileLogArtifact.size,
              compileLogArtifact.sha256,
            ],
          );
        await c.query(
          "INSERT INTO usage_records(submission_id,project_id,wall_ms,cpu_ms,artifact_bytes) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [
            id,
            s.project_id,
            totalWall,
            totalCpu,
            compileLogArtifact?.size || 0,
          ],
        );
        await transition(
          c,
          id,
          end,
          "Execution finalized",
          config.WORKER_ID,
          attempt,
          { imageId: result.imageId },
        );
      });
      duration.observe(totalWall / 1000);
      await publish(id, "state", { state: end });
    } catch (e) {
      await tx(async (c) => {
        await transition(
          c,
          id,
          "failed",
          "Sandbox infrastructure failure",
          config.WORKER_ID,
          attempt,
        );
      });
      await publish(id, "state", { state: "failed" }).catch(() => {});
      structuredLog(
        "worker",
        {
          event: "submission_execution_failed",
          submissionId: id,
          workerId: config.WORKER_ID,
          attempt,
          error: e instanceof Error ? e.message : "UNKNOWN_ERROR",
        },
        "error",
      );
    } finally {
      clearInterval(ticker);
      controllers.delete(id);
      active.set(controllers.size);
    }
  },
  {
    connection: queueConnection as any,
    concurrency: config.WORKER_SLOTS,
    maxStalledCount: 1,
    lockDuration: 30000,
  },
);
worker.on("error", () => {
  healthy = false;
});
const health = Fastify();
health.get("/health/live", async () => ({ status: "ok" }));
health.get("/health/ready", async (_req, reply) => {
  if (!healthy || draining) reply.code(503);
  return {
    status: healthy && !draining ? "ready" : "unavailable",
    slots: config.WORKER_SLOTS,
    active: controllers.size,
    runtimes: available,
  };
});
health.get("/metrics", async (_req, reply) =>
  reply.type(registry.contentType).send(await registry.metrics()),
);
await health.listen({ port: 4100, host: "0.0.0.0" });
const shutdown = async () => {
  if (draining) return;
  draining = true;
  await pool.query("UPDATE workers SET status='draining' WHERE id=$1", [
    config.WORKER_ID,
  ]);
  await publishControlEvent(controlPlaneStream, "worker.draining", {
    workerId: config.WORKER_ID,
    active: controllers.size,
  });
  structuredLog("worker", {
    event: "worker.draining",
    workerId: config.WORKER_ID,
    active: controllers.size,
  });
  const deadline = setTimeout(() => {
    for (const c of controllers.values()) c.abort();
  }, 20000);
  await worker.close();
  clearTimeout(deadline);
  clearInterval(heart);
  await pool.query("UPDATE workers SET status='offline' WHERE id=$1", [
    config.WORKER_ID,
  ]);
  await backend.reap(config.WORKER_ID, new Set());
  await health.close();
  identity.release();
  await pool.end();
  await redis.quit();
  await queueConnection.quit();
};
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    void shutdown();
  });
