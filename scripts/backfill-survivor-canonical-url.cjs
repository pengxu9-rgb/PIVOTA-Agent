#!/usr/bin/env node
'use strict';
/**
 * ADR-020 follow-up — repair canonical_url on archive survivors.
 *
 * archive-stranded-external-seed-mirrors.cjs proved its rows were duplicates
 * (shared content_key + matching title) but did NOT check that the SURVIVING
 * row was the better representative. On prod 2026-08-05 that let 45 rows keep a
 * regional storefront URL while the clean one was archived
 * (.../bronze-balm archived, .../bronze-balm-eu survived), plus a Tower 28 row
 * whose survivor pointed at a gift-with-purchase page.
 *
 * This repairs the survivors in place. Nothing needs un-archiving: the archived
 * rows really were redundant, only the URL left standing is wrong.
 *
 * SOURCE OF TRUTH is the survivor's own ACTIVE seed, not the archived row.
 * sync-external-seeds-to-catalog.cjs writes catalog_products.canonical_url from
 * the seed, so a survivor whose URL disagrees with its seed is simply stale.
 * Taking the seed's value repairs the row without inventing data, and fixes the
 * Tower 28 case for free (its active seed already carries the clean PDP URL
 * while the catalog row kept the promo one).
 *
 * Only actual regressions are touched — a survivor is repaired when its current
 * URL is downgraded (regional/promo, per isDowngradedUrl) or empty AND its
 * seed's URL is clean. Divergences that are already fine are left alone rather
 * than churned.
 *
 * Read-only DRY-RUN by default. Writing requires BOTH --write and
 * --confirm BACKFILL_SURVIVOR_CANONICAL_URL.
 *
 *   node scripts/backfill-survivor-canonical-url.cjs             # dry-run
 *   node scripts/backfill-survivor-canonical-url.cjs --write \
 *     --confirm BACKFILL_SURVIVOR_CANONICAL_URL
 */

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const { isDowngradedUrl } = require('./archive-stranded-external-seed-mirrors.cjs');

// First-party merchant rows are transacted through the merchant integration.
// A blank canonical_url on one is normal (only ~47% of live first-party rows
// carry one), and their attached seed's URL points at the SEED's storefront,
// not the merchant's own — on prod all 47 blank-URL candidates were one
// merchant whose seeds carried a different Shopify store than the merchant
// itself. Writing that URL would misdirect the row, so blank first-party URLs
// are left alone. Mirrors the same carve-out in the archive script's guard.
const FIRST_PARTY_KEY_RE = /^prod::merch_/i;

const CONFIRM_TOKEN = 'BACKFILL_SURVIVOR_CANONICAL_URL';
const DEFAULT_LOOKBACK_DAYS = 2;
const DEFAULT_BATCH_SIZE = 100;

// Held back by the archive guard (title differs only by a ® symbol), so it is
// not reachable through the archived-rows join but has the same broken survivor.
const EXTRA_SURVIVOR_KEYS = Object.freeze([
  'ext:tower-28-beauty-makewaves-mascara::eabe44e4',
]);

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return String(value ?? '').trim();
}

function assertWriteConfirmed({ write, confirm }) {
  if (write && asString(confirm) !== CONFIRM_TOKEN) {
    throw new Error(`Refusing write without --confirm ${CONFIRM_TOKEN}`);
  }
}

/**
 * Survivors of the archive run, joined to their freshest active seed.
 * `$1` is the lookback in days; `$2` carries the explicitly-named extras.
 */
const SURVIVOR_SQL = `
  WITH survivors AS (
    SELECT DISTINCT eps.attached_product_key AS product_key
    FROM catalog_products cp
    JOIN external_product_seeds eps ON eps.id = cp.source_ref
    WHERE cp.sync_status = 'archived'
      AND cp.updated_at > now() - ($1::int * interval '1 day')
      AND coalesce(eps.attached_product_key, '') <> ''
    UNION
    SELECT unnest($2::text[])
  )
  SELECT
    t.product_key,
    t.title,
    t.canonical_url AS survivor_url,
    s.id            AS seed_id,
    s.canonical_url AS seed_url
  FROM survivors v
  JOIN catalog_products t ON t.product_key = v.product_key
  LEFT JOIN LATERAL (
    SELECT eps.id, eps.canonical_url
    FROM external_product_seeds eps
    WHERE eps.attached_product_key = t.product_key
      AND eps.status = 'active'
    ORDER BY eps.updated_at DESC NULLS LAST, eps.id
    LIMIT 1
  ) s ON true
  WHERE t.sync_status = 'live'
  ORDER BY t.product_key
`;

/**
 * Pure decision over one survivor row. Returns { action, reason } where action
 * is 'repair' or 'skip'.
 */
function planFor(row) {
  const r = row && typeof row === 'object' ? row : {};
  const survivorUrl = asString(r.survivor_url);
  const seedUrl = asString(r.seed_url);

  const title = asString(r.title);

  if (!seedUrl) return { action: 'skip', reason: 'no_seed_url' };
  if (seedUrl === survivorUrl) return { action: 'skip', reason: 'already_matches_seed' };
  if (isDowngradedUrl(seedUrl, title)) return { action: 'skip', reason: 'seed_url_also_downgraded' };
  if (survivorUrl && !isDowngradedUrl(survivorUrl, title)) {
    // Diverges, but what is stored is already a clean URL — not a regression
    // this repair is responsible for. Leave it rather than churn it.
    return { action: 'skip', reason: 'survivor_url_already_clean' };
  }
  if (!survivorUrl && FIRST_PARTY_KEY_RE.test(asString(r.product_key))) {
    return { action: 'skip', reason: 'first_party_blank_url_is_normal' };
  }
  return {
    action: 'repair',
    reason: survivorUrl ? 'survivor_url_downgraded' : 'survivor_url_missing',
  };
}

async function fetchSurvivors({ lookbackDays }) {
  const res = await query(SURVIVOR_SQL, [lookbackDays, EXTRA_SURVIVOR_KEYS]);
  return res.rows || [];
}

/**
 * Set-based repair. Re-asserts sync_status='live' and pins the expected current
 * value, so a row that changed between SELECT and UPDATE is skipped rather than
 * overwritten on stale evidence.
 */
async function repairBatch(updates) {
  if (!updates.length) return 0;
  const res = await query(
    `
      UPDATE catalog_products AS cp
      SET canonical_url = d.seed_url,
          updated_at = now()
      FROM (
        SELECT unnest($1::text[]) AS product_key,
               unnest($2::text[]) AS seed_url,
               unnest($3::text[]) AS expected_current
      ) d
      WHERE cp.product_key = d.product_key
        AND cp.sync_status = 'live'
        AND coalesce(cp.canonical_url, '') = d.expected_current
    `,
    [
      updates.map((u) => u.product_key),
      updates.map((u) => u.seed_url),
      updates.map((u) => u.survivor_url ?? ''),
    ],
  );
  return Number(res.rowCount || 0);
}

async function run({ write, confirm, lookbackDays, batchSize }) {
  assertWriteConfirmed({ write, confirm });

  const rows = await fetchSurvivors({ lookbackDays });
  const repairs = [];
  const skipped = {};
  for (const row of rows) {
    const plan = planFor(row);
    if (plan.action === 'repair') {
      repairs.push({
        product_key: row.product_key,
        title: row.title,
        survivor_url: asString(row.survivor_url),
        seed_url: asString(row.seed_url),
        seed_id: row.seed_id,
        reason: plan.reason,
      });
    } else {
      skipped[plan.reason] = (skipped[plan.reason] || 0) + 1;
    }
  }

  let repaired = 0;
  if (write) {
    for (let i = 0; i < repairs.length; i += batchSize) {
      repaired += await repairBatch(repairs.slice(i, i + batchSize));
    }
  }

  const byReason = repairs.reduce((acc, r) => {
    acc[r.reason] = (acc[r.reason] || 0) + 1;
    return acc;
  }, {});

  return {
    counters: {
      survivors_examined: rows.length,
      repair_candidates: repairs.length,
      skipped: rows.length - repairs.length,
      rows_repaired: repaired,
    },
    by_repair_reason: byReason,
    by_skip_reason: skipped,
    sample: repairs.slice(0, 12),
  };
}

async function main() {
  const write = hasFlag('write');
  const confirm = asString(argValue('confirm'));
  const lookbackDays = Math.max(1, Number(argValue('lookback-days', String(DEFAULT_LOOKBACK_DAYS))) || DEFAULT_LOOKBACK_DAYS);
  const batchSize = Math.max(1, Number(argValue('batch-size', String(DEFAULT_BATCH_SIZE))) || DEFAULT_BATCH_SIZE);
  const out = asString(argValue('out'));

  assertWriteConfirmed({ write, confirm });

  const result = await run({ write, confirm, lookbackDays, batchSize });
  const report = {
    plan: 'adr020_backfill_survivor_canonical_url',
    generated_at: new Date().toISOString(),
    mode: write ? 'write' : 'dry_run',
    lookback_days: lookbackDays,
    ...result,
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (out) {
    const resolved = path.isAbsolute(out) ? out : path.join(process.cwd(), out);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, serialized, 'utf8');
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
    });
}

module.exports = {
  CONFIRM_TOKEN,
  EXTRA_SURVIVOR_KEYS,
  SURVIVOR_SQL,
  assertWriteConfirmed,
  planFor,
  fetchSurvivors,
  repairBatch,
  run,
};
