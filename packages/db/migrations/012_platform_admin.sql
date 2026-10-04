ALTER TABLE users
  ADD COLUMN platform_admin boolean NOT NULL DEFAULT false;

ALTER TABLE runtimes
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX users_platform_admin_idx
  ON users(id)
  WHERE platform_admin;
