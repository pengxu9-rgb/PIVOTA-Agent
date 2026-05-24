#!/usr/bin/env node
'use strict';

const { closeReadOnlyPool, queryReadOnly } = require('./lib/read-only-db.cjs');
const { parseCommonArgs, printRows, usage } = require('./lib/pdp-sampling-cli.cjs');

const SCRIPT = 'audit-orphan-shopify-offers.cjs';
const DESCRIPTION = 'Samples Shopify catalog_offers whose sku_key does not resolve to catalog_skus.';

const QUERY = `
SELECT
  o.offer_id,
  o.merchant_id,
  COALESCE(cp.platform, 'shopify') AS platform,
  NULLIF(COALESCE(
    o.offer_payload->>'source_variant_id',
    o.offer_payload->>'variant_id',
    o.offer_payload->>'raw_variant_id'
  ), '') AS source_variant_id,
  o.list_price AS price_cents,
  o.currency,
  COALESCE(o.availability = 'in_stock', false) AS available,
  CASE
    WHEN o.merchant_id IS NOT NULL
     AND COALESCE(cp.platform, 'shopify') IS NOT NULL
     AND NULLIF(COALESCE(
       o.offer_payload->>'source_variant_id',
       o.offer_payload->>'variant_id',
       o.offer_payload->>'raw_variant_id'
     ), '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM catalog_skus cs_existing
       WHERE cs_existing.merchant_id = o.merchant_id
         AND cs_existing.platform = COALESCE(cp.platform, 'shopify')
         AND cs_existing.source_variant_id = NULLIF(COALESCE(
           o.offer_payload->>'source_variant_id',
           o.offer_payload->>'variant_id',
           o.offer_payload->>'raw_variant_id'
         ), '')
     )
    THEN true
    ELSE false
  END AS would_backfill_sku
FROM catalog_offers o
LEFT JOIN catalog_skus cs ON cs.sku_key = o.sku_key
LEFT JOIN catalog_products cp ON cp.product_key = o.product_key
WHERE cs.sku_key IS NULL
  AND o.source_system = 'shopify_products_sync'
ORDER BY o.updated_at DESC NULLS LAST, o.offer_id
LIMIT $1
`.trim();

async function main() {
  const args = parseCommonArgs();
  if (args.help) {
    process.stdout.write(`${usage(SCRIPT, DESCRIPTION)}\n`);
    return;
  }
  const result = await queryReadOnly(QUERY, [args.limit]);
  printRows(result.rows || [], args);
}

main()
  .catch((err) => {
    process.stderr.write(`${err?.message || err}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeReadOnlyPool().catch(() => {}));
