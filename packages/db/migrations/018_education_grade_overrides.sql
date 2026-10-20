-- Instructor grade decisions are kept separate from immutable execution results.
CREATE TABLE education_grade_overrides (
  attempt_id uuid PRIMARY KEY REFERENCES education_assignment_attempts(id) ON DELETE CASCADE,
  score numeric(6,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE education_grade_override_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES education_assignment_attempts(id) ON DELETE CASCADE,
  score numeric(6,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  reason text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX education_grade_override_events_attempt_idx
  ON education_grade_override_events(attempt_id,id DESC);
