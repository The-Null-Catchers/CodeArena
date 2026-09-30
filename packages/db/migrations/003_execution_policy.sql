ALTER TABLE projects ADD COLUMN max_priority text NOT NULL DEFAULT 'normal' CHECK(max_priority IN ('low','normal','high','system'));
ALTER TABLE submissions ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','system'));
ALTER TABLE challenge_test_cases ADD COLUMN wall_time_ms int CHECK(wall_time_ms BETWEEN 100 AND 15000);
ALTER TABLE challenge_test_cases ADD COLUMN memory_mb int CHECK(memory_mb BETWEEN 32 AND 512);
ALTER TABLE challenge_test_cases ADD COLUMN test_group text;
ALTER TABLE challenge_test_cases ADD CONSTRAINT test_weight_positive CHECK(weight > 0);
CREATE INDEX submissions_worker_active ON submissions(worker_id,state);
CREATE INDEX usage_project_time ON usage_records(project_id,created_at);
