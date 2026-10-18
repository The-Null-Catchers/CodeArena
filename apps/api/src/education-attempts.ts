import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tx, audit } from "../../../packages/db/src/index.js";
import { actor, authorize } from "./auth.js";

const uuid = z.string().uuid();
const reject = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

export function registerEducationAttempts(app: FastifyInstance) {
  app.post("/v1/education/assignments/:assignmentId/attempts", async (req, reply) => {
    const { assignmentId } = z.object({ assignmentId: uuid }).parse(req.params);
    z.object({}).strict().parse(req.body ?? {});
    const user = await actor(req);
    if (!user.userId) throw reject("User session required", 403);
    // Obtain the assignment lock before counting attempts: concurrent submissions
    // for the same assignment are serialized even across different API processes.
    const attempt = await tx(async (client) => {
      const assignment = (await client.query(
        `SELECT a.id,a.status,a.max_attempts,a.due_at,c.project_id,c.status AS course_status
           FROM education_assignments a JOIN education_courses c ON c.id=a.course_id
          WHERE a.id=$1 FOR UPDATE OF a`,
        [assignmentId],
      )).rows[0];
      if (!assignment) throw reject("Assignment not found", 404);
      await authorize(user, assignment.project_id, "submissions:read");
      if (assignment.status !== "published" || assignment.course_status !== "published")
        throw reject("Assignment is not available", 403);
      const enrolled = await client.query(
        `SELECT 1 FROM education_enrollments e
          JOIN education_assignments a ON a.course_id=e.course_id
         WHERE a.id=$1 AND e.user_id=$2`,
        [assignmentId, user.userId],
      );
      if (!enrolled.rowCount) throw reject("Enrollment required", 403);
      if (assignment.due_at && new Date(assignment.due_at).getTime() <= Date.now())
        throw reject("Assignment deadline passed", 409);
      const count = Number((await client.query(
        "SELECT count(*) AS n FROM education_assignment_attempts WHERE assignment_id=$1 AND user_id=$2",
        [assignmentId, user.userId],
      )).rows[0].n);
      if (count >= assignment.max_attempts)
        throw reject("Attempt limit reached", 409);
      const row = (await client.query(
        `INSERT INTO education_assignment_attempts(assignment_id,user_id,attempt_number)
         VALUES($1,$2,$3)
         RETURNING id,assignment_id,user_id,attempt_number,submitted_at`,
        [assignmentId, user.userId, count + 1],
      )).rows[0];
      await audit(client, "education.assignment.attempt.create", user.userId!, row.id);
      return row;
    });
    reply.code(201);
    return attempt;
  });
}
