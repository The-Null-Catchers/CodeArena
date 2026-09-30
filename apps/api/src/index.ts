import { registerEmail } from "./email.js";
import { encryptSecret, allowedUrl } from "../../scheduler/src/webhooks.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { z, ZodError } from "zod";
import { randomBytes } from "node:crypto";
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import { config } from "../../../packages/config/src/index.js";
import { pool, tx, audit } from "../../../packages/db/src/index.js";
import {
  redis,
  publish,
  transition,
} from "../../../packages/shared/src/events.js";
import {
  submissionSchema,
  priorityAllowed,
  quotaExceeded,
  terminal,
} from "../../../packages/shared/src/domain.js";
import { getRuntime } from "../../../packages/shared/src/runtimes.js";
import { registerAuth, actor, authorize, hash } from "./auth.js";
export const app = Fastify({
  bodyLimit: 160 * 1024,
  logger: {
    redact: [
      "req.headers.authorization",
      "password",
      "refreshToken",
      "secret",
      "source",
      "stdin",
    ],
    level: "info",
  },
  requestIdHeader: false,
  genReqId: () => crypto.randomUUID(),
});
await app.register(cors, { origin: config.WEB_ORIGIN });
await app.register(jwt, { secret: config.JWT_SECRET });
await app.register(rateLimit, { redis, max: 100, timeWindow: "1 minute" });
await registerAuth(app);
registerEmail(app);
const registry = new Registry();
collectDefaultMetrics({ register: registry });
const requests = new Counter({
  name: "codearena_api_requests_total",
  help: "Requests by route and status",
  labelNames: ["route", "status"],
  registers: [registry],
});
const latency = new Histogram({
  name: "codearena_api_duration_seconds",
  help: "API response latency",
  labelNames: ["route"],
  registers: [registry],
});
app.addHook("onResponse", async (req, reply) => {
  const route = req.routeOptions.url || "unknown";
  requests.inc({ route, status: String(reply.statusCode) });
  latency.observe({ route }, reply.elapsedTime / 1000);
});
app.setErrorHandler((unknownError, req, reply) => {
  const e = unknownError as Error & { statusCode?: number };
  const status =
    e instanceof ZodError
      ? 400
      : e.statusCode || ((e as any).code === "23505" ? 409 : 500);
  if (status >= 500)
    req.log.error({ err: e, request_id: req.id }, "Request failed");
  reply.code(status).send({
    error: {
      code:
        e instanceof ZodError
          ? "VALIDATION_ERROR"
          : status === 500
            ? "INTERNAL_ERROR"
            : e.message.replaceAll(" ", "_").toUpperCase(),
      message:
        status >= 500
          ? "An internal error occurred."
          : status === 409
            ? "The resource already exists."
            : e.message,
      requestId: req.id,
    },
  });
});
for (const path of ["/health", "/health/live"])
  app.get(path, { config: { rateLimit: false } }, async () => ({
    status: "ok",
    service: "codearena-api",
  }));
app.get(
  "/health/ready",
  { config: { rateLimit: false } },
  async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      await redis.ping();
      return { status: "ready" };
    } catch {
      reply.code(503);
      return { status: "unavailable" };
    }
  },
);
app.get("/metrics", async (_req, reply) =>
  reply.type(registry.contentType).send(await registry.metrics()),
);
app.get("/v1/runtimes", async () => ({
  items: (
    await pool.query(
      "SELECT id,language,version,enabled FROM runtimes ORDER BY language,version",
    )
  ).rows,
}));
app.get("/v1/projects", async (req) => {
  const a = await actor(req);
  if (a.projectId)
    return {
      items: (
        await pool.query(
          "SELECT id,name,organization_id FROM projects WHERE id=$1",
          [a.projectId],
        )
      ).rows,
    };
  return {
    items: (
      await pool.query(
        "SELECT p.*,m.role FROM projects p JOIN memberships m ON m.organization_id=p.organization_id WHERE m.user_id=$1 ORDER BY p.created_at",
        [a.userId],
      )
    ).rows,
  };
});
app.post("/v1/projects", async (req, reply) => {
  const a = await actor(req);
  const b = z
    .object({
      organizationId: z.string().uuid(),
      name: z.string().min(1).max(100),
    })
    .strict()
    .parse(req.body);
  if (!a.userId)
    throw Object.assign(new Error("User session required"), {
      statusCode: 403,
    });
  const project = await tx(async (c) => {
    const membership = (
      await c.query(
        "SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE",
        [b.organizationId, a.userId],
      )
    ).rows[0];
    if (!membership || !["owner", "admin"].includes(membership.role))
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    const row = (
      await c.query(
        "INSERT INTO projects(organization_id,name) VALUES($1,$2) RETURNING id,name,organization_id",
        [b.organizationId, b.name],
      )
    ).rows[0];
    await audit(c, "project.create", a.userId!, row.id);
    return row;
  });
  reply.code(201);
  return project;
});
app.post("/v1/challenges", async (req, reply) => {
  const a = await actor(req);
  const b = z
    .object({
      projectId: z.string().uuid(),
      title: z.string().min(1).max(160),
      slug: z.string().regex(/^[a-z0-9-]{1,100}$/),
      description: z.string().min(1).max(30000),
      difficulty: z.enum(["easy", "medium", "hard"]),
      visibility: z.enum(["public", "private"]).default("private"),
      judge: z
        .enum(["exact", "whitespace", "case_insensitive", "float"])
        .default("whitespace"),
      tests: z
        .array(
          z
            .object({
              stdin: z.string().max(65536),
              expected: z.string().max(65536),
              hidden: z.boolean().default(true),
              weight: z.number().int().min(1).max(100).default(1),
              wallTimeMs: z.number().int().min(100).max(15000).optional(),
              memoryMb: z.number().int().min(32).max(512).optional(),
              group: z.string().max(80).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict()
    .parse(req.body);
  await authorize(a, b.projectId, "challenges:write");
  const id = await tx(async (c) => {
    const row = (
      await c.query(
        "INSERT INTO challenges(project_id,title,slug,description,difficulty,visibility,judge) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [
          b.projectId,
          b.title,
          b.slug,
          b.description,
          b.difficulty,
          b.visibility,
          b.judge,
        ],
      )
    ).rows[0];
    for (const [position, t] of b.tests.entries())
      await c.query(
        "INSERT INTO challenge_test_cases(challenge_id,position,stdin,expected,hidden,weight,wall_time_ms,memory_mb,test_group) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          row.id,
          position,
          t.stdin,
          t.expected,
          t.hidden,
          t.weight,
          t.wallTimeMs ?? null,
          t.memoryMb ?? null,
          t.group ?? null,
        ],
      );
    await audit(c, "challenge.publish", a.userId ?? null, row.id);
    return row.id;
  });
  reply.code(201);
  return { id };
});
const create = async (req: any, body: unknown) => {
  const a = await actor(req),
    b = submissionSchema.parse(body),
    r = getRuntime(b.language, b.version);
  await authorize(a, b.projectId, "submissions:create");
  const id = await tx(async (c) => {
    const p = (
      await c.query("SELECT * FROM projects WHERE id=$1 FOR UPDATE", [
        b.projectId,
      ])
    ).rows[0];
    if (!priorityAllowed(b.priority, p.max_priority))
      throw Object.assign(new Error("Priority not allowed"), {
        statusCode: 403,
      });
    const count = await c.query(
      "SELECT count(*) FILTER(WHERE state NOT IN ('completed','failed','cancelled','timed_out'))::int AS outstanding,count(*) FILTER(WHERE created_at>=date_trunc('day',now()))::int AS daily FROM submissions WHERE project_id=$1",
      [b.projectId],
    );
    if (
      quotaExceeded(count.rows[0], {
        maxOutstanding: p.max_outstanding,
        maxDaily: p.max_daily,
      })
    )
      throw Object.assign(new Error("Submission limit exceeded"), {
        statusCode: 429,
      });
    if (
      !(await c.query("SELECT 1 FROM runtimes WHERE id=$1 AND enabled", [r.id]))
        .rowCount
    )
      throw Object.assign(new Error("Runtime unavailable"), {
        statusCode: 400,
      });
    if (
      b.challengeId &&
      !(
        await c.query(
          "SELECT 1 FROM challenges WHERE id=$1 AND (visibility='public' OR project_id=$2)",
          [b.challengeId, b.projectId],
        )
      ).rowCount
    )
      throw Object.assign(new Error("Challenge unavailable"), {
        statusCode: 404,
      });
    const row = (
      await c.query(
        "INSERT INTO submissions(project_id,user_id,runtime_id,challenge_id,source,stdin,mode,limits,priority,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'created') RETURNING id",
        [
          b.projectId,
          a.userId || null,
          r.id,
          b.challengeId || null,
          b.source,
          b.stdin,
          b.mode,
          JSON.stringify(b.limits),
          b.priority,
        ],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO submission_events(submission_id,state,reason) VALUES($1,'created','Request accepted')",
      [row.id],
    );
    await transition(c, row.id, "queued", "Quota reserved");
    return row.id;
  });
  await publish(id, "state", { state: "queued" }).catch(() => {});
  return { id, status: "queued" };
};
app.post("/v1/submissions", async (req, reply) => {
  reply.code(202);
  return create(req, req.body);
});
app.post("/v1/submissions/batch", async (req, reply) => {
  const bodies = z.array(submissionSchema).min(1).max(10).parse(req.body);
  const items = [];
  for (const b of bodies) {
    try {
      items.push({ ok: true, ...(await create(req, b)) });
    } catch (e) {
      items.push({ ok: false, error: (e as Error).message });
    }
  }
  reply.code(207);
  return { items };
});
const own = async (req: any) => {
  const id = z.string().uuid().parse(req.params.id);
  const row = (await pool.query("SELECT * FROM submissions WHERE id=$1", [id]))
    .rows[0];
  if (!row)
    throw Object.assign(new Error("Submission not found"), { statusCode: 404 });
  await authorize(await actor(req), row.project_id, "submissions:read");
  return row;
};
app.get("/v1/submissions", async (req) => {
  const q = z
    .object({
      projectId: z.string().uuid(),
      before: z.string().datetime().optional(),
    })
    .parse(req.query);
  await authorize(await actor(req), q.projectId, "submissions:read");
  return {
    items: (
      await pool.query(
        "SELECT s.id,s.state,s.runtime_id,s.challenge_id,s.created_at,r.verdict,r.wall_ms,r.peak_memory_bytes FROM submissions s LEFT JOIN submission_results r ON r.submission_id=s.id WHERE s.project_id=$1 AND ($2::timestamptz IS NULL OR s.created_at<$2) ORDER BY s.created_at DESC LIMIT 50",
        [q.projectId, q.before || null],
      )
    ).rows,
  };
});
app.get("/v1/submissions/:id", async (req) => {
  const s = await own(req);
  const [results, events, tests] = await Promise.all([
    pool.query("SELECT * FROM submission_results WHERE submission_id=$1", [
      s.id,
    ]),
    pool.query(
      "SELECT * FROM submission_events WHERE submission_id=$1 ORDER BY id",
      [s.id],
    ),
    pool.query(
      "SELECT t.verdict,t.wall_ms,t.peak_memory_bytes,c.position,c.hidden FROM test_results t JOIN challenge_test_cases c ON c.id=t.test_case_id WHERE t.submission_id=$1 ORDER BY c.position",
      [s.id],
    ),
  ]);
  return {
    submission: s,
    result: results.rows[0] || null,
    events: events.rows,
    tests: tests.rows,
  };
});
app.post("/v1/submissions/:id/cancel", async (req) => {
  const s = await own(req);
  await authorize(await actor(req), s.project_id, "submissions:create");
  await tx(async (c) => {
    const locked = (
      await c.query("SELECT state FROM submissions WHERE id=$1 FOR UPDATE", [
        s.id,
      ])
    ).rows[0];
    if (terminal.has(locked.state)) return;
    await c.query("UPDATE submissions SET cancel_requested=true WHERE id=$1", [
      s.id,
    ]);
    if (["created", "queued", "scheduled"].includes(locked.state))
      await transition(c, s.id, "cancelled", "Cancelled by caller");
  });
  await redis.set(`cancel:${s.id}`, "1", "EX", 60).catch(() => {});
  await publish(s.id, "state", { cancelRequested: true });
  return { ok: true };
});
// Redis Streams provide output replay without polling the database. State snapshot reconciles expired streams.
app.get("/v1/submissions/:id/events", async (req, reply) => {
  const s = await own(req);
  const streamKey = `sse:${s.project_id}`;
  const admitted = await redis.eval(
    "redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); if redis.call('ZCARD',KEYS[1])>=10 then return 0 end; redis.call('ZADD',KEYS[1],ARGV[2],ARGV[3]); redis.call('EXPIRE',KEYS[1],60); return 1",
    1,
    streamKey,
    Date.now(),
    Date.now() + 30000,
    req.id,
  );
  if (!admitted)
    throw Object.assign(new Error("Stream connection limit exceeded"), {
      statusCode: 429,
    });
  const keepAlive = setInterval(() => {
    void redis.zadd(streamKey, Date.now() + 30000, req.id).catch(() => {});
  }, 10000);
  // XREAD intentionally blocks for ten seconds; give this dedicated reader a
  // longer deadline than ordinary Redis commands, then close SSE on failure.
  const reader = redis.duplicate({ commandTimeout: 15000, lazyConnect: true });
  reader.on("error", () => {});
  let cursor = /^\d+-\d+$/.test(String(req.headers["last-event-id"]))
    ? String(req.headers["last-event-id"])
    : "0-0";
  let closed = false;
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": config.WEB_ORIGIN,
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(
    `event: snapshot\ndata: ${JSON.stringify({ state: s.state })}\n\n`,
  );
  reply.raw.on("close", () => {
    closed = true;
    clearInterval(keepAlive);
    void redis.zrem(streamKey, req.id).catch(() => {});
    reader.disconnect();
  });
  try {
    await reader.connect();
    while (!closed) {
      const records = (await reader.call(
        "XREAD",
        "BLOCK",
        10000,
        "COUNT",
        32,
        "STREAMS",
        `events:${s.id}`,
        cursor,
      )) as any;
      const chunks: string[] = [];
      if (!records) chunks.push(": heartbeat\n\n");
      else
        for (const [, entries] of records)
          for (const [id, fields] of entries) {
            cursor = id;
            chunks.push(
              `id: ${id}\nevent: ${fields[1]}\ndata: ${fields[3]}\n\n`,
            );
          }
      for (const chunk of chunks) {
        if (closed) break;
        if (!reply.raw.write(chunk))
          await new Promise<void>((resolve) => {
            reply.raw.once("drain", resolve);
            reply.raw.once("close", resolve);
          });
      }
    }
  } catch {
    if (!closed) reply.raw.end();
  } finally {
    clearInterval(keepAlive);
    await redis.zrem(streamKey, req.id).catch(() => {});
    reader.disconnect();
  }
});
app.get("/v1/challenges", async () => ({
  items: (
    await pool.query(
      "SELECT id,slug,title,difficulty,description FROM challenges WHERE visibility='public' ORDER BY title LIMIT 100",
    )
  ).rows,
}));
app.get("/v1/challenges/:slug", async (req) => {
  const slug = z
    .string()
    .max(100)
    .parse((req.params as any).slug);
  const c = (
    await pool.query(
      "SELECT id,slug,title,description,difficulty FROM challenges WHERE slug=$1 AND visibility='public'",
      [slug],
    )
  ).rows[0];
  if (!c)
    throw Object.assign(new Error("Challenge not found"), { statusCode: 404 });
  return {
    ...c,
    samples: (
      await pool.query(
        "SELECT stdin,expected FROM challenge_test_cases WHERE challenge_id=$1 AND NOT hidden ORDER BY position",
        [c.id],
      )
    ).rows,
  };
});
app.put("/v1/drafts/:id", async (req) => {
  const a = await actor(req);
  if (!a.userId)
    throw Object.assign(new Error("User session required"), {
      statusCode: 403,
    });
  const b = z
    .object({ runtimeId: z.string().max(64), source: z.string().max(65536) })
    .parse(req.body);
  const id = z
    .string()
    .uuid()
    .parse((req.params as any).id);
  if (
    !(
      await pool.query(
        "SELECT 1 FROM challenges WHERE id=$1 AND visibility='public'",
        [id],
      )
    ).rowCount
  )
    throw Object.assign(new Error("Challenge not found"), { statusCode: 404 });
  await pool.query(
    "INSERT INTO drafts VALUES($1,$2,$3,$4,now()) ON CONFLICT(user_id,challenge_id,runtime_id) DO UPDATE SET source=excluded.source,updated_at=now()",
    [a.userId, id, b.runtimeId, b.source],
  );
  return { ok: true };
});
app.get("/v1/drafts/:id", async (req) => {
  const a = await actor(req);
  return {
    items: (
      await pool.query(
        "SELECT runtime_id,source FROM drafts WHERE user_id=$1 AND challenge_id=$2",
        [
          a.userId,
          z
            .string()
            .uuid()
            .parse((req.params as any).id),
        ],
      )
    ).rows,
  };
});
app.post("/v1/api-keys", async (req, reply) => {
  const b = z
    .object({
      projectId: z.string().uuid(),
      name: z.string().min(1).max(80),
      scopes: z
        .array(
          z.enum([
            "submissions:create",
            "submissions:read",
            "challenges:read",
            "challenges:write",
            "analytics:read",
            "workers:read",
          ]),
        )
        .min(1),
      expiresAt: z.string().datetime().optional(),
    })
    .parse(req.body);
  const a = await actor(req);
  await authorize(a, b.projectId, "submissions:write", true);
  const secret = "ca_live_" + randomBytes(32).toString("base64url");
  const id = await tx(async (c) => {
    const row = await c.query(
      "INSERT INTO api_keys(project_id,name,prefix,secret_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
      [
        b.projectId,
        b.name,
        secret.slice(0, 16),
        hash(secret),
        b.scopes,
        b.expiresAt || null,
      ],
    );
    await audit(c, "api_key.create", a.userId!, row.rows[0].id);
    return row.rows[0].id;
  });
  reply.code(201);
  return { id, secret };
});
app.get("/v1/api-keys", async (req) => {
  const { projectId } = z
    .object({ projectId: z.string().uuid() })
    .parse(req.query);
  await authorize(await actor(req), projectId, "submissions:read", true);
  return {
    items: (
      await pool.query(
        "SELECT id,name,prefix,scopes,last_used_at,expires_at,revoked_at FROM api_keys WHERE project_id=$1",
        [projectId],
      )
    ).rows,
  };
});
app.delete("/v1/api-keys/:id", async (req) => {
  const a = await actor(req),
    id = z
      .string()
      .uuid()
      .parse((req.params as any).id),
    k = (await pool.query("SELECT project_id FROM api_keys WHERE id=$1", [id]))
      .rows[0];
  if (!k) throw Object.assign(new Error("Not found"), { statusCode: 404 });
  await authorize(a, k.project_id, "submissions:write", true);
  await tx(async (c) => {
    await c.query("UPDATE api_keys SET revoked_at=now() WHERE id=$1", [id]);
    await audit(c, "api_key.revoke", a.userId!, id);
  });
  return { ok: true };
});
app.get("/v1/usage", async (req) => {
  const { projectId } = z
    .object({ projectId: z.string().uuid() })
    .parse(req.query);
  await authorize(await actor(req), projectId, "analytics:read");
  return {
    items: (
      await pool.query(
        "SELECT date_trunc('day',created_at) AS day,count(*)::int AS executions,sum(cpu_ms)::bigint AS cpu_ms,sum(wall_ms)::bigint AS wall_ms FROM usage_records WHERE project_id=$1 AND created_at>now()-interval '30 days' GROUP BY 1 ORDER BY 1",
        [projectId],
      )
    ).rows,
  };
});
app.get("/v1/workers", async (req) => {
  const { projectId } = z
    .object({ projectId: z.string().uuid() })
    .parse(req.query);
  await authorize(await actor(req), projectId, "workers:read", true);
  return {
    items: (
      await pool.query(
        "SELECT w.*,count(DISTINCT s.id)::int AS active,array_agg(DISTINCT wr.runtime_id) AS runtimes FROM workers w LEFT JOIN submissions s ON s.worker_id=w.id AND s.state IN ('scheduled','preparing','compiling','running','judging') LEFT JOIN worker_runtimes wr ON wr.worker_id=w.id GROUP BY w.id",
      )
    ).rows,
  };
});
app.get("/v1/queue", async (req) => {
  const { projectId } = z
    .object({ projectId: z.string().uuid() })
    .parse(req.query);
  await authorize(await actor(req), projectId, "analytics:read", true);
  return {
    items: (
      await pool.query(
        "SELECT state,count(*)::int AS count FROM submissions WHERE project_id=$1 GROUP BY state",
        [projectId],
      )
    ).rows,
  };
});

app.post("/v1/webhooks", async (req, reply) => {
  const b = z
    .object({ projectId: z.string().uuid(), url: z.string().url() })
    .parse(req.body);
  const a = await actor(req);
  await authorize(a, b.projectId, "submissions:write", true);
  allowedUrl(b.url);
  const secret = randomBytes(32).toString("base64url");
  const id = await tx(async (c) => {
    const row = await c.query(
      "INSERT INTO webhook_endpoints(project_id,url,secret) VALUES($1,$2,$3) RETURNING id",
      [b.projectId, b.url, encryptSecret(secret)],
    );
    await audit(c, "webhook.create", a.userId!, row.rows[0].id);
    return row.rows[0].id;
  });
  reply.code(201);
  return { id, secret };
});
app.get("/v1/webhooks", async (req) => {
  const { projectId } = z
    .object({ projectId: z.string().uuid() })
    .parse(req.query);
  await authorize(await actor(req), projectId, "submissions:read", true);
  return {
    items: (
      await pool.query(
        "SELECT id,url,enabled,created_at FROM webhook_endpoints WHERE project_id=$1",
        [projectId],
      )
    ).rows,
  };
});
app.get("/v1/webhooks/:id/deliveries", async (req) => {
  const id = z
    .string()
    .uuid()
    .parse((req.params as any).id);
  const endpoint = (
    await pool.query("SELECT project_id FROM webhook_endpoints WHERE id=$1", [
      id,
    ])
  ).rows[0];
  if (!endpoint)
    throw Object.assign(new Error("Not found"), { statusCode: 404 });
  await authorize(
    await actor(req),
    endpoint.project_id,
    "submissions:read",
    true,
  );
  return {
    items: (
      await pool.query(
        "SELECT id,event,attempts,status,response_code,next_attempt_at FROM webhook_deliveries WHERE endpoint_id=$1 ORDER BY next_attempt_at DESC LIMIT 50",
        [id],
      )
    ).rows,
  };
});
app.post("/v1/webhook-deliveries/:id/redeliver", async (req) => {
  const id = z
      .string()
      .uuid()
      .parse((req.params as any).id),
    a = await actor(req);
  const d = (
    await pool.query(
      "SELECT e.project_id FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1",
      [id],
    )
  ).rows[0];
  if (!d) throw Object.assign(new Error("Not found"), { statusCode: 404 });
  await authorize(a, d.project_id, "submissions:write", true);
  await tx(async (c) => {
    await c.query(
      "UPDATE webhook_deliveries SET attempts=0,status='pending',next_attempt_at=now() WHERE id=$1 AND status<>'delivering'",
      [id],
    );
    await audit(c, "webhook.redeliver", a.userId!, id);
  });
  return { ok: true };
});

app.post("/v1/workers/:id/drain", async (req) => {
  const a = await actor(req);
  const operators = (process.env.PLATFORM_ADMIN_IDS || "").split(",");
  if (!a.userId || !operators.includes(a.userId))
    throw Object.assign(new Error("Platform administrator required"), {
      statusCode: 403,
    });
  const id = z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .parse((req.params as any).id);
  await tx(async (c) => {
    await c.query("UPDATE workers SET status='draining' WHERE id=$1", [id]);
    await audit(c, "worker.drain", a.userId!, id);
  });
  return { ok: true };
});

if (process.env.NODE_ENV !== "test")
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    void app.close().then(() => Promise.all([pool.end(), redis.quit()]));
  });
