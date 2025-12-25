CREATE TABLE IF NOT EXISTS layer1_bundle_samples_us (
  id UUID PRIMARY KEY,
  session_id TEXT NOT NULL,
  market TEXT NOT NULL, -- always US
  locale TEXT NOT NULL,
  preference_mode TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  bundle_json JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS layer1_bundle_samples_us_session_created_idx
  ON layer1_bundle_samples_us (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS layer1_bundle_samples_us_created_idx
  ON layer1_bundle_samples_us (created_at DESC);

CREATE INDEX IF NOT EXISTS layer1_bundle_samples_us_preference_idx
  ON layer1_bundle_samples_us (preference_mode, created_at DESC);

