-- ADR-020 Phase 1 slice 1: project the external-seed recall doc into
-- catalog_products so the unified sig-keyed lane can search catalog rows
-- without a per-request external_product_seeds join.
--
-- Columns are nullable projections maintained by the convergent reconciler
-- scripts/reconcile-catalog-recall-doc.cjs (ADR-012 style: chunked,
-- stalest-first, drift-metric reported; NOT a sync-time poke):
--   recall_doc            lower()ed searchable text, one source field per
--                         E'\n'-separated line, mirroring the arms of
--                         external_product_seeds.search_text (migration 057)
--                         / EXTERNAL_SEED_RECALL_SQL_FIELDS in
--                         src/services/externalSeedRecall.js
--   recall_market         upper()ed seed market (scoping)
--   recall_tool           seed tool (scoping)
--   recall_availability   normalized seed availability
--   recall_doc_updated_at when the projection last landed; the reconciler's
--                         drift predicate compares it against
--                         external_product_seeds.updated_at
--
-- PROD ROLLOUT NOTE: catalog_products is a live serving table. On prod the
-- trigram GIN index build MUST be run out-of-band with
-- CREATE INDEX CONCURRENTLY (same playbook as migrations 055/056/057) BEFORE
-- this file deploys; IF NOT EXISTS then makes the inline build a no-op here.
-- Fresh/empty environments run everything inline.

DO $$
DECLARE
  trgm_ready boolean := false;
BEGIN
  IF to_regclass('public.catalog_products') IS NULL THEN
    RAISE NOTICE 'catalog_products table not found; skipping recall_doc projection columns';
    RETURN;
  END IF;

  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm';
    trgm_ready := true;
  EXCEPTION
    WHEN undefined_file THEN
      RAISE NOTICE 'pg_trgm extension not installed; skipping recall_doc trigram index';
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'insufficient privilege to create pg_trgm; skipping recall_doc trigram index';
    WHEN OTHERS THEN
      RAISE NOTICE 'pg_trgm unavailable (%); skipping recall_doc trigram index', SQLERRM;
  END;

  EXECUTE $sql$
    ALTER TABLE catalog_products
      ADD COLUMN IF NOT EXISTS recall_doc text,
      ADD COLUMN IF NOT EXISTS recall_market text,
      ADD COLUMN IF NOT EXISTS recall_tool text,
      ADD COLUMN IF NOT EXISTS recall_availability text,
      ADD COLUMN IF NOT EXISTS recall_doc_updated_at timestamptz
  $sql$;

  -- Reconciler scan support: drift selection is stalest-first by
  -- recall_doc_updated_at ASC NULLS FIRST with no market filter (the
  -- reconciler's ORDER BY), so the index matches that ordering exactly;
  -- NULLs (never projected) sort first.
  EXECUTE $sql$
    CREATE INDEX IF NOT EXISTS idx_catalog_products_recall_doc_updated
    ON catalog_products (recall_doc_updated_at ASC NULLS FIRST)
  $sql$;

  IF trgm_ready THEN
    -- Unified-lane text recall over the projected doc. Partial on
    -- recall_doc IS NOT NULL: today only external_referral rows carry a
    -- projection; the predicate stays valid as other tracks gain docs.
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_catalog_products_recall_doc_trgm
      ON catalog_products
      USING gin (recall_doc gin_trgm_ops)
      WHERE recall_doc IS NOT NULL
    $sql$;
  END IF;
END $$;
