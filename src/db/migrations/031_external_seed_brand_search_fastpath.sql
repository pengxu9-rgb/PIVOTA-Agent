CREATE INDEX IF NOT EXISTS idx_external_product_seeds_brand_search_fastpath
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
  )
)
WHERE status = 'active'
  AND attached_product_key IS NULL;
