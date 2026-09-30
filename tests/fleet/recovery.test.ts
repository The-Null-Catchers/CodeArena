import { beforeAll, afterAll, describe, it, expect } from "vitest";
import pg from "pg";
import Docker from "dockerode";
import { limitedFetch } from "../integration/http.js";
import { transition } from "../../packages/shared/src/events.js";
import { redis } from "../../packages/shared/src/events.js";
const base = process.env.API_URL || "http://localhost:4000";
const db = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://codearena:development-db-password@localhost:5432/codearena",
});
const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
});
let token = "",
  project = "";
async function request(path: string, body?: unknown) {
  const response = await limitedFetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  expect(response.ok, `${response.status} ${path}`).toBe(true);
  return response.json();
}
async function until<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  timeout = 90000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Fleet condition did not become true before deadline");
}
async function submission(id: string) {
  return (await db.query("SELECT * FROM submissions WHERE id=$1", [id]))
    .rows[0];
}
async function create(source: string) {
  return (
    await request("/v1/submissions", {
      projectId: project,
      language: "python",
      version: "3.13",
      source,
      limits: { wallTimeMs: 15000 },
    })
  ).id as string;
}
beforeAll(async () => {
  const account = await request("/v1/auth/register", {
    email: `fleet-${crypto.randomUUID()}@example.com`,
    password: "Fleet-qualification-123",
  });
  token = account.accessToken;
  project = (await request("/v1/projects")).items[0].id;
  await until(
    async () =>
      (
        await db.query(
          "SELECT id FROM workers WHERE status='online' AND last_heartbeat>now()-interval '15 seconds'",
        )
      ).rows,
    (workers) => workers.length === 2,
  );
});
afterAll(async () => {
  await db.end();
  await redis.quit();
});
describe("two live workers with real failure injection", () => {
  it("finalizes and cancels during Redis loss, then dispatches its durable outbox without restarting workers", async () => {
    const ids = await Promise.all(
      Array.from({ length: 3 }, () =>
        create("import time\ntime.sleep(8)\nprint('redis-recovered')"),
      ),
    );
    const running = await until(
      async () =>
        (
          await db.query(
            "SELECT id,worker_id FROM submissions WHERE id=ANY($1::uuid[]) AND state='running'",
            [ids],
          )
        ).rows,
      (rows) => rows.length === 2,
    );
    const pendingId = ids.find((id) => !running.some((row) => row.id === id))!;
    const findService = async (service: string) => {
      const containers = await docker.listContainers({
        filters: JSON.stringify({
          label: [
            "com.docker.compose.project=codearena",
            `com.docker.compose.service=${service}`,
          ],
        }),
      });
      expect(containers).toHaveLength(1);
      return docker.getContainer(containers[0].Id);
    };
    const broker = await findService("redis");
    const workers = await Promise.all([
      findService("worker"),
      findService("worker-02"),
    ]);
    const before = await Promise.all(workers.map((worker) => worker.inspect()));
    try {
      await broker.stop({ t: 2 });
      const readiness = await fetch(base + "/health/ready", {
        signal: AbortSignal.timeout(5000),
      });
      expect(readiness.status).toBe(503);
      // PostgreSQL is authoritative for cancellation; Redis is only a notification hint.
      await db.query(
        "UPDATE submissions SET cancel_requested=true WHERE id=$1",
        [running[0].id],
      );
      await until(
        () => submission(running[0].id),
        (row) => row.state === "cancelled",
        20000,
      );
      await until(
        () => submission(running[1].id),
        (row) => row.state === "completed",
        20000,
      );
      expect(
        (
          await db.query(
            "SELECT verdict,stdout FROM submission_results WHERE submission_id=$1",
            [running[1].id],
          )
        ).rows,
      ).toEqual([{ verdict: "accepted", stdout: "redis-recovered\n" }]);
      await until(
        async () =>
          (
            await db.query(
              "SELECT * FROM dispatch_outbox WHERE submission_id=$1",
              [pendingId],
            )
          ).rows,
        (rows) => rows.length === 1,
        10000,
      );
      expect((await submission(pendingId)).state).toBe("scheduled");
      expect(
        (
          await db.query(
            "SELECT id FROM workers WHERE status='online' AND last_heartbeat>now()-interval '6 seconds'",
          )
        ).rows,
      ).toHaveLength(2);
    } finally {
      await broker.start();
    }
    await until(
      async () => {
        try {
          return (
            await fetch(base + "/health/ready", {
              signal: AbortSignal.timeout(5000),
            })
          ).status;
        } catch {
          return 0;
        }
      },
      (status) => status === 200,
    );
    await until(
      () => submission(pendingId),
      (row) => row.state === "completed",
    );
    const after = await Promise.all(workers.map((worker) => worker.inspect()));
    for (let i = 0; i < before.length; i++) {
      expect(after[i].State.StartedAt).toBe(before[i].State.StartedAt);
      expect(after[i].RestartCount).toBe(before[i].RestartCount);
    }
    expect(
      (
        await db.query(
          "SELECT state FROM submission_events WHERE submission_id=$1 AND state='completed'",
          [pendingId],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT * FROM dispatch_outbox WHERE submission_id=ANY($1::uuid[])",
          [ids],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await db.query(
          "SELECT submission_id FROM usage_records WHERE submission_id=ANY($1::uuid[])",
          [ids],
        )
      ).rows,
    ).toHaveLength(3);
    await until(
      () =>
        docker.listContainers({
          all: true,
          filters: JSON.stringify({
            label: ["codearena.managed=true"],
          }),
        }),
      (items) => items.length === 0,
    );
  });
  it("reserves only available slots and executes across both identities", async () => {
    const ids = await Promise.all(
      Array.from({ length: 4 }, () =>
        create("import time\ntime.sleep(3)\nprint('fleet')"),
      ),
    );
    try {
      const active = await until(
        async () =>
          (
            await db.query(
              "SELECT worker_id,count(*)::int AS jobs FROM submissions WHERE id=ANY($1::uuid[]) AND state IN ('scheduled','preparing','compiling','running','judging') GROUP BY worker_id",
              [ids],
            )
          ).rows,
        (rows) => rows.length === 2,
      );
      expect(active.every((row) => row.jobs === 1)).toBe(true);
      await until(
        async () =>
          (
            await db.query(
              "SELECT state FROM submissions WHERE id=ANY($1::uuid[])",
              [ids],
            )
          ).rows,
        (rows) => rows.every((row) => row.state === "completed"),
      );
      const results = (
        await db.query(
          "SELECT s.worker_id,r.verdict,r.stdout FROM submissions s JOIN submission_results r ON r.submission_id=s.id WHERE s.id=ANY($1::uuid[])",
          [ids],
        )
      ).rows;
      expect(new Set(results.map((row) => row.worker_id)).size).toBe(2);
      expect(
        results.every(
          (row) => row.verdict === "accepted" && row.stdout === "fleet\n",
        ),
      ).toBe(true);
    } finally {
      for (const id of ids) await request(`/v1/submissions/${id}/cancel`, {});
    }
  });
  it("recovers an interrupted attempt, fences stale writes, and cleans abandoned containers", async () => {
    const id = await create("import time\ntime.sleep(3)\nprint('recovered')");
    const original = await until(
      () => submission(id),
      (row) => row.state === "running",
    );
    const service = original.worker_id === "worker-01" ? "worker" : "worker-02";
    const containers = await docker.listContainers({
      filters: JSON.stringify({
        label: [
          "com.docker.compose.project=codearena",
          `com.docker.compose.service=${service}`,
        ],
      }),
    });
    expect(containers).toHaveLength(1);
    const worker = docker.getContainer(containers[0].Id);
    try {
      // Docker kill bypasses the worker's shutdown handler, exactly like abrupt process loss.
      await worker.update({ RestartPolicy: { Name: "no" } });
      await worker.kill({ signal: "SIGKILL" });
      const recovered = await until(
        () => submission(id),
        (row) => row.state === "running" && row.attempt > original.attempt,
      );
      expect(recovered.worker_id).not.toBe(original.worker_id);
      expect(
        (
          await db.query("SELECT status FROM workers WHERE id=$1", [
            original.worker_id,
          ])
        ).rows[0].status,
      ).toBe("offline");
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        expect(
          await transition(
            client,
            id,
            "failed",
            "Stale attempt regression",
            original.worker_id,
            original.attempt,
          ),
        ).toBe(false);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      await until(
        () => submission(id),
        (row) => row.state === "completed",
      );
      expect(
        (
          await db.query(
            "SELECT verdict,stdout FROM submission_results WHERE submission_id=$1",
            [id],
          )
        ).rows,
      ).toEqual([{ verdict: "accepted", stdout: "recovered\n" }]);
      const events = (
        await db.query(
          "SELECT state,reason FROM submission_events WHERE submission_id=$1",
          [id],
        )
      ).rows;
      expect(
        events.some(
          (e) => e.state === "queued" && e.reason.includes("interrupted"),
        ),
      ).toBe(true);
      expect(events.filter((e) => e.state === "completed")).toHaveLength(1);
    } finally {
      await worker.update({ RestartPolicy: { Name: "unless-stopped" } });
      await worker.start();
      await until(
        async () =>
          (
            await db.query("SELECT status FROM workers WHERE id=$1", [
              original.worker_id,
            ])
          ).rows[0],
        (row) => row?.status === "online",
      );
      await request(`/v1/submissions/${id}/cancel`, {});
    }
    await until(
      () =>
        docker.listContainers({
          all: true,
          filters: JSON.stringify({
            label: ["codearena.managed=true", `codearena.submission=${id}`],
          }),
        }),
      (items) => items.length === 0,
    );
  });
});
