-- Purpose: Persist Aurora optional safety prompt state and one-time asked tracking.
-- Non-breaking migration: adds JSONB column to guest/account profile tables.

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS safety_prompt_state JSONB;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS safety_prompt_state JSONB;
