-- Purpose: Add chat context persistence and experiment logs for Aurora chat cards v1.
-- Non-breaking migration: adds JSONB columns and append-only experiment event tables.

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS chat_context JSONB;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS chat_context JSONB;

CREATE TABLE IF NOT EXISTS aurora_user_experiment_logs (
  id BIGSERIAL PRIMARY KEY,
  aurora_uid TEXT NOT NULL REFERENCES aurora_user_profiles(aurora_uid) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id TEXT,
  trace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aurora_user_experiment_logs_uid_ts
  ON aurora_user_experiment_logs (aurora_uid, event_ts DESC);

CREATE INDEX IF NOT EXISTS idx_aurora_user_experiment_logs_trace
  ON aurora_user_experiment_logs (trace_id)
  WHERE trace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS aurora_account_experiment_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES aurora_account_profiles(user_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id TEXT,
  trace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aurora_account_experiment_logs_uid_ts
  ON aurora_account_experiment_logs (user_id, event_ts DESC);

CREATE INDEX IF NOT EXISTS idx_aurora_account_experiment_logs_trace
  ON aurora_account_experiment_logs (trace_id)
  WHERE trace_id IS NOT NULL;
