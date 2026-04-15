CREATE INDEX IF NOT EXISTS idx_external_product_seeds_recall_category_coalesced_recency
ON external_product_seeds (
  market,
  tool,
  lower(coalesce(
    seed_data->'derived'->'recall'->>'category',
    seed_data->>'category',
    seed_data->'product'->>'category',
    seed_data->'snapshot'->>'category',
    seed_data->>'product_type',
    seed_data->'product'->>'product_type',
    seed_data->'snapshot'->>'product_type',
    ''
  )),
  updated_at DESC NULLS LAST,
  created_at DESC NULLS LAST,
  id DESC
)
WHERE status = 'active'
  AND attached_product_key IS NULL;
