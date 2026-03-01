-- Purpose: Persist legacy single travel plan + multi-trip travel plans.

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS travel_plan JSONB;

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS travel_plans JSONB;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS travel_plan JSONB;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS travel_plans JSONB;
