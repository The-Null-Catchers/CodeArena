import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { limitedFetch } from "./http.js";

const base = process.env.API_URL || "http://localhost:4000";
const db = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://codearena:development-db-password@localhost:5432/codearena",
});
const suffix = crypto.randomUUID();
const emails = {
  owner: `directory-owner-${suffix}@example.com`,
  candidate: `directory-candidate-${suffix}@example.com`,
  outsider: `directory-outsider-${suffix}@example.com`,
};
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
let organizationId = "";
let projectId = "";
let roomId = "";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function issueAccessToken(userId: string) {
  const refreshToken = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')",
    [userId, sha256(refreshToken)],
  );
  const response = await limitedFetch(base + "/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).accessToken as string;
}

async function request(
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
) {
  const response = await limitedFetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  for (const [name, email] of Object.entries(emails)) {
    ids[name] = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
        [email, "unused-by-directory-test"],
      )
    ).rows[0].id;
    tokens[name] = await issueAccessToken(ids[name]);
  }

  organizationId = (
    await db.query(
      "INSERT INTO organizations(name) VALUES($1) RETURNING id",
      [`Participant directory ${suffix}`],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [organizationId, ids.owner],
  );
  projectId = (
    await db.query(
      "INSERT INTO projects(organization_id,name) VALUES($1,$2) RETURNING id",
      [organizationId, `Directory project ${suffix}`],
    )
  ).rows[0].id;

  const created = await request("/v1/interview-rooms", tokens.owner, "POST", {
    projectId,
    title: "Participant directory interview",
  });
  expect(created.status).toBe(201);
  roomId = created.body.id;

  const added = await request(
    `/v1/interview-rooms/${roomId}/participants`,
    tokens.owner,
    "POST",
    { userId: ids.candidate, role: "candidate" },
  );
  expect(added.status).toBe(201);
});

afterAll(async () => {
  const userIds = Object.values(ids);
  await db.query("DELETE FROM audit_logs WHERE user_id=ANY($1::uuid[])", [userIds]);
  await db.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [userIds]);
  if (projectId) await db.query("DELETE FROM projects WHERE id=$1", [projectId]);
  if (organizationId)
    await db.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
  await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
  await db.end();
});

describe("interview participant directory", () => {
  it("returns persisted participants to interviewers", async () => {
    const result = await request(
      `/v1/interview-rooms/${roomId}/participants`,
      tokens.owner,
    );
    expect(result.status).toBe(200);
    expect(result.body.items).toHaveLength(2);
    expect(result.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: ids.owner,
          email: emails.owner,
          role: "interviewer",
          disabled: false,
        }),
        expect.objectContaining({
          user_id: ids.candidate,
          email: emails.candidate,
          role: "candidate",
          disabled: false,
        }),
      ]),
    );
  });

  it("keeps the directory interviewer-only", async () => {
    const candidate = await request(
      `/v1/interview-rooms/${roomId}/participants`,
      tokens.candidate,
    );
    expect(candidate.status).toBe(403);

    const outsider = await request(
      `/v1/interview-rooms/${roomId}/participants`,
      tokens.outsider,
    );
    expect(outsider.status).toBe(404);
  });

  it("reflects role updates from the existing participant upsert API", async () => {
    const updated = await request(
      `/v1/interview-rooms/${roomId}/participants`,
      tokens.owner,
      "POST",
      { userId: ids.candidate, role: "observer" },
    );
    expect(updated.status).toBe(201);
    expect(updated.body.role).toBe("observer");

    const directory = await request(
      `/v1/interview-rooms/${roomId}/participants`,
      tokens.owner,
    );
    expect(directory.status).toBe(200);
    expect(
      directory.body.items.find((item: any) => item.user_id === ids.candidate)
        ?.role,
    ).toBe("observer");
  });
});
