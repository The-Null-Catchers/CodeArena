import { beforeAll, describe, it, expect } from "vitest";
const base = process.env.API_URL || "http://localhost:4000";
let token = "",
  project = "";
async function request(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
beforeAll(async () => {
  const email = `integration-${crypto.randomUUID()}@example.com`;
  const r = await request("/v1/auth/register", {
    email,
    password: "Integration-password-123",
  });
  expect(r.status).toBe(201);
  token = r.data.accessToken;
  project = (await request("/v1/projects")).data.items[0].id;
});
async function submit(source: string, extra: Record<string, unknown> = {}) {
  const r = await request("/v1/submissions", {
    projectId: project,
    language: "python",
    version: "3.13",
    source,
    stdin: "arena",
    ...extra,
  });
  expect(r.status).toBe(202);
  return r.data.id;
}
async function wait(id: string) {
  const response = await fetch(`${base}/v1/submissions/${id}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(90000),
  });
  expect(response.ok).toBe(true);
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) throw new Error("Unexpected end");
      pending += decoder.decode(r.value, { stream: true });
      let end;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (frame.startsWith(":")) continue;
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (
          data &&
          ["completed", "failed", "cancelled", "timed_out"].includes(
            JSON.parse(data.slice(6)).state,
          )
        )
          return (await request(`/v1/submissions/${id}`)).data;
      }
    }
  } finally {
    await reader.cancel();
  }
}
describe("full API → scheduler → Docker flow", () => {
  it("returns real stdin/stdout and a persisted timeline", async () => {
    const r = await wait(await submit("print(input())"));
    expect(r.result.stdout).toBe("arena\n");
    expect(r.events.map((e: any) => e.state)).toEqual(
      expect.arrayContaining([
        "created",
        "queued",
        "scheduled",
        "preparing",
        "running",
        "completed",
      ]),
    );
  });
  it("enforces execution timeout", async () => {
    const r = await wait(
      await submit("while True:pass", {
        limits: { wallTimeMs: 500, cpuTimeMs: 300 },
      }),
    );
    expect(r.submission.state).toBe("timed_out");
  });
  it("cancels queued or running execution idempotently", async () => {
    const id = await submit("while True:pass");
    await request(`/v1/submissions/${id}/cancel`, {});
    await request(`/v1/submissions/${id}/cancel`, {});
    expect((await wait(id)).submission.state).toBe("cancelled");
  });
  it("does not disclose hidden input/output through final results or SSE", async () => {
    const c = (await request("/v1/challenges/reverse-string")).data;
    expect(c.samples).toHaveLength(1);
    const id = await submit("import sys\nprint(sys.stdin.read())", {
      mode: "challenge",
      challengeId: c.id,
    });
    const r = await wait(id);
    expect(r.tests).toHaveLength(2);
    expect(r.result.stdout).toBe("");
    expect(r.result.stderr).toBe("");
    expect(JSON.stringify(r)).not.toContain("sandbox");
    expect(r.tests.some((t: any) => t.hidden)).toBe(true);
  });
  it("enforces API key scope and project ownership", async () => {
    const k = (
      await request("/v1/api-keys", {
        projectId: project,
        name: "Read-only",
        scopes: ["submissions:read"],
      })
    ).data;
    const old = token;
    try {
      token = k.secret;
      expect(
        (
          await request("/v1/submissions", {
            projectId: project,
            language: "python",
            version: "3.13",
            source: "print(1)",
          })
        ).status,
      ).toBe(403);
    } finally {
      token = old;
    }
  });
  it("rejects requests exceeding hard limits", async () =>
    expect(
      (
        await request("/v1/submissions", {
          projectId: project,
          language: "python",
          version: "3.13",
          source: "print(1)",
          limits: { memoryMb: 99999 },
        })
      ).status,
    ).toBe(400));
});
