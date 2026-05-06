CREATE TABLE IF NOT EXISTS external_seed_image_cache_jobs (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  mode TEXT NOT NULL DEFAULT 'apply',
  filters JSONB NOT NULL DEFAULT '{}'::JSONB,
  result JSONB,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT,
  locked_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_external_seed_image_cache_jobs_status_created
ON external_seed_image_cache_jobs (status, created_at ASC);

