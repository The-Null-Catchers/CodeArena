import { beforeAll, afterAll, describe, it, expect } from "vitest";
import pg from "pg";
import { limitedFetch } from "./http.js";
const base = process.env.API_URL || "http://localhost:4000";
const db = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://codearena:development-db-password@localhost:5432/codearena",
});
let token = "",
  project = "",
  challengeId = "",
  submissionId = "";
const slug = `snapshot-${crypto.randomUUID()}`;
async function request(path: string, body?: unknown, access = token) {
  const r = await limitedFetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
const input = () => ({
  projectId: project,
  language: "python",
  version: "3.13",
  source: "print(input())",
  mode: "challenge",
  challengeId,
});
async function result(id: string) {
  // Admission/mutation ordering is controlled by the scheduler advisory lock;
  // completion is observed via the actual SSE endpoint, not a simulated runner.
  const stream = await fetch(base + `/v1/submissions/${id}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(90000),
  });
  expect(stream.ok).toBe(true);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done)
        throw new Error("Execution stream closed before completion");
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
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
beforeAll(async () => {
  const account = await request("/v1/auth/register", {
    email: `judging-${crypto.randomUUID()}@example.com`,
    password: "Judging-integration-123",
  });
  expect(account.status).toBe(201);
  token = account.data.accessToken;
  project = (await request("/v1/projects")).data.items[0].id;
  const challenge = await request("/v1/challenges", {
    projectId: project,
    slug,
    title: "Immutable judging",
    description: "Echo one line.",
    difficulty: "easy",
    visibility: "public",
    judge: "exact",
    languages: ["python"],
    tests: [
      {
        stdin: "example\n",
        expected: "example\n",
        hidden: false,
        weight: 2,
        group: "samples",
      },
      {
        stdin: "private-snapshot-input\n",
        expected: "private-snapshot-input\n",
        hidden: true,
        weight: 3,
        group: "private",
        wallTimeMs: 1000,
        memoryMb: 64,
      },
    ],
  });
  expect(challenge.status).toBe(201);
  challengeId = challenge.data.id;
});
afterAll(async () => {
  await db.end();
});
describe("immutable judging admission through the real execution stack", () => {
  it("advertises and enforces challenge language restrictions server-side", async () => {
    expect((await request(`/v1/challenges/${slug}`)).data.languages).toEqual([
      "python",
    ]);
    expect(
      (
        await request("/v1/submissions", {
          ...input(),
          language: "javascript",
          version: "22",
          source: "console.log('example')",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await db.query("SELECT id FROM submissions WHERE challenge_id=$1", [
          challengeId,
        ])
      ).rows,
    ).toHaveLength(0);
  });
  it("keeps admitted tests and judge after originals are changed and deleted", async () => {
    const lock = await db.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(908302)");
      const admitted = await request("/v1/submissions", input());
      expect(admitted.status).toBe(202);
      submissionId = admitted.data.id;
      const snapshot = (await request(`/v1/submissions/${submissionId}`)).data;
      expect(snapshot.submission.state).toBe("queued");
      expect(snapshot.submission.test_snapshot_origin).toBe("admission");
      expect(snapshot.submission.test_snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshot.submission.judge_strategy).toBe("exact");
      await db.query("UPDATE challenges SET judge='float' WHERE id=$1", [
        challengeId,
      ]);
      await db.query("DELETE FROM challenge_test_cases WHERE challenge_id=$1", [
        challengeId,
      ]);
      await db.query(
        "INSERT INTO challenge_test_cases(challenge_id,position,stdin,expected,hidden,weight) VALUES($1,0,'replacement','999',false,20)",
        [challengeId],
      );
    } finally {
      await lock.query("SELECT pg_advisory_unlock(908302)");
      lock.release();
    }
    const final = await result(submissionId);
    expect(final.submission.state).toBe("completed");
    expect(final.result.verdict).toBe("accepted");
    expect(final.result.score).toBe(100);
    expect(final.tests).toHaveLength(2);
    expect(final.tests.map((test: any) => test.hidden)).toEqual([false, true]);
    expect(final.tests.map((test: any) => test.weight)).toEqual([2, 3]);
    expect(final.result.stdout).toBe("");
    expect(final.result.stderr).toBe("");
    expect(JSON.stringify(final)).not.toContain("private-snapshot-input");
  });
  it("rejects edits, deletions, late insertion and judge replacement on a captured snapshot", async () => {
    const snapshot = (
      await db.query(
        "SELECT * FROM submission_test_cases WHERE submission_id=$1 LIMIT 1",
        [submissionId],
      )
    ).rows[0];
    await expect(
      db.query(
        "UPDATE submission_test_cases SET expected='tampered' WHERE submission_id=$1",
        [submissionId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      db.query("DELETE FROM submission_test_cases WHERE submission_id=$1", [
        submissionId,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      db.query(
        "INSERT INTO submission_test_cases(submission_id,test_case_id,position,stdin,expected,hidden,weight) VALUES($1,gen_random_uuid(),99,'','',true,1)",
        [submissionId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      db.query("UPDATE submissions SET judge_strategy='float' WHERE id=$1", [
        submissionId,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    expect(snapshot.expected).not.toBe("tampered");
  });
  it("captures the changed challenge for later admissions", async () => {
    const admitted = await request("/v1/submissions", input());
    expect(admitted.status).toBe(202);
    const final = await result(admitted.data.id);
    expect(final.result.verdict).toBe("wrong_answer");
    expect(final.tests).toHaveLength(1);
    expect(final.submission.judge_strategy).toBe("float");
    const previous = (await request(`/v1/submissions/${submissionId}`)).data;
    expect(final.submission.test_snapshot_hash).not.toBe(
      previous.submission.test_snapshot_hash,
    );
    expect(previous.result.verdict).toBe("accepted");
  });
});
