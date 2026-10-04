import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import pg from "pg";
import { limitedFetch } from "./http.js";

const base = process.env.API_URL || "http://localhost:4000";
const db = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://codearena:development-db-password@localhost:5432/codearena",
});
const password = "Platform-analytics-test-123";
const suffix = crypto.randomUUID();
const adminEmail = `analytics-admin-${suffix}@example.com`;
const userEmail = `analytics-user-${suffix}@example.com`;
let adminId = "";
let userId = "";
let organizationId = "";
let projectId = "";
let runtimeId = "";
let adminToken = "";
let userToken = "";
const submissionIds: string[] = [];

async function login(email: string) {
  const response = await limitedFetch(base + "/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).accessToken as string;
}

async function analytics(token: string, hours = 24) {
  const response = await limitedFetch(
    `${base}/v1/admin/analytics?hours=${hours}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  adminId = (
    await db.query(
      "INSERT INTO users(email,password_hash,platform_admin) VALUES($1,$2,true) RETURNING id",
      [adminEmail, passwordHash],
    )
  ).rows[0].id;
  userId = (
    await db.query(
      "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
      [userEmail, passwordHash],
    )
  ).rows[0].id;
  organizationId = (
    await db.query("INSERT INTO organizations(name) VALUES($1) RETURNING id", [
      `Analytics ${suffix}`,
    ])
  ).rows[0].id;
  projectId = (
    await db.query(
      "INSERT INTO projects(organization_id,name) VALUES($1,$2) RETURNING id",
      [organizationId, `Analytics project ${suffix}`],
    )
  ).rows[0].id;
  runtimeId = (
    await db.query("SELECT id FROM runtimes ORDER BY id LIMIT 1")
  ).rows[0].id;

  for (const [index, fixture] of [
    { state: "completed", verdict: "accepted", wall: 100, cpu: 40 },
    { state: "completed", verdict: "wrong_answer", wall: 200, cpu: 80 },
    { state: "timed_out", verdict: "time_limit_exceeded", wall: 400, cpu: 120 },
  ].entries()) {
    const submission = (
      await db.query(
        `INSERT INTO submissions(project_id,user_id,runtime_id,source,stdin,mode,limits,state)
         VALUES($1,$2,$3,$4,'','run','{}'::jsonb,$5)
         RETURNING id`,
        [projectId, userId, runtimeId, `print(${index})`, fixture.state],
      )
    ).rows[0];
    submissionIds.push(submission.id);
    await db.query(
      `INSERT INTO submission_results(
         submission_id,verdict,stdout,stderr,wall_ms,cpu_ms,peak_memory_bytes
       ) VALUES($1,$2,'','',$3,$4,1024)`,
      [submission.id, fixture.verdict, fixture.wall, fixture.cpu],
    );
    await db.query(
      "INSERT INTO usage_records(submission_id,project_id,wall_ms,cpu_ms) VALUES($1,$2,$3,$4)",
      [submission.id, projectId, fixture.wall, fixture.cpu],
    );
  }

  adminToken = await login(adminEmail);
  userToken = await login(userEmail);
});

afterAll(async () => {
  if (submissionIds.length) {
    await db.query("DELETE FROM usage_records WHERE submission_id=ANY($1::uuid[])", [
      submissionIds,
    ]);
    await db.query(
      "DELETE FROM submission_results WHERE submission_id=ANY($1::uuid[])",
      [submissionIds],
    );
    await db.query("DELETE FROM submissions WHERE id=ANY($1::uuid[])", [
      submissionIds,
    ]);
  }
  await db.query("DELETE FROM audit_logs WHERE user_id=ANY($1::uuid[])", [
    [adminId, userId],
  ]);
  await db.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [
    [adminId, userId],
  ]);
  await db.query("DELETE FROM projects WHERE id=$1", [projectId]);
  await db.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
  await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
    [adminId, userId],
  ]);
  await db.end();
});

describe("platform execution analytics", () => {
  it("restricts global analytics and returns measured percentiles and hotspots", async () => {
    const denied = await analytics(userToken);
    expect(denied.status).toBe(403);

    const result = await analytics(adminToken);
    expect(result.status).toBe(200);
    expect(result.body.windowHours).toBe(24);
    expect(Number(result.body.summary.submissions)).toBeGreaterThanOrEqual(3);
    expect(Number(result.body.summary.wall_p50_ms)).toBeGreaterThan(0);
    expect(Number(result.body.summary.wall_p95_ms)).toBeGreaterThanOrEqual(200);
    expect(Number(result.body.summary.throughputPerHour)).toBeGreaterThan(0);
    expect(
      result.body.runtimes.some((row: any) => row.runtime_id === runtimeId),
    ).toBe(true);
    expect(
      result.body.projects.some((row: any) => row.id === projectId),
    ).toBe(true);
    expect(result.body.throughput.length).toBeGreaterThan(0);
  });

  it("bounds analytics windows", async () => {
    const invalid = await analytics(adminToken, 1000);
    expect(invalid.status).toBe(400);
  });
});
