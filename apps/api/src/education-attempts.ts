import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, tx, audit } from "../../../packages/db/src/index.js";
import { actor, authorize } from "./auth.js";

const uuid = z.string().uuid();
const reject = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

export function registerEducationAttempts(app: FastifyInstance) {
  app.put("/v1/education/attempts/:attemptId/grade-override", async (req) => {
    const { attemptId } = z.object({ attemptId: uuid }).parse(req.params);
    const body = z.object({
      score: z.number().finite().min(0).max(100),
      reason: z.string().trim().min(1).max(2000),
    }).strict().parse(req.body);
    const user = await actor(req);
    if (!user.userId) throw reject("User session required", 403);
    return tx(async (client) => {
      const attempt = (await client.query(
        `SELECT at.id,c.project_id,s.state,at.submission_id
           FROM education_assignment_attempts at
           JOIN education_assignments a ON a.id=at.assignment_id
           JOIN education_courses c ON c.id=a.course_id
           LEFT JOIN submissions s ON s.id=at.submission_id
          WHERE at.id=$1 FOR UPDATE OF at`, [attemptId],
      )).rows[0];
      if (!attempt) throw reject("Attempt not found", 404);
      await authorize(user, attempt.project_id, "submissions:write", true);
      if (!attempt.submission_id || attempt.state !== "completed")
        throw reject("Completed execution required", 409);
      const previous = (await client.query(
        "SELECT score,reason FROM education_grade_overrides WHERE attempt_id=$1",
        [attemptId],
      )).rows[0];
      await client.query(
        `INSERT INTO education_grade_overrides(attempt_id,score,reason,updated_by)
         VALUES($1,$2,$3,$4) ON CONFLICT (attempt_id)
         DO UPDATE SET score=EXCLUDED.score,reason=EXCLUDED.reason,
                       updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [attemptId, body.score, body.reason, user.userId],
      );
      await client.query(
        `INSERT INTO education_grade_override_events(attempt_id,score,reason,actor_id)
         VALUES($1,$2,$3,$4)`,
        [attemptId, body.score, body.reason, user.userId],
      );
      await audit(client, "education.grade.override", user.userId!, attemptId, {
        previousScore: previous?.score ?? null, score: body.score,
        reason: body.reason,
      });
      return { attemptId, score: body.score, reason: body.reason };
    });
  });

  app.get("/v1/education/attempts/:attemptId/grade-override/history", async (req) => {
    const { attemptId } = z.object({ attemptId: uuid }).parse(req.params);
    const user = await actor(req);
    if (!user.userId) throw reject("User session required", 403);
    const row = (await pool.query(
      `SELECT c.project_id FROM education_assignment_attempts at
         JOIN education_assignments a ON a.id=at.assignment_id
         JOIN education_courses c ON c.id=a.course_id WHERE at.id=$1`, [attemptId],
    )).rows[0];
    if (!row) throw reject("Attempt not found", 404);
    await authorize(user, row.project_id, "submissions:read", true);
    const history = await pool.query(
      `SELECT id,score,reason,actor_id,recorded_at FROM education_grade_override_events
         WHERE attempt_id=$1 ORDER BY id DESC LIMIT 100`, [attemptId],
    );
    return { items: history.rows };
  });

  app.put("/v1/education/attempts/:attemptId/submission", async (req) => {
    const { attemptId } = z.object({ attemptId: uuid }).parse(req.params);
    const { submissionId } = z.object({ submissionId: uuid }).strict().parse(req.body);
    const user = await actor(req);
    if (!user.userId) throw reject("User session required", 403);
    return tx(async (client) => {
      const attempt = (await client.query(
        `SELECT at.id,at.user_id,at.submission_id,at.submitted_at,a.challenge_id,c.project_id
         FROM education_assignment_attempts at
         JOIN education_assignments a ON a.id=at.assignment_id
         JOIN education_courses c ON c.id=a.course_id
         WHERE at.id=$1 FOR UPDATE OF at`,
        [attemptId],
      )).rows[0];
      if (!attempt) throw reject("Attempt not found", 404);
      if (attempt.user_id !== user.userId) throw reject("Forbidden", 403);
      await authorize(user, attempt.project_id, "submissions:read");
      if (!attempt.challenge_id)
        throw reject("Assignment has no linked challenge", 409);
      if (attempt.submission_id) {
        if (attempt.submission_id !== submissionId)
          throw reject("Attempt already linked", 409);
        return { attemptId, submissionId, linked: false };
      }
      const submission = (await client.query(
        `SELECT id FROM submissions
          WHERE id=$1 AND user_id=$2 AND project_id=$3
            AND mode='challenge' AND challenge_id=$4
            AND created_at>= $5`,
        [submissionId, user.userId, attempt.project_id, attempt.challenge_id, attempt.submitted_at],
      )).rows[0];
      if (!submission) throw reject("Eligible submission not found", 404);
      const result = await client.query(
        "UPDATE education_assignment_attempts SET submission_id=$2 WHERE id=$1 RETURNING id",
        [attemptId, submissionId],
      );
      if (!result.rowCount) throw reject("Attempt not found", 404);
      await audit(client, "education.attempt.submission.link", user.userId!, attemptId, { submissionId });
      return { attemptId, submissionId, linked: true };
    });
  });

  app.get("/v1/education/assignments/:assignmentId/attempts", async (req) => {
    const { assignmentId } = z.object({ assignmentId: uuid }).parse(req.params);
    const query = z.object({ userId: uuid.optional() }).strict().parse(req.query);
    const user = await actor(req);
    if (!user.userId) throw reject("User session required", 403);
    const assignment = (await pool.query(
      `SELECT c.project_id,a.course_id
         FROM education_assignments a JOIN education_courses c ON c.id=a.course_id
        WHERE a.id=$1`, [assignmentId],
    )).rows[0];
    if (!assignment) throw reject("Assignment not found", 404);
    await authorize(user, assignment.project_id, "submissions:read");
    const targetUser = query.userId ?? user.userId;
    if (targetUser !== user.userId)
      await authorize(user, assignment.project_id, "submissions:write", true);
    else {
      const enrolled = (await pool.query(
        "SELECT 1 FROM education_enrollments WHERE course_id=$1 AND user_id=$2",
        [assignment.course_id, user.userId],
      )).rowCount;
      if (!enrolled) {
        const administrator = (await pool.query(
          `SELECT 1 FROM memberships m JOIN projects p ON p.organization_id=m.organization_id
            WHERE p.id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin')`,
          [assignment.project_id, user.userId],
        )).rowCount;
        if (!administrator) throw reject("Enrollment required", 403);
      }
    }
    const result = await pool.query(
      `SELECT at.id,at.assignment_id,at.user_id,at.attempt_number,at.submitted_at,
                at.submission_id,s.state AS execution_state,
                CASE WHEN s.state='completed' THEN r.verdict END AS verdict,
                CASE WHEN s.state='completed' THEN r.score END AS score,
                CASE WHEN s.state='completed' THEN go.score END AS override_score,
                CASE WHEN s.state='completed' THEN go.reason END AS override_reason
         FROM education_assignment_attempts at
         LEFT JOIN submissions s ON s.id=at.submission_id
         LEFT JOIN submission_results r ON r.submission_id=s.id
         LEFT JOIN education_grade_overrides go ON go.attempt_id=at.id
         WHERE at.assignment_id=$1 AND at.user_id=$2
         ORDER BY at.attempt_number ASC LIMIT 100`, [assignmentId, targetUser],
    );
    return { items: result.rows };
  });

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
