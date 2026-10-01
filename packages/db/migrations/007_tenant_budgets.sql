ALTER TABLE projects
  ADD COLUMN max_concurrent int NOT NULL DEFAULT 4 CHECK(max_concurrent BETWEEN 1 AND 64),
  ADD COLUMN submissions_per_minute int NOT NULL DEFAULT 60 CHECK(submissions_per_minute BETWEEN 1 AND 1000);

ALTER TABLE users
  ADD COLUMN submissions_per_minute int NOT NULL DEFAULT 120 CHECK(submissions_per_minute BETWEEN 1 AND 2000);

ALTER TABLE api_keys
  ADD COLUMN submissions_per_minute int NOT NULL DEFAULT 60 CHECK(submissions_per_minute BETWEEN 1 AND 1000);

CREATE INDEX submissions_project_active
  ON submissions(project_id,state)
  WHERE state IN ('scheduled','preparing','compiling','running','judging');
