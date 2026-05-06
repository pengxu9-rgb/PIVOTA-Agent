CREATE TABLE IF NOT EXISTS external_seed_image_assets (
  id BIGSERIAL PRIMARY KEY,
  external_product_id TEXT NOT NULL,
  external_seed_id TEXT,
  original_url TEXT NOT NULL,
  cached_url TEXT,
  source_url TEXT,
  source_host TEXT,
  status TEXT NOT NULL,
  reason_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  sha256 TEXT,
  content_type TEXT,
  bytes INTEGER,
  width INTEGER,
  height INTEGER,
  fetched_at TIMESTAMPTZ,
  fetch_method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_external_seed_image_assets_product_original
ON external_seed_image_assets (external_product_id, original_url);

CREATE INDEX IF NOT EXISTS idx_external_seed_image_assets_sha256
ON external_seed_image_assets (sha256)
WHERE sha256 IS NOT NULL AND sha256 <> '';

CREATE INDEX IF NOT EXISTS idx_external_seed_image_assets_status_updated
ON external_seed_image_assets (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_seed_image_assets_source_host
ON external_seed_image_assets (source_host)
WHERE source_host IS NOT NULL AND source_host <> '';
