#!/usr/bin/env node
'use strict';

const { closeReadOnlyPool, queryReadOnly } = require('./lib/read-only-db.cjs');
const { parseCommonArgs, printRows, usage } = require('./lib/pdp-sampling-cli.cjs');

const SCRIPT = 'sample-duplicate-canonical-groups.cjs';
const DESCRIPTION = 'Samples the largest duplicate canonical catalog groups.';

const QUERY = `
WITH product_rows AS (
  SELECT
    COALESCE(NULLIF(cp.content_key, ''), NULLIF(pgm.product_group_id, ''), cp.product_key) AS group_key,
    cp.product_key,
    cp.pivota_signature_id,
    cp.content_key,
    cp.merchant_id,
    (
      SELECT cs.source_variant_id
      FROM catalog_skus cs
      WHERE cs.product_key = cp.product_key
      ORDER BY cs.updated_at DESC NULLS LAST, cs.sku_key
      LIMIT 1
    ) AS source_variant_id,
    cp.brand,
    cp.title,
    cp.source_system AS source
  FROM catalog_products cp
  LEFT JOIN product_group_members pgm
    ON pgm.merchant_id = cp.merchant_id
   AND pgm.platform = cp.platform
   AND pgm.platform_product_id = cp.source_product_id
  WHERE COALESCE(NULLIF(cp.content_key, ''), NULLIF(pgm.product_group_id, ''), cp.product_key) IS NOT NULL
),
grouped AS (
  SELECT
    group_key,
    COUNT(*)::int AS group_size,
    JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'pivota_signature_id', pivota_signature_id,
        'content_key', content_key,
        'merchant_id', merchant_id,
        'source_variant_id', source_variant_id,
        'brand', brand,
        'title', title,
        'source', source
      )
      ORDER BY merchant_id, product_key
    ) AS members
  FROM product_rows
  GROUP BY group_key
  HAVING COUNT(*) > 1
)
SELECT
  group_key,
  group_size,
  members
FROM grouped
ORDER BY group_size DESC, group_key
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
