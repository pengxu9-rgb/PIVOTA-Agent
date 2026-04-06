-- The 031 brand-search migrations reused the same index name for different
-- expressions, so the normalized fastpath expression can be skipped by
-- IF NOT EXISTS. Use a unique name that exactly matches the runtime predicate.

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_brand_search_norm_recency
ON external_product_seeds (
  market,
  tool,
  lower(
    regexp_replace(
      coalesce(
        seed_data->>'brand',
        seed_data->'snapshot'->>'brand',
        split_part(domain, '.', 1),
        ''
      ),
      '[^a-z0-9]+',
      '',
      'g'
    )
  ),
  updated_at DESC NULLS LAST,
  created_at DESC NULLS LAST
)
WHERE status = 'active'
  AND attached_product_key IS NULL;
