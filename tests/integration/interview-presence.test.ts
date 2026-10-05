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
const users = {
  owner: `presence-owner-${suffix}@example.com`,
  candidate: `presence-candidate-${suffix}@example.com`,
  outsider: `presence-outsider-${suffix}@example.com`,
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
  for (const [name, email] of Object.entries(users)) {
    ids[name] = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
        [email, "unused-by-presence-test"],
      )
    ).rows[0].id;
    tokens[name] = await issueAccessToken(ids[name]);
  }
  organizationId = (
    await db.query(
      "INSERT INTO organizations(name) VALUES($1) RETURNING id",
      [`Presence test ${suffix}`],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [organizationId, ids.owner],
  );
  projectId = (
    await db.query(
      "INSERT INTO projects(organization_id,name) VALUES($1,$2) RETURNING id",
      [organizationId, `Presence project ${suffix}`],
    )
  ).rows[0].id;

  const created = await request("/v1/interview-rooms", tokens.owner, "POST", {
    projectId,
    title: "Presence room",
  });
  expect(created.status).toBe(201);
  roomId = created.body.id;
  const invited = await request(
    `/v1/interview-rooms/${roomId}/participants`,
    tokens.owner,
    "POST",
    { userId: ids.candidate, role: "candidate" },
  );
  expect(invited.status).toBe(201);
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

describe("interview presence", () => {
  it("tracks participant heartbeats without exposing the room to outsiders", async () => {
    const ownerPresence = await request(
      `/v1/interview-rooms/${roomId}/presence`,
      tokens.owner,
      "POST",
      { state: "active" },
    );
    expect(ownerPresence.status).toBe(200);
    expect(ownerPresence.body.presence.role).toBe("interviewer");

    const candidatePresence = await request(
      `/v1/interview-rooms/${roomId}/presence`,
      tokens.candidate,
      "POST",
      { state: "idle" },
    );
    expect(candidatePresence.status).toBe(200);
    expect(candidatePresence.body.presence.role).toBe("candidate");

    const visible = await request(
      `/v1/interview-rooms/${roomId}/presence`,
      tokens.candidate,
    );
    expect(visible.status).toBe(200);
    expect(visible.body.items).toHaveLength(2);
    expect(
      visible.body.items.some(
        (entry: any) => entry.userId === ids.owner && entry.state === "active",
      ),
    ).toBe(true);
    expect(
      visible.body.items.some(
        (entry: any) =>
          entry.userId === ids.candidate && entry.state === "idle",
      ),
    ).toBe(true);

    const outsider = await request(
      `/v1/interview-rooms/${roomId}/presence`,
      tokens.outsider,
    );
    expect(outsider.status).toBe(404);

    const left = await request(
      `/v1/interview-rooms/${roomId}/presence`,
      tokens.owner,
      "DELETE",
    );
    expect(left.status).toBe(200);

    const afterLeave = await request(
      `/v1/interview-rooms/${roomId}/presence`,
      tokens.candidate,
    );
    expect(afterLeave.body.items).toHaveLength(1);
    expect(afterLeave.body.items[0].userId).toBe(ids.candidate);

    const ended = await request(
      `/v1/interview-rooms/${roomId}/end`,
      tokens.owner,
      "POST",
      {},
    );
    expect(ended.status).toBe(200);
    const heartbeatAfterEnd = await request(
      `/v1/interview-rooms/${roomId}/presence`,
      tokens.candidate,
      "POST",
      { state: "active" },
    );
    expect(heartbeatAfterEnd.status).toBe(409);
  });
});
