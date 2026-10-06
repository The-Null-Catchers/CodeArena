import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../../packages/db/src/index.js";
import { actor } from "./auth.js";

const roomId = z.string().uuid();

async function requireUser(req: Parameters<typeof actor>[0]) {
  const a = await actor(req);
  if (!a.userId)
    throw Object.assign(new Error("User session required"), { statusCode: 403 });
  return { ...a, userId: a.userId };
}

export function registerInterviewParticipantDirectory(app: FastifyInstance) {
  app.get("/v1/interview-rooms/:id/participants", async (req) => {
    const a = await requireUser(req);
    const id = roomId.parse((req.params as any).id);
    const current = (
      await pool.query(
        `SELECT role
           FROM interview_room_participants
          WHERE room_id=$1 AND user_id=$2`,
        [id, a.userId],
      )
    ).rows[0];
    if (!current)
      throw Object.assign(new Error("Interview room not found"), {
        statusCode: 404,
      });
    if (current.role !== "interviewer")
      throw Object.assign(
        new Error("Only interviewers can view the participant directory"),
        { statusCode: 403 },
      );

    const rows = await pool.query(
      `SELECT p.user_id,p.role,p.invited_by,p.joined_at,u.email,u.disabled
         FROM interview_room_participants p
         JOIN users u ON u.id=p.user_id
        WHERE p.room_id=$1
        ORDER BY CASE p.role
          WHEN 'interviewer' THEN 0
          WHEN 'candidate' THEN 1
          ELSE 2
        END,p.joined_at,p.user_id`,
      [id],
    );
    return { items: rows.rows };
  });
}
