-- Purpose: Persist optional upcoming plan / itinerary context for personalization.

ALTER TABLE IF EXISTS aurora_user_profiles
  ADD COLUMN IF NOT EXISTS itinerary JSONB;

ALTER TABLE IF EXISTS aurora_account_profiles
  ADD COLUMN IF NOT EXISTS itinerary JSONB;

