import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { limitedFetch } from "./http.js";

const base = process.env.API_URL || "http://localhost:4000";
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgresql://codearena:development-db-password@localhost:5432/codearena",
});
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
let orgId = "";
let projectId = "";

async function issueToken(userId: string) {
  const refreshToken = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')",
    [userId, createHash("sha256").update(refreshToken).digest("hex")],
  );
  const res = await limitedFetch(base + "/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).accessToken as string;
}

async function request(path: string, token: string, method = "GET", body?: unknown) {
  const res = await limitedFetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  for (const role of ["owner", "learner", "outsider"]) {
    ids[role] = (await db.query(
      "INSERT INTO users(email,password_hash) VALUES($1,'unused') RETURNING id",
      [`education-api-${role}-${crypto.randomUUID()}@example.com`],
    )).rows[0].id;
  }
  orgId = (await db.query(
    "INSERT INTO organizations(name) VALUES($1) RETURNING id",
    [`Education API test ${crypto.randomUUID()}`],
  )).rows[0].id;
  for (const role of ["owner", "learner"]) {
    await db.query(
      "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)",
      [orgId, ids[role], role === "owner" ? "owner" : "viewer"],
    );
  }
  projectId = (await db.query(
    "INSERT INTO projects(organization_id,name) VALUES($1,'Education API project') RETURNING id",
    [orgId],
  )).rows[0].id;
  for (const role of ["owner", "learner", "outsider"])
    tokens[role] = await issueToken(ids[role]);
});

afterAll(async () => {
  const users = Object.values(ids);
  await db.query("DELETE FROM audit_logs WHERE user_id=ANY($1::uuid[])", [users]);
  await db.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [users]);
  if (projectId) await db.query("DELETE FROM projects WHERE id=$1", [projectId]);
  if (orgId) await db.query("DELETE FROM organizations WHERE id=$1", [orgId]);
  await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
  await db.end();
});

describe("education course API authorization", () => {
  it("permits owner creation and limits draft/published course visibility to enrolled learners", async () => {
    const path = `/v1/education/projects/${projectId}/courses`;
    const denied = await request("/v1/education/courses", tokens.learner, "POST", {
      projectId, title: "Learner draft",
    });
    expect(denied.status).toBe(403);
    const created = await request("/v1/education/courses", tokens.owner, "POST", {
      projectId, title: "Introduction to algorithms",
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("draft");
    const courseId = created.body.id as string;
    const ownerList = await request(path, tokens.owner);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.items.some((c: { id: string }) => c.id === courseId)).toBe(true);
    const learnerDraft = await request(path, tokens.learner);
    expect(learnerDraft.status).toBe(200);
    expect(learnerDraft.body.items).toEqual([]);
    const outsider = await request(path, tokens.outsider);
    expect(outsider.status).toBe(403);
    await db.query("UPDATE education_courses SET status='published' WHERE id=$1", [courseId]);
    const learnerNotEnrolled = await request(path, tokens.learner);
    expect(learnerNotEnrolled.body.items).toEqual([]);
    const enrollPath = `/v1/education/courses/${courseId}/enrollments`;
    const deniedEnroll = await request(enrollPath, tokens.learner, "POST", { userId: ids.learner });
    expect(deniedEnroll.status).toBe(403);
    const invalidMember = await request(enrollPath, tokens.owner, "POST", { userId: ids.outsider });
    expect(invalidMember.status).toBe(400);
    const enrolled = await request(enrollPath, tokens.owner, "POST", { userId: ids.learner });
    expect(enrolled.status).toBe(201);
    const duplicate = await request(enrollPath, tokens.owner, "POST", { userId: ids.learner });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.enrolled).toBe(false);
    const learnerEnrolled = await request(path, tokens.learner);
    expect(learnerEnrolled.body.items.map((c: { id: string }) => c.id)).toContain(courseId);
    const deniedRemoval = await request(
      `${enrollPath}/${ids.learner}`, tokens.learner, "DELETE",
    );
    expect(deniedRemoval.status).toBe(403);
    const removed = await request(
      `${enrollPath}/${ids.learner}`, tokens.owner, "DELETE",
    );
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(true);
    const learnerAfterRemoval = await request(path, tokens.learner);
    expect(learnerAfterRemoval.body.items).toEqual([]);
  }, 60_000);
  it("enforces draft assignment visibility, enrolled access, publication and archive rules", async () => {
    const created = await request("/v1/education/courses", tokens.owner, "POST", {
      projectId, title: "Assignment security course",
    });
    expect(created.status).toBe(201);
    const courseId = String(created.body.id);
    const assignments = `/v1/education/courses/${courseId}/assignments`;
    const deniedCreate = await request(assignments, tokens.learner, "POST", {
      title: "Unauthorized assignment",
    });
    expect(deniedCreate.status).toBe(403);
    const draft = await request(assignments, tokens.owner, "POST", {
      title: "Array exercises", instructions: "Solve each problem", maxAttempts: 2,
    });
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("draft");
    expect(draft.body.max_attempts).toBe(2);
    const assignmentId = String(draft.body.id);
    const statusPath = `${assignments}/${assignmentId}/status`;
    const outsider = await request(assignments, tokens.outsider);
    expect(outsider.status).toBe(403);
    const unenrolled = await request(assignments, tokens.learner);
    expect(unenrolled.status).toBe(403);
    await db.query("UPDATE education_courses SET status='published' WHERE id=$1", [courseId]);
    const enrollment = await request(
      `/v1/education/courses/${courseId}/enrollments`,
      tokens.owner, "POST", { userId: ids.learner },
    );
    expect(enrollment.status).toBe(201);
    const learnerDraft = await request(assignments, tokens.learner);
    expect(learnerDraft.status).toBe(200);
    expect(learnerDraft.body.items).toEqual([]);
    const deniedPublish = await request(statusPath, tokens.learner, "PATCH", {
      status: "published",
    });
    expect(deniedPublish.status).toBe(403);
    const published = await request(statusPath, tokens.owner, "PATCH", {
      status: "published",
    });
    expect(published.status).toBe(200);
    expect(published.body.status).toBe("published");
    const learnerPublished = await request(assignments, tokens.learner);
    expect(learnerPublished.status).toBe(200);
    expect(learnerPublished.body.items.map((x: { id: string }) => x.id)).toContain(assignmentId);
    const archived = await request(statusPath, tokens.owner, "PATCH", {
      status: "archived",
    });
    expect(archived.status).toBe(200);
    const learnerArchived = await request(assignments, tokens.learner);
    expect(learnerArchived.body.items).toEqual([]);
    const reopen = await request(statusPath, tokens.owner, "PATCH", {
      status: "published",
    });
    expect(reopen.status).toBe(409);
  }, 60_000);

  it("enforces assignment attempt limits and deadlines", async () => {
    const course = await request("/v1/education/courses", tokens.owner, "POST", {
      projectId, title: "Attempt admission course",
    });
    expect(course.status).toBe(201);
    const courseId = String(course.body.id);
    await db.query("UPDATE education_courses SET status='published' WHERE id=$1", [courseId]);
    const assignment = await request(`/v1/education/courses/${courseId}/assignments`, tokens.owner, "POST", {
      title: "Attempt-limited task", maxAttempts: 2,
    });
    expect(assignment.status).toBe(201);
    const assignmentId = String(assignment.body.id);
    const endpoint = `/v1/education/assignments/${assignmentId}/attempts`;
    expect((await request(endpoint, tokens.learner, "POST", {})).status).toBe(403);
    expect((await request(endpoint, tokens.outsider, "POST", {})).status).toBe(403);
    expect((await request(
      `/v1/education/courses/${courseId}/enrollments`, tokens.owner, "POST", {userId: ids.learner},
    )).status).toBe(201);
    expect((await request(endpoint, tokens.learner, "POST", {})).status).toBe(403);
    expect((await request(
      `/v1/education/courses/${courseId}/assignments/${assignmentId}/status`,
      tokens.owner, "PATCH", {status: "published"},
    )).status).toBe(200);
    const attempts = await Promise.all([
      request(endpoint, tokens.learner, "POST", {}),
      request(endpoint, tokens.learner, "POST", {}),
    ]);
    expect(attempts.map(x => x.status)).toEqual([201, 201]);
    expect(attempts.map(x => x.body.attempt_number).sort()).toEqual([1, 2]);
    expect((await request(endpoint, tokens.learner, "POST", {})).status).toBe(409);
    await db.query("UPDATE education_assignments SET max_attempts=3,due_at=now()-interval '1 minute' WHERE id=$1", [assignmentId]);
    expect((await request(endpoint, tokens.learner, "POST", {})).status).toBe(409);
    const linkPath = `/v1/education/attempts/${attempts[0].body.id}/submission`;
    const invalidLink = await request(linkPath, tokens.learner, "PUT", {
      submissionId: crypto.randomUUID(),
    });
    expect(invalidLink.status).toBe(409);
    expect((await request(linkPath, tokens.outsider, "PUT", {
      submissionId: crypto.randomUUID(),
    })).status).toBe(403);
    const overridePath = `/v1/education/attempts/${attempts[0].body.id}/grade-override`;
    expect((await request(overridePath, tokens.learner, "PUT", {
      score: 95, reason: "Unauthorized",
    })).status).toBe(403);
    expect((await request(overridePath, tokens.owner, "PUT", {
      score: 95, reason: "Requires completed execution",
    })).status).toBe(409);
    expect((await request(`${overridePath}/history`, tokens.learner)).status).toBe(403);
    const history = await request(`${overridePath}/history`, tokens.owner);
    expect(history.status).toBe(200);
    expect(history.body.items).toEqual([]);
    const ownHistory = await request(endpoint, tokens.learner);
    expect(ownHistory.status).toBe(200);
    expect(ownHistory.body.items.map((x: { attempt_number: number }) => x.attempt_number)).toEqual([1, 2]);
    expect(ownHistory.body.items.every((x: { execution_state: unknown; verdict: unknown; score: unknown }) => x.execution_state === null && x.verdict === null && x.score === null)).toBe(true);
    const ownerHistory = await request(`${endpoint}?userId=${ids.learner}`, tokens.owner);
    expect(ownerHistory.status).toBe(200);
    expect(ownerHistory.body.items).toHaveLength(2);
    expect((await request(`${endpoint}?userId=${ids.owner}`, tokens.learner)).status).toBe(403);
    expect((await request(endpoint, tokens.outsider)).status).toBe(403);
    const count = await db.query(
      "SELECT count(*) AS n FROM education_assignment_attempts WHERE assignment_id=$1 AND user_id=$2",
      [assignmentId, ids.learner],
    );
    expect(Number(count.rows[0].n)).toBe(2);
  }, 60_000);

});
