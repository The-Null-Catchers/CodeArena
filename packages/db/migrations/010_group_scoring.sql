-- Preserve historical scoring behavior while enabling richer group semantics for
-- newly admitted challenge submissions. Existing submissions keep weighted-v1.
ALTER TABLE submissions
  ADD COLUMN scoring_strategy text NOT NULL DEFAULT 'weighted-v1'
  CHECK (scoring_strategy IN ('weighted-v1','group-all-or-nothing-v1'));

-- If any captured test belongs to a group, mark the admission snapshot as using
-- all-or-nothing group scoring. This runs only while the submission is still in
-- its admission transaction, so retries later remain deterministic.
CREATE FUNCTION set_group_scoring_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NULLIF(btrim(NEW.test_group), '') IS NOT NULL THEN
    UPDATE submissions
    SET scoring_strategy='group-all-or-nothing-v1'
    WHERE id=NEW.submission_id
      AND state='created'
      AND test_snapshot_origin IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_group_scoring_snapshot
BEFORE INSERT ON submission_test_cases
FOR EACH ROW EXECUTE FUNCTION set_group_scoring_snapshot();

-- Scoring strategy is part of the immutable judging snapshot.
CREATE OR REPLACE FUNCTION protect_submission_judge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.test_snapshot_origin IS NOT NULL AND
     (NEW.judge_strategy,NEW.test_snapshot_hash,NEW.test_snapshot_origin,NEW.test_snapshot_at,NEW.scoring_strategy)
     IS DISTINCT FROM
     (OLD.judge_strategy,OLD.test_snapshot_hash,OLD.test_snapshot_origin,OLD.test_snapshot_at,OLD.scoring_strategy) THEN
    RAISE EXCEPTION 'Submission judge snapshot is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

-- Keep score derivation in PostgreSQL so every worker version observes the same
-- snapshot semantics. The worker may insert its legacy weighted score first;
-- these triggers converge the persisted score as test results arrive.
CREATE FUNCTION recompute_submission_score() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sid uuid := NEW.submission_id;
  strategy text;
  total_weight numeric;
  earned_weight numeric;
BEGIN
  SELECT scoring_strategy INTO strategy FROM submissions WHERE id=sid;
  SELECT COALESCE(sum(weight),0)::numeric INTO total_weight
  FROM submission_test_cases WHERE submission_id=sid;

  IF total_weight = 0 THEN
    earned_weight := 0;
  ELSIF strategy = 'group-all-or-nothing-v1' THEN
    WITH ungrouped AS (
      SELECT COALESCE(sum(c.weight),0)::numeric AS earned
      FROM submission_test_cases c
      LEFT JOIN test_results r
        ON r.submission_id=c.submission_id AND r.test_case_id=c.test_case_id
      WHERE c.submission_id=sid
        AND NULLIF(btrim(c.test_group),'') IS NULL
        AND r.verdict='accepted'
    ), grouped AS (
      SELECT c.test_group,
             sum(c.weight)::numeric AS group_weight,
             bool_and(COALESCE(r.verdict='accepted',false)) AS all_accepted
      FROM submission_test_cases c
      LEFT JOIN test_results r
        ON r.submission_id=c.submission_id AND r.test_case_id=c.test_case_id
      WHERE c.submission_id=sid
        AND NULLIF(btrim(c.test_group),'') IS NOT NULL
      GROUP BY c.test_group
    )
    SELECT COALESCE((SELECT earned FROM ungrouped),0)
         + COALESCE(sum(CASE WHEN all_accepted THEN group_weight ELSE 0 END),0)
    INTO earned_weight
    FROM grouped;
  ELSE
    SELECT COALESCE(sum(c.weight),0)::numeric INTO earned_weight
    FROM submission_test_cases c
    JOIN test_results r
      ON r.submission_id=c.submission_id AND r.test_case_id=c.test_case_id
    WHERE c.submission_id=sid AND r.verdict='accepted';
  END IF;

  UPDATE submission_results
  SET score = CASE
    WHEN total_weight = 0 THEN 0
    ELSE (100.0 * COALESCE(earned_weight,0) / total_weight)
  END
  WHERE submission_id=sid;
  RETURN NEW;
END;
$$;

CREATE TRIGGER recompute_score_on_result
AFTER INSERT ON test_results
FOR EACH ROW EXECUTE FUNCTION recompute_submission_score();

CREATE TRIGGER recompute_score_on_submission_result
AFTER INSERT ON submission_results
FOR EACH ROW EXECUTE FUNCTION recompute_submission_score();
