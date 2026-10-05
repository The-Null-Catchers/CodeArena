import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, pool, tx } from "../../../packages/db/src/index.js";
import { actor, authorize } from "./auth.js";

const roomId = z.string().uuid();
const participantRole = z.enum(["interviewer", "candidate", "observer"]);

async function requireUser(req: Parameters<typeof actor>[0]) {
  const a = await actor(req);
  if (!a.userId)
    throw Object.assign(new Error("User session required"), { statusCode: 403 });
  return { ...a, userId: a.userId };
}

async function participant(room: string, userId: string) {
  const row = (
    await pool.query(
      `SELECT r.id,r.project_id,r.created_by,r.title,r.runtime_id,r.challenge_id,r.status,
              r.document,r.document_revision,r.created_at,r.ended_at,p.role
         FROM interview_rooms r
         JOIN interview_room_participants p ON p.room_id=r.id
        WHERE r.id=$1 AND p.user_id=$2`,
      [room, userId],
    )
  ).rows[0];
  if (!row) throw Object.assign(new Error("Interview room not found"), { statusCode: 404 });
  return row;
}

export function registerInterviewRooms(app: FastifyInstance) {
  app.post("/v1/interview-rooms", async (req, reply) => {
    const a = await requireUser(req);
    const body = z
      .object({
        projectId: z.string().uuid(),
        title: z.string().trim().min(1).max(120),
        runtimeId: z.string().min(1).max(100).nullable().optional(),
        challengeId: z.string().uuid().nullable().optional(),
      })
      .strict()
      .parse(req.body);
    await authorize(a, body.projectId, "submissions:write");

    const room = await tx(async (client) => {
      if (body.runtimeId) {
        const runtime = await client.query("SELECT 1 FROM runtimes WHERE id=$1 AND enabled", [body.runtimeId]);
        if (!runtime.rowCount)
          throw Object.assign(new Error("Runtime not available"), { statusCode: 400 });
      }
      if (body.challengeId) {
        const challenge = await client.query(
          "SELECT 1 FROM challenges WHERE id=$1 AND (project_id=$2 OR visibility='public')",
          [body.challengeId, body.projectId],
        );
        if (!challenge.rowCount)
          throw Object.assign(new Error("Challenge not available"), { statusCode: 400 });
      }
      const created = (
        await client.query(
          `INSERT INTO interview_rooms(project_id,created_by,title,runtime_id,challenge_id)
           VALUES($1,$2,$3,$4,$5)
           RETURNING id,project_id,created_by,title,runtime_id,challenge_id,status,document,document_revision,created_at,ended_at`,
          [body.projectId, a.userId, body.title, body.runtimeId ?? null, body.challengeId ?? null],
        )
      ).rows[0];
      await client.query(
        "INSERT INTO interview_room_participants(room_id,user_id,role,invited_by) VALUES($1,$2,'interviewer',$2)",
        [created.id, a.userId],
      );
      await client.query(
        "INSERT INTO interview_room_events(room_id,actor_user_id,kind,payload) VALUES($1,$2,'room.created',$3)",
        [created.id, a.userId, JSON.stringify({ title: body.title })],
      );
      await audit(client, "interview_room.create", a.userId, created.id);
      return { ...created, role: "interviewer" };
    });
    reply.code(201);
    return room;
  });

  app.get("/v1/interview-rooms", async (req) => {
    const a = await requireUser(req);
    const query = z
      .object({ projectId: z.string().uuid().optional(), status: z.enum(["active", "ended"]).optional() })
      .parse(req.query);
    const values: unknown[] = [a.userId];
    const where = ["p.user_id=$1"];
    if (query.projectId) {
      values.push(query.projectId);
      where.push(`r.project_id=$${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`r.status=$${values.length}`);
    }
    const rows = await pool.query(
      `SELECT r.id,r.project_id,r.created_by,r.title,r.runtime_id,r.challenge_id,r.status,
              r.document_revision,r.created_at,r.ended_at,p.role
         FROM interview_rooms r
         JOIN interview_room_participants p ON p.room_id=r.id
        WHERE ${where.join(" AND ")}
        ORDER BY r.created_at DESC,r.id DESC
        LIMIT 100`,
      values,
    );
    return { items: rows.rows };
  });

  app.get("/v1/interview-rooms/:id", async (req) => {
    const a = await requireUser(req);
    return participant(roomId.parse((req.params as any).id), a.userId);
  });

  app.post("/v1/interview-rooms/:id/participants", async (req, reply) => {
    const a = await requireUser(req);
    const id = roomId.parse((req.params as any).id);
    const current = await participant(id, a.userId);
    if (current.role !== "interviewer")
      throw Object.assign(new Error("Only interviewers can add participants"), { statusCode: 403 });
    const body = z
      .object({ userId: z.string().uuid(), role: participantRole })
      .strict()
      .parse(req.body);
    const added = await tx(async (client) => {
      const user = await client.query("SELECT 1 FROM users WHERE id=$1 AND NOT disabled", [body.userId]);
      if (!user.rowCount) throw Object.assign(new Error("User not available"), { statusCode: 400 });
      const row = (
        await client.query(
          `INSERT INTO interview_room_participants(room_id,user_id,role,invited_by)
           VALUES($1,$2,$3,$4)
           ON CONFLICT(room_id,user_id) DO UPDATE SET role=EXCLUDED.role,invited_by=EXCLUDED.invited_by
           RETURNING room_id,user_id,role,joined_at`,
          [id, body.userId, body.role, a.userId],
        )
      ).rows[0];
      await client.query(
        "INSERT INTO interview_room_events(room_id,actor_user_id,kind,payload) VALUES($1,$2,'participant.added',$3)",
        [id, a.userId, JSON.stringify({ userId: body.userId, role: body.role })],
      );
      await audit(client, "interview_room.participant.add", a.userId, id, {
        participantUserId: body.userId,
        role: body.role,
      });
      return row;
    });
    reply.code(201);
    return added;
  });

  app.patch("/v1/interview-rooms/:id/document", async (req) => {
    const a = await requireUser(req);
    const id = roomId.parse((req.params as any).id);
    const current = await participant(id, a.userId);
    if (current.status !== "active")
      throw Object.assign(new Error("Interview room ended"), { statusCode: 409 });
    const body = z
      .object({ document: z.string().max(200000), expectedRevision: z.number().int().min(0) })
      .strict()
      .parse(req.body);
    return tx(async (client) => {
      const updated = (
        await client.query(
          `UPDATE interview_rooms
              SET document=$1,document_revision=document_revision+1
            WHERE id=$2 AND status='active' AND document_revision=$3
            RETURNING document,document_revision`,
          [body.document, id, body.expectedRevision],
        )
      ).rows[0];
      if (!updated)
        throw Object.assign(new Error("Document revision conflict"), { statusCode: 409 });
      const event = (
        await client.query(
          `INSERT INTO interview_room_events(room_id,actor_user_id,kind,payload)
           VALUES($1,$2,'document.updated',$3) RETURNING id,created_at`,
          [id, a.userId, JSON.stringify({ revision: updated.document_revision })],
        )
      ).rows[0];
      return { ...updated, eventId: event.id, updatedAt: event.created_at };
    });
  });

  app.get("/v1/interview-rooms/:id/events", async (req) => {
    const a = await requireUser(req);
    const id = roomId.parse((req.params as any).id);
    await participant(id, a.userId);
    const query = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const rows = await pool.query(
      `SELECT id,actor_user_id,kind,payload,created_at
         FROM interview_room_events
        WHERE room_id=$1 AND id>$2
        ORDER BY id ASC
        LIMIT 500`,
      [id, query.after],
    );
    return { items: rows.rows };
  });

  app.get("/v1/interview-rooms/:id/private-notes", async (req) => {
    const a = await requireUser(req);
    const id = roomId.parse((req.params as any).id);
    const current = await participant(id, a.userId);
    if (current.role !== "interviewer")
      throw Object.assign(new Error("Private notes are interviewer-only"), { statusCode: 403 });
    const rows = await pool.query(
      `SELECT id,body,created_at,updated_at
         FROM interview_private_notes
        WHERE room_id=$1 AND author_user_id=$2
        ORDER BY updated_at DESC,id`,
      [id, a.userId],
    );
    return { items: rows.rows };
  });

  app.post("/v1/interview-rooms/:id/private-notes", async (req, reply) => {
    const a = await requireUser(req);
    const id = roomId.parse((req.params as any).id);
    const current = await participant(id, a.userId);
    if (current.role !== "interviewer")
      throw Object.assign(new Error("Private notes are interviewer-only"), { statusCode: 403 });
    const body = z.object({ body: z.string().max(20000) }).strict().parse(req.body);
    const row = (
      await pool.query(
        `INSERT INTO interview_private_notes(room_id,author_user_id,body)
         VALUES($1,$2,$3) RETURNING id,body,created_at,updated_at`,
        [id, a.userId, body.body],
      )
    ).rows[0];
    reply.code(201);
    return row;
  });

  app.post("/v1/interview-rooms/:id/end", async (req) => {
    const a = await requireUser(req);
    const id = roomId.parse((req.params as any).id);
    const current = await participant(id, a.userId);
    if (current.role !== "interviewer")
      throw Object.assign(new Error("Only interviewers can end rooms"), { statusCode: 403 });
    return tx(async (client) => {
      const ended = (
        await client.query(
          `UPDATE interview_rooms SET status='ended',ended_at=COALESCE(ended_at,now())
            WHERE id=$1 RETURNING status,ended_at`,
          [id],
        )
      ).rows[0];
      await client.query(
        "INSERT INTO interview_room_events(room_id,actor_user_id,kind,payload) VALUES($1,$2,'room.ended','{}')",
        [id, a.userId],
      );
      await audit(client, "interview_room.end", a.userId, id);
      return ended;
    });
  });
}
