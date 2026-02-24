CREATE TABLE IF NOT EXISTS aurora_budget_preference_events (
  id BIGSERIAL PRIMARY KEY,
  identity_key TEXT NOT NULL,
  aurora_uid TEXT,
  user_id TEXT,
  tier TEXT NOT NULL CHECK (tier IN ('low', 'mid', 'high')),
  price NUMERIC,
  currency TEXT,
  source_event TEXT,
  product_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aurora_budget_pref_identity_created
  ON aurora_budget_preference_events (identity_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aurora_budget_pref_created_at
  ON aurora_budget_preference_events (created_at DESC);
