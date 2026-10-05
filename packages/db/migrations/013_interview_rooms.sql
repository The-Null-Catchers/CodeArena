CREATE TABLE interview_rooms(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  runtime_id text REFERENCES runtimes,
  challenge_id uuid REFERENCES challenges,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
  document text NOT NULL DEFAULT '',
  document_revision bigint NOT NULL DEFAULT 0 CHECK(document_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX interview_rooms_project_created ON interview_rooms(project_id,created_at DESC,id);

CREATE TABLE interview_room_participants(
  room_id uuid NOT NULL REFERENCES interview_rooms ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('interviewer','candidate','observer')),
  invited_by uuid REFERENCES users,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(room_id,user_id)
);
CREATE INDEX interview_room_participants_user ON interview_room_participants(user_id,joined_at DESC);

CREATE TABLE interview_room_events(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES interview_rooms ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users ON DELETE SET NULL,
  kind text NOT NULL CHECK(kind IN ('room.created','participant.added','document.updated','room.ended')),
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interview_room_events_stream ON interview_room_events(room_id,id);

-- Private interviewer notes intentionally live outside the shared event stream and document.
-- The API always scopes reads/writes by author_user_id so notes cannot leak to candidates.
CREATE TABLE interview_private_notes(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES interview_rooms ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  body text NOT NULL CHECK(length(body) <= 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interview_private_notes_author ON interview_private_notes(room_id,author_user_id,updated_at DESC);
