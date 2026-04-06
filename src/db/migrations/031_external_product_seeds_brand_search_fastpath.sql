-- Speed up brand-like public search exact-match routing on external_product_seeds.
-- This matches the normalized brand expression used by the gateway fast path.

CREATE INDEX IF NOT EXISTS idx_external_product_seeds_brand_search_fastpath
ON external_product_seeds (
  market,
  tool,
  (
    lower(
      coalesce(
        seed_data->>'brand',
        seed_data->'snapshot'->>'brand',
        seed_data->>'merchant_display_name',
        seed_data->'snapshot'->>'merchant_display_name',
        seed_data->>'vendor',
        seed_data->'snapshot'->>'vendor',
        ''
      )
    )
  ),
  updated_at DESC,
  created_at DESC
)
WHERE status = 'active' AND attached_product_key IS NULL;
