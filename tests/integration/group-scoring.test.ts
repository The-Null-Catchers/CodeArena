import { beforeAll, describe, expect, it } from "vitest";
import { limitedFetch } from "./http.js";

const base = process.env.API_URL || "http://localhost:4000";
let token = "";
let projectId = "";

async function request(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const response = await limitedFetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function wait(id: string) {
  const response = await fetch(`${base}/v1/submissions/${id}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(90000),
  });
  expect(response.ok).toBe(true);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) throw new Error("Unexpected SSE end");
      pending += decoder.decode(next.value, { stream: true });
      let end = -1;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (frame.startsWith(":")) continue;
        const line = frame.split("\n").find((value) => value.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (["completed", "failed", "cancelled", "timed_out"].includes(event.state))
          return (await request(`/v1/submissions/${id}`)).body;
      }
    }
  } finally {
    await reader.cancel();
  }
}

beforeAll(async () => {
  const registered = await request("/v1/auth/register", {
    email: `group-scoring-${crypto.randomUUID()}@example.com`,
    password: "Integration-password-123",
  });
  expect(registered.status).toBe(201);
  token = registered.body.accessToken;
  projectId = (await request("/v1/projects")).body.items[0].id;
});

describe("immutable grouped challenge scoring", () => {
  it("awards a group only when every test in the group passes", async () => {
    const slug = `group-score-${crypto.randomUUID()}`;
    const created = await request("/v1/challenges", {
      projectId,
      title: "Grouped score evidence",
      slug,
      description: "Integration coverage for all-or-nothing groups",
      difficulty: "medium",
      visibility: "private",
      languages: ["python"],
      judge: "exact",
      tests: [
        { stdin: "a\n", expected: "a\n", hidden: true, weight: 2, group: "core" },
        { stdin: "b\n", expected: "wrong\n", hidden: true, weight: 3, group: "core" },
        { stdin: "c\n", expected: "c\n", hidden: true, weight: 5 },
      ],
    });
    expect(created.status).toBe(201);

    const submitted = await request("/v1/submissions", {
      projectId,
      language: "python",
      version: "3.13",
      mode: "challenge",
      challengeId: created.body.id,
      source: "import sys\nprint(sys.stdin.read().strip())",
    });
    expect(submitted.status).toBe(202);

    const result = await wait(submitted.body.id);
    expect(result.submission.scoring_strategy).toBe("group-all-or-nothing-v1");
    expect(result.tests.map((test: any) => test.verdict)).toEqual([
      "accepted",
      "wrong_answer",
      "accepted",
    ]);
    expect(Number(result.result.score)).toBe(50);
  });

  it("keeps ordinary ungrouped challenges on weighted-v1", async () => {
    const slug = `weighted-score-${crypto.randomUUID()}`;
    const created = await request("/v1/challenges", {
      projectId,
      title: "Weighted score evidence",
      slug,
      description: "Legacy weighted scoring remains explicit",
      difficulty: "easy",
      visibility: "private",
      languages: ["python"],
      judge: "exact",
      tests: [
        { stdin: "a\n", expected: "a\n", hidden: true, weight: 2 },
        { stdin: "b\n", expected: "wrong\n", hidden: true, weight: 3 },
        { stdin: "c\n", expected: "c\n", hidden: true, weight: 5 },
      ],
    });
    expect(created.status).toBe(201);

    const submitted = await request("/v1/submissions", {
      projectId,
      language: "python",
      version: "3.13",
      mode: "challenge",
      challengeId: created.body.id,
      source: "import sys\nprint(sys.stdin.read().strip())",
    });
    expect(submitted.status).toBe(202);

    const result = await wait(submitted.body.id);
    expect(result.submission.scoring_strategy).toBe("weighted-v1");
    expect(Number(result.result.score)).toBe(70);
  });
});
