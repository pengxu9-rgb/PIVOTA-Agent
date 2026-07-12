#!/usr/bin/env node
'use strict';

/**
 * Fix Plan E — T2 (demo-store duplication) + T3 (test-fixture sweep).
 *
 * Retire-don't-delete. NO DELETEs. Reversible marker 'demo_retired_2026_07'.
 * Does NOT touch merchants / merchant_onboarding / billing rows.
 * Does NOT touch merch_efbc46b4619cfbdf ("Chydan", the kept checkout canary).
 * Mojawa protection asserted before + after.
 *
 * T2 — retire merch_bbd34645bc1950cc from index/serving metrics:
 *   - merchant_stores.status -> 'inactive' (serving gates honor this, #1359/#1360)
 *   - catalog_products.suppression_reason -> marker, suppressed_at=now()
 *   - catalog_offers.suppression_reason -> marker, availability='out_of_stock'
 *   merch_efbc46b4619cfbdf is left completely untouched (kept canary).
 *
 * T3 — retire test fixtures:
 *   - merch_test_ownist_001 products+offers (ownist_test_fixture_v1)
 *   - review-demo store catalog rows for brands snowboard/hydrogen/
 *     multi-managed/pivota review demo% (stores themselves are KEPT active for
 *     Shopify App review; only their indexed catalog rows are suppressed).
 *
 * After apply, catalog_row_trust is recomputed for every touched product so all
 * serving readers drop them.
 *
 * Usage:
 *   railway run node ./scripts/retire-demo-fixtures-and-stores.cjs           # dry-run
 *   railway run node ./scripts/retire-demo-fixtures-and-stores.cjs --apply
 *   [--report path.json]
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MARKER = 'demo_retired_2026_07';
const PLAN = 'fixplan_2026-07-12_E';
const MOJAWA_MERCHANTS = ['merch_obs_022b65d47a58b87a', 'merch_9678f6352da21473'];

const T2_RETIRE = 'merch_bbd34645bc1950cc';
const T2_KEEP = 'merch_efbc46b4619cfbdf';
const T3_FIXTURE = 'merch_test_ownist_001';
const T3_REVIEW_DEMO = ['merch_shopify_00d4a720d67d96c5dcba', 'merch_shopify_0584b37f7a8be00a5223', 'merch_shopify_b20b5797f4181983c177'];
const TEST_BRANDS = ['snowboard vendor', 'hydrogen vendor', 'multi-managed vendor'];

const APPLY = process.argv.includes('--apply');
const reportIdx = process.argv.indexOf('--report');
const REPORT_PATH = reportIdx >= 0 ? process.argv[reportIdx + 1] : '';

function log(...a) { process.stdout.write(a.join(' ') + '\n'); }
function abort(msg, detail) {
  process.stderr.write(`\nABORT: ${msg}\n`);
  if (detail !== undefined) process.stderr.write(JSON.stringify(detail, null, 2) + '\n');
  process.exit(2);
}

async function resolve(c) {
  const q = (sql, p = []) => c.query(sql, p).then((r) => r.rows);

  // T2 — bbd catalog
  const t2Products = await q(
    `SELECT product_key, merchant_id, lower(btrim(coalesce(brand,''))) AS brand, title, suppression_reason
     FROM catalog_products WHERE merchant_id=$1 ORDER BY product_key`, [T2_RETIRE]);
  const t2Offers = await q(
    `SELECT offer_id FROM catalog_offers WHERE merchant_id=$1`, [T2_RETIRE]);
  const t2Stores = await q(
    `SELECT store_id, status FROM merchant_stores WHERE merchant_id=$1 ORDER BY store_id`, [T2_RETIRE]);

  // T3a — ownist fixtures
  const t3Ownist = await q(
    `SELECT product_key, merchant_id, lower(btrim(coalesce(brand,''))) AS brand, title
     FROM catalog_products WHERE merchant_id=$1 ORDER BY product_key`, [T3_FIXTURE]);
  const t3OwnistOffers = await q(
    `SELECT offer_id FROM catalog_offers WHERE merchant_id=$1`, [T3_FIXTURE]);

  // T3b — review-demo store test brands
  const t3Brands = await q(
    `SELECT product_key, merchant_id, lower(btrim(coalesce(brand,''))) AS brand, title
     FROM catalog_products
     WHERE merchant_id = ANY($1)
       AND (lower(btrim(coalesce(brand,''))) = ANY($2)
            OR lower(btrim(coalesce(brand,''))) LIKE 'pivota review demo%')
     ORDER BY brand, title`, [T3_REVIEW_DEMO, TEST_BRANDS]);
  const t3BrandKeys = t3Brands.map((r) => r.product_key);
  const t3BrandOffers = t3BrandKeys.length
    ? await q(`SELECT offer_id FROM catalog_offers WHERE product_key = ANY($1)`, [t3BrandKeys])
    : [];

  return { t2Products, t2Offers, t2Stores, t3Ownist, t3OwnistOffers, t3Brands, t3BrandOffers };
}

function guards(r) {
  const allProducts = [...r.t2Products, ...r.t3Ownist, ...r.t3Brands];
  // Mojawa guard.
  const moj = allProducts.filter((p) => p.brand === 'mojawa' || MOJAWA_MERCHANTS.includes(p.merchant_id));
  if (moj.length) abort('Mojawa protection guard tripped', moj);
  // Never touch the kept canary.
  const keepHit = allProducts.filter((p) => p.merchant_id === T2_KEEP);
  if (keepHit.length) abort(`refusing to touch kept canary ${T2_KEEP}`, keepHit.slice(0, 5));
  // T2 must resolve to bbd only.
  if (r.t2Products.some((p) => p.merchant_id !== T2_RETIRE)) abort('T2 product set includes non-bbd merchant');
}

async function snapshotInvariants(c) {
  const q = (sql, p = []) => c.query(sql, p).then((r) => r.rows);
  const mojawa = await q(
    `SELECT product_key, updated_at, suppression_reason, suppressed_at FROM catalog_products
     WHERE lower(btrim(coalesce(brand,'')))='mojawa' OR merchant_id = ANY($1) ORDER BY product_key`, [MOJAWA_MERCHANTS]);
  const keepProducts = (await q(`SELECT count(*)::int n FROM catalog_products WHERE merchant_id=$1`, [T2_KEEP]))[0].n;
  const keepMarked = (await q(`SELECT count(*)::int n FROM catalog_products WHERE merchant_id=$1 AND suppression_reason=$2`, [T2_KEEP, MARKER]))[0].n;
  const keepStores = await q(`SELECT store_id, status FROM merchant_stores WHERE merchant_id=$1 ORDER BY store_id`, [T2_KEEP]);
  return { mojawa, keepProducts, keepMarked, keepStores };
}

function printPlan(r) {
  log('============ FIX PLAN E — T2 + T3 (demo store dup + fixtures) ============');
  log(`mode: ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  log('');
  log(`T2 retire ${T2_RETIRE}:`);
  log(`  catalog_products: ${r.t2Products.length}  -> suppression_reason='${MARKER}'`);
  log(`  catalog_offers:   ${r.t2Offers.length}  -> marker + availability='out_of_stock'`);
  log(`  merchant_stores:  ${r.t2Stores.map((s) => `${s.store_id}(${s.status})`).join(', ')}  -> status='inactive'`);
  log(`  KEEP untouched:   ${T2_KEEP}`);
  log('');
  log(`T3 fixtures:`);
  log(`  ${T3_FIXTURE} products: ${r.t3Ownist.length}, offers: ${r.t3OwnistOffers.length}  -> marker`);
  for (const p of r.t3Ownist) log(`    prod  ${p.product_key}  [${p.brand}]  ${p.title}`);
  log(`  review-demo test brands: ${r.t3Brands.length} products, ${r.t3BrandOffers.length} offers  -> marker`);
  const byBrand = {};
  for (const p of r.t3Brands) byBrand[p.brand] = (byBrand[p.brand] || 0) + 1;
  for (const [b, n] of Object.entries(byBrand)) log(`    brand [${b}]: ${n} (merchants: ${[...new Set(r.t3Brands.filter((x) => x.brand === b).map((x) => x.merchant_id))].join(', ')})`);
  log('========================================================================');
}

async function apply(c, r) {
  const q = (sql, p = []) => c.query(sql, p);
  const t2Keys = r.t2Products.map((p) => p.product_key);
  const t3OwnistKeys = r.t3Ownist.map((p) => p.product_key);
  const t3BrandKeys = r.t3Brands.map((p) => p.product_key);
  const allKeys = [...new Set([...t2Keys, ...t3OwnistKeys, ...t3BrandKeys])];

  const suppressProductsSql = (col, val) => `
    UPDATE catalog_products
    SET suppression_reason=$2, suppressed_at=now(),
        suppression_metadata = coalesce(suppression_metadata,'{}'::jsonb)
          || jsonb_build_object('demo_retirement', jsonb_build_object('plan',$3::text,'marker',$2::text,'prior_suppression_reason',suppression_reason,'retired_at',now())),
        updated_at=now()
    WHERE ${col} = ${val}`;
  const suppressOffersSql = (col, val) => `
    UPDATE catalog_offers
    SET suppression_reason=$2, suppressed_at=now(), availability='out_of_stock',
        suppression_metadata = coalesce(suppression_metadata,'{}'::jsonb)
          || jsonb_build_object('demo_retirement', jsonb_build_object('plan',$3::text,'marker',$2::text,'prior_suppression_reason',suppression_reason,'prior_availability',availability,'retired_at',now())),
        updated_at=now()
    WHERE ${col} = ${val}`;

  const res = {};
  await q('BEGIN');
  // T2
  res.t2_products = (await q(suppressProductsSql('merchant_id', '$1'), [T2_RETIRE, MARKER, PLAN])).rowCount;
  res.t2_offers = (await q(suppressOffersSql('merchant_id', '$1'), [T2_RETIRE, MARKER, PLAN])).rowCount;
  res.t2_stores = (await q(
    `UPDATE merchant_stores SET status='inactive'
     WHERE merchant_id=$1 AND coalesce(status,'') <> 'inactive'`, [T2_RETIRE])).rowCount;
  // T3a ownist
  res.t3_ownist_products = (await q(suppressProductsSql('merchant_id', '$1'), [T3_FIXTURE, MARKER, PLAN])).rowCount;
  res.t3_ownist_offers = (await q(suppressOffersSql('merchant_id', '$1'), [T3_FIXTURE, MARKER, PLAN])).rowCount;
  // T3b test brands (scoped to review-demo merchants + specific brands, via explicit key list)
  res.t3_brand_products = t3BrandKeys.length
    ? (await q(suppressProductsSql('product_key', 'ANY($1)'), [t3BrandKeys, MARKER, PLAN])).rowCount : 0;
  res.t3_brand_offers = t3BrandKeys.length
    ? (await q(suppressOffersSql('product_key', 'ANY($1)'), [t3BrandKeys, MARKER, PLAN])).rowCount : 0;
  await q('COMMIT');

  // Propagate to serving lane.
  let trustPath = 'none';
  let trustWrote = null;
  try {
    const { upsertCatalogRowTrustMany } = require('../src/services/catalogRowTrustUpserter');
    trustWrote = await upsertCatalogRowTrustMany(c, allKeys, new Date());
    trustPath = 'upserter';
  } catch (err) {
    const rr = await q(
      `UPDATE catalog_row_trust SET serving_decision='blocked', serving_reason_codes=ARRAY['ROW_TOMBSTONED'], updated_at=now()
       WHERE subject_type='product' AND subject_key = ANY($1)`, [allKeys]);
    trustWrote = rr.rowCount;
    trustPath = `fallback_direct (${err.message})`;
  }
  res.trust_rows_written = trustWrote;
  res.trust_path = trustPath;
  res.touched_product_keys = allKeys.length;
  return res;
}

async function verify(c, r, invBefore) {
  const q = (sql, p = []) => c.query(sql, p).then((rr) => rr.rows);
  const one = (sql, p = []) => q(sql, p).then((rr) => rr[0] || {});

  const v = {};
  v.t2_bbd_products_marked = (await one(`SELECT count(*)::int n FROM catalog_products WHERE merchant_id=$1 AND suppression_reason=$2`, [T2_RETIRE, MARKER])).n;
  v.t2_bbd_offers_oos_marked = (await one(`SELECT count(*)::int n FROM catalog_offers WHERE merchant_id=$1 AND suppression_reason=$2 AND availability='out_of_stock'`, [T2_RETIRE, MARKER])).n;
  v.t2_bbd_stores = await q(`SELECT store_id, status FROM merchant_stores WHERE merchant_id=$1 ORDER BY store_id`, [T2_RETIRE]);
  v.t3_ownist_marked = (await one(`SELECT count(*)::int n FROM catalog_products WHERE merchant_id=$1 AND suppression_reason=$2`, [T3_FIXTURE, MARKER])).n;
  v.t3_brand_marked = (await one(
    `SELECT count(*)::int n FROM catalog_products WHERE merchant_id = ANY($1)
       AND (lower(btrim(coalesce(brand,''))) = ANY($2) OR lower(btrim(coalesce(brand,''))) LIKE 'pivota review demo%')
       AND suppression_reason=$3`, [T3_REVIEW_DEMO, TEST_BRANDS, MARKER])).n;

  const touchedKeys = [...new Set([...r.t2Products, ...r.t3Ownist, ...r.t3Brands].map((p) => p.product_key))];
  v.trust_public_remaining = (await one(
    `SELECT count(*)::int n FROM catalog_row_trust WHERE subject_type='product' AND subject_key = ANY($1) AND serving_decision='public'`, [touchedKeys])).n;

  const invAfter = await snapshotInvariants(c);
  v.kept_canary_products_before = invBefore.keepProducts;
  v.kept_canary_products_after = invAfter.keepProducts;
  v.kept_canary_marked_with_our_marker = invAfter.keepMarked;
  v.kept_canary_stores_before = invBefore.keepStores;
  v.kept_canary_stores_after = invAfter.keepStores;
  v.kept_canary_untouched = invAfter.keepMarked === 0
    && invAfter.keepProducts === invBefore.keepProducts
    && JSON.stringify(invAfter.keepStores) === JSON.stringify(invBefore.keepStores);

  const changed = [];
  const beforeById = new Map(invBefore.mojawa.map((x) => [x.product_key, x]));
  for (const a of invAfter.mojawa) {
    const b = beforeById.get(a.product_key);
    if (!b || JSON.stringify(b) !== JSON.stringify(a)) changed.push({ before: b, after: a });
  }
  v.mojawa_unchanged = changed.length === 0 && invBefore.mojawa.length === invAfter.mojawa.length;
  v.mojawa_changed_rows = changed;
  return v;
}

async function main() {
  if (!process.env.DATABASE_URL) abort('DATABASE_URL is required');
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 30000 });
  await c.connect();
  const report = { plan: PLAN, task: 'T2_T3_demo_stores_and_fixtures', mode: APPLY ? 'apply' : 'dry-run', at: new Date().toISOString() };
  try {
    const r = await resolve(c);
    guards(r);
    printPlan(r);
    report.counts = {
      t2_products: r.t2Products.length, t2_offers: r.t2Offers.length, t2_stores: r.t2Stores.length,
      t3_ownist_products: r.t3Ownist.length, t3_ownist_offers: r.t3OwnistOffers.length,
      t3_brand_products: r.t3Brands.length, t3_brand_offers: r.t3BrandOffers.length,
    };
    const invBefore = await snapshotInvariants(c);
    if (APPLY) {
      log('\n>>> APPLYING (retire-don\'t-delete) ...');
      report.apply = await apply(c, r);
      report.verify = await verify(c, r, invBefore);
      log('\nAPPLY: ' + JSON.stringify(report.apply, null, 2));
      log('VERIFY: ' + JSON.stringify(report.verify, null, 2));
      if (!report.verify.mojawa_unchanged) abort('Mojawa rows CHANGED', report.verify.mojawa_changed_rows);
      if (!report.verify.kept_canary_untouched) abort('kept canary merch_efbc46b4 was disturbed', report.verify);
      log('\nMojawa untouched: ' + (report.verify.mojawa_unchanged ? 'CONFIRMED' : 'FAILED'));
      log('Kept canary untouched: ' + (report.verify.kept_canary_untouched ? 'CONFIRMED' : 'FAILED'));
    } else {
      log('\n(dry-run) re-run with --apply to write. No rows changed.');
    }
  } finally {
    if (REPORT_PATH) {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
      log(`\nreport written: ${REPORT_PATH}`);
    }
    await c.end();
  }
}
main().catch((e) => { process.stderr.write((e.stack || e.message) + '\n'); process.exit(1); });
