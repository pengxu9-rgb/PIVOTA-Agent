CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_recall_title_trgm
ON external_product_seeds
USING gin (
  lower(coalesce(seed_data->'derived'->'recall'->>'retrieval_title', '')) gin_trgm_ops
)
WHERE status = 'active'
  AND attached_product_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_recall_summary_trgm
ON external_product_seeds
USING gin (
  lower(coalesce(seed_data->'derived'->'recall'->>'retrieval_summary', '')) gin_trgm_ops
)
WHERE status = 'active'
  AND attached_product_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_recall_category_vertical_recency
ON external_product_seeds (
  market,
  tool,
  lower(coalesce(seed_data->'derived'->'recall'->>'category', '')),
  lower(coalesce(seed_data->'derived'->'recall'->>'vertical', '')),
  updated_at DESC NULLS LAST,
  created_at DESC NULLS LAST
)
WHERE status = 'active'
  AND attached_product_key IS NULL;
