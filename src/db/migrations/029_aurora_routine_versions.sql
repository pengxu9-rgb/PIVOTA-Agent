-- Purpose: Routine versioning — each save creates a new version row; user profile
--          tracks the active routine_id. Check-in logs gain a routine_id column for
--          attribution.

-- 1. Routine versions (one row per save)
CREATE TABLE IF NOT EXISTS aurora_routine_versions (
  routine_id   TEXT NOT NULL,
  version_id   TEXT NOT NULL,
  aurora_uid   TEXT,
  user_id      TEXT,
  label        TEXT NOT NULL DEFAULT 'My Routine',
  intensity    TEXT NOT NULL DEFAULT 'balanced',
  status       TEXT NOT NULL DEFAULT 'active',
  am_steps     JSONB NOT NULL DEFAULT '[]'::jsonb,
  pm_steps     JSONB NOT NULL DEFAULT '[]'::jsonb,
  areas        JSONB NOT NULL DEFAULT '["face"]'::jsonb,
  audit        JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (routine_id, version_id)
);

CREATE INDEX IF NOT EXISTS idx_aurora_routine_versions_uid
  ON aurora_routine_versions(aurora_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aurora_routine_versions_user
  ON aurora_routine_versions(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- 2. Profile pointer to active routine
ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS active_routine_id TEXT;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS active_routine_id TEXT;

-- 3. Check-in attribution
ALTER TABLE IF EXISTS aurora_skin_logs
  ADD COLUMN IF NOT EXISTS routine_id TEXT;

ALTER TABLE IF EXISTS aurora_account_skin_logs
  ADD COLUMN IF NOT EXISTS routine_id TEXT;
