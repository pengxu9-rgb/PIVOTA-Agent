#!/usr/bin/env node
'use strict';

const { closeReadOnlyPool, queryReadOnly } = require('./lib/read-only-db.cjs');
const { parseCommonArgs, printRows, usage } = require('./lib/pdp-sampling-cli.cjs');

const SCRIPT = 'audit-zero-price-offer-timestamps.cjs';
const DESCRIPTION = 'Rolls up zero or missing price catalog_offers by source and timestamp range.';

const QUERY = `
SELECT
  COALESCE(source_system, 'unknown') AS source,
  COUNT(*)::int AS count,
  MIN(created_at) AS created_at_min,
  MAX(created_at) AS created_at_max,
  MIN(updated_at) AS updated_at_min,
  MAX(updated_at) AS updated_at_max
FROM catalog_offers
WHERE list_price IS NULL
   OR list_price <= 0
GROUP BY COALESCE(source_system, 'unknown')
ORDER BY count DESC, source
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
