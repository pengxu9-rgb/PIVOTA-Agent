-- Extend missing_catalog_products with reject context for product-intel guardrails.

ALTER TABLE IF EXISTS missing_catalog_products
  ADD COLUMN IF NOT EXISTS candidate_title TEXT NULL;

ALTER TABLE IF EXISTS missing_catalog_products
  ADD COLUMN IF NOT EXISTS candidate_url TEXT NULL;

ALTER TABLE IF EXISTS missing_catalog_products
  ADD COLUMN IF NOT EXISTS candidate_source TEXT NULL;

ALTER TABLE IF EXISTS missing_catalog_products
  ADD COLUMN IF NOT EXISTS reject_reason TEXT NULL;

ALTER TABLE IF EXISTS missing_catalog_products
  ADD COLUMN IF NOT EXISTS rule_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_missing_catalog_products_reject_reason
  ON missing_catalog_products (reject_reason);

CREATE INDEX IF NOT EXISTS idx_missing_catalog_products_rule_id
  ON missing_catalog_products (rule_id);
