-- ADR-009 phase 3 — re-key ledger.
--
-- Phase 3 moves legacy Path B rows off the `external_seed` sentinel onto the
-- observed seller (`merch_obs_…`) that `ensure_observed_seller` already minted
-- for them. Every merchant_id write it performs is recorded here so a rollback
-- is a join against this table rather than an archaeology exercise — the flip
-- itself is not otherwise reversible, since the old value is overwritten in
-- place and `product_key` is deliberately left untouched (ADR-009 D4.2: the
-- `prod::external_seed::…` key becomes a historical-format storage token, and
-- a 2026-08-01 backfill that "repaired" such keys took 364 public PDPs to 500).
--
-- One row per (table, row) actually written, not per row attempted, so the
-- ledger count is the authoritative record of what moved. `source_table`
-- distinguishes the product row from the three sibling tables that carry a
-- denormalized merchant_id for the same cohort and must move with it.
--
-- `row_ref` always holds that table's PRIMARY KEY, so one ledger entry maps to
-- exactly one row and rollback is unambiguous:
--   catalog_products      product_key
--   catalog_skus          sku_key
--   catalog_offers        offer_id
--   pdp_identity_listing  source_listing_ref
--
-- Note these are NOT the columns the re-key joins on. catalog_offers joins on
-- product_key, which has up to 30 rows per product in this cohort, and
-- pdp_identity_listing joins on product_id (= catalog_products.source_product_id,
-- a different key space from product_key). Recording a join key instead of the
-- primary key would collapse distinct rows into one ledger entry and make
-- rollback revert rows the batch never touched.

CREATE TABLE IF NOT EXISTS external_seed_rekey_ledger (
  id              BIGSERIAL PRIMARY KEY,
  batch_id        TEXT        NOT NULL,
  source_table    TEXT        NOT NULL,
  row_ref         TEXT        NOT NULL,
  old_merchant_id TEXT        NOT NULL,
  new_merchant_id TEXT        NOT NULL,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rollback path: given a batch, restore each row's previous merchant_id.
CREATE INDEX IF NOT EXISTS idx_external_seed_rekey_ledger_batch
  ON external_seed_rekey_ledger (batch_id);

-- "Was this row ever moved, and where from?" — the lookup used when a single
-- product is investigated after the fact.
CREATE INDEX IF NOT EXISTS idx_external_seed_rekey_ledger_row
  ON external_seed_rekey_ledger (source_table, row_ref);

-- Per-seller progress + resumability: the script batches by target seller.
CREATE INDEX IF NOT EXISTS idx_external_seed_rekey_ledger_new_merchant
  ON external_seed_rekey_ledger (new_merchant_id);
