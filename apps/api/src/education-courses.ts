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
  app.patch("/v1/education/courses/:courseId/status", async (req) => {
    const courseId = uuid.parse((req.params as { courseId: string }).courseId);
    const { status } = z.object({
      status: z.enum(["draft", "published", "archived"]),
    }).strict().parse(req.body);
    const user = await actor(req);
    if (!user.userId)
      throw Object.assign(new Error("User session required"), { statusCode: 403 });
    const course = (await pool.query(
      "SELECT project_id FROM education_courses WHERE id=$1", [courseId],
    )).rows[0];
    if (!course)
      throw Object.assign(new Error("Course not found"), { statusCode: 404 });
    await authorize(user, course.project_id, "submissions:write", true);
    return tx(async (client) => {
      const existing = (await client.query(
        "SELECT status FROM education_courses WHERE id=$1 FOR UPDATE", [courseId],
      )).rows[0];
      if (!existing)
        throw Object.assign(new Error("Course not found"), { statusCode: 404 });
      if (existing.status === "archived" && status !== "archived")
        throw Object.assign(new Error("Archived course cannot be reopened"), { statusCode: 409 });
      const updated = (await client.query(
        `UPDATE education_courses SET status=$2,updated_at=now()
          WHERE id=$1 RETURNING id,project_id,title,description,status,created_at,updated_at`,
        [courseId, status],
      )).rows[0];
      if (existing.status !== status)
        await audit(client, "education.course.status", user.userId!, courseId, {
          from: existing.status, to: status,
        });
      return updated;
    });
  });

  app.patch("/v1/education/courses/:courseId", async (req) => {
    const courseId = uuid.parse((req.params as { courseId: string }).courseId);
    const input = z.object({
      title: z.string().trim().min(1).max(160).optional(),
      description: z.string().max(10000).optional(),
    }).strict().refine((value) => value.title !== undefined || value.description !== undefined,
      "At least one field must be provided").parse(req.body);
    const user = await actor(req);
    if (!user.userId)
      throw Object.assign(new Error("User session required"), { statusCode: 403 });
    const course = (await pool.query(
      "SELECT project_id FROM education_courses WHERE id=$1", [courseId],
    )).rows[0];
    if (!course)
      throw Object.assign(new Error("Course not found"), { statusCode: 404 });
    await authorize(user, course.project_id, "submissions:write", true);
    return tx(async (client) => {
      const existing = (await client.query(
        "SELECT title,description,status FROM education_courses WHERE id=$1 FOR UPDATE", [courseId],
      )).rows[0];
      if (!existing)
        throw Object.assign(new Error("Course not found"), { statusCode: 404 });
      if (existing.status === "archived")
        throw Object.assign(new Error("Archived course cannot be edited"), { statusCode: 409 });
      const title = input.title ?? existing.title;
      const description = input.description ?? existing.description;
      if (title === existing.title && description === existing.description)
        return (await client.query(
          "SELECT id,project_id,title,description,status,created_at,updated_at FROM education_courses WHERE id=$1",
          [courseId],
        )).rows[0];
      const updated = (await client.query(
        `UPDATE education_courses SET title=$2,description=$3,updated_at=now()
         WHERE id=$1 RETURNING id,project_id,title,description,status,created_at,updated_at`,
        [courseId, title, description],
      )).rows[0];
      await audit(client, "education.course.update", user.userId!, courseId, {
        titleChanged: title !== existing.title,
        descriptionChanged: description !== existing.description,
      });
      return updated;
    });
  });

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

  app.post("/v1/education/courses/:courseId/enrollments", async (req, reply) => {
    const courseId = uuid.parse((req.params as { courseId: string }).courseId);
    const body = z.object({ userId: uuid }).strict().parse(req.body);
    const user = await actor(req);
    if (!user.userId)
      throw Object.assign(new Error("User session required"), { statusCode: 403 });
    const course = (await pool.query(
      "SELECT project_id FROM education_courses WHERE id=$1",
      [courseId],
    )).rows[0];
    if (!course)
      throw Object.assign(new Error("Course not found"), { statusCode: 404 });
    await authorize(user, course.project_id, "submissions:write", true);
    const result = await tx(async (client) => {
      const member = (await client.query(
        `SELECT 1 FROM memberships m JOIN projects p ON p.organization_id=m.organization_id
         WHERE p.id=$1 AND m.user_id=$2`,
        [course.project_id, body.userId],
      )).rowCount;
      if (!member)
        throw Object.assign(new Error("Learner is not a project member"), { statusCode: 400 });
      const inserted = (await client.query(
        `INSERT INTO education_enrollments(course_id,user_id) VALUES($1,$2)
         ON CONFLICT DO NOTHING RETURNING course_id,user_id,enrolled_at`,
        [courseId, body.userId],
      )).rows[0];
      if (inserted)
        await audit(client, "education.enrollment.create", user.userId!, courseId);
      return { enrolled: Boolean(inserted) };
    });
    reply.code(result.enrolled ? 201 : 200);
    return { courseId, userId: body.userId, ...result };
  });

  app.get("/v1/education/courses/:courseId/enrollments", async (req) => {
    const courseId = uuid.parse((req.params as { courseId: string }).courseId);
    const user = await actor(req);
    if (!user.userId)
      throw Object.assign(new Error("User session required"), { statusCode: 403 });
    const course = (await pool.query(
      "SELECT project_id FROM education_courses WHERE id=$1", [courseId],
    )).rows[0];
    if (!course)
      throw Object.assign(new Error("Course not found"), { statusCode: 404 });
    await authorize(user, course.project_id, "submissions:read", true);
    const result = await pool.query(
      `SELECT e.user_id,u.email,e.enrolled_at
         FROM education_enrollments e JOIN users u ON u.id=e.user_id
        WHERE e.course_id=$1 ORDER BY e.enrolled_at DESC,e.user_id DESC LIMIT 1000`,
      [courseId],
    );
    return { items: result.rows };
  });

  app.delete("/v1/education/courses/:courseId/enrollments/:userId", async (req) => {
    const params = z.object({ courseId: uuid, userId: uuid }).parse(req.params);
    const user = await actor(req);
    if (!user.userId)
      throw Object.assign(new Error("User session required"), { statusCode: 403 });
    const course = (await pool.query(
      "SELECT project_id FROM education_courses WHERE id=$1",
      [params.courseId],
    )).rows[0];
    if (!course)
      throw Object.assign(new Error("Course not found"), { statusCode: 404 });
    await authorize(user, course.project_id, "submissions:write", true);
    const removed = await tx(async (client) => {
      const row = await client.query(
        "DELETE FROM education_enrollments WHERE course_id=$1 AND user_id=$2 RETURNING user_id",
        [params.courseId, params.userId],
      );
      if (row.rowCount)
        await audit(client, "education.enrollment.delete", user.userId!, params.courseId);
      return Boolean(row.rowCount);
    });
    return { removed };
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
