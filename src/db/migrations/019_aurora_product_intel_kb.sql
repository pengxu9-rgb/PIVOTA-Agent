-- Purpose: Aurora product-intel KB cache for URL realtime analysis backfill.
-- Table:
--   - aurora_product_intel_kb: key -> normalized product analysis payload + provenance.

CREATE TABLE IF NOT EXISTS aurora_product_intel_kb (
  kb_key TEXT PRIMARY KEY,
  analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT,
  source_meta JSONB,
  last_success_at TIMESTAMPTZ,
  last_error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aurora_product_intel_kb_last_success
  ON aurora_product_intel_kb(last_success_at DESC);

