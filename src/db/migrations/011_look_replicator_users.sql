CREATE TABLE IF NOT EXISTS look_replicator_users (
  user_id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS look_replicator_users_email_idx
  ON look_replicator_users (email);

ALTER TABLE look_replicator_jobs
  ADD COLUMN IF NOT EXISTS user_id UUID;

CREATE INDEX IF NOT EXISTS look_replicator_jobs_user_created_idx
  ON look_replicator_jobs (user_id, created_at DESC);

