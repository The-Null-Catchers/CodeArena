import { createHash } from "node:crypto";
import type pg from "pg";

/** Called in the admission transaction, before the submission can be scheduled.
 * Lock the challenge row before calling; future challenge editors must do likewise.
 */
export async function captureJudgingSnapshot(
  c: pg.PoolClient,
  submissionId: string,
  challengeId: string,
  strategy: string,
) {
  const tests = (
    await c.query(
      "SELECT id,position,stdin,expected,hidden,weight,wall_time_ms,memory_mb,test_group FROM challenge_test_cases WHERE challenge_id=$1 ORDER BY position FOR SHARE",
      [challengeId],
    )
  ).rows;
  if (!tests.length || tests.length > 100)
    throw Object.assign(
      new Error("Challenge must have between 1 and 100 tests"),
      { statusCode: 400 },
    );
  const digest = createHash("sha256")
    .update(JSON.stringify({ strategy, tests }))
    .digest("hex");
  await c.query(
    `INSERT INTO submission_test_cases
     SELECT $1,id,position,stdin,expected,hidden,weight,wall_time_ms,memory_mb,test_group
     FROM jsonb_to_recordset($2::jsonb) AS t(id uuid,position int,stdin text,expected text,hidden boolean,weight int,wall_time_ms int,memory_mb int,test_group text)`,
    [submissionId, JSON.stringify(tests)],
  );
  await c.query(
    "UPDATE submissions SET judge_strategy=$2,test_snapshot_hash=$3,test_snapshot_origin='admission',test_snapshot_at=now() WHERE id=$1",
    [submissionId, strategy, digest],
  );
  return digest;
}
