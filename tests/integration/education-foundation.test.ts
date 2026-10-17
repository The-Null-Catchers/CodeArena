import { describe, expect, it } from "vitest";
import pg from "pg";

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgresql://codearena:development-db-password@localhost:5432/codearena",
});

describe("education schema foundation", () => {
  it("isolates course enrollment, deadlines and attempt limits with database constraints", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const userId = (await client.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'unused') RETURNING id",
        [`education-${crypto.randomUUID()}@example.com`],
      )).rows[0].id;
      const orgId = (await client.query(
        "INSERT INTO organizations(name) VALUES('Education integration test') RETURNING id",
      )).rows[0].id;
      const projectId = (await client.query(
        "INSERT INTO projects(organization_id,name) VALUES($1,'Education project') RETURNING id",
        [orgId],
      )).rows[0].id;
      const courseId = (await client.query(
        "INSERT INTO education_courses(project_id,created_by,title) VALUES($1,$2,'Intro to coding') RETURNING id,status",
        [projectId,userId],
      )).rows[0].id;
      await client.query(
        "INSERT INTO education_enrollments(course_id,user_id) VALUES($1,$2)",
        [courseId,userId],
      );
      const assignment = (await client.query(
        "INSERT INTO education_assignments(course_id,title,max_attempts,due_at) VALUES($1,'Arrays',3,now()+interval '2 days') RETURNING id,max_attempts,due_at,status",
        [courseId],
      )).rows[0];
      expect(assignment.max_attempts).toBe(3);
      expect(assignment.due_at).toBeTruthy();
      expect(assignment.status).toBe("draft");
      expect(Number((await client.query(
        "SELECT count(*) AS total FROM education_enrollments WHERE course_id=$1",
        [courseId],
      )).rows[0].total)).toBe(1);
      await client.query("SAVEPOINT invalid_attempts");
      await expect(client.query(
        "UPDATE education_assignments SET max_attempts=0 WHERE id=$1",
        [assignment.id],
      )).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK TO SAVEPOINT invalid_attempts");
      await client.query("SAVEPOINT duplicate_enrollment");
      await expect(client.query(
        "INSERT INTO education_enrollments(course_id,user_id) VALUES($1,$2)",
        [courseId,userId],
      )).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_enrollment");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
