-- Purpose: Aurora travel context KB cache (destination + month + language).
-- Table:
--   - aurora_travel_context_kb: compact, reusable travel delta/actions/product-type guidance.

CREATE TABLE IF NOT EXISTS aurora_travel_context_kb (
  kb_key TEXT PRIMARY KEY,
  destination_norm TEXT NOT NULL,
  month_bucket INT NOT NULL,
  lang TEXT NOT NULL,
  climate_delta_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  adaptive_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  product_type_recos JSONB NOT NULL DEFAULT '[]'::jsonb,
  local_brand_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC NOT NULL DEFAULT 0,
  quality_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_success_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aurora_travel_context_kb_lookup
  ON aurora_travel_context_kb(destination_norm, month_bucket, lang);

CREATE INDEX IF NOT EXISTS idx_aurora_travel_context_kb_expires
  ON aurora_travel_context_kb(expires_at DESC);
