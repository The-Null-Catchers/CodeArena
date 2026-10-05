import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../../packages/db/src/index.js";
import { redis } from "../../../packages/shared/src/events.js";
import { actor } from "./auth.js";

const roomId = z.string().uuid();
const presenceTtlMs = 45_000;

async function requireParticipant(
  req: Parameters<typeof actor>[0],
  room: string,
) {
  const a = await actor(req);
  if (!a.userId)
    throw Object.assign(new Error("User session required"), { statusCode: 403 });
  const participant = (
    await pool.query(
      `SELECT p.role,r.status
         FROM interview_room_participants p
         JOIN interview_rooms r ON r.id=p.room_id
        WHERE p.room_id=$1 AND p.user_id=$2`,
      [room, a.userId],
    )
  ).rows[0];
  if (!participant)
    throw Object.assign(new Error("Interview room not found"), {
      statusCode: 404,
    });
  return { userId: a.userId, role: participant.role as string, status: participant.status as string };
}

function keys(room: string) {
  return {
    live: `interview:presence:${room}:live`,
    details: `interview:presence:${room}:details`,
  };
}

async function listPresence(room: string) {
  const now = Date.now();
  const { live, details } = keys(room);
  await redis.zremrangebyscore(live, "-inf", now);
  const userIds = await redis.zrangebyscore(live, now + 1, "+inf");
  if (!userIds.length) return [];
  const payloads = await redis.hmget(details, ...userIds);
  return payloads.flatMap((payload) => {
    if (!payload) return [];
    try {
      const parsed = JSON.parse(payload) as {
        userId: string;
        role: string;
        state: string;
        lastSeenAt: string;
      };
      return [parsed];
    } catch {
      return [];
    }
  });
}

export function registerInterviewPresence(app: FastifyInstance) {
  app.post("/v1/interview-rooms/:id/presence", async (req) => {
    const id = roomId.parse((req.params as any).id);
    const current = await requireParticipant(req, id);
    if (current.status !== "active")
      throw Object.assign(new Error("Interview room ended"), {
        statusCode: 409,
      });
    const body = z
      .object({ state: z.enum(["active", "idle"]).default("active") })
      .strict()
      .parse(req.body ?? {});
    const now = Date.now();
    const entry = {
      userId: current.userId,
      role: current.role,
      state: body.state,
      lastSeenAt: new Date(now).toISOString(),
    };
    const { live, details } = keys(id);
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(live, "-inf", now);
    pipeline.zadd(live, now + presenceTtlMs, current.userId);
    pipeline.hset(details, current.userId, JSON.stringify(entry));
    pipeline.pexpire(live, presenceTtlMs * 2);
    pipeline.pexpire(details, presenceTtlMs * 2);
    await pipeline.exec();
    return { presence: entry, expiresInMs: presenceTtlMs };
  });

  app.get("/v1/interview-rooms/:id/presence", async (req) => {
    const id = roomId.parse((req.params as any).id);
    await requireParticipant(req, id);
    return { items: await listPresence(id), expiresInMs: presenceTtlMs };
  });

  app.delete("/v1/interview-rooms/:id/presence", async (req) => {
    const id = roomId.parse((req.params as any).id);
    const current = await requireParticipant(req, id);
    const { live, details } = keys(id);
    await redis
      .multi()
      .zrem(live, current.userId)
      .hdel(details, current.userId)
      .exec();
    return { ok: true };
  });
}
