-- 052_pba_sig_id.sql
-- Adds sig_id to product_beauty_attributes so the preflight gate can look up
-- attributes by pivota_signature_id (sig_*) after the graph is rekeyed to sig_*.
--
-- Backfill joins via catalog_products.source_product_id = pba.product_key.
-- ~90% fill rate expected; the ~10% with no catalog_products row keep sig_id=NULL
-- and the gate abstains for those (existing behaviour for missing attrs).

ALTER TABLE product_beauty_attributes
  ADD COLUMN IF NOT EXISTS sig_id TEXT;

CREATE INDEX IF NOT EXISTS idx_pba_sig_id
  ON product_beauty_attributes (sig_id)
  WHERE sig_id IS NOT NULL;

-- Backfill from unambiguous external-seed catalog rows. Safe to re-run: updates
-- only rows where sig_id doesn't match the catalog (handles sig corrections from
-- backfill-sig-propagation). Duplicate source ids with conflicting sigs are
-- skipped instead of letting UPDATE ... FROM choose an arbitrary source row.
WITH catalog_sig AS (
  SELECT
    source_product_id,
    MIN(pivota_signature_id) AS pivota_signature_id
  FROM catalog_products
  WHERE merchant_id = 'external_seed'
    AND source_product_id IS NOT NULL
    AND source_product_id <> ''
    AND pivota_signature_id IS NOT NULL
  GROUP BY source_product_id
  HAVING COUNT(DISTINCT pivota_signature_id) = 1
)
UPDATE product_beauty_attributes pba
SET sig_id = catalog_sig.pivota_signature_id
FROM catalog_sig
WHERE catalog_sig.source_product_id = pba.product_key
  AND pba.sig_id IS DISTINCT FROM catalog_sig.pivota_signature_id;
