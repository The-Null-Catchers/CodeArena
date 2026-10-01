ALTER TABLE worker_runtimes ADD COLUMN image_id text CHECK(image_id ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE submissions
  ADD COLUMN runtime_image_id text CHECK(runtime_image_id ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN runtime_definition jsonb,
  ADD COLUMN runtime_snapshot_origin text CHECK(runtime_snapshot_origin IN ('admission','legacy-first-claim'));
-- Existing executions cannot be retroactively guaranteed reproducible. Pending
-- legacy rows are pinned on their first claim by an upgraded worker.
CREATE FUNCTION protect_runtime_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.runtime_image_id IS NOT NULL AND
     (NEW.runtime_id,NEW.runtime_image_id,NEW.runtime_definition,NEW.runtime_snapshot_origin)
     IS DISTINCT FROM
     (OLD.runtime_id,OLD.runtime_image_id,OLD.runtime_definition,OLD.runtime_snapshot_origin) THEN
    RAISE EXCEPTION 'Runtime snapshots are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_runtime_snapshot BEFORE UPDATE ON submissions
FOR EACH ROW EXECUTE FUNCTION protect_runtime_snapshot();
