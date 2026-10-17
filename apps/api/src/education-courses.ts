import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, tx, audit } from "../../../packages/db/src/index.js";
import { actor, authorize } from "./auth.js";

const uuid = z.string().uuid();
const courseInput = z.object({
  projectId: uuid,
  title: z.string().trim().min(1).max(160),
  description: z.string().max(10000).default(""),
}).strict();

export function registerEducationCourses(app: FastifyInstance) {
  app.post("/v1/education/courses", async (req, reply) => {
    const user = await actor(req);
    if (!user.userId)
      throw Object.assign(new Error("User session required"), { statusCode: 403 });
    const body = courseInput.parse(req.body);
    await authorize(user, body.projectId, "submissions:write", true);
    const course = await tx(async (client) => {
      const row = (await client.query(
        `INSERT INTO education_courses(project_id,created_by,title,description)
         VALUES($1,$2,$3,$4)
         RETURNING id,project_id,created_by,title,description,status,created_at,updated_at`,
        [body.projectId, user.userId, body.title, body.description],
      )).rows[0];
      await audit(client, "education.course.create", user.userId!, row.id);
      return row;
    });
    reply.code(201);
    return course;
  });

  app.get("/v1/education/projects/:projectId/courses", async (req) => {
    const projectId = uuid.parse((req.params as { projectId: string }).projectId);
    const user = await actor(req);
    if (!user.userId)
      throw Object.assign(new Error("User session required"), { statusCode: 403 });
    await authorize(user, projectId, "submissions:read");
    const administrator = (await pool.query(
      `SELECT 1 FROM memberships m JOIN projects p ON p.organization_id=m.organization_id
       WHERE p.id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin')`,
      [projectId, user.userId],
    )).rowCount !== 0;
    const result = await pool.query(
      `SELECT c.id,c.project_id,c.title,c.description,c.status,c.created_at,c.updated_at
       FROM education_courses c
       WHERE c.project_id=$1 AND (
         $2::boolean OR
         (c.status='published' AND EXISTS (
           SELECT 1 FROM education_enrollments e
           WHERE e.course_id=c.id AND e.user_id=$3
         ))
       )
       ORDER BY c.created_at DESC,c.id DESC LIMIT 100`,
      [projectId, administrator, user.userId],
    );
    return { items: result.rows };
  });
}
