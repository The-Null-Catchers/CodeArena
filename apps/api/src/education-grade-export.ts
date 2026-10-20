import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../../packages/db/src/index.js";
import { actor, authorize } from "./auth.js";

const uuid = z.string().uuid();
const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  // Spreadsheet applications may interpret imported cells as formulas.
  const safe = /^\s*[=+@-]/.test(raw) ? "'" + raw : raw;
  return '"' + safe.replaceAll('"', '""') + '"';
};

export function registerEducationGradeExports(app: FastifyInstance) {
  app.get("/v1/education/assignments/:assignmentId/grades", async (req) => {
    const assignmentId = uuid.parse((req.params as { assignmentId: string }).assignmentId);
    const user = await actor(req);
    if (!user.userId)
      throw Object.assign(new Error("User session required"), { statusCode: 403 });
    const assignment = (await pool.query(
      `SELECT c.project_id FROM education_assignments a
         JOIN education_courses c ON c.id=a.course_id WHERE a.id=$1`,
      [assignmentId],
    )).rows[0];
    if (!assignment)
      throw Object.assign(new Error("Assignment not found"), { statusCode: 404 });
    await authorize(user, assignment.project_id, "submissions:read", true);
    // Preserve enrolled learners without completed attempts. Only completed
    // executions contribute to a score; instructor overrides take precedence.
    const result = await pool.query(
      `SELECT e.user_id,
              COALESCE(stats.attempt_count,0)::int AS attempt_count,
              COALESCE(stats.completed_count,0)::int AS completed_count,
              stats.best_score
         FROM education_assignments a
         JOIN education_enrollments e ON e.course_id=a.course_id
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS attempt_count,
                  count(*) FILTER (WHERE s.state='completed' AND r.submission_id IS NOT NULL)::int
                    AS completed_count,
                  max(CASE WHEN s.state='completed' AND r.submission_id IS NOT NULL
                    THEN COALESCE(g.score::numeric,r.score::numeric) END) AS best_score
             FROM education_assignment_attempts at
             LEFT JOIN submissions s ON s.id=at.submission_id
             LEFT JOIN submission_results r ON r.submission_id=s.id
             LEFT JOIN education_grade_overrides g ON g.attempt_id=at.id
            WHERE at.assignment_id=a.id AND at.user_id=e.user_id
         ) stats ON true
        WHERE a.id=$1
        ORDER BY e.user_id LIMIT 10000`,
      [assignmentId],
    );
    return { assignmentId, policy: "best_completed_attempt", items: result.rows };
  });

  app.get("/v1/education/assignments/:assignmentId/grades.csv", async (req, reply) => {
    const assignmentId = uuid.parse((req.params as { assignmentId: string }).assignmentId);
    const user = await actor(req);
    if (!user.userId)
      throw Object.assign(new Error("User session required"), { statusCode: 403 });
    const assignment = (await pool.query(
      `SELECT c.project_id FROM education_assignments a
       JOIN education_courses c ON c.id=a.course_id WHERE a.id=$1`, [assignmentId],
    )).rows[0];
    if (!assignment)
      throw Object.assign(new Error("Assignment not found"), { statusCode: 404 });
    await authorize(user, assignment.project_id, "submissions:read", true);
    const rows = (await pool.query(
      `SELECT at.user_id,at.id AS attempt_id,at.attempt_number,at.submitted_at,
              at.submission_id,s.state AS execution_state,
              CASE WHEN s.state='completed' THEN r.verdict END AS verdict,
              CASE WHEN s.state='completed' THEN r.score END AS engine_score,
              CASE WHEN s.state='completed' THEN g.score END AS override_score,
              CASE WHEN s.state='completed' THEN COALESCE(g.score::numeric,r.score::numeric) END AS effective_score
       FROM education_assignment_attempts at
       LEFT JOIN submissions s ON s.id=at.submission_id
       LEFT JOIN submission_results r ON r.submission_id=s.id
       LEFT JOIN education_grade_overrides g ON g.attempt_id=at.id
       WHERE at.assignment_id=$1
       ORDER BY at.user_id,at.attempt_number
       LIMIT 10000`, [assignmentId],
    )).rows;
    const columns = ["user_id","attempt_id","attempt_number","submitted_at","submission_id",
      "execution_state","verdict","engine_score","override_score","effective_score"] as const;
    const csv = [columns.join(","), ...rows.map(row =>
      columns.map(key => csvCell(row[key] instanceof Date ? row[key].toISOString() : row[key])).join(","),
    )].join("\r\n") + "\r\n";
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="assignment-${assignmentId}-grades.csv"`)
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(csv);
  });
}
