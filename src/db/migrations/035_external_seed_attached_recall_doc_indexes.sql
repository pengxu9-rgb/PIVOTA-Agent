CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_attached_recall_title_trgm
ON external_product_seeds
USING gin (
  lower(coalesce(seed_data->'derived'->'recall'->>'retrieval_title', '')) gin_trgm_ops
)
WHERE status = 'active'
  AND coalesce(attached_product_key, '') <> '';

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_attached_recall_summary_trgm
ON external_product_seeds
USING gin (
  lower(coalesce(seed_data->'derived'->'recall'->>'retrieval_summary', '')) gin_trgm_ops
)
WHERE status = 'active'
  AND coalesce(attached_product_key, '') <> '';

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_recall_ingredient_tokens_trgm
ON external_product_seeds
USING gin (
  lower(coalesce(seed_data#>>'{derived,recall,ingredient_tokens}', '')) gin_trgm_ops
)
WHERE status = 'active'
  AND attached_product_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_recall_alias_tokens_trgm
ON external_product_seeds
USING gin (
  lower(coalesce(seed_data#>>'{derived,recall,alias_tokens}', '')) gin_trgm_ops
)
WHERE status = 'active'
  AND attached_product_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_attached_recall_ingredient_tokens_trgm
ON external_product_seeds
USING gin (
  lower(coalesce(seed_data#>>'{derived,recall,ingredient_tokens}', '')) gin_trgm_ops
)
WHERE status = 'active'
  AND coalesce(attached_product_key, '') <> '';

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_attached_recall_alias_tokens_trgm
ON external_product_seeds
USING gin (
  lower(coalesce(seed_data#>>'{derived,recall,alias_tokens}', '')) gin_trgm_ops
)
WHERE status = 'active'
  AND coalesce(attached_product_key, '') <> '';
