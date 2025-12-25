CREATE TABLE IF NOT EXISTS look_replicator_jobs (
  job_id UUID PRIMARY KEY,
  share_id TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  progress INT,
  market TEXT NOT NULL,
  locale TEXT NOT NULL,
  reference_image_url TEXT,
  selfie_image_url TEXT,
  undertone TEXT,
  result_json JSONB,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS look_replicator_jobs_status_updated_idx
  ON look_replicator_jobs (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS look_replicator_jobs_created_idx
  ON look_replicator_jobs (created_at DESC);

