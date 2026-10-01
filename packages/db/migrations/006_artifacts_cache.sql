CREATE TABLE artifacts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('compile_log','generated','compiled')),
  object_key text NOT NULL UNIQUE,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 0 AND 10485760),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_submission ON artifacts(submission_id,created_at,id);
CREATE INDEX artifacts_project ON artifacts(project_id,created_at DESC,id);

CREATE TABLE compilation_cache(
  cache_key text PRIMARY KEY CHECK(cache_key ~ '^[0-9a-f]{64}$'),
  runtime_id text NOT NULL REFERENCES runtimes,
  runtime_image_id text NOT NULL CHECK(runtime_image_id ~ '^sha256:[0-9a-f]{64}$'),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  compile_fingerprint text NOT NULL CHECK(compile_fingerprint ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL UNIQUE,
  size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 33554432),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compilation_cache_runtime ON compilation_cache(runtime_id,last_used_at DESC);

ALTER TABLE usage_records
  ADD COLUMN artifact_bytes bigint NOT NULL DEFAULT 0 CHECK(artifact_bytes >= 0);
