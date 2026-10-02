ALTER TABLE submissions ADD COLUMN correlation_id text;
UPDATE submissions SET correlation_id=id::text WHERE correlation_id IS NULL;
ALTER TABLE submissions ALTER COLUMN correlation_id SET NOT NULL;
ALTER TABLE submissions ADD CONSTRAINT submission_correlation_id_bounded
  CHECK(length(correlation_id) BETWEEN 1 AND 128);
CREATE INDEX submissions_correlation_id ON submissions(correlation_id);
