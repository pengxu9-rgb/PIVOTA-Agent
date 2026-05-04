CREATE INDEX IF NOT EXISTS idx_external_product_seeds_active_external_product_id
ON external_product_seeds (external_product_id)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_active_seed_external_product_id
ON external_product_seeds ((seed_data->>'external_product_id'))
WHERE status = 'active'
  AND seed_data ? 'external_product_id';

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_active_seed_product_id
ON external_product_seeds ((seed_data->>'product_id'))
WHERE status = 'active'
  AND seed_data ? 'product_id';

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_active_snapshot_product_id
ON external_product_seeds ((seed_data->'snapshot'->>'product_id'))
WHERE status = 'active'
  AND seed_data ? 'snapshot';

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_recall_domain_recency
ON external_product_seeds (
  market,
  tool,
  domain,
  updated_at DESC NULLS LAST,
  created_at DESC NULLS LAST
)
WHERE status = 'active'
  AND attached_product_key IS NULL
  AND coalesce(domain, '') <> '';
