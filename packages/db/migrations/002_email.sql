ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
CREATE TABLE auth_tokens(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users,token_hash text UNIQUE NOT NULL,purpose text NOT NULL CHECK(purpose IN ('verify','reset')),expires_at timestamptz NOT NULL,consumed_at timestamptz);
CREATE TABLE mail_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient text NOT NULL,subject text NOT NULL,encrypted_body text NOT NULL,attempts int NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),status text NOT NULL DEFAULT 'pending');
