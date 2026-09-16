-- Drop the two external_product_seeds brand-search indexes. Neither serves any reader.
--
-- Measured on prod 2026-09-16 (pg_stat_user_indexes, stats_reset 2026-08-22 — 25 days of
-- production traffic):
--
--   idx_external_product_seeds_brand_search_fastpath      16 kB, idx_scan = 0, idx_tup_read = 0
--   idx_external_product_seeds_brand_search_norm_recency  16 kB, idx_scan = 0, idx_tup_read = 0
--
-- Both are partial on `status = 'active' AND attached_product_key IS NULL`, which matches 5 of
-- 14,043 rows. Sibling indexes on the same table took 24.8M and 15.3M scans over the same window,
-- so zero here is a real zero and not a quiet database.
--
-- Why they cannot be used:
--   * The brand fastpath (findProductsExternalSeedBrandFastpath) hard-codes
--     `AND attached_product_key IS NOT NULL` — the opposite of the partial predicate — so neither
--     index can ever serve it, whatever expression they carry.
--   * productGroundingResolver IS on `attached_product_key IS NULL`, and its two brand arms once
--     matched these expressions character for character. It still plans as a Seq Scan either way:
--     `tool = '*' OR tool = $2` plus the two-branch brand OR already defeat them. #2217 then
--     changed one of those arms to `regexp_replace(lower(...))`, leaving norm_recency matching no
--     expression anywhere in the codebase.
--
-- The cost of keeping them is not their size, it is that they read as brand-search coverage that
-- does not exist. That exact trap has already cost review time once: these are the indexes that
-- "look like the right ones" for the brand-page scan and are partial on the wrong row set.
--
-- SAFETY. This file runs inside the migration runner's transaction, at gateway BOOT, before
-- app.listen — so a migration that throws stops the revision from starting. DROP INDEX needs
-- ACCESS EXCLUSIVE on external_product_seeds, which is hot, so the lock is taken with a short
-- timeout and a failure to get it is swallowed rather than allowed to wedge a rollout. The drop
-- itself is instant once the lock is held (16 kB, 5 rows).
--
-- CONSEQUENCE, stated because it is a real one: if the lock is not obtained, this migration is
-- still recorded as applied and will NOT retry. Verify afterwards with
--
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'external_product_seeds'
--      AND indexname IN ('idx_external_product_seeds_brand_search_fastpath',
--                        'idx_external_product_seeds_brand_search_norm_recency');
--
-- and if either is still present, drop it by hand:
--
--   DROP INDEX CONCURRENTLY IF EXISTS idx_external_product_seeds_brand_search_fastpath;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_external_product_seeds_brand_search_norm_recency;
--
-- CONCURRENTLY is the right form by hand and is impossible here: it cannot run inside a
-- transaction block, and this runner wraps every migration in one.

DO $$
BEGIN
  SET LOCAL lock_timeout = '3s';
  EXECUTE 'DROP INDEX IF EXISTS idx_external_product_seeds_brand_search_fastpath';
  EXECUTE 'DROP INDEX IF EXISTS idx_external_product_seeds_brand_search_norm_recency';
EXCEPTION
  WHEN lock_not_available THEN
    RAISE WARNING 'migration 033: could not lock external_product_seeds within 3s; brand-search indexes NOT dropped. Drop them by hand with DROP INDEX CONCURRENTLY — see this file.';
END $$;
