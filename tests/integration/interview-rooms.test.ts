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
  owner: `interview-owner-${suffix}@example.com`,
  candidate: `interview-candidate-${suffix}@example.com`,
  outsider: `interview-outsider-${suffix}@example.com`,
};
const ids: Record<string, string> = {};
let organizationId = "";
let projectId = "";
let ownerToken = "";
let candidateToken = "";
let outsiderToken = "";
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
        [email, "unused-by-interview-test"],
      )
    ).rows[0].id;
  }
  organizationId = (
    await db.query(
      "INSERT INTO organizations(name) VALUES($1) RETURNING id",
      [`Interview test ${suffix}`],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [organizationId, ids.owner],
  );
  projectId = (
    await db.query(
      "INSERT INTO projects(organization_id,name) VALUES($1,$2) RETURNING id",
      [organizationId, `Interview project ${suffix}`],
    )
  ).rows[0].id;
  ownerToken = await issueAccessToken(ids.owner);
  candidateToken = await issueAccessToken(ids.candidate);
  outsiderToken = await issueAccessToken(ids.outsider);
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

describe("interview rooms", () => {
  it("enforces participation, revision conflicts, and private-note isolation", async () => {
    const created = await request("/v1/interview-rooms", ownerToken, "POST", {
      projectId,
      title: "Backend interview",
    });
    expect(created.status).toBe(201);
    expect(created.body.role).toBe("interviewer");
    expect(Number(created.body.document_revision)).toBe(0);
    roomId = created.body.id;

    const added = await request(
      `/v1/interview-rooms/${roomId}/participants`,
      ownerToken,
      "POST",
      { userId: ids.candidate, role: "candidate" },
    );
    expect(added.status).toBe(201);
    expect(added.body.role).toBe("candidate");

    const candidateRoom = await request(
      `/v1/interview-rooms/${roomId}`,
      candidateToken,
    );
    expect(candidateRoom.status).toBe(200);
    expect(candidateRoom.body.role).toBe("candidate");

    const outsiderRoom = await request(
      `/v1/interview-rooms/${roomId}`,
      outsiderToken,
    );
    expect(outsiderRoom.status).toBe(404);

    const noteBody = `private-${suffix}`;
    const note = await request(
      `/v1/interview-rooms/${roomId}/private-notes`,
      ownerToken,
      "POST",
      { body: noteBody },
    );
    expect(note.status).toBe(201);
    expect(note.body.body).toBe(noteBody);

    const candidateNotes = await request(
      `/v1/interview-rooms/${roomId}/private-notes`,
      candidateToken,
    );
    expect(candidateNotes.status).toBe(403);

    const firstEdit = await request(
      `/v1/interview-rooms/${roomId}/document`,
      ownerToken,
      "PATCH",
      { document: "const answer = 41;", expectedRevision: 0 },
    );
    expect(firstEdit.status).toBe(200);
    expect(Number(firstEdit.body.document_revision)).toBe(1);

    const staleEdit = await request(
      `/v1/interview-rooms/${roomId}/document`,
      candidateToken,
      "PATCH",
      { document: "const answer = 42;", expectedRevision: 0 },
    );
    expect(staleEdit.status).toBe(409);

    const candidateEdit = await request(
      `/v1/interview-rooms/${roomId}/document`,
      candidateToken,
      "PATCH",
      { document: "const answer = 42;", expectedRevision: 1 },
    );
    expect(candidateEdit.status).toBe(200);
    expect(Number(candidateEdit.body.document_revision)).toBe(2);

    const events = await request(
      `/v1/interview-rooms/${roomId}/events?after=0`,
      candidateToken,
    );
    expect(events.status).toBe(200);
    expect(events.body.items.some((event: any) => event.kind === "document.updated")).toBe(true);
    expect(JSON.stringify(events.body)).not.toContain(noteBody);

    const ended = await request(
      `/v1/interview-rooms/${roomId}/end`,
      ownerToken,
      "POST",
      {},
    );
    expect(ended.status).toBe(200);
    expect(ended.body.status).toBe("ended");

    const editAfterEnd = await request(
      `/v1/interview-rooms/${roomId}/document`,
      candidateToken,
      "PATCH",
      { document: "late edit", expectedRevision: 2 },
    );
    expect(editAfterEnd.status).toBe(409);
  });
});
