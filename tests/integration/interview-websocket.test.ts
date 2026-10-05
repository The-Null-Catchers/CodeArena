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
const users = {
  owner: `ws-owner-${suffix}@example.com`,
  candidate: `ws-candidate-${suffix}@example.com`,
  outsider: `ws-outsider-${suffix}@example.com`,
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

type JsonMessage = Record<string, any>;

function client(token: string, after = 0) {
  const socket = new WebSocket(
    `${wsBase}/v1/interview-rooms/${roomId}/ws?after=${after}`,
    ["codearena.v1", `codearena.jwt.${token}`],
  );
  const queued: JsonMessage[] = [];
  const waiters = new Set<{
    predicate: (value: JsonMessage) => boolean;
    resolve: (value: JsonMessage) => void;
    reject: (error: Error) => void;
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
    const existingIndex = queued.findIndex(predicate);
    if (existingIndex >= 0) return Promise.resolve(queued.splice(existingIndex, 1)[0]);
    return new Promise<JsonMessage>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error("WebSocket message timeout"));
        }, timeout),
      };
      waiters.add(waiter);
    });
  };
  return { socket, opened, next, queued };
}

beforeAll(async () => {
  for (const [name, email] of Object.entries(users)) {
    ids[name] = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
        [email, "unused-by-websocket-test"],
      )
    ).rows[0].id;
    tokens[name] = await issueAccessToken(ids[name]);
  }
  organizationId = (
    await db.query(
      "INSERT INTO organizations(name) VALUES($1) RETURNING id",
      [`WebSocket test ${suffix}`],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [organizationId, ids.owner],
  );
  projectId = (
    await db.query(
      "INSERT INTO projects(organization_id,name) VALUES($1,$2) RETURNING id",
      [organizationId, `WebSocket project ${suffix}`],
    )
  ).rows[0].id;
  const created = await request("/v1/interview-rooms", tokens.owner, "POST", {
    projectId,
    title: "Realtime interview",
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

describe("interview WebSocket collaboration", () => {
  it("authenticates participants, edits bidirectionally, broadcasts presence, and replays missed durable events", async () => {
    const privateMarker = `private-${suffix}`;
    const privateNote = await request(
      `/v1/interview-rooms/${roomId}/private-notes`,
      tokens.owner,
      "POST",
      { body: privateMarker },
    );
    expect(privateNote.status).toBe(201);

    const owner = client(tokens.owner);
    const candidate = client(tokens.candidate);
    await Promise.all([owner.opened, candidate.opened]);
    await Promise.all([
      owner.next((message) => message.type === "ready"),
      candidate.next((message) => message.type === "ready"),
    ]);

    candidate.socket.send(
      JSON.stringify({
        type: "document.update",
        document: "const answer = 41;",
        expectedRevision: 0,
        operationId: "candidate-edit-1",
      }),
    );
    const firstAck = await candidate.next(
      (message) =>
        message.type === "ack" && message.operationId === "candidate-edit-1",
    );
    expect(firstAck.revision).toBe(1);
    const firstEvent = await owner.next(
      (message) =>
        message.type === "event" && message.event?.kind === "document.updated",
    );
    expect(firstEvent.event.payload.revision).toBe(1);
    expect(JSON.stringify(firstEvent)).not.toContain(privateMarker);

    candidate.socket.send(
      JSON.stringify({ type: "presence.heartbeat", state: "idle" }),
    );
    const idlePresence = await owner.next(
      (message) =>
        message.type === "presence.changed" &&
        message.presence?.userId === ids.candidate &&
        message.presence?.state === "idle",
    );
    expect(idlePresence.presence.role).toBe("candidate");

    candidate.socket.close(1000, "reconnect-test");
    await new Promise((resolve) => setTimeout(resolve, 100));
    owner.socket.send(
      JSON.stringify({
        type: "document.update",
        document: "const answer = 42;",
        expectedRevision: 1,
        operationId: "owner-edit-2",
      }),
    );
    const secondAck = await owner.next(
      (message) => message.type === "ack" && message.operationId === "owner-edit-2",
    );
    expect(secondAck.revision).toBe(2);
    expect(secondAck.eventId).toBeGreaterThan(firstAck.eventId);

    const reconnected = client(tokens.candidate, Number(firstAck.eventId));
    await reconnected.opened;
    const replayed = await reconnected.next(
      (message) =>
        message.type === "event" &&
        Number(message.event?.id) === Number(secondAck.eventId),
    );
    expect(replayed.event.payload.revision).toBe(2);
    await reconnected.next((message) => message.type === "ready");

    const outsider = client(tokens.outsider);
    await expect(outsider.opened).rejects.toThrow("WebSocket handshake failed");

    owner.socket.close();
    reconnected.socket.close();
    outsider.socket.close();
  }, 20_000);
});
