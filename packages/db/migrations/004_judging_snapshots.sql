-- Drain API/scheduler/workers before applying this migration to an existing fleet.
ALTER TABLE submissions
  ADD COLUMN judge_strategy text CHECK (judge_strategy IN ('exact','whitespace','case_insensitive','float')),
  ADD COLUMN test_snapshot_hash text CHECK (test_snapshot_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN test_snapshot_origin text CHECK (test_snapshot_origin IN ('admission','legacy-backfill')),
  ADD COLUMN test_snapshot_at timestamptz;

CREATE TABLE submission_test_cases (
  submission_id uuid NOT NULL REFERENCES submissions,
  test_case_id uuid NOT NULL,
  position int NOT NULL,
  stdin text NOT NULL,
  expected text NOT NULL,
  hidden boolean NOT NULL,
  weight int NOT NULL CHECK (weight > 0),
  wall_time_ms int CHECK (wall_time_ms BETWEEN 100 AND 15000),
  memory_mb int CHECK (memory_mb BETWEEN 32 AND 512),
  test_group text,
  PRIMARY KEY (submission_id,test_case_id),
  UNIQUE (submission_id,position)
);

-- Historical tests cannot be reconstructed after edits. Label this backfill
-- explicitly and never claim its rows were captured at original admission.
INSERT INTO submission_test_cases
SELECT s.id,t.id,t.position,t.stdin,t.expected,t.hidden,t.weight,t.wall_time_ms,t.memory_mb,t.test_group
FROM submissions s JOIN challenge_test_cases t ON t.challenge_id=s.challenge_id
WHERE s.mode='challenge';
UPDATE submissions s SET judge_strategy=c.judge,test_snapshot_origin='legacy-backfill',test_snapshot_at=now()
FROM challenges c WHERE s.mode='challenge' AND s.challenge_id=c.id;

ALTER TABLE test_results DROP CONSTRAINT test_results_test_case_id_fkey;
ALTER TABLE test_results ADD CONSTRAINT test_results_snapshot_fkey
  FOREIGN KEY (submission_id,test_case_id) REFERENCES submission_test_cases(submission_id,test_case_id);

CREATE TABLE challenge_languages (
  challenge_id uuid NOT NULL REFERENCES challenges ON DELETE CASCADE,
  language text NOT NULL CHECK (language IN ('python','javascript','typescript','java','c','cpp','go','rust')),
  PRIMARY KEY (challenge_id,language)
);
-- No restriction rows means all supported platform languages (legacy behavior).

CREATE FUNCTION reject_judging_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Judging snapshots are immutable' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER immutable_submission_tests BEFORE UPDATE OR DELETE ON submission_test_cases
FOR EACH ROW EXECUTE FUNCTION reject_judging_snapshot_mutation();

CREATE FUNCTION guard_judging_snapshot_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM submissions WHERE id=NEW.submission_id
                 AND state='created' AND test_snapshot_origin IS NULL) THEN
    RAISE EXCEPTION 'Test snapshots can only be captured during admission' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admission_only_submission_tests BEFORE INSERT ON submission_test_cases
FOR EACH ROW EXECUTE FUNCTION guard_judging_snapshot_insert();

CREATE FUNCTION protect_submission_judge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.test_snapshot_origin IS NOT NULL AND
     (NEW.judge_strategy,NEW.test_snapshot_hash,NEW.test_snapshot_origin,NEW.test_snapshot_at)
     IS DISTINCT FROM
     (OLD.judge_strategy,OLD.test_snapshot_hash,OLD.test_snapshot_origin,OLD.test_snapshot_at) THEN
    RAISE EXCEPTION 'Submission judge snapshot is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_submission_judge BEFORE UPDATE ON submissions
FOR EACH ROW EXECUTE FUNCTION protect_submission_judge();
