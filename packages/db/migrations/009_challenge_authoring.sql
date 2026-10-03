ALTER TABLE challenges
  ADD COLUMN status text NOT NULL DEFAULT 'published' CHECK(status IN ('draft','published','archived')),
  ADD COLUMN current_revision int NOT NULL DEFAULT 1 CHECK(current_revision > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN published_at timestamptz,
  ADD COLUMN draft_visibility text CHECK(draft_visibility IN ('public','private'));

UPDATE challenges SET published_at=created_at WHERE status='published' AND published_at IS NULL;

CREATE TABLE challenge_tags (
  challenge_id uuid NOT NULL REFERENCES challenges ON DELETE CASCADE,
  tag text NOT NULL CHECK(tag ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  PRIMARY KEY(challenge_id,tag)
);
CREATE INDEX challenge_tags_tag ON challenge_tags(tag,challenge_id);

CREATE TABLE challenge_revisions (
  challenge_id uuid NOT NULL REFERENCES challenges ON DELETE CASCADE,
  revision int NOT NULL CHECK(revision > 0),
  title text NOT NULL,
  description text NOT NULL,
  difficulty text NOT NULL CHECK(difficulty IN ('easy','medium','hard')),
  visibility text NOT NULL CHECK(visibility IN ('public','private')),
  judge text NOT NULL CHECK(judge IN ('exact','whitespace','case_insensitive','float')),
  languages text[] NOT NULL,
  tags text[] NOT NULL,
  tests jsonb NOT NULL,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY(challenge_id,revision),
  CHECK(jsonb_typeof(tests)='array')
);

CREATE TABLE challenge_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  difficulty text NOT NULL DEFAULT 'medium' CHECK(difficulty IN ('easy','medium','hard')),
  visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN ('public','private')),
  judge text NOT NULL DEFAULT 'whitespace' CHECK(judge IN ('exact','whitespace','case_insensitive','float')),
  languages text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  tests jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(tests)='array'),
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,name)
);

CREATE INDEX challenges_project_status_updated ON challenges(project_id,status,updated_at DESC,id);
CREATE INDEX challenge_revisions_history ON challenge_revisions(challenge_id,revision DESC);
CREATE INDEX challenge_templates_project ON challenge_templates(project_id,updated_at DESC,id);
