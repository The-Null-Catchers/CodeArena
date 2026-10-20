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
