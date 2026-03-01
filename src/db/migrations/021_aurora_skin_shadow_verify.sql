-- Purpose: Store shadow verify outputs in isolated storage and keep last_analysis immutable.

CREATE TABLE IF NOT EXISTS aurora_skin_shadow_verify_runs (
  id BIGSERIAL PRIMARY KEY,
  aurora_uid TEXT REFERENCES aurora_user_profiles(aurora_uid) ON DELETE CASCADE,
  user_id TEXT REFERENCES aurora_account_profiles(user_id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'shadow_verify',
  provider TEXT NOT NULL DEFAULT 'gemini',
  prompt_version TEXT,
  input_hash TEXT,
  verdict_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (aurora_uid IS NOT NULL OR user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_aurora_skin_shadow_verify_runs_user_created
  ON aurora_skin_shadow_verify_runs(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_aurora_skin_shadow_verify_runs_uid_created
  ON aurora_skin_shadow_verify_runs(aurora_uid, created_at DESC)
  WHERE aurora_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_aurora_skin_shadow_verify_runs_input_hash
  ON aurora_skin_shadow_verify_runs(input_hash)
  WHERE input_hash IS NOT NULL;
