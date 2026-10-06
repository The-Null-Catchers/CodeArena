import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { limitedFetch } from "./http.js";

const base = process.env.API_URL || "http://localhost:4000";
const wsBase = base.replace(/^http/, "ws");
const db = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://codearena:development-db-password@localhost:5432/codearena",
});
const suffix = crypto.randomUUID();
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

type JsonMessage = Record<string, any>;

function wsClient(token: string) {
  const socket = new WebSocket(
    `${wsBase}/v1/interview-rooms/${roomId}/ws`,
    ["codearena.v1", `codearena.jwt.${token}`],
  );
  const queued: JsonMessage[] = [];
  const waiters = new Set<{
    predicate: (value: JsonMessage) => boolean;
    resolve: (value: JsonMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  socket.addEventListener("message", (event) => {
    let value: JsonMessage;
    try {
      value = JSON.parse(String(event.data));
    } catch {
      return;
    }
    for (const waiter of waiters) {
      if (!waiter.predicate(value)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(value);
      return;
    }
    queued.push(value);
  });
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), 5000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("WebSocket handshake failed"));
      },
      { once: true },
    );
  });
  const next = (predicate: (value: JsonMessage) => boolean, timeout = 5000) => {
    const existing = queued.findIndex(predicate);
    if (existing >= 0) return Promise.resolve(queued.splice(existing, 1)[0]);
    return new Promise<JsonMessage>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error("WebSocket message timeout"));
        }, timeout),
      };
      waiters.add(waiter);
    });
  };
  return { socket, opened, next };
}

beforeAll(async () => {
  for (const name of ["owner", "candidate"]) {
    ids[name] = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
        [`ops-${name}-${suffix}@example.com`, "unused-by-document-ops-test"],
      )
    ).rows[0].id;
    tokens[name] = await issueAccessToken(ids[name]);
  }
  organizationId = (
    await db.query("INSERT INTO organizations(name) VALUES($1) RETURNING id", [
      `Document ops ${suffix}`,
    ])
  ).rows[0].id;
  await db.query(
    "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [organizationId, ids.owner],
  );
  projectId = (
    await db.query(
      "INSERT INTO projects(organization_id,name) VALUES($1,$2) RETURNING id",
      [organizationId, `Document ops project ${suffix}`],
    )
  ).rows[0].id;
  const created = await request("/v1/interview-rooms", tokens.owner, "POST", {
    projectId,
    title: "Operation room",
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

describe("interview document operations", () => {
  it("persists, rebases, deduplicates, and fences operations across full-document resets", async () => {
    const owner = wsClient(tokens.owner);
    const candidate = wsClient(tokens.candidate);
    await Promise.all([owner.opened, candidate.opened]);
    await Promise.all([
      owner.next((message) => message.type === "ready"),
      candidate.next((message) => message.type === "ready"),
    ]);

    owner.socket.send(
      JSON.stringify({
        type: "document.op",
        clientId: "owner-client",
        sequence: 1,
        baseRevision: 0,
        change: { index: 0, deleteCount: 0, insert: "A" },
        operationId: "owner-op-1",
      }),
    );
    const ownerAck = await owner.next(
      (message) => message.type === "ack" && message.operationId === "owner-op-1",
    );
    expect(ownerAck.operation).toBe("document.op");
    expect(ownerAck.revision).toBe(1);
    expect(ownerAck.idempotent).toBe(false);

    candidate.socket.send(
      JSON.stringify({
        type: "document.op",
        clientId: "candidate-client",
        sequence: 1,
        baseRevision: 0,
        change: { index: 0, deleteCount: 0, insert: "B" },
        operationId: "candidate-op-1",
      }),
    );
    const candidateAck = await candidate.next(
      (message) => message.type === "ack" && message.operationId === "candidate-op-1",
    );
    expect(candidateAck.revision).toBe(2);
    expect(candidateAck.transformed).toEqual({ index: 0, deleteCount: 0, insert: "B" });

    const room = await request(`/v1/interview-rooms/${roomId}`, tokens.owner);
    expect(room.status).toBe(200);
    expect(room.body.document).toBe("BA");
    expect(Number(room.body.document_revision)).toBe(2);

    candidate.socket.send(
      JSON.stringify({
        type: "document.op",
        clientId: "candidate-client",
        sequence: 1,
        baseRevision: 0,
        change: { index: 0, deleteCount: 0, insert: "B" },
        operationId: "candidate-op-retry",
      }),
    );
    const retryAck = await candidate.next(
      (message) =>
        message.type === "ack" && message.operationId === "candidate-op-retry",
    );
    expect(retryAck.idempotent).toBe(true);
    expect(retryAck.revision).toBe(2);
    expect(retryAck.eventId).toBe(candidateAck.eventId);

    const persisted = await db.query(
      "SELECT count(*)::int AS count FROM interview_document_operations WHERE room_id=$1",
      [roomId],
    );
    expect(persisted.rows[0].count).toBe(2);

    owner.socket.send(
      JSON.stringify({
        type: "document.update",
        document: "RESET",
        expectedRevision: 2,
        operationId: "full-reset",
      }),
    );
    const resetAck = await owner.next(
      (message) => message.type === "ack" && message.operationId === "full-reset",
    );
    expect(resetAck.revision).toBe(3);

    candidate.socket.send(
      JSON.stringify({
        type: "document.op",
        clientId: "candidate-client",
        sequence: 2,
        baseRevision: 2,
        change: { index: 2, deleteCount: 0, insert: "!" },
        operationId: "stale-after-reset",
      }),
    );
    const fenced = await candidate.next(
      (message) =>
        message.type === "error" && message.operationId === "stale-after-reset",
    );
    expect(fenced.code).toBe("rebase_unavailable");
    expect(fenced.currentRevision).toBe(3);

    owner.socket.close();
    candidate.socket.close();
  }, 20_000);
});
