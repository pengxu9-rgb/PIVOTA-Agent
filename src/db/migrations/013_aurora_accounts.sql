-- Purpose: Aurora BFF account memory (user_id) + identity links
-- Tables:
--   - aurora_account_profiles: long-lived skin profile for signed-in users
--   - aurora_account_skin_logs: daily tracker logs for signed-in users
--   - aurora_identity_links: map anonymous aurora_uid -> user_id

CREATE TABLE IF NOT EXISTS aurora_account_profiles (
  user_id TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_aurora_account_profiles_updated_at
  ON aurora_account_profiles(updated_at DESC);

CREATE TABLE IF NOT EXISTS aurora_account_skin_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES aurora_account_profiles(user_id) ON DELETE CASCADE,
  log_date DATE NOT NULL,
  redness SMALLINT,
  acne SMALLINT,
  hydration SMALLINT,
  notes TEXT,
  target_product TEXT,
  sensation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_aurora_account_skin_logs_uid_date
  ON aurora_account_skin_logs(user_id, log_date DESC);

CREATE TABLE IF NOT EXISTS aurora_identity_links (
  aurora_uid TEXT PRIMARY KEY REFERENCES aurora_user_profiles(aurora_uid) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aurora_identity_links_user_id
  ON aurora_identity_links(user_id);

