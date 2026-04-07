CREATE INDEX IF NOT EXISTS idx_external_product_seeds_beauty_surface_text_trgm
ON external_product_seeds
USING gin (
  lower(
    concat_ws(
      ' ',
      coalesce(title, ''),
      coalesce(domain, ''),
      coalesce(canonical_url, ''),
      coalesce(destination_url, ''),
      coalesce(seed_data->>'title', ''),
      coalesce(seed_data->'snapshot'->>'title', ''),
      coalesce(seed_data->>'brand', ''),
      coalesce(seed_data->>'brand_name', ''),
      coalesce(seed_data->>'vendor', ''),
      coalesce(seed_data->>'vendor_name', ''),
      coalesce(seed_data->>'merchant_display_name', ''),
      coalesce(seed_data->'snapshot'->>'brand', ''),
      coalesce(seed_data->'snapshot'->>'brand_name', ''),
      coalesce(seed_data->'snapshot'->>'vendor', ''),
      coalesce(seed_data->'snapshot'->>'vendor_name', ''),
      coalesce(seed_data->'snapshot'->>'merchant_display_name', ''),
      coalesce(seed_data->>'category', ''),
      coalesce(seed_data->>'product_type', ''),
      coalesce(seed_data->'snapshot'->>'category', ''),
      coalesce(seed_data->'snapshot'->>'product_type', '')
    )
  ) gin_trgm_ops
)
WHERE status = 'active'
  AND attached_product_key IS NULL;
