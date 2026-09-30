import { beforeAll, describe, it, expect } from "vitest";
const base = process.env.API_URL || "http://localhost:4000";
let access = "",
  project = "",
  otherAccess = "",
  refresh = "";
async function call(
  path: string,
  body?: unknown,
  token = access,
  method = body ? "POST" : "GET",
) {
  const response = await fetch(base + path, {
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
  project = (await call("/v1/projects")).body.items[0].id;
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
    const results = await Promise.all(
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
    for (const r of results.filter((r) => r.status === 202))
      await call(`/v1/submissions/${r.body.id}/cancel`, {});
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
