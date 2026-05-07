/**
 * Manual / live-DB sanity check for canonicalCatalogSearch.
 *
 * NOT part of CI. Run against prod (or staging) DATABASE_URL once before
 * Step 2 to confirm the helper's SQL actually returns rows for the
 * categories we backfilled in PR #313 + #332.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node tests/_manual/canonical_catalog_search_live.js
 *
 * Expected output (against current prod, 2026-05-07):
 *   - "lipstick" → 18 rows (15 PDPs × 1.2 offers/PDP)
 *   - "perfume"  → ~50 rows (Phase 8 fragrance candidates)
 *   - "口红"      → 0 rows (Chinese term not in title/brand/SKU; relies on
 *                  category prefix being passed in by upstream classifier)
 *   - "口红" + categoryPathPrefix='beauty/makeup/lip/' → 18 rows
 */

'use strict';

const { Client } = require('pg');
const {
  fetchCanonicalChainRows,
} = require('../../src/services/canonicalCatalogSearch');

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const client = new Client({ connectionString: dsn });
  await client.connect();
  const query = (sql, params) => client.query(sql, params);

  const cases = [
    { label: 'lipstick (no prefix)', args: { query: 'lipstick', deps: { query } } },
    {
      label: 'lipstick (with prefix beauty/makeup/lip/)',
      args: {
        query: 'lipstick',
        categoryPathPrefix: 'beauty/makeup/lip/',
        deps: { query },
      },
    },
    {
      label: '口红 (no prefix — should be 0 since title/brand are EN)',
      args: { query: '口红', deps: { query } },
    },
    {
      label: '口红 (with prefix beauty/makeup/lip/ — should match category)',
      args: {
        query: '口红',
        categoryPathPrefix: 'beauty/makeup/lip/',
        deps: { query },
      },
    },
    { label: 'perfume', args: { query: 'perfume', deps: { query } } },
    { label: 'mascara', args: { query: 'mascara', deps: { query } } },
  ];

  for (const { label, args } of cases) {
    const t0 = Date.now();
    const rows = await fetchCanonicalChainRows(args);
    const elapsed = Date.now() - t0;
    console.log(`\n=== ${label} — ${rows.length} rows in ${elapsed}ms ===`);
    for (const r of rows.slice(0, 3)) {
      console.log(
        `  ${String(r.product_title || '').slice(0, 50).padEnd(50)} | brand=${String(r.brand || '').slice(0, 14).padEnd(14)} | track=${r.catalog_track} | scope=${r.pdp_scope} | rank=${r.rank_score}`,
      );
    }
    if (rows.length > 3) console.log(`  … +${rows.length - 3} more`);
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
