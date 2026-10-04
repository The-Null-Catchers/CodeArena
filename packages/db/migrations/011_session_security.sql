ALTER TABLE sessions
  ADD COLUMN user_agent text NOT NULL DEFAULT '',
  ADD COLUMN ip_hash text,
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX sessions_user_active
  ON sessions(user_id, created_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE users
  ADD COLUMN failed_login_count int NOT NULL DEFAULT 0 CHECK(failed_login_count BETWEEN 0 AND 1000),
  ADD COLUMN login_locked_until timestamptz,
  ADD COLUMN last_failed_login_at timestamptz;
