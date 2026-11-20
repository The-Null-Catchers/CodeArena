import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";
import { limitedFetch } from "./http.js";

// All accounts, challenges and source code in this suite are synthetic.
// This test requires the CI Compose API, scheduler and a real Python worker.
const base = process.env.API_URL || "http://localhost:4000";
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgresql://codearena:development-db-password@localhost:5432/codearena",
});
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
let orgId = "";
let projectId = "";
let courseId = "";
let challengeId = "";
let assignmentId = "";
let attemptId = "";
let submissionId = "";

async function issueToken(userId: string) {
  const refreshToken = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')",
    [userId, createHash("sha256").update(refreshToken).digest("hex")],
  );
  const res = await limitedFetch(base + "/v1/auth/refresh", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).accessToken as string;
}

async function request(path: string, role: string, method = "GET", body?: unknown) {
  const res = await limitedFetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${tokens[role]}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

async function awaitCompletion(id: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await request(`/v1/submissions/${id}`, "learner");
    expect(result.status).toBe(200);
    if (["completed", "failed", "cancelled", "timed_out"].includes(result.body.submission.state))
      return result.body;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Real worker did not reach a terminal state within 120 seconds");
}

beforeAll(async () => {
  for (const role of ["owner", "learner", "outsider"]) {
    ids[role] = (await db.query(
      "INSERT INTO users(email,password_hash) VALUES($1,'unused') RETURNING id",
      [`education-live-${role}-${crypto.randomUUID()}@example.com`],
    )).rows[0].id;
  }
  orgId = (await db.query(
    "INSERT INTO organizations(name) VALUES($1) RETURNING id",
    [`Education live worker ${crypto.randomUUID()}`],
  )).rows[0].id;
  for (const role of ["owner", "learner"]) {
    await db.query(
      "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)",
      [orgId, ids[role], role === "owner" ? "owner" : "viewer"],
    );
  }
  projectId = (await db.query(
    "INSERT INTO projects(organization_id,name) VALUES($1,'Education live worker') RETURNING id",
    [orgId],
  )).rows[0].id;
  for (const role of ["owner", "learner", "outsider"])
    tokens[role] = await issueToken(ids[role]);
});

// CI destroys the disposable Compose database after the suite. Do not manually
// delete worker-owned submissions while asynchronous audit/outbox references exist.
afterAll(async () => {
  await db.end();
});

describe("education attempt with a real judging worker", () => {
  it("admits once, preserves the attempt on retry and exposes exactly one private grade", async () => {
    const created = await request("/v1/challenges", "owner", "POST", {
      projectId, slug: `education-live-${crypto.randomUUID()}`,
      title: "Synthetic echo exercise", description: "Echo one line.",
      difficulty: "easy", visibility: "private", judge: "exact",
      languages: ["python"],
      tests: [
        { stdin: "public-fixture\\n", expected: "public-fixture\\n", hidden: false, weight: 1 },
        { stdin: "private-education-input\\n", expected: "private-education-input\\n", hidden: true, weight: 1 },
      ],
    });
    expect(created.status).toBe(201);
    challengeId = created.body.id;

    const course = await request("/v1/education/courses", "owner", "POST", {
      projectId, title: "Synthetic real-worker course",
    });
    expect(course.status).toBe(201);
    courseId = course.body.id;
    const assignment = await request(`/v1/education/courses/${courseId}/assignments`, "owner", "POST", {
      title: "Echo challenge", challengeId, maxAttempts: 1,
    });
    expect(assignment.status).toBe(201);
    assignmentId = assignment.body.id;
    expect((await request(`/v1/education/courses/${courseId}/status`, "owner", "PATCH",
      { status: "published" })).status).toBe(200);
    expect((await request(`/v1/education/courses/${courseId}/assignments/${assignmentId}/status`,
      "owner", "PATCH", { status: "published" })).status).toBe(200);
    expect((await request(`/v1/education/courses/${courseId}/enrollments`, "owner", "POST",
      { userId: ids.learner })).status).toBe(201);

    const attemptsPath = `/v1/education/assignments/${assignmentId}/attempts`;
    const reserved = await request(attemptsPath, "learner", "POST", {});
    expect(reserved.status).toBe(201);
    attemptId = reserved.body.id;
    const payload = {
      projectId, language: "python", version: "3.13",
      source: "print(input())", stdin: "", mode: "challenge", challengeId,
      educationAttemptId: attemptId,
    };
    expect((await request("/v1/submissions", "outsider", "POST", payload)).status)
      .not.toBe(202);
    const admitted = await request("/v1/submissions", "learner", "POST", payload);
    expect(admitted.status).toBe(202);
    submissionId = admitted.body.id;
    expect(submissionId).toMatch(/^[0-9a-f-]{36}$/);

    // A retry after an uncertain HTTP response must not create a second job.
    const duplicate = await request("/v1/submissions", "learner", "POST", payload);
    expect(duplicate.status).toBe(409);
    const finished = await awaitCompletion(submissionId);
    expect(finished.submission.state).toBe("completed");
    expect(finished.result.verdict).toBe("accepted");
    expect(Number(finished.result.score)).toBe(100);
    expect(finished.tests).toHaveLength(2);
    expect(finished.tests.some((t: { hidden: boolean }) => t.hidden)).toBe(true);
    expect(JSON.stringify(finished)).not.toContain("private-education-input");

    const history = await request(attemptsPath, "learner");
    expect(history.status).toBe(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0].id).toBe(attemptId);
    expect(history.body.items[0].submission_id).toBe(submissionId);
    expect(history.body.items[0].verdict).toBe("accepted");
    expect(Number(history.body.items[0].score)).toBe(100);
    expect((await request(attemptsPath, "learner", "POST", {})).status).toBe(409);

    const grades = await request(`/v1/education/assignments/${assignmentId}/grades`, "owner");
    expect(grades.status).toBe(200);
    const grade = grades.body.items.find((row: { user_id: string }) => row.user_id === ids.learner);
    expect(grade).toBeTruthy();
    expect(grade.attempt_count).toBe(1);
    expect(grade.completed_count).toBe(1);
    expect(Number(grade.best_score)).toBe(100);
    expect((await request(`/v1/education/assignments/${assignmentId}/grades`, "learner")).status).toBe(403);

    const linked = await db.query(
      "SELECT count(*)::int AS n FROM submissions WHERE id=$1 AND project_id=$2",
      [submissionId, projectId],
    );
    expect(linked.rows[0].n).toBe(1);
    const attempt = await db.query(
      "SELECT submission_id FROM education_assignment_attempts WHERE id=$1",
      [attemptId],
    );
    expect(attempt.rows[0].submission_id).toBe(submissionId);
    console.log("Education live-worker evidence", {
      revision: process.env.GITHUB_SHA || "local",
      attemptId, submissionId, verdict: finished.result.verdict, score: finished.result.score,
    });
  }, 180_000);
});
