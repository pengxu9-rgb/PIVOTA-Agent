-- Purpose: Persist optional safety profile fields for guest/account profile tables.

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS age_band TEXT;

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS pregnancy_status TEXT;

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS pregnancy_due_date DATE;

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS lactation_status TEXT;

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS high_risk_medications JSONB;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS age_band TEXT;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS pregnancy_status TEXT;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS pregnancy_due_date DATE;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS lactation_status TEXT;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS high_risk_medications JSONB;
