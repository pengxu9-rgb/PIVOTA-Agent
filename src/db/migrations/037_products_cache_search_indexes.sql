-- Speed up cross-merchant lexical browse/search over products_cache.
-- The gateway search path uses leading-wildcard LIKE over product_data JSON fields;
-- pg_trgm expression indexes let Postgres avoid repeated full JSON scans.

DO $$
DECLARE
  trgm_ready boolean := false;
BEGIN
  IF to_regclass('public.products_cache') IS NULL THEN
    RAISE NOTICE 'products_cache table not found; skipping products_cache search indexes';
    RETURN;
  END IF;

  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm';
    trgm_ready := true;
  EXCEPTION
    WHEN undefined_file THEN
      RAISE NOTICE 'pg_trgm extension not installed; skipping products_cache trigram indexes';
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'insufficient privilege to create pg_trgm; skipping products_cache trigram indexes';
    WHEN OTHERS THEN
      RAISE NOTICE 'pg_trgm unavailable (%); skipping products_cache trigram indexes', SQLERRM;
  END;

  EXECUTE $sql$
    CREATE INDEX IF NOT EXISTS idx_products_cache_expires_recent
    ON products_cache (expires_at DESC, id DESC)
  $sql$;

  EXECUTE $sql$
    CREATE INDEX IF NOT EXISTS idx_products_cache_cached_recent
    ON products_cache (cached_at DESC NULLS LAST, id DESC)
  $sql$;

  EXECUTE $sql$
    CREATE INDEX IF NOT EXISTS idx_products_cache_merchant_lookup
    ON products_cache (merchant_id)
  $sql$;

  EXECUTE $sql$
    CREATE INDEX IF NOT EXISTS idx_products_cache_status_expr
    ON products_cache (lower(coalesce(product_data->>'status', '')))
  $sql$;

  EXECUTE $sql$
    CREATE INDEX IF NOT EXISTS idx_products_cache_orderable_expr
    ON products_cache (lower(coalesce(product_data->>'orderable', '')))
  $sql$;

  IF trgm_ready THEN
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_products_cache_title_trgm
      ON products_cache
      USING gin (lower(coalesce(product_data->>'title', '')) gin_trgm_ops)
    $sql$;

    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_products_cache_description_trgm
      ON products_cache
      USING gin (lower(coalesce(product_data->>'description', '')) gin_trgm_ops)
    $sql$;

    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_products_cache_product_type_trgm
      ON products_cache
      USING gin (lower(coalesce(product_data->>'product_type', '')) gin_trgm_ops)
    $sql$;

    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_products_cache_sku_trgm
      ON products_cache
      USING gin (lower(coalesce(product_data->>'sku', '')) gin_trgm_ops)
    $sql$;

    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_products_cache_vendor_trgm
      ON products_cache
      USING gin (lower(coalesce(product_data->>'vendor', '')) gin_trgm_ops)
    $sql$;
  END IF;
END $$;
