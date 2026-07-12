#!/usr/bin/env node
'use strict';

/**
 * Fix Plan E — T1: retire the May electronics demo cohort.
 *
 * Cohort (pinned, per docs/fixplan_2026-07-12_E_demo_data_retirement.md):
 *   external_product_seeds.id LIKE 'seed:catalog_enrichment_agent_v1:%'
 *     AND created_at >= 2026-05-07 AND created_at < 2026-05-12
 *     AND brand ∈ ELECTRONICS  (isolates the ~21 electronics seeds out of the
 *                               138 date+tool seeds — the rest are beauty and
 *                               must NOT be touched)
 *   + the catalog_products reachable from those seeds
 *       (product_key = seed.attached_product_key  OR
 *        source_product_id = seed.external_product_id)
 *   + the catalog_offers on those products.
 * Measured baseline: 21 seeds / 33 products / 42 offers, all 9 electronics brands.
 *
 * Retire-don't-delete. NO DELETEs. Reversible markers only.
 *   seeds    -> status = 'retired_demo'
 *   products -> suppression_reason = 'demo_retired_2026_07', suppressed_at = now()
 *   offers   -> suppression_reason = 'demo_retired_2026_07', suppressed_at = now(),
 *               availability = 'out_of_stock'
 * Prior suppression_reason is preserved into suppression_metadata for reversibility.
 * After apply, catalog_row_trust is recomputed for the cohort (suppression ->
 * ROW_TOMBSTONED -> serving_decision='blocked') so all readers drop them.
 *
 * Usage:
 *   railway run node ./scripts/retire-demo-electronics-cohort.cjs            # dry-run
 *   railway run node ./scripts/retire-demo-electronics-cohort.cjs --apply    # write
 *   [--report <path.json>]
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ELECTRONICS = ['sony', 'apple', 'bose', 'samsung', 'jbl', 'sennheiser', 'kobo', 'beats', 'amazon'];
const MOJAWA_MERCHANTS = ['merch_obs_022b65d47a58b87a', 'merch_9678f6352da21473'];
const MARKER = 'demo_retired_2026_07';
const PLAN = 'fixplan_2026-07-12_E';
const SEED_LIKE = 'seed:catalog_enrichment_agent_v1:%';
const DATE_LO = '2026-05-07';
const DATE_HI = '2026-05-12'; // exclusive upper bound

const APPLY = process.argv.includes('--apply');
const reportIdx = process.argv.indexOf('--report');
const REPORT_PATH = reportIdx >= 0 ? process.argv[reportIdx + 1] : '';

function log(...a) { process.stdout.write(a.join(' ') + '\n'); }
function abort(msg, detail) {
  process.stderr.write(`\nABORT: ${msg}\n`);
  if (detail !== undefined) process.stderr.write(JSON.stringify(detail, null, 2) + '\n');
  process.exit(2);
}

async function resolveCohort(c) {
  const seedRes = await c.query(
    `SELECT id, lower(btrim(coalesce(seed_data->>'brand',''))) AS brand, title, status,
            external_product_id, attached_product_key, seller_ref, domain
     FROM external_product_seeds
     WHERE id LIKE $1 AND created_at >= $2 AND created_at < $3
       AND lower(btrim(coalesce(seed_data->>'brand',''))) = ANY($4)
     ORDER BY brand, title`,
    [SEED_LIKE, DATE_LO, DATE_HI, ELECTRONICS],
  );
  const seeds = seedRes.rows;

  // Report the beauty/other seeds that the date+tool window catches but that the
  // brand guard deliberately EXCLUDES (must remain untouched).
  const excludedRes = await c.query(
    `SELECT lower(btrim(coalesce(seed_data->>'brand',''))) AS brand, count(*)::int n
     FROM external_product_seeds
     WHERE id LIKE $1 AND created_at >= $2 AND created_at < $3
       AND NOT (lower(btrim(coalesce(seed_data->>'brand',''))) = ANY($4))
     GROUP BY 1 ORDER BY n DESC`,
    [SEED_LIKE, DATE_LO, DATE_HI, ELECTRONICS],
  );

  const attached = [...new Set(seeds.map((s) => s.attached_product_key).filter(Boolean))];
  const extIds = [...new Set(seeds.map((s) => s.external_product_id).filter(Boolean))];

  const prodRes = await c.query(
    `SELECT product_key, merchant_id, lower(btrim(coalesce(brand,''))) AS brand, brand AS brand_raw,
            title, source_product_id, content_key, seller_ref, suppression_reason, suppressed_at
     FROM catalog_products
     WHERE product_key = ANY($1) OR source_product_id = ANY($2)
     ORDER BY brand, title`,
    [attached, extIds],
  );
  const products = prodRes.rows;
  const productKeys = [...new Set(products.map((p) => p.product_key))];

  const offerRes = productKeys.length
    ? await c.query(
        `SELECT offer_id, product_key, merchant_id, availability, offer_type,
                suppression_reason, suppressed_at
         FROM catalog_offers WHERE product_key = ANY($1) ORDER BY product_key, offer_id`,
        [productKeys],
      )
    : { rows: [] };
  const offers = offerRes.rows;

  return { seeds, excluded: excludedRes.rows, products, productKeys, offers };
}

function runGuards(cohort) {
  const { seeds, products, productKeys, offers } = cohort;

  // Guard A — brand guard: every touched product & seed brand ∈ ELECTRONICS.
  const badProductBrands = products.filter((p) => !ELECTRONICS.includes(p.brand));
  const badSeedBrands = seeds.filter((s) => !ELECTRONICS.includes(s.brand));
  if (badProductBrands.length || badSeedBrands.length) {
    abort('brand guard tripped — non-electronics rows matched the cohort selector', {
      bad_products: badProductBrands.map((p) => ({ product_key: p.product_key, brand: p.brand_raw })),
      bad_seeds: badSeedBrands.map((s) => ({ id: s.id, brand: s.brand })),
    });
  }

  // Guard B — Mojawa protection: cohort must contain ZERO Mojawa rows.
  const mojProducts = products.filter(
    (p) => p.brand === 'mojawa' || MOJAWA_MERCHANTS.includes(p.merchant_id) || MOJAWA_MERCHANTS.includes(p.seller_ref),
  );
  const mojSeeds = seeds.filter(
    (s) => s.brand === 'mojawa' || MOJAWA_MERCHANTS.includes(s.seller_ref),
  );
  if (mojProducts.length || mojSeeds.length) {
    abort('Mojawa protection guard tripped — cohort contains Mojawa rows', {
      mojawa_products: mojProducts, mojawa_seeds: mojSeeds,
    });
  }

  // Guard C — sanity: non-empty & within an order of magnitude of the pinned baseline.
  if (!seeds.length || !productKeys.length) abort('cohort empty — selector matched nothing', { seeds: seeds.length, products: productKeys.length });
  const warn = [];
  if (seeds.length !== 21) warn.push(`seed count ${seeds.length} != pinned 21`);
  if (productKeys.length !== 33) warn.push(`product count ${productKeys.length} != pinned 33`);
  if (offers.length !== 42) warn.push(`offer count ${offers.length} != pinned 42`);
  if (seeds.length > 40 || productKeys.length > 60 || offers.length > 80) {
    abort('cohort far larger than pinned baseline — refusing to proceed', {
      seeds: seeds.length, products: productKeys.length, offers: offers.length,
    });
  }
  return warn;
}

async function snapshotMojawa(c) {
  const r = await c.query(
    `SELECT product_key, merchant_id, brand, updated_at, suppression_reason, suppressed_at, content_changed_at
     FROM catalog_products
     WHERE lower(btrim(coalesce(brand,'')))='mojawa' OR merchant_id = ANY($1)
     ORDER BY product_key`,
    [MOJAWA_MERCHANTS],
  );
  return r.rows;
}

function printCohort(cohort, warnings) {
  const { seeds, excluded, products, productKeys, offers } = cohort;
  log('================ FIX PLAN E — T1 ELECTRONICS DEMO COHORT ================');
  log(`mode: ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  log('');
  log(`SEEDS (${seeds.length})  -> status='retired_demo'`);
  for (const s of seeds) log(`  seed  ${s.id}  [${s.brand}]  ${s.title}  (status=${s.status}, seller_ref=${s.seller_ref})`);
  log('');
  log(`CATALOG_PRODUCTS (${productKeys.length})  -> suppression_reason='${MARKER}'`);
  for (const p of products) log(`  prod  ${p.product_key}  [${p.brand_raw}]  ${p.title}  (merchant=${p.merchant_id}, prior_suppression=${p.suppression_reason || 'none'})`);
  log('');
  log(`CATALOG_OFFERS (${offers.length})  -> suppression_reason='${MARKER}' + availability='out_of_stock'`);
  for (const o of offers) log(`  offer ${o.offer_id}  product_key=${o.product_key}  (avail=${o.availability}, prior_suppression=${o.suppression_reason || 'none'})`);
  log('');
  log(`EXCLUDED by brand guard (date+tool window, NON-electronics — untouched): ${excluded.reduce((a, b) => a + b.n, 0)} seeds`);
  for (const e of excluded) log(`  excl  [${e.brand || 'unknown'}]  ${e.n}`);
  log('');
  const brandsTouched = [...new Set(products.map((p) => p.brand))].sort();
  log(`brands touched: ${brandsTouched.join(', ')}`);
  if (warnings.length) { log(''); for (const w of warnings) log(`WARN: ${w}`); }
  log('=======================================================================');
}

async function apply(c, cohort) {
  const { seeds, productKeys, offers } = cohort;
  const seedIds = seeds.map((s) => s.id);
  const offerIds = offers.map((o) => o.offer_id);

  await c.query('BEGIN');
  const upSeeds = await c.query(
    `UPDATE external_product_seeds
     SET status='retired_demo', updated_at=now()
     WHERE id = ANY($1)`,
    [seedIds],
  );
  const upProducts = await c.query(
    `UPDATE catalog_products
     SET suppression_reason=$2,
         suppressed_at=now(),
         suppression_metadata = coalesce(suppression_metadata, '{}'::jsonb)
           || jsonb_build_object('demo_retirement',
                jsonb_build_object('plan', $3::text, 'marker', $2::text,
                  'prior_suppression_reason', suppression_reason,
                  'retired_at', now())),
         updated_at=now()
     WHERE product_key = ANY($1)`,
    [productKeys, MARKER, PLAN],
  );
  const upOffers = await c.query(
    `UPDATE catalog_offers
     SET suppression_reason=$2,
         suppressed_at=now(),
         availability='out_of_stock',
         suppression_metadata = coalesce(suppression_metadata, '{}'::jsonb)
           || jsonb_build_object('demo_retirement',
                jsonb_build_object('plan', $3::text, 'marker', $2::text,
                  'prior_suppression_reason', suppression_reason,
                  'prior_availability', availability,
                  'retired_at', now())),
         updated_at=now()
     WHERE offer_id = ANY($1)`,
    [offerIds, MARKER, PLAN],
  );
  await c.query('COMMIT');

  // Propagate to the primary serving lane: recompute catalog_row_trust for the
  // cohort. Suppression -> ROW_TOMBSTONED -> serving_decision='blocked'.
  let trustWrote = null;
  let trustPath = 'none';
  try {
    const { upsertCatalogRowTrustMany } = require('../src/services/catalogRowTrustUpserter');
    trustWrote = await upsertCatalogRowTrustMany(c, productKeys, new Date());
    trustPath = 'upserter';
  } catch (err) {
    // Fallback: direct scoped update of the materialized trust rows.
    const r = await c.query(
      `UPDATE catalog_row_trust
       SET serving_decision='blocked',
           serving_reason_codes = ARRAY['ROW_TOMBSTONED'],
           updated_at=now()
       WHERE subject_type='product' AND subject_key = ANY($1)`,
      [productKeys],
    );
    trustWrote = r.rowCount;
    trustPath = `fallback_direct (${err.message})`;
  }

  return {
    seeds_updated: upSeeds.rowCount,
    products_updated: upProducts.rowCount,
    offers_updated: upOffers.rowCount,
    trust_rows_written: trustWrote,
    trust_path: trustPath,
  };
}

async function verify(c, cohort, mojBefore) {
  const { seeds, productKeys, offers } = cohort;
  const seedIds = seeds.map((s) => s.id);
  const offerIds = offers.map((o) => o.offer_id);

  const seedCheck = await c.query(
    `SELECT count(*) FILTER (WHERE status='retired_demo')::int retired,
            count(*) FILTER (WHERE status='active')::int still_active
     FROM external_product_seeds WHERE id = ANY($1)`,
    [seedIds],
  );
  const prodCheck = await c.query(
    `SELECT count(*) FILTER (WHERE suppression_reason=$2)::int marked,
            count(*)::int total FROM catalog_products WHERE product_key = ANY($1)`,
    [productKeys, MARKER],
  );
  const offerCheck = await c.query(
    `SELECT count(*) FILTER (WHERE suppression_reason=$2 AND availability='out_of_stock')::int marked,
            count(*)::int total FROM catalog_offers WHERE offer_id = ANY($1)`,
    [offerIds, MARKER],
  );
  const trustCheck = await c.query(
    `SELECT serving_decision, count(*)::int n
     FROM catalog_row_trust WHERE subject_type='product' AND subject_key = ANY($1)
     GROUP BY 1 ORDER BY 1`,
    [productKeys],
  );
  const servingPublic = await c.query(
    `SELECT count(*)::int n FROM catalog_row_trust
     WHERE subject_type='product' AND subject_key = ANY($1) AND serving_decision='public'`,
    [productKeys],
  );

  const mojAfter = await snapshotMojawa(c);
  const mojChanged = [];
  const beforeById = new Map(mojBefore.map((r) => [r.product_key, r]));
  for (const a of mojAfter) {
    const b = beforeById.get(a.product_key);
    if (!b || JSON.stringify(b) !== JSON.stringify(a)) mojChanged.push({ before: b, after: a });
  }

  return {
    seeds: seedCheck.rows[0],
    products: prodCheck.rows[0],
    offers: offerCheck.rows[0],
    trust_breakdown: trustCheck.rows,
    trust_public_count: servingPublic.rows[0].n,
    mojawa_before_count: mojBefore.length,
    mojawa_after_count: mojAfter.length,
    mojawa_changed_rows: mojChanged,
    mojawa_unchanged: mojChanged.length === 0 && mojBefore.length === mojAfter.length,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) abort('DATABASE_URL is required');
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
  });
  await c.connect();
  const report = { plan: PLAN, task: 'T1_electronics_demo_cohort', mode: APPLY ? 'apply' : 'dry-run', at: new Date().toISOString() };
  try {
    const cohort = await resolveCohort(c);
    const warnings = runGuards(cohort);
    printCohort(cohort, warnings);
    report.counts = { seeds: cohort.seeds.length, products: cohort.productKeys.length, offers: cohort.offers.length };
    report.warnings = warnings;
    report.brands_touched = [...new Set(cohort.products.map((p) => p.brand))].sort();
    report.excluded_non_electronics_seed_count = cohort.excluded.reduce((a, b) => a + b.n, 0);

    const mojBefore = await snapshotMojawa(c);
    report.mojawa_snapshot_before = mojBefore;

    if (APPLY) {
      log('\n>>> APPLYING (retire-don\'t-delete) ...');
      report.apply = await apply(c, cohort);
      report.verify = await verify(c, cohort, mojBefore);
      log('\nAPPLY RESULT: ' + JSON.stringify(report.apply, null, 2));
      log('VERIFY: ' + JSON.stringify(report.verify, null, 2));
      if (!report.verify.mojawa_unchanged) abort('Mojawa rows CHANGED — investigate immediately', report.verify.mojawa_changed_rows);
      if (report.verify.trust_public_count !== 0) log(`\nWARN: ${report.verify.trust_public_count} cohort products still serving_decision='public'`);
      log('\nMojawa untouched: ' + (report.verify.mojawa_unchanged ? 'CONFIRMED (all 6 rows byte-identical)' : 'FAILED'));
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
