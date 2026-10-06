import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { config } from "../../../packages/config/src/index.js";
import { pool, tx } from "../../../packages/db/src/index.js";
import {
  applyOperation,
  type AppliedOperation,
  type CollaborationOperation,
} from "../../../packages/shared/src/collaboration.js";
import { redis } from "../../../packages/shared/src/events.js";

const pathPattern = /^\/v1\/interview-rooms\/([0-9a-f-]{36})\/ws$/i;
const eventChannel = "interview_room_events";
const presenceChannel = "interview_room_presence";
const maxMessageBytes = 256 * 1024;
const maxDocumentBytes = 200_000;
const presenceTtlMs = 45_000;
const maxConnectionsPerUserRoom = 5;

type Participant = {
  roomId: string;
  userId: string;
  sessionId: string;
  role: "interviewer" | "candidate" | "observer";
  status: "active" | "ended";
  document: string;
  documentRevision: number;
};

type Connection = Participant & {
  id: string;
  socket: Socket;
  cursor: number;
  receiveBuffer: Buffer;
  fragmentedOpcode?: number;
  fragments: Buffer[];
  fragmentedBytes: number;
  syncQueue: Promise<void>;
  closed: boolean;
  lastPongAt: number;
  presenceState: "active" | "idle";
  pingTimer?: NodeJS.Timeout;
};

function httpError(socket: Socket, status: number, message: string) {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function frame(opcode: number, payload: Buffer = Buffer.alloc(0)) {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendJson(connection: Connection, value: unknown) {
  if (connection.closed || connection.socket.destroyed) return;
  connection.socket.write(frame(0x1, Buffer.from(JSON.stringify(value))));
}

function sendClose(connection: Connection, code: number, reason: string) {
  if (connection.closed) return;
  const reasonBytes = Buffer.from(reason).subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  connection.socket.write(frame(0x8, payload));
  connection.socket.end();
}

function presenceKeys(roomId: string) {
  return {
    live: `interview:presence:${roomId}:live`,
    details: `interview:presence:${roomId}:details`,
  };
}

function connectionKey(connection: Pick<Connection, "roomId" | "userId">) {
  return `interview:ws:${connection.roomId}:${connection.userId}`;
}

async function refreshConnectionLease(connection: Connection) {
  const key = connectionKey(connection);
  await redis
    .zadd(key, Date.now() + presenceTtlMs * 2, connection.id)
    .catch(() => {});
  await redis.pexpire(key, presenceTtlMs * 3).catch(() => {});
}

async function markPresence(
  connection: Connection,
  state: "active" | "idle" = connection.presenceState,
) {
  connection.presenceState = state;
  const now = Date.now();
  const entry = {
    userId: connection.userId,
    role: connection.role,
    state,
    lastSeenAt: new Date(now).toISOString(),
  };
  const { live, details } = presenceKeys(connection.roomId);
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(live, "-inf", now);
  pipeline.zadd(live, now + presenceTtlMs, connection.userId);
  pipeline.hset(details, connection.userId, JSON.stringify(entry));
  pipeline.pexpire(live, presenceTtlMs * 2);
  pipeline.pexpire(details, presenceTtlMs * 2);
  await pipeline.exec();
  await refreshConnectionLease(connection);
  await redis
    .publish(
      presenceChannel,
      JSON.stringify({ roomId: connection.roomId, presence: entry }),
    )
    .catch(() => {});
  return entry;
}

async function removePresence(connection: Connection) {
  const key = connectionKey(connection);
  const remaining = await redis
    .multi()
    .zrem(key, connection.id)
    .zremrangebyscore(key, "-inf", Date.now())
    .zcard(key)
    .exec()
    .catch(() => null);
  const count = Number(remaining?.[2]?.[1] ?? 0);
  if (count > 0) return;
  const { live, details } = presenceKeys(connection.roomId);
  await redis
    .multi()
    .zrem(live, connection.userId)
    .hdel(details, connection.userId)
    .exec()
    .catch(() => {});
  await redis
    .publish(
      presenceChannel,
      JSON.stringify({ roomId: connection.roomId, leftUserId: connection.userId }),
    )
    .catch(() => {});
}

async function presenceSnapshot(roomId: string) {
  const now = Date.now();
  const { live, details } = presenceKeys(roomId);
  await redis.zremrangebyscore(live, "-inf", now);
  const ids = await redis.zrangebyscore(live, now + 1, "+inf");
  if (!ids.length) return [];
  const values = await redis.hmget(details, ...ids);
  return values.flatMap((value) => {
    if (!value) return [];
    try {
      return [JSON.parse(value)];
    } catch {
      return [];
    }
  });
}

async function loadEvents(roomId: string, after: number) {
  return (
    await pool.query(
      `SELECT id,actor_user_id,kind,payload,created_at
         FROM interview_room_events
        WHERE room_id=$1 AND id>$2
        ORDER BY id ASC
        LIMIT 500`,
      [roomId, after],
    )
  ).rows;
}

async function syncDurableEvents(connection: Connection) {
  while (!connection.closed) {
    const events = await loadEvents(connection.roomId, connection.cursor);
    if (!events.length) return;
    for (const event of events) {
      if (connection.closed) return;
      const id = Number(event.id);
      if (id <= connection.cursor) continue;
      connection.cursor = id;
      sendJson(connection, { type: "event", event: { ...event, id } });
    }
    if (events.length < 500) return;
  }
}

function queueSync(connection: Connection) {
  connection.syncQueue = connection.syncQueue
    .then(() => syncDurableEvents(connection))
    .catch(() => {
      sendClose(connection, 1011, "durable event sync failed");
    });
}

async function updateDocument(
  connection: Connection,
  body: { document: string; expectedRevision: number; operationId?: string },
) {
  if (connection.role === "observer") {
    sendJson(connection, {
      type: "error",
      code: "forbidden",
      operationId: body.operationId,
      message: "Observers cannot edit the shared document",
    });
    return;
  }
  try {
    const result = await tx(async (client) => {
      const updated = (
        await client.query(
          `UPDATE interview_rooms
              SET document=$1,document_revision=document_revision+1
            WHERE id=$2 AND status='active' AND document_revision=$3
            RETURNING document_revision`,
          [body.document, connection.roomId, body.expectedRevision],
        )
      ).rows[0];
      if (!updated) return null;
      const event = (
        await client.query(
          `INSERT INTO interview_room_events(room_id,actor_user_id,kind,payload)
           VALUES($1,$2,'document.updated',$3)
           RETURNING id,created_at`,
          [
            connection.roomId,
            connection.userId,
            JSON.stringify({ revision: Number(updated.document_revision) }),
          ],
        )
      ).rows[0];
      await client.query("SELECT pg_notify($1,$2)", [
        eventChannel,
        JSON.stringify({
          roomId: connection.roomId,
          eventId: Number(event.id),
        }),
      ]);
      return {
        revision: Number(updated.document_revision),
        eventId: Number(event.id),
        updatedAt: event.created_at,
      };
    });
    if (!result) {
      const current = (
        await pool.query(
          "SELECT status,document_revision FROM interview_rooms WHERE id=$1",
          [connection.roomId],
        )
      ).rows[0];
      sendJson(connection, {
        type: "error",
        code: current?.status === "ended" ? "room_ended" : "revision_conflict",
        operationId: body.operationId,
        currentRevision: current ? Number(current.document_revision) : undefined,
      });
      return;
    }
    sendJson(connection, {
      type: "ack",
      operation: "document.update",
      operationId: body.operationId,
      ...result,
    });
  } catch {
    sendJson(connection, {
      type: "error",
      code: "document_update_failed",
      operationId: body.operationId,
    });
  }
}

type DocumentOperationMessage = CollaborationOperation & {
  operationId?: string;
};

async function updateDocumentWithOperation(
  connection: Connection,
  body: DocumentOperationMessage,
) {
  if (connection.role === "observer") {
    sendJson(connection, {
      type: "error",
      code: "forbidden",
      operationId: body.operationId,
      message: "Observers cannot edit the shared document",
    });
    return;
  }

  try {
    const result = await tx(async (client) => {
      const room = (
        await client.query(
          `SELECT status,document,document_revision
             FROM interview_rooms
            WHERE id=$1
            FOR UPDATE`,
          [connection.roomId],
        )
      ).rows[0];
      if (!room) return { kind: "missing" as const };
      const currentRevision = Number(room.document_revision);
      if (room.status !== "active")
        return { kind: "ended" as const, currentRevision };

      const existing = (
        await client.query(
          `SELECT revision,event_id,transformed,created_at
             FROM interview_document_operations
            WHERE room_id=$1 AND client_id=$2 AND sequence=$3`,
          [connection.roomId, body.clientId, body.sequence],
        )
      ).rows[0];
      if (existing) {
        return {
          kind: "ok" as const,
          revision: Number(existing.revision),
          eventId: Number(existing.event_id),
          transformed: existing.transformed,
          updatedAt: existing.created_at,
          idempotent: true,
        };
      }

      if (body.baseRevision > currentRevision) {
        return {
          kind: "conflict" as const,
          currentRevision,
          code: "revision_conflict" as const,
        };
      }

      const historyRows = (
        await client.query(
          `SELECT client_id,sequence,base_revision,revision,change,transformed
             FROM interview_document_operations
            WHERE room_id=$1 AND revision>$2
            ORDER BY revision ASC`,
          [connection.roomId, body.baseRevision],
        )
      ).rows;
      if (historyRows.length !== currentRevision - body.baseRevision) {
        return {
          kind: "conflict" as const,
          currentRevision,
          code: "rebase_unavailable" as const,
        };
      }

      const history: AppliedOperation[] = historyRows.map((row) => ({
        clientId: row.client_id,
        sequence: Number(row.sequence),
        baseRevision: Number(row.base_revision),
        revision: Number(row.revision),
        change: row.change,
        transformed: row.transformed,
      }));

      let applied: ReturnType<typeof applyOperation>;
      try {
        applied = applyOperation(
          room.document,
          {
            clientId: body.clientId,
            sequence: body.sequence,
            baseRevision: body.baseRevision,
            change: body.change,
          },
          history,
          currentRevision,
        );
      } catch (error) {
        return {
          kind: "invalid" as const,
          message: error instanceof Error ? error.message : "Invalid document operation",
          currentRevision,
        };
      }
      if (applied.document.length > maxDocumentBytes) {
        return {
          kind: "invalid" as const,
          message: "Document exceeds maximum size",
          currentRevision,
        };
      }

      await client.query(
        `UPDATE interview_rooms
            SET document=$1,document_revision=$2
          WHERE id=$3`,
        [applied.document, applied.revision, connection.roomId],
      );
      const eventPayload = {
        revision: applied.revision,
        mode: "operation",
        operation: {
          clientId: body.clientId,
          sequence: body.sequence,
          baseRevision: body.baseRevision,
          change: body.change,
          transformed: applied.applied.transformed,
        },
      };
      const event = (
        await client.query(
          `INSERT INTO interview_room_events(room_id,actor_user_id,kind,payload)
           VALUES($1,$2,'document.updated',$3)
           RETURNING id,created_at`,
          [connection.roomId, connection.userId, JSON.stringify(eventPayload)],
        )
      ).rows[0];
      await client.query(
        `INSERT INTO interview_document_operations(
           room_id,client_id,sequence,actor_user_id,base_revision,revision,change,transformed,event_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          connection.roomId,
          body.clientId,
          body.sequence,
          connection.userId,
          body.baseRevision,
          applied.revision,
          JSON.stringify(body.change),
          JSON.stringify(applied.applied.transformed),
          event.id,
        ],
      );
      await client.query("SELECT pg_notify($1,$2)", [
        eventChannel,
        JSON.stringify({
          roomId: connection.roomId,
          eventId: Number(event.id),
        }),
      ]);
      return {
        kind: "ok" as const,
        revision: applied.revision,
        eventId: Number(event.id),
        transformed: applied.applied.transformed,
        updatedAt: event.created_at,
        idempotent: false,
      };
    });

    if (result.kind === "ok") {
      sendJson(connection, {
        type: "ack",
        operation: "document.op",
        operationId: body.operationId,
        revision: result.revision,
        eventId: result.eventId,
        transformed: result.transformed,
        updatedAt: result.updatedAt,
        idempotent: result.idempotent,
      });
      return;
    }
    if (result.kind === "conflict") {
      sendJson(connection, {
        type: "error",
        code: result.code,
        operationId: body.operationId,
        currentRevision: result.currentRevision,
      });
      return;
    }
    if (result.kind === "ended") {
      sendJson(connection, {
        type: "error",
        code: "room_ended",
        operationId: body.operationId,
        currentRevision: result.currentRevision,
      });
      return;
    }
    if (result.kind === "invalid") {
      sendJson(connection, {
        type: "error",
        code: "invalid_operation",
        operationId: body.operationId,
        currentRevision: result.currentRevision,
        message: result.message,
      });
      return;
    }
    sendJson(connection, {
      type: "error",
      code: "document_operation_failed",
      operationId: body.operationId,
    });
  } catch {
    sendJson(connection, {
      type: "error",
      code: "document_operation_failed",
      operationId: body.operationId,
    });
  }
}

const incomingMessage = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("document.update"),
      document: z.string().max(maxDocumentBytes),
      expectedRevision: z.number().int().min(0),
      operationId: z.string().min(1).max(80).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("document.op"),
      clientId: z.string().min(1).max(80),
      sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      change: z
        .object({
          index: z.number().int().min(0).max(maxDocumentBytes),
          deleteCount: z.number().int().min(0).max(maxDocumentBytes),
          insert: z.string().max(maxDocumentBytes),
        })
        .strict(),
      operationId: z.string().min(1).max(80).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("presence.heartbeat"),
      state: z.enum(["active", "idle"]).default("active"),
    })
    .strict(),
  z.object({ type: z.literal("presence.leave") }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
]);

function handleText(connection: Connection, payload: Buffer) {
  let parsed: z.infer<typeof incomingMessage>;
  try {
    parsed = incomingMessage.parse(JSON.parse(payload.toString("utf8")));
  } catch {
    sendJson(connection, {
      type: "error",
      code: "invalid_message",
      message: "Malformed or unsupported WebSocket message",
    });
    return;
  }
  if (parsed.type === "document.update") {
    void updateDocument(connection, parsed);
  } else if (parsed.type === "document.op") {
    void updateDocumentWithOperation(connection, parsed);
  } else if (parsed.type === "presence.heartbeat") {
    void markPresence(connection, parsed.state).catch(() => {
      sendJson(connection, { type: "error", code: "presence_unavailable" });
    });
  } else if (parsed.type === "presence.leave") {
    void removePresence(connection).catch(() => {});
  } else {
    sendJson(connection, { type: "pong", at: new Date().toISOString() });
  }
}

function protocolError(connection: Connection, reason: string) {
  sendClose(connection, 1002, reason);
}

function consumeFrames(connection: Connection, chunk: Buffer) {
  if (connection.closed) return;
  connection.receiveBuffer = Buffer.concat([connection.receiveBuffer, chunk]);
  while (!connection.closed) {
    const buffer = connection.receiveBuffer;
    if (buffer.length < 2) return;
    const first = buffer[0];
    const second = buffer[1];
    const fin = Boolean(first & 0x80);
    const rsv = first & 0x70;
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if (rsv) return protocolError(connection, "RSV bits are not supported");
    if (!masked) return protocolError(connection, "Client frames must be masked");
    if (length === 126) {
      if (buffer.length < 4) return;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return;
      const longLength = buffer.readBigUInt64BE(2);
      if (longLength > BigInt(maxMessageBytes)) {
        sendClose(connection, 1009, "Message too large");
        return;
      }
      length = Number(longLength);
      offset = 10;
    }
    if (opcode >= 0x8 && (!fin || length > 125))
      return protocolError(connection, "Invalid control frame");
    if (length > maxMessageBytes) {
      sendClose(connection, 1009, "Message too large");
      return;
    }
    if (buffer.length < offset + 4 + length) return;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let index = 0; index < payload.length; index++)
      payload[index] ^= mask[index % 4];
    connection.receiveBuffer = buffer.subarray(offset + 4 + length);

    if (opcode === 0x8) {
      connection.socket.write(frame(0x8, payload.subarray(0, 125)));
      connection.socket.end();
      return;
    }
    if (opcode === 0x9) {
      connection.socket.write(frame(0xa, payload));
      continue;
    }
    if (opcode === 0xa) {
      connection.lastPongAt = Date.now();
      void markPresence(connection).catch(() => {});
      continue;
    }
    if (opcode === 0x0) {
      if (connection.fragmentedOpcode === undefined)
        return protocolError(connection, "Unexpected continuation frame");
      connection.fragmentedBytes += payload.length;
      if (connection.fragmentedBytes > maxMessageBytes) {
        sendClose(connection, 1009, "Message too large");
        return;
      }
      connection.fragments.push(payload);
      if (fin) {
        const joined = Buffer.concat(connection.fragments);
        const originalOpcode = connection.fragmentedOpcode;
        connection.fragmentedOpcode = undefined;
        connection.fragments = [];
        connection.fragmentedBytes = 0;
        if (originalOpcode === 0x1) handleText(connection, joined);
        else sendClose(connection, 1003, "Binary messages are not supported");
      }
      continue;
    }
    if (opcode !== 0x1 && opcode !== 0x2)
      return protocolError(connection, "Unsupported opcode");
    if (connection.fragmentedOpcode !== undefined)
      return protocolError(connection, "Interleaved fragmented messages are invalid");
    if (!fin) {
      connection.fragmentedOpcode = opcode;
      connection.fragments = [payload];
      connection.fragmentedBytes = payload.length;
      continue;
    }
    if (opcode === 0x1) handleText(connection, payload);
    else sendClose(connection, 1003, "Binary messages are not supported");
  }
}

async function authenticate(
  app: FastifyInstance,
  req: IncomingMessage,
  roomId: string,
): Promise<Participant | null> {
  const protocols = String(req.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!protocols.includes("codearena.v1")) return null;
  const authProtocol = protocols.find((value) => value.startsWith("codearena.jwt."));
  if (!authProtocol) return null;
  const token = authProtocol.slice("codearena.jwt.".length);
  let payload: { sub: string; sid: string };
  try {
    payload = await app.jwt.verify<{ sub: string; sid: string }>(token);
  } catch {
    return null;
  }
  const session = await pool.query(
    `UPDATE sessions s
        SET last_seen_at=CASE
          WHEN s.last_seen_at < now()-interval '5 minutes' THEN now()
          ELSE s.last_seen_at
        END
       FROM users u
      WHERE s.id=$1 AND s.user_id=$2 AND u.id=s.user_id
        AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT u.disabled
      RETURNING s.id`,
    [payload.sid, payload.sub],
  );
  if (!session.rowCount) return null;
  const row = (
    await pool.query(
      `SELECT p.role,r.status,r.document,r.document_revision
         FROM interview_room_participants p
         JOIN interview_rooms r ON r.id=p.room_id
        WHERE p.room_id=$1 AND p.user_id=$2`,
      [roomId, payload.sub],
    )
  ).rows[0];
  if (!row) return null;
  return {
    roomId,
    userId: payload.sub,
    sessionId: payload.sid,
    role: row.role,
    status: row.status,
    document: row.document,
    documentRevision: Number(row.document_revision),
  };
}

export function registerInterviewWebSocket(app: FastifyInstance) {
  const rooms = new Map<string, Set<Connection>>();
  let eventListener: pg.PoolClient | undefined;
  let presenceSubscriber: ReturnType<typeof redis.duplicate> | undefined;

  const localBroadcast = (roomId: string, value: unknown) => {
    for (const connection of rooms.get(roomId) || []) sendJson(connection, value);
  };

  app.addHook("onReady", async () => {
    eventListener = await pool.connect();
    await eventListener.query(`LISTEN ${eventChannel}`);
    eventListener.on("notification", (notification) => {
      if (notification.channel !== eventChannel || !notification.payload) return;
      try {
        const message = JSON.parse(notification.payload) as { roomId?: string };
        if (!message.roomId) return;
        for (const connection of rooms.get(message.roomId) || []) queueSync(connection);
      } catch {
        // Durable cursor replay is authoritative; malformed wakeups can be ignored.
      }
    });

    presenceSubscriber = redis.duplicate();
    presenceSubscriber.on("error", () => {});
    await presenceSubscriber.subscribe(presenceChannel);
    presenceSubscriber.on("message", (channel, raw) => {
      if (channel !== presenceChannel) return;
      try {
        const message = JSON.parse(raw) as {
          roomId?: string;
          presence?: unknown;
          leftUserId?: string;
        };
        if (!message.roomId) return;
        if (message.presence)
          localBroadcast(message.roomId, {
            type: "presence.changed",
            presence: message.presence,
          });
        else if (message.leftUserId)
          localBroadcast(message.roomId, {
            type: "presence.left",
            userId: message.leftUserId,
          });
      } catch {
        // Ephemeral presence messages are best effort.
      }
    });
  });

  const closeConnection = (connection: Connection) => {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.pingTimer) clearInterval(connection.pingTimer);
    const set = rooms.get(connection.roomId);
    set?.delete(connection);
    if (set && set.size === 0) rooms.delete(connection.roomId);
    void removePresence(connection).catch(() => {});
  };

  const handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    void (async () => {
      const url = new URL(req.url || "/", "http://codearena.local");
      const match = pathPattern.exec(url.pathname);
      if (!match) return httpError(socket, 404, "Not Found");
      const origin = req.headers.origin;
      if (origin && origin !== config.WEB_ORIGIN)
        return httpError(socket, 403, "Forbidden");
      if (String(req.headers.upgrade || "").toLowerCase() !== "websocket")
        return httpError(socket, 400, "Bad Request");
      if (!String(req.headers.connection || "").toLowerCase().split(/\s*,\s*/).includes("upgrade"))
        return httpError(socket, 400, "Bad Request");
      if (String(req.headers["sec-websocket-version"] || "") !== "13")
        return httpError(socket, 426, "Upgrade Required");
      const key = String(req.headers["sec-websocket-key"] || "");
      if (!/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, "base64").length !== 16)
        return httpError(socket, 400, "Bad Request");

      const participant = await authenticate(app, req, match[1]);
      if (!participant) return httpError(socket, 401, "Unauthorized");
      const after = Number(url.searchParams.get("after") || 0);
      const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
      const connection: Connection = {
        ...participant,
        id: randomUUID(),
        socket,
        cursor,
        receiveBuffer: Buffer.alloc(0),
        fragments: [],
        fragmentedBytes: 0,
        syncQueue: Promise.resolve(),
        closed: false,
        lastPongAt: Date.now(),
        presenceState: "active",
      };
      const leaseKey = connectionKey(connection);
      const admitted = Number(
        await redis.eval(
          "redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[4]) then return 0 end; redis.call('ZADD',KEYS[1],ARGV[2],ARGV[3]); redis.call('PEXPIRE',KEYS[1],ARGV[5]); return 1",
          1,
          leaseKey,
          Date.now(),
          Date.now() + presenceTtlMs * 2,
          connection.id,
          maxConnectionsPerUserRoom,
          presenceTtlMs * 3,
        ),
      );
      if (!admitted) return httpError(socket, 429, "Too Many Requests");

      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          "Sec-WebSocket-Protocol: codearena.v1\r\n\r\n",
      );

      let set = rooms.get(connection.roomId);
      if (!set) {
        set = new Set();
        rooms.set(connection.roomId, set);
      }
      set.add(connection);
      socket.setNoDelay(true);
      socket.on("data", (chunk) => consumeFrames(connection, chunk));
      socket.on("close", () => closeConnection(connection));
      socket.on("error", () => closeConnection(connection));
      if (head.length) consumeFrames(connection, head);

      await markPresence(connection).catch(() => {});
      queueSync(connection);
      await connection.syncQueue;
      const latest = (
        await pool.query(
          `SELECT status,document,document_revision
             FROM interview_rooms WHERE id=$1`,
          [connection.roomId],
        )
      ).rows[0];
      if (latest) {
        connection.status = latest.status;
        connection.document = latest.document;
        connection.documentRevision = Number(latest.document_revision);
      }
      sendJson(connection, {
        type: "snapshot",
        room: {
          id: connection.roomId,
          status: connection.status,
          document: connection.document,
          documentRevision: connection.documentRevision,
        },
        role: connection.role,
        cursor: connection.cursor,
        presence: await presenceSnapshot(connection.roomId).catch(() => []),
      });
      sendJson(connection, { type: "ready", cursor: connection.cursor });

      connection.pingTimer = setInterval(() => {
        if (connection.closed) return;
        if (Date.now() - connection.lastPongAt > presenceTtlMs * 2) {
          sendClose(connection, 1001, "Heartbeat timeout");
          return;
        }
        connection.socket.write(frame(0x9, Buffer.from(String(Date.now()))));
        void refreshConnectionLease(connection);
      }, 20_000);
    })().catch(() => {
      httpError(socket, 500, "Internal Server Error");
    });
  };

  app.server.on("upgrade", handleUpgrade);
  app.addHook("onClose", async () => {
    app.server.off("upgrade", handleUpgrade);
    for (const connections of rooms.values())
      for (const connection of connections) {
        connection.closed = true;
        if (connection.pingTimer) clearInterval(connection.pingTimer);
        connection.socket.destroy();
      }
    rooms.clear();
    if (eventListener) {
      eventListener.removeAllListeners("notification");
      await eventListener.query(`UNLISTEN ${eventChannel}`).catch(() => {});
      eventListener.release();
    }
    if (presenceSubscriber) {
      presenceSubscriber.removeAllListeners();
      presenceSubscriber.disconnect();
    }
  });
}
