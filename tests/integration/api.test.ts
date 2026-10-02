import { limitedFetch } from "./http.js";
import { beforeAll, describe, it, expect } from "vitest";
import pg from "pg";
const base = process.env.API_URL || "http://localhost:4000";
let access = "",
  project = "",
  organization = "",
  otherAccess = "",
  refresh = "";
async function call(
  path: string,
  body?: unknown,
  token = access,
  method = body ? "POST" : "GET",
  retry429 = true,
) {
  const request = {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const response = retry429
    ? await limitedFetch(base + path, request)
    : await fetch(base + path, request);

    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  const r = await call("/v1/auth/register", {
    email: `api-${crypto.randomUUID()}@example.com`,
    password: "Real-transaction-test-123",
  });
  expect(r.status).toBe(201);
  access = r.body.accessToken;
  refresh = r.body.refreshToken;
  const defaultProject = (await call("/v1/projects")).body.items[0];
  project = defaultProject.id;
  organization = defaultProject.organization_id;
  const other = await call("/v1/auth/register", {
    email: `tenant-${crypto.randomUUID()}@example.com`,
    password: "Real-transaction-test-123",
  });
  otherAccess = other.body.accessToken;
});
const input = { language: "python", version: "3.13", source: "print(1)" };
describe("real PostgreSQL + Redis API boundaries", () => {
  it("rejects anonymous submission creation", async () =>
    expect(
      (await call("/v1/submissions", { ...input, projectId: project }, ""))
        .status,
    ).toBe(401));
  it("does not authorize another organization", async () =>
    expect(
      (
        await call(
          "/v1/submissions",
          { ...input, projectId: project },
          otherAccess,
        )
      ).status,
    ).toBe(403));
  it("reserves quota atomically under concurrent creation", async () => {
    const db = new pg.Pool({
      connectionString:
        process.env.DATABASE_URL ||
        "postgresql://codearena:development-db-password@localhost:5432/codearena",
    });
    const lock = await db.connect();
    let results: { status: number; body: any }[] = [];
    try {
      // Keep every admitted job outstanding. Global IP throttling can delay
      // requests long enough for live executions to finish and free real quota.
      await lock.query("SELECT pg_advisory_lock(908302)");
      results = await Promise.all(
        Array.from({ length: 24 }, () =>
          call("/v1/submissions", {
            ...input,
            source: "while True: pass",
            limits: { wallTimeMs: 15000 },
            projectId: project,
          }),
        ),
      );
      expect(results.filter((r) => r.status === 202)).toHaveLength(20);
      expect(results.filter((r) => r.status === 429)).toHaveLength(4);
    } finally {
      try {
        for (const r of results.filter((r) => r.status === 202))
          await call(`/v1/submissions/${r.body.id}/cancel`, {});
      } finally {
        await lock.query("SELECT pg_advisory_unlock(908302)");
        lock.release();
        await db.end();
      }
    }
  });
  it("enforces per-user and per-project submission budgets", async () => {
    const email = `budget-${crypto.randomUUID()}@example.com`;
    const registered = await call("/v1/auth/register", {
      email,
      password: "Real-transaction-test-123",
    });
    expect(registered.status).toBe(201);
    const token = registered.body.accessToken;
    const budgetProject = (await call("/v1/projects", undefined, token)).body
      .items[0].id;
    const db = new pg.Pool({
      connectionString:
        process.env.DATABASE_URL ||
        "postgresql://codearena:development-db-password@localhost:5432/codearena",
    });
    const admitted: any[] = [];
    try {
      await db.query(
        "UPDATE users SET submissions_per_minute=2 WHERE email=$1",
        [email],
      );
      expect(
        (
          await call(
            `/v1/projects/${budgetProject}/limits`,
            { submissionsPerMinute: 100 },
            token,
            "PATCH",
          )
        ).status,
      ).toBe(200);
      for (let i = 0; i < 3; i += 1)
        admitted.push(
          await call(
            "/v1/submissions",
            { ...input, projectId: budgetProject },
            token,
            "POST",
            false,
          ),
        );
      expect(admitted.map((r) => r.status)).toEqual([202, 202, 429]);
      expect(Number(admitted[2].retryAfter)).toBeGreaterThan(0);
    } finally {
      for (const r of admitted.filter((item) => item.status === 202))
        await call(
          `/v1/submissions/${r.body.id}/cancel`,
          {},
          token,
        );
      await db.end();
    }
  });

  it("enforces API-key-specific admission budgets", async () => {
    const key = (
      await call("/v1/api-keys", {
        projectId: project,
        name: "Rate limited executor",
        scopes: ["submissions:create", "submissions:read"],
        submissionsPerMinute: 1,
      })
    ).body;
    let first: any;
    try {
      first = await call(
        "/v1/submissions",
        { ...input, projectId: project },
        key.secret,
      );
      const second = await call(
        "/v1/submissions",
        { ...input, projectId: project },
        key.secret,
        "POST",
        false,
      );
      expect(first.status).toBe(202);
      expect(second.status).toBe(429);
      expect(Number(second.retryAfter)).toBeGreaterThan(0);
    } finally {
      if (first?.status === 202)
        await call(`/v1/submissions/${first.body.id}/cancel`, {});
      await call(`/v1/api-keys/${key.id}`, undefined, access, "DELETE");
    }
  });

  it("keeps excess tenant executions queued at the concurrency cap", async () => {
    const created = await call("/v1/projects", {
      organizationId: organization,
      name: `Concurrency ${crypto.randomUUID()}`,
    });
    expect(created.status).toBe(201);
    const cappedProject = created.body.id;
    const db = new pg.Pool({
      connectionString:
        process.env.DATABASE_URL ||
        "postgresql://codearena:development-db-password@localhost:5432/codearena",
    });
    const submissions: any[] = [];
    try {
      expect(
        (
          await call(
            `/v1/projects/${cappedProject}/limits`,
            { maxConcurrent: 1, maxOutstanding: 10 },
            access,
            "PATCH",
          )
        ).status,
      ).toBe(200);
      for (let i = 0; i < 3; i += 1)
        submissions.push(
          await call("/v1/submissions", {
            ...input,
            source: "import time; time.sleep(4); print(1)",
            limits: { wallTimeMs: 6000 },
            projectId: cappedProject,
          }),
        );
      expect(submissions.every((r) => r.status === 202)).toBe(true);

      let observedBound = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const states = (
          await db.query(
            "SELECT state,count(*)::int AS count FROM submissions WHERE project_id=$1 GROUP BY state",
            [cappedProject],
          )
        ).rows;
        const active = states
          .filter((row) =>
            ["scheduled", "preparing", "compiling", "running", "judging"].includes(
              row.state,
            ),
          )
          .reduce((sum, row) => sum + row.count, 0);
        const queued =
          states.find((row) => row.state === "queued")?.count || 0;
        expect(active).toBeLessThanOrEqual(1);
        if (active === 1 && queued >= 1) {
          observedBound = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(observedBound).toBe(true);
    } finally {
      for (const submission of submissions.filter((r) => r.status === 202))
        await call(`/v1/submissions/${submission.body.id}/cancel`, {});
      await db.end();
    }
  });

  it("persists cancellation exactly once", async () => {
    const id = (await call("/v1/submissions", { ...input, projectId: project }))
      .body.id;
    await call(`/v1/submissions/${id}/cancel`, {});
    await call(`/v1/submissions/${id}/cancel`, {});
    const r = (await call(`/v1/submissions/${id}`)).body;
    expect(r.submission.state).toBe("cancelled");
    expect(r.events.filter((e: any) => e.state === "cancelled")).toHaveLength(
      1,
    );
  });
  it("shows an API key secret once, enforces scopes, and revokes it", async () => {
    const k = (
      await call("/v1/api-keys", {
        projectId: project,
        name: "Read only",
        scopes: ["submissions:read"],
      })
    ).body;
    expect(k.secret).toMatch(/^ca_live_/);
    expect(
      (
        await call(
          "/v1/submissions",
          { ...input, projectId: project },
          k.secret,
        )
      ).status,
    ).toBe(403);
    const list = await call(`/v1/api-keys?projectId=${project}`);
    expect(JSON.stringify(list.body)).not.toContain(k.secret);
    await call(`/v1/api-keys/${k.id}`, undefined, access, "DELETE");
    expect(
      (await call(`/v1/submissions?projectId=${project}`, undefined, k.secret))
        .status,
    ).toBe(401);
  });
  it("returns only public sample tests", async () => {
    const r = await call("/v1/challenges/reverse-string");
    expect(r.body.samples).toEqual([{ stdin: "arena\n", expected: "anera\n" }]);
    expect(JSON.stringify(r.body)).not.toContain("sandbox");
  });
  it("validates platform resource maximums", async () =>
    expect(
      (
        await call("/v1/submissions", {
          ...input,
          projectId: project,
          limits: { memoryMb: 513 },
        })
      ).status,
    ).toBe(400));
  it("rotates refresh tokens and rejects reuse", async () => {
    const first = await call("/v1/auth/refresh", { refreshToken: refresh });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(refresh);
    expect(
      (await call("/v1/auth/refresh", { refreshToken: refresh })).status,
    ).toBe(401);
  });
});
