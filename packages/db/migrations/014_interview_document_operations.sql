CREATE TABLE interview_document_operations(
  room_id uuid NOT NULL REFERENCES interview_rooms ON DELETE CASCADE,
  client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 80),
  sequence bigint NOT NULL CHECK(sequence >= 0),
  actor_user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  base_revision bigint NOT NULL CHECK(base_revision >= 0),
  revision bigint NOT NULL CHECK(revision > 0),
  change jsonb NOT NULL,
  transformed jsonb NOT NULL,
  event_id bigint NOT NULL REFERENCES interview_room_events ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(room_id,client_id,sequence),
  UNIQUE(room_id,revision),
  UNIQUE(event_id)
);

CREATE INDEX interview_document_operations_history
  ON interview_document_operations(room_id,revision);
