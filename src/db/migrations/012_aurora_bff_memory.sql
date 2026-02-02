-- Purpose: Aurora BFF memory store (anonymous aurora_uid)
-- Tables:
--   - aurora_user_profiles: long-lived skin profile
--   - aurora_skin_logs: daily tracker logs (last 7 days in chat context)

CREATE TABLE IF NOT EXISTS aurora_user_profiles (
  aurora_uid TEXT PRIMARY KEY,
  skin_type TEXT,
  sensitivity TEXT,
  barrier_status TEXT,
  goals JSONB,
  region TEXT,
  budget_tier TEXT,
  current_routine JSONB,
  contraindications JSONB,
  lang_pref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_aurora_user_profiles_updated_at
  ON aurora_user_profiles(updated_at DESC);

CREATE TABLE IF NOT EXISTS aurora_skin_logs (
  id BIGSERIAL PRIMARY KEY,
  aurora_uid TEXT NOT NULL REFERENCES aurora_user_profiles(aurora_uid) ON DELETE CASCADE,
  log_date DATE NOT NULL,
  redness SMALLINT,
  acne SMALLINT,
  hydration SMALLINT,
  notes TEXT,
  target_product TEXT,
  sensation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(aurora_uid, log_date)
);

CREATE INDEX IF NOT EXISTS idx_aurora_skin_logs_uid_date
  ON aurora_skin_logs(aurora_uid, log_date DESC);

