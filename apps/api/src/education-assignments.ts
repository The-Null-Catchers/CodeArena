import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, tx, audit } from "../../../packages/db/src/index.js";
import { actor, authorize } from "./auth.js";

const uuid = z.string().uuid();
const assignmentInput = z.object({
  title: z.string().trim().min(1).max(160),
  instructions: z.string().max(20000).default(""),
  dueAt: z.string().datetime({ offset: true }).nullable().default(null),
  maxAttempts: z.number().int().min(1).max(100).default(1),
  challengeId: uuid.nullable().default(null),
}).strict();
const notFound = () => Object.assign(new Error("Course not found"), { statusCode: 404 });
const forbidden = () => Object.assign(new Error("User session required"), { statusCode: 403 });

async function courseProjectId(courseId: string) {
  const course = (await pool.query("SELECT project_id FROM education_courses WHERE id=$1", [courseId])).rows[0];
  if (!course) throw notFound();
  return course.project_id as string;
}

export function registerEducationAssignments(app: FastifyInstance) {
  app.post("/v1/education/courses/:courseId/assignments", async (req, reply) => {
    const courseId = uuid.parse((req.params as { courseId: string }).courseId);
    const input = assignmentInput.parse(req.body);
    const user = await actor(req);
    if (!user.userId) throw forbidden();
    const projectId = await courseProjectId(courseId);
    await authorize(user, projectId, "submissions:write", true);
    const assignment = await tx(async (client) => {
      if (input.challengeId) {
        const available = await client.query(
          `SELECT 1 FROM challenges WHERE id=$1 AND status='published'
             AND (project_id=$2 OR visibility='public')`,
          [input.challengeId, projectId],
        );
        if (!available.rowCount)
          throw Object.assign(new Error("Published challenge unavailable for project"), { statusCode: 400 });
      }
      const result = await client.query(
        `INSERT INTO education_assignments(course_id,title,instructions,due_at,max_attempts,challenge_id)
         VALUES($1,$2,$3,$4,$5,$6)
         RETURNING id,course_id,title,instructions,status,due_at,max_attempts,challenge_id,created_at,updated_at`,
        [courseId, input.title, input.instructions, input.dueAt, input.maxAttempts, input.challengeId],
      );
      const row = result.rows[0];
      await audit(client, "education.assignment.create", user.userId!, row.id);
      return row;
    });
    reply.code(201);
    return assignment;
  });

  app.patch("/v1/education/courses/:courseId/assignments/:assignmentId/status", async (req) => {
    const { courseId, assignmentId } = z.object({ courseId: uuid, assignmentId: uuid }).parse(req.params);
    const { status } = z.object({ status: z.enum(["draft", "published", "archived"]) }).strict().parse(req.body);
    const user = await actor(req);
    if (!user.userId) throw forbidden();
    const projectId = await courseProjectId(courseId);
    await authorize(user, projectId, "submissions:write", true);
    return tx(async (client) => {
      const current = (await client.query(
        "SELECT id,status FROM education_assignments WHERE id=$1 AND course_id=$2 FOR UPDATE",
        [assignmentId, courseId],
      )).rows[0];
      if (!current) throw Object.assign(new Error("Assignment not found"), { statusCode: 404 });
      if (current.status === "archived" && status !== "archived")
        throw Object.assign(new Error("Archived assignment cannot be reopened"), { statusCode: 409 });
      const row = (await client.query(
        "UPDATE education_assignments SET status=$3,updated_at=now() WHERE id=$1 AND course_id=$2 RETURNING id,course_id,status,updated_at",
        [assignmentId, courseId, status],
      )).rows[0];
      if (current.status !== status)
        await audit(client, "education.assignment.status", user.userId!, assignmentId);
      return row;
    });
  });

  app.get("/v1/education/courses/:courseId/assignments", async (req) => {
    const courseId = uuid.parse((req.params as { courseId: string }).courseId);
    const user = await actor(req);
    if (!user.userId) throw forbidden();
    const projectId = await courseProjectId(courseId);
    await authorize(user, projectId, "submissions:read");
    const admin = (await pool.query(
      `SELECT 1 FROM projects p JOIN memberships m ON m.organization_id=p.organization_id
       WHERE p.id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin')`,
      [projectId, user.userId],
    )).rowCount !== 0;
    if (!admin) {
      const permitted = (await pool.query(
        `SELECT 1 FROM education_courses c
         JOIN education_enrollments e ON e.course_id=c.id
         WHERE c.id=$1 AND c.status='published' AND e.user_id=$2`,
        [courseId, user.userId],
      )).rowCount !== 0;
      if (!permitted)
        throw Object.assign(new Error("Course enrollment required"), { statusCode: 403 });
    }
    const result = await pool.query(
      `SELECT id,course_id,title,instructions,status,due_at,max_attempts,challenge_id,created_at,updated_at
       FROM education_assignments WHERE course_id=$1 AND ($2::boolean OR status='published')
       ORDER BY created_at DESC,id DESC LIMIT 100`,
      [courseId, admin],
    );
    return { items: result.rows };
  });
}
