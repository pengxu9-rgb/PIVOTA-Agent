#!/usr/bin/env node
'use strict';

/**
 * Fix Plan E — read-only targeted metrics for the before/after retirement diff.
 * Captures exactly the cohorts T1/T2/T3 touch (the standard catalog-counts audit
 * is beauty-dominated and hides these small electronics/demo cohorts).
 *
 * Usage: railway run node ./scripts/report-demo-retirement-metrics.cjs [--out path.json]
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ELECTRONICS = ['sony', 'apple', 'bose', 'samsung', 'jbl', 'sennheiser', 'kobo', 'beats', 'amazon'];
const T2_RETIRE = 'merch_bbd34645bc1950cc';
const T2_KEEP = 'merch_efbc46b4619cfbdf';
const T3_FIXTURE = 'merch_test_ownist_001';
const T3_REVIEW_DEMO = ['merch_shopify_00d4a720d67d96c5dcba', 'merch_shopify_0584b37f7a8be00a5223', 'merch_shopify_b20b5797f4181983c177'];
const TEST_BRANDS = ['snowboard vendor', 'hydrogen vendor', 'multi-managed vendor'];

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : '';
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 30000 });
  await c.connect();
  const q = (sql, p = []) => c.query(sql, p).then((r) => r.rows);
  const one = (sql, p = []) => q(sql, p).then((r) => r[0] || {});
  const m = { at: new Date().toISOString() };

  // T1 electronics
  m.t1_electronics_active_seeds = (await one(
    `SELECT count(*)::int n FROM external_product_seeds
     WHERE lower(btrim(coalesce(seed_data->>'brand',''))) = ANY($1)
       AND lower(coalesce(status,''))='active'`, [ELECTRONICS])).n;
  m.t1_electronics_products_total = (await one(
    `SELECT count(*)::int n FROM catalog_products WHERE lower(btrim(coalesce(brand,''))) = ANY($1)`, [ELECTRONICS])).n;
  m.t1_electronics_products_unsuppressed = (await one(
    `SELECT count(*)::int n FROM catalog_products WHERE lower(btrim(coalesce(brand,''))) = ANY($1) AND suppression_reason IS NULL`, [ELECTRONICS])).n;
  m.t1_electronics_products_marked = (await one(
    `SELECT count(*)::int n FROM catalog_products WHERE lower(btrim(coalesce(brand,''))) = ANY($1) AND suppression_reason='demo_retired_2026_07'`, [ELECTRONICS])).n;
  m.t1_electronics_offers_unsuppressed = (await one(
    `SELECT count(*)::int n FROM catalog_offers o
     WHERE o.product_key IN (SELECT product_key FROM catalog_products WHERE lower(btrim(coalesce(brand,''))) = ANY($1))
       AND o.suppression_reason IS NULL`, [ELECTRONICS])).n;
  m.t1_electronics_trust_public = (await one(
    `SELECT count(*)::int n FROM catalog_row_trust crt
     JOIN catalog_products cp ON cp.product_key=crt.subject_key
     WHERE lower(btrim(coalesce(cp.brand,''))) = ANY($1) AND crt.serving_decision='public'`, [ELECTRONICS])).n;

  // T2 duplication merchants
  m.t2_bbd_products_total = (await one(`SELECT count(*)::int n FROM catalog_products WHERE merchant_id=$1`, [T2_RETIRE])).n;
  m.t2_bbd_products_marked = (await one(`SELECT count(*)::int n FROM catalog_products WHERE merchant_id=$1 AND suppression_reason='demo_retired_2026_07'`, [T2_RETIRE])).n;
  m.t2_bbd_offers_total = (await one(`SELECT count(*)::int n FROM catalog_offers WHERE merchant_id=$1`, [T2_RETIRE])).n;
  m.t2_bbd_offers_marked = (await one(`SELECT count(*)::int n FROM catalog_offers WHERE merchant_id=$1 AND suppression_reason='demo_retired_2026_07'`, [T2_RETIRE])).n;
  m.t2_bbd_stores = await q(`SELECT store_id, status FROM merchant_stores WHERE merchant_id=$1 ORDER BY store_id`, [T2_RETIRE]);
  m.t2_ef_products_total = (await one(`SELECT count(*)::int n FROM catalog_products WHERE merchant_id=$1`, [T2_KEEP])).n;
  m.t2_ef_stores = await q(`SELECT store_id, status FROM merchant_stores WHERE merchant_id=$1 ORDER BY store_id`, [T2_KEEP]);

  // T3 fixtures
  m.t3_ownist_products_total = (await one(`SELECT count(*)::int n FROM catalog_products WHERE merchant_id=$1`, [T3_FIXTURE])).n;
  m.t3_ownist_products_marked = (await one(`SELECT count(*)::int n FROM catalog_products WHERE merchant_id=$1 AND suppression_reason='demo_retired_2026_07'`, [T3_FIXTURE])).n;
  m.t3_ownist_offers_total = (await one(`SELECT count(*)::int n FROM catalog_offers WHERE merchant_id=$1`, [T3_FIXTURE])).n;
  m.t3_ownist_offers_marked = (await one(`SELECT count(*)::int n FROM catalog_offers WHERE merchant_id=$1 AND suppression_reason='demo_retired_2026_07'`, [T3_FIXTURE])).n;
  m.t3_test_brand_products_total = (await one(
    `SELECT count(*)::int n FROM catalog_products
     WHERE (lower(btrim(coalesce(brand,''))) = ANY($1) OR lower(btrim(coalesce(brand,''))) LIKE 'pivota review demo%')
       AND merchant_id = ANY($2)`, [TEST_BRANDS, T3_REVIEW_DEMO])).n;
  m.t3_test_brand_products_marked = (await one(
    `SELECT count(*)::int n FROM catalog_products
     WHERE (lower(btrim(coalesce(brand,''))) = ANY($1) OR lower(btrim(coalesce(brand,''))) LIKE 'pivota review demo%')
       AND merchant_id = ANY($2) AND suppression_reason='demo_retired_2026_07'`, [TEST_BRANDS, T3_REVIEW_DEMO])).n;

  // Mojawa untouched invariant
  m.mojawa_products = await q(
    `SELECT product_key, updated_at, suppression_reason, suppressed_at FROM catalog_products
     WHERE lower(btrim(coalesce(brand,'')))='mojawa' OR merchant_id IN ('merch_obs_022b65d47a58b87a','merch_9678f6352da21473')
     ORDER BY product_key`);

  await c.end();
  const json = JSON.stringify(m, null, 2);
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, json + '\n'); }
  process.stdout.write(json + '\n');
}
main().catch((e) => { process.stderr.write((e.stack || e.message) + '\n'); process.exit(1); });
