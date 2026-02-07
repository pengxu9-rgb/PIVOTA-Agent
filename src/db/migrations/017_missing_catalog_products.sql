-- Resolver gap tracking: recommended items that cannot be grounded to a PDP-openable product_ref.

CREATE TABLE IF NOT EXISTS missing_catalog_products (
  id BIGSERIAL PRIMARY KEY,
  normalized_query TEXT NOT NULL,
  query_sample TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en',
  hints JSONB NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count INT NOT NULL DEFAULT 1,
  last_caller TEXT NULL,
  last_session_id TEXT NULL,
  last_reason TEXT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_missing_catalog_products_norm_lang
  ON missing_catalog_products (normalized_query, lang);

CREATE INDEX IF NOT EXISTS idx_missing_catalog_products_last_seen
  ON missing_catalog_products (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_missing_catalog_products_seen_count
  ON missing_catalog_products (seen_count DESC);

