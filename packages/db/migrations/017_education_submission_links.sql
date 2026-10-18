-- Each reserved learner attempt can reference one admitted execution submission.
ALTER TABLE education_assignment_attempts
  ADD COLUMN submission_id uuid UNIQUE REFERENCES submissions(id) ON DELETE SET NULL;
CREATE INDEX education_attempts_submission_idx
  ON education_assignment_attempts(submission_id) WHERE submission_id IS NOT NULL;
