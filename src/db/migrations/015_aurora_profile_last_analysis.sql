-- Purpose: Persist the last skin analysis summary for personalization.

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS last_analysis JSONB;

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS last_analysis_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS last_analysis_lang TEXT;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS last_analysis JSONB;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS last_analysis_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS last_analysis_lang TEXT;

CREATE INDEX IF NOT EXISTS idx_aurora_user_profiles_last_analysis_at
  ON aurora_user_profiles(last_analysis_at DESC);

CREATE INDEX IF NOT EXISTS idx_aurora_account_profiles_last_analysis_at
  ON aurora_account_profiles(last_analysis_at DESC);

