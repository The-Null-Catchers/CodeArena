import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, tx, audit } from "../../../packages/db/src/index.js";
import { actor, authorize } from "./auth.js";

const languages = z.enum([
  "python",
  "javascript",
  "typescript",
  "java",
  "c",
  "cpp",
  "go",
  "rust",
]);
const judge = z.enum(["exact", "whitespace", "case_insensitive", "float"]);
const testCase = z
  .object({
    stdin: z.string().max(65536),
    expected: z.string().max(65536),
    hidden: z.boolean().default(true),
    weight: z.number().int().min(1).max(100).default(1),
    wallTimeMs: z.number().int().min(100).max(15000).optional(),
    memoryMb: z.number().int().min(32).max(512).optional(),
    group: z.string().max(80).optional(),
  })
  .strict();
const tag = z
  .string()
  .min(1)
  .max(40)
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/));
const editable = z
  .object({
    title: z.string().min(1).max(160).optional(),
    description: z.string().min(1).max(30000).optional(),
    difficulty: z.enum(["easy", "medium", "hard"]).optional(),
    visibility: z.enum(["public", "private"]).optional(),
    judge: judge.optional(),
    languages: z.array(languages).min(1).max(8).optional(),
    tags: z.array(tag).max(12).optional(),
    tests: z.array(testCase).min(1).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field required");

async function fullChallenge(client: any, id: string) {
  const row = (
    await client.query(
      "SELECT id,project_id,slug,title,description,difficulty,visibility,judge,status,current_revision,created_at,updated_at,published_at FROM challenges WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!row)
    throw Object.assign(new Error("Challenge not found"), { statusCode: 404 });
  const [languageRows, tagRows, testRows] = await Promise.all([
    client.query(
      "SELECT language FROM challenge_languages WHERE challenge_id=$1 ORDER BY language",
      [id],
    ),
    client.query("SELECT tag FROM challenge_tags WHERE challenge_id=$1 ORDER BY tag", [id]),
    client.query(
      "SELECT id,position,stdin,expected,hidden,weight,wall_time_ms,memory_mb,test_group FROM challenge_test_cases WHERE challenge_id=$1 ORDER BY position",
      [id],
    ),
  ]);
  return {
    ...row,
    languages: languageRows.rows.map((item: any) => item.language),
    tags: tagRows.rows.map((item: any) => item.tag),
    tests: testRows.rows.map((item: any) => ({
      id: item.id,
      position: item.position,
      stdin: item.stdin,
      expected: item.expected,
      hidden: item.hidden,
      weight: item.weight,
      wallTimeMs: item.wall_time_ms,
      memoryMb: item.memory_mb,
      group: item.test_group,
    })),
  };
}

async function saveRevision(client: any, challenge: any, userId?: string) {
  await client.query(
    `INSERT INTO challenge_revisions(
      challenge_id,revision,title,description,difficulty,visibility,judge,languages,tags,tests,created_by,published_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
    ON CONFLICT(challenge_id,revision) DO UPDATE SET
      title=excluded.title,description=excluded.description,difficulty=excluded.difficulty,
      visibility=excluded.visibility,judge=excluded.judge,languages=excluded.languages,
      tags=excluded.tags,tests=excluded.tests,created_by=excluded.created_by,
      published_at=COALESCE(challenge_revisions.published_at,excluded.published_at)`,
    [
      challenge.id,
      challenge.current_revision,
      challenge.title,
      challenge.description,
      challenge.difficulty,
      challenge.visibility,
      challenge.judge,
      challenge.languages,
      challenge.tags,
      JSON.stringify(challenge.tests),
      userId ?? null,
      challenge.status === "published" ? challenge.published_at ?? new Date() : null,
    ],
  );
}

export function registerChallengeAuthoring(app: FastifyInstance) {
  app.get("/v1/challenge-authoring/:id", async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const a = await actor(req);
    const challenge = await fullChallenge(pool, id);
    await authorize(a, challenge.project_id, "challenges:write");
    return challenge;
  });

  app.patch("/v1/challenge-authoring/:id", async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const body = editable.parse(req.body);
    const a = await actor(req);
    const initial = await fullChallenge(pool, id);
    await authorize(a, initial.project_id, "challenges:write");

    return tx(async (client) => {
      const locked = (
        await client.query("SELECT * FROM challenges WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!locked)
        throw Object.assign(new Error("Challenge not found"), { statusCode: 404 });
      const revision = locked.current_revision + 1;
      await client.query(
        `UPDATE challenges SET
          title=COALESCE($2,title),description=COALESCE($3,description),difficulty=COALESCE($4,difficulty),
          visibility=COALESCE($5,visibility),judge=COALESCE($6,judge),status='draft',
          current_revision=$7,updated_at=now()
        WHERE id=$1`,
        [
          id,
          body.title ?? null,
          body.description ?? null,
          body.difficulty ?? null,
          body.visibility ?? null,
          body.judge ?? null,
          revision,
        ],
      );
      if (body.languages) {
        await client.query("DELETE FROM challenge_languages WHERE challenge_id=$1", [id]);
        for (const language of new Set(body.languages))
          await client.query(
            "INSERT INTO challenge_languages(challenge_id,language) VALUES($1,$2)",
            [id, language],
          );
      }
      if (body.tags) {
        await client.query("DELETE FROM challenge_tags WHERE challenge_id=$1", [id]);
        for (const value of new Set(body.tags))
          await client.query(
            "INSERT INTO challenge_tags(challenge_id,tag) VALUES($1,$2)",
            [id, value],
          );
      }
      if (body.tests) {
        await client.query("DELETE FROM challenge_test_cases WHERE challenge_id=$1", [id]);
        for (const [position, test] of body.tests.entries())
          await client.query(
            "INSERT INTO challenge_test_cases(challenge_id,position,stdin,expected,hidden,weight,wall_time_ms,memory_mb,test_group) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              id,
              position,
              test.stdin,
              test.expected,
              test.hidden,
              test.weight,
              test.wallTimeMs ?? null,
              test.memoryMb ?? null,
              test.group ?? null,
            ],
          );
      }
      const next = await fullChallenge(client, id);
      await saveRevision(client, next, a.userId);
      await audit(client, "challenge.revision.create", a.userId ?? null, id, {
        revision,
      });
      return next;
    });
  });

  app.post("/v1/challenge-authoring/:id/publish", async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const a = await actor(req);
    const initial = await fullChallenge(pool, id);
    await authorize(a, initial.project_id, "challenges:write");
    return tx(async (client) => {
      const locked = (
        await client.query("SELECT * FROM challenges WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!locked)
        throw Object.assign(new Error("Challenge not found"), { statusCode: 404 });
      const testCount = Number(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM challenge_test_cases WHERE challenge_id=$1",
            [id],
          )
        ).rows[0].count,
      );
      if (!testCount)
        throw Object.assign(new Error("Challenge has no tests"), { statusCode: 400 });
      await client.query(
        "UPDATE challenges SET status='published',published_at=now(),updated_at=now() WHERE id=$1",
        [id],
      );
      const published = await fullChallenge(client, id);
      await saveRevision(client, published, a.userId);
      await client.query(
        "UPDATE challenge_revisions SET published_at=COALESCE(published_at,now()) WHERE challenge_id=$1 AND revision=$2",
        [id, published.current_revision],
      );
      await audit(client, "challenge.publish", a.userId ?? null, id, {
        revision: published.current_revision,
      });
      return published;
    });
  });

  app.post("/v1/challenge-authoring/:id/archive", async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const a = await actor(req);
    const challenge = await fullChallenge(pool, id);
    await authorize(a, challenge.project_id, "challenges:write");
    await tx(async (client) => {
      await client.query(
        "UPDATE challenges SET status='archived',updated_at=now() WHERE id=$1",
        [id],
      );
      await audit(client, "challenge.archive", a.userId ?? null, id, {
        revision: challenge.current_revision,
      });
    });
    return { ok: true };
  });

  app.get("/v1/challenge-authoring/:id/revisions", async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const a = await actor(req);
    const challenge = await fullChallenge(pool, id);
    await authorize(a, challenge.project_id, "challenges:write");
    return {
      items: (
        await pool.query(
          "SELECT revision,title,difficulty,visibility,judge,languages,tags,created_by,created_at,published_at FROM challenge_revisions WHERE challenge_id=$1 ORDER BY revision DESC LIMIT 100",
          [id],
        )
      ).rows,
    };
  });

  app.get("/v1/challenges/:id/leaderboard", async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const query = z
      .object({ runtimeId: z.string().max(80).optional() })
      .parse(req.query ?? {});
    const a = await actor(req);
    const challenge = (
      await pool.query(
        "SELECT id,project_id,visibility,status FROM challenges WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!challenge || challenge.status !== "published")
      throw Object.assign(new Error("Challenge unavailable"), { statusCode: 404 });
    if (challenge.visibility !== "public")
      await authorize(a, challenge.project_id, "submissions:create");
    const rows = (
      await pool.query(
        `WITH best AS (
          SELECT DISTINCT ON (COALESCE(s.user_id::text,s.id::text),s.runtime_id)
            s.id,s.runtime_id,r.language,r.version,
            'user-' || substr(encode(digest(COALESCE(s.user_id::text,s.id::text),'sha256'),'hex'),1,12) AS participant,
            sr.score,sr.wall_ms,sr.cpu_ms,sr.peak_memory_bytes,s.created_at
          FROM submissions s
          JOIN submission_results sr ON sr.submission_id=s.id
          JOIN runtimes r ON r.id=s.runtime_id
          WHERE s.challenge_id=$1 AND s.state='completed' AND ($2::text IS NULL OR s.runtime_id=$2)
          ORDER BY COALESCE(s.user_id::text,s.id::text),s.runtime_id,sr.score DESC,sr.wall_ms ASC,sr.cpu_ms ASC,s.created_at ASC
        )
        SELECT *,dense_rank() OVER(ORDER BY score DESC,wall_ms ASC,cpu_ms ASC) AS rank
        FROM best ORDER BY rank,created_at LIMIT 100`,
        [id, query.runtimeId ?? null],
      )
    ).rows;
    return { items: rows };
  });

  app.get("/v1/challenge-templates", async (req) => {
    const a = await actor(req);
    const query = z.object({ projectId: z.string().uuid() }).parse(req.query);
    await authorize(a, query.projectId, "challenges:write");
    return {
      items: (
        await pool.query(
          "SELECT id,name,title,description,difficulty,visibility,judge,languages,tags,tests,created_at,updated_at FROM challenge_templates WHERE project_id=$1 ORDER BY updated_at DESC",
          [query.projectId],
        )
      ).rows,
    };
  });

  app.post("/v1/challenge-templates", async (req, reply) => {
    const body = z
      .object({
        projectId: z.string().uuid(),
        name: z.string().min(1).max(120),
        title: z.string().max(160).default(""),
        description: z.string().max(30000).default(""),
        difficulty: z.enum(["easy", "medium", "hard"]).default("medium"),
        visibility: z.enum(["public", "private"]).default("private"),
        judge: judge.default("whitespace"),
        languages: z.array(languages).max(8).default([]),
        tags: z.array(tag).max(12).default([]),
        tests: z.array(testCase).max(100).default([]),
      })
      .strict()
      .parse(req.body);
    const a = await actor(req);
    await authorize(a, body.projectId, "challenges:write");
    const row = (
      await pool.query(
        "INSERT INTO challenge_templates(project_id,name,title,description,difficulty,visibility,judge,languages,tags,tests,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id,name,created_at",
        [
          body.projectId,
          body.name,
          body.title,
          body.description,
          body.difficulty,
          body.visibility,
          body.judge,
          [...new Set(body.languages)],
          [...new Set(body.tags)],
          JSON.stringify(body.tests),
          a.userId ?? null,
        ],
      )
    ).rows[0];
    reply.code(201);
    return row;
  });
}
