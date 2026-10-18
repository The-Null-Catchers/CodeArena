-- Immutable learner assignment-attempt reservations. Grading/execution links follow separately.
CREATE TABLE education_assignment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES education_assignments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 100),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id,user_id,attempt_number)
);
CREATE INDEX education_attempts_learner_idx
  ON education_assignment_attempts(user_id,submitted_at DESC);
