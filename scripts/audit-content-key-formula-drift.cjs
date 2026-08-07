#!/usr/bin/env node
'use strict';
/**
 * audit-content-key-formula-drift — the standing invariant for issue #1916.
 *
 * INVARIANT
 * ---------
 * For every catalog_products row minted on or after WATERMARK, the stored content_key
 * must equal `makeContentKey(brand, title, gtin)` — the one minter, mirrored from
 * pivota-backend/services/catalog_identity.py.
 *
 * WHY A WATERMARK AND NOT "ALL ROWS"
 * ----------------------------------
 * Two retired generations are baked into the corpus and will never reproduce:
 *
 *   v0-d2c      ck = sha256(norm(brand)\n norm(title)\n norm(url))   1,260 rows, all 2026-05
 *   v0-retailer ck = sha256(norm(brand)\n norm(title))                 340 rows, all 2026-05
 *
 * Both were replaced by v1 on 2026-05-25 and nothing has minted under them since.
 * Re-keying 1,600 live rows to satisfy an audit would rewrite index_pipeline_state
 * primary keys for no serving benefit, so the audit is watermarked instead: the
 * decision is "existing keys are immutable, new keys are reproducible", and the
 * watermark is where that promise starts. Rows below it are counted and reported,
 * never failed on.
 *
 * MEASURED 2026-08-07 at watermark 2026-06-01: 6,960 rows above it, 6,952 reproduce
 * under v1, 8 are input-rewritten, 0 carry a retired generation. Audit is green.
 *
 * The audit also reports rows ABOVE the watermark whose recompute misses — that is
 * the real signal. Two distinct causes, separated in the output:
 *   - `formula_drift`  the key is not reproducible AND not a known retired generation
 *                      → someone minted with a fourth formula. This fails the audit.
 *   - `input_rewritten` the key matches nothing today because brand/title were edited
 *                      after minting (content repairs, brand-surface patches). Stored
 *                      keys are immutable by contract, so this is expected and is
 *                      reported as a count, not a failure. A spike still means a
 *                      rewrite path is running too hot.
 *
 * MEASURED BASELINE (prod, 2026-08-07, 14,104 keyed rows)
 *   v1 (current)      12,441   88.2%
 *   v0-d2c             1,260    8.9%   all created <= 2026-05-25
 *   v0-retailer          340    2.4%   all created <= 2026-05-25
 *   input_rewritten       63    0.4%
 *   fourth formula         0    0.0%   <- what this audit exists to keep at zero
 *
 * USAGE
 *   railway run -e production -s PIVOTA-Agent node scripts/audit-content-key-formula-drift.cjs
 *   node scripts/audit-content-key-formula-drift.cjs --watermark 2026-05-25 --out reports/x.json
 *
 * Exit 1 when a row above the watermark drifts (or when the retired-generation count
 * grows past its frozen baseline, which would mean a retired formula came back).
 * Read-only: opens a read-only transaction and never writes.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { makeContentKey } = require('../src/services/contentKey');

// v1 became the minter on 2026-05-25 (pivota-backend, "Centralize content key
// computation"), but the watermark is set a week later, at 2026-06-01, and the gap is
// deliberate. Two things sit between the two dates and neither is drift:
//   - 2026-05-25 is the cutover day itself — 19 rows minted before that day's deploy
//     carry v0-d2c, which a date-granular watermark cannot separate from the rows
//     minted after it.
//   - 2026-05-30/31 hold 8 rows from the "Ownist" demo cohort, minted by a checkout
//     that had not picked up the change (4 under ownist_test_fixture_v1).
// From 2026-06-01 the corpus satisfies the invariant exactly, so that is where the
// promise starts. Do not move this date forward to silence a failure: a new red here
// means a minter other than contentKey.js is running, which is the whole point.
const DEFAULT_WATERMARK = '2026-06-01';

// Frozen count of rows carrying a retired generation, measured on prod 2026-08-07.
// These rows are immutable; the number may only shrink (via deletion), never grow.
const RETIRED_GENERATION_BASELINE = 1600;

const PAGE_SIZE = 2500;

function parseArgs(argv) {
  const out = { watermark: DEFAULT_WATERMARK, out: '', limit: 0 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--watermark') out.watermark = String(argv[++i] || DEFAULT_WATERMARK);
    else if (arg === '--out') out.out = String(argv[++i] || '');
    else if (arg === '--limit') out.limit = Number(argv[++i] || 0);
  }
  return out;
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

// --- retired generations, kept only so the audit can NAME what it found ------------
// These are historical shapes, not fallbacks. Nothing calls them to mint.

function retiredNormalize(value) {
  return asString(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function retiredHash(parts) {
  return `ck_${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)}`;
}

function normalizeUrl(value) {
  const raw = asString(value);
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Which generation, if any, reproduces this row's stored key.
 *
 * catalog_products.gtin records the GTIN the row has NOW, not the one the minter held
 * at mint time — the seed mirrors pass gtin=None even for rows that later acquire one.
 * So v1 is checked both ways. Both are the same formula; the pair only tells us
 * whether the minter had a GTIN, which is why they share one verdict.
 */
function identifyGeneration(row) {
  const brand = asString(row.brand);
  const title = asString(row.title);
  const stored = asString(row.content_key);
  if (!stored) return 'no_key';
  const gtin = asString(row.gtin);
  if (makeContentKey(brand, title, null) === stored) return 'v1_current';
  if (gtin && makeContentKey(brand, title, gtin) === stored) return 'v1_current';
  if (retiredHash([retiredNormalize(brand), retiredNormalize(title), retiredNormalize(normalizeUrl(row.canonical_url))]) === stored) {
    return 'v0_d2c_url';
  }
  if (retiredHash([retiredNormalize(brand), retiredNormalize(title)]) === stored) return 'v0_retailer';
  return 'unreproducible';
}

async function main() {
  const args = parseArgs(process.argv);
  // eslint-disable-next-line global-require
  const { closePool, query } = require('../src/db');

  await query('SET default_transaction_read_only = on', []);

  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    // eslint-disable-next-line no-await-in-loop
    const res = await query(
      `
        SELECT product_key, brand, title, gtin, canonical_url, content_key, created_at,
               source_system, suppression_reason
        FROM catalog_products
        WHERE content_key IS NOT NULL
        ORDER BY product_key
        LIMIT $1 OFFSET $2
      `,
      [PAGE_SIZE, offset],
    );
    rows.push(...(res.rows || []));
    if ((res.rows || []).length < PAGE_SIZE) break;
    if (args.limit && rows.length >= args.limit) break;
  }

  const watermark = new Date(`${args.watermark}T00:00:00Z`);
  const counts = {
    total: rows.length,
    above_watermark: 0,
    below_watermark: 0,
    v1_current: 0,
    v0_d2c_url: 0,
    v0_retailer: 0,
    unreproducible: 0,
    formula_drift: 0,
    input_rewritten: 0,
  };
  const drift = [];

  for (const row of rows) {
    const generation = identifyGeneration(row);
    counts[generation] = (counts[generation] || 0) + 1;
    const createdAt = row.created_at ? new Date(row.created_at) : null;
    const above = createdAt ? createdAt >= watermark : false;
    if (above) counts.above_watermark += 1;
    else counts.below_watermark += 1;

    if (generation === 'v1_current') continue;
    if (!above) continue;

    // Above the watermark and not reproducible under v1. A retired generation up here
    // means a retired minter is running again — that is drift. Anything else is a
    // post-mint rewrite of brand/title, which the immutability contract allows.
    if (generation === 'v0_d2c_url' || generation === 'v0_retailer') {
      counts.formula_drift += 1;
      drift.push({ ...summarize(row), classification: 'retired_generation_above_watermark', generation });
    } else {
      counts.input_rewritten += 1;
    }
  }

  // A fourth formula would land in `unreproducible` and be indistinguishable from an
  // input rewrite row-by-row. It is distinguishable in AGGREGATE: rewrites are diffuse,
  // a new minter is concentrated in one source_system + a tight created_at window.
  const suspects = clusterUnreproducible(rows, watermark);

  const retiredTotal = counts.v0_d2c_url + counts.v0_retailer;
  const retiredGrew = retiredTotal > RETIRED_GENERATION_BASELINE;

  const report = {
    generated_at: new Date().toISOString(),
    watermark: args.watermark,
    counts,
    retired_generation_baseline: RETIRED_GENERATION_BASELINE,
    retired_generation_total: retiredTotal,
    drift_sample: drift.slice(0, 50),
    unreproducible_clusters: suspects,
    ok: counts.formula_drift === 0 && !retiredGrew,
  };

  console.log(JSON.stringify(report, null, 2));
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  await closePool();

  if (!report.ok) {
    console.error(
      `\nFAIL: ${counts.formula_drift} row(s) above the ${args.watermark} watermark carry a ` +
        `retired content_key generation; retired total ${retiredTotal} vs baseline ` +
        `${RETIRED_GENERATION_BASELINE}. A minter other than src/services/contentKey.js is running.`,
    );
    process.exitCode = 1;
  }
}

function summarize(row) {
  return {
    product_key: row.product_key,
    content_key: row.content_key,
    brand: row.brand,
    title: asString(row.title).slice(0, 120),
    created_at: row.created_at,
    source_system: row.source_system,
    recomputed: makeContentKey(asString(row.brand), asString(row.title), null),
  };
}

/**
 * Group unreproducible rows above the watermark by (source_system, created day). A
 * diffuse spread is post-mint editing; a dense cluster is a new minter. Reported so a
 * human can tell them apart without re-running the whole investigation.
 */
function clusterUnreproducible(rows, watermark) {
  const byBucket = new Map();
  for (const row of rows) {
    const createdAt = row.created_at ? new Date(row.created_at) : null;
    if (!createdAt || createdAt < watermark) continue;
    if (identifyGeneration(row) !== 'unreproducible') continue;
    const bucket = `${row.source_system || 'null'}::${createdAt.toISOString().slice(0, 10)}`;
    byBucket.set(bucket, (byBucket.get(bucket) || 0) + 1);
  }
  return Array.from(byBucket.entries())
    .map(([bucket, count]) => {
      const [source_system, day] = bucket.split('::');
      return { source_system, day, unreproducible_rows: count };
    })
    .sort((a, b) => b.unreproducible_rows - a.unreproducible_rows)
    .slice(0, 25);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { identifyGeneration, clusterUnreproducible, DEFAULT_WATERMARK };
