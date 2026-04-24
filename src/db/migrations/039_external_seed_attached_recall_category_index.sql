CREATE INDEX IF NOT EXISTS idx_external_product_seeds_attached_recall_category_vertical_recency
ON external_product_seeds (
  market,
  tool,
  lower(coalesce(seed_data->'derived'->'recall'->>'category', '')),
  lower(coalesce(seed_data->'derived'->'recall'->>'vertical', '')),
  updated_at DESC NULLS LAST,
  created_at DESC NULLS LAST
)
WHERE status = 'active'
  AND coalesce(attached_product_key, '') <> '';
