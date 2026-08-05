#!/usr/bin/env node
'use strict';
/**
 * ADR-020 follow-up — archive stranded external-seed mirror rows.
 *
 * A "stranded mirror" is a catalog_products row with
 * catalog_track='external_referral' that no ACTIVE seed points back at
 * (external_product_seeds.attached_product_key), whose OWN source_ref names a
 * seed that is active and now attached to a DIFFERENT product_key. Those rows
 * were left behind when a dedup/graduation re-pointed the seed at a better
 * canonical row (typically a first-party prod::merch_*::shopify::* row). They
 * are invisible to the ADR-020 reconciler — it projects through the seed
 * back-pointer — so they linger as live duplicates forever.
 *
 * WHY ARCHIVE RATHER THAN RE-LINK: the seed already points somewhere better.
 * Re-linking would double-attach one seed to two catalog rows. Archiving flips
 * sync_status to 'archived', which is what every serving predicate filters on
 * (cp.sync_status = 'live' in RecommendationEngine, discoveryFeed,
 * pdpIdentityGraph, productRelationshipGraphSources).
 *
 * SAFETY INVARIANT — every row archived must be a proven duplicate:
 *   1. the canonical row named by the seed EXISTS and is sync_status='live';
 *   2. it carries the SAME content_key as the stranded row (identical content
 *      identity, not merely a similar product);
 *   3. titles match case/whitespace-insensitively.
 * Rows failing any guard are reported with a block_reason and never written.
 * Measured on prod 2026-08-01: 612 live candidates, 612 same content_key,
 * 611 exact title match, 612 with a live canonical.
 *
 * DO NOT TOUCH index_pipeline_state. It is keyed on content_key, which the
 * stranded row SHARES with its canonical — the single index row belongs to the
 * survivor. Clearing serving_eligible here would de-index the canonical too,
 * which is the opposite of the intent. (This is why this script has no
 * --update-index flag, unlike repair-external-seed-mirror-attachments.cjs,
 * where each content_key belonged to exactly one row.)
 *
 * Read-only DRY-RUN by default. Writing requires BOTH --write and
 * --confirm ARCHIVE_STRANDED_EXTERNAL_SEED_MIRRORS.
 *
 *   node scripts/archive-stranded-external-seed-mirrors.cjs               # dry-run
 *   node scripts/archive-stranded-external-seed-mirrors.cjs --domain x.com
 *   node scripts/archive-stranded-external-seed-mirrors.cjs --limit 100 \
 *     --write --confirm ARCHIVE_STRANDED_EXTERNAL_SEED_MIRRORS
 */

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

const CONFIRM_TOKEN = 'ARCHIVE_STRANDED_EXTERNAL_SEED_MIRRORS';
const DEFAULT_BATCH_SIZE = 100;

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

/**
 * The stranded-mirror cohort. `canonical` is the row the seed now points at.
 * Guard columns are selected (not filtered) so blocked rows stay visible in
 * the report instead of silently vanishing from the candidate set.
 */
const COHORT_SQL = `
  SELECT
    cp.product_key,
    cp.content_key,
    cp.title,
    cp.source_domain,
    cp.canonical_url,
    cp.sync_status,
    eps.id AS seed_id,
    eps.attached_product_key AS canonical_key,
    t.product_key IS NOT NULL AS canonical_exists,
    t.sync_status AS canonical_sync_status,
    t.content_key AS canonical_content_key,
    t.title AS canonical_title,
    t.source_domain AS canonical_domain,
    t.canonical_url AS canonical_canonical_url
  FROM catalog_products cp
  JOIN external_product_seeds eps ON eps.id = cp.source_ref
  LEFT JOIN catalog_products t ON t.product_key = eps.attached_product_key
  WHERE cp.catalog_track = 'external_referral'
    AND cp.sync_status = 'live'
    AND NOT EXISTS (
      SELECT 1 FROM external_product_seeds a
      WHERE a.attached_product_key = cp.product_key
        AND a.status = 'active'
    )
    AND eps.status = 'active'
    AND coalesce(eps.attached_product_key, '') NOT IN ('', cp.product_key)
`;

// A canonical_url is "downgraded" when it points at a regional storefront or a
// promo/bundle page rather than the primary product page. Archiving a row whose
// URL is clean in favour of a survivor carrying one of these silently changes
// which page represents the product.
const DOWNGRADED_URL_RE = /(-(eu|uk|ca|au|de|fr|jp|kr)(\/|\?|$))|(gift-with-purchase|gwp|bundle|sample|promo|free-)/i;

// First-party merchant rows are transacted through the merchant integration and
// legitimately carry no external canonical_url, so an empty URL on one of these
// is not evidence of a downgrade.
const FIRST_PARTY_KEY_RE = /^prod::merch_/i;

function isDowngradedUrl(url) {
  const v = asString(url);
  return v !== '' && DOWNGRADED_URL_RE.test(v);
}

/**
 * Pure guard evaluation over one cohort row. Returns null when the row is safe
 * to archive, or a block_reason string naming the invariant that failed.
 *
 * The first four guards prove the row is a DUPLICATE. The fifth proves the
 * survivor is not a WORSE representative — added after a prod run archived 45
 * rows whose clean canonical_url was replaced by a regional variant
 * (e.g. .../bronze-balm archived, .../bronze-balm-eu survived), plus a
 * Tower 28 row whose survivor pointed at a gift-with-purchase page. Proving
 * two rows are the same product is not the same as proving the right one won.
 */
function blockReasonFor(row) {
  const r = row && typeof row === 'object' ? row : {};
  if (!r.canonical_exists) return 'canonical_missing';
  if (asString(r.canonical_sync_status).toLowerCase() !== 'live') return 'canonical_not_live';
  if (!asString(r.content_key) || asString(r.content_key) !== asString(r.canonical_content_key)) {
    return 'content_key_mismatch';
  }
  if (asString(r.title).toLowerCase() !== asString(r.canonical_title).toLowerCase()) {
    return 'title_mismatch';
  }

  const strandedUrl = asString(r.canonical_url);
  const survivorUrl = asString(r.canonical_canonical_url);
  if (strandedUrl) {
    if (isDowngradedUrl(survivorUrl) && !isDowngradedUrl(strandedUrl)) {
      return 'survivor_url_downgraded';
    }
    if (!survivorUrl && !FIRST_PARTY_KEY_RE.test(asString(r.canonical_key))) {
      return 'survivor_url_missing';
    }
  }
  return null;
}

function assertWriteConfirmed({ write, confirm }) {
  if (write && asString(confirm) !== CONFIRM_TOKEN) {
    throw new Error(`Refusing write without --confirm ${CONFIRM_TOKEN}`);
  }
}

async function fetchCohort({ domain = '', limit = 0 }) {
  const params = [];
  let sql = COHORT_SQL;
  if (domain) {
    params.push(domain.toLowerCase());
    sql += ` AND lower(coalesce(cp.source_domain, '')) = $${params.length}`;
  }
  sql += ' ORDER BY cp.product_key ASC';
  if (limit > 0) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }
  const res = await query(sql, params);
  return res.rows || [];
}

/**
 * Set-based archive of one batch. Re-asserts the cohort predicate in the
 * UPDATE itself (still live, still external_referral, still no active seed) so
 * a row that changed between SELECT and UPDATE is skipped rather than archived
 * on stale evidence. Returns the rowCount actually landed.
 */
async function archiveBatch(productKeys) {
  if (!productKeys.length) return 0;
  const res = await query(
    `
      UPDATE catalog_products AS cp
      SET sync_status = 'archived',
          updated_at = now()
      WHERE cp.product_key = ANY($1::text[])
        AND cp.catalog_track = 'external_referral'
        AND cp.sync_status = 'live'
        AND NOT EXISTS (
          SELECT 1 FROM external_product_seeds a
          WHERE a.attached_product_key = cp.product_key
            AND a.status = 'active'
        )
    `,
    [productKeys],
  );
  return Number(res.rowCount || 0);
}

async function run({ write, confirm, domain, limit, batchSize }) {
  assertWriteConfirmed({ write, confirm });

  const cohort = await fetchCohort({ domain, limit });
  const eligible = [];
  const blocked = [];
  for (const row of cohort) {
    const reason = blockReasonFor(row);
    if (reason) blocked.push({ product_key: row.product_key, block_reason: reason });
    else eligible.push(row);
  }

  const byBlockReason = blocked.reduce((acc, b) => {
    acc[b.block_reason] = (acc[b.block_reason] || 0) + 1;
    return acc;
  }, {});

  let archived = 0;
  if (write) {
    for (let i = 0; i < eligible.length; i += batchSize) {
      const slice = eligible.slice(i, i + batchSize).map((r) => r.product_key);
      archived += await archiveBatch(slice);
    }
  }

  return {
    counters: {
      cohort_rows: cohort.length,
      eligible_rows: eligible.length,
      blocked_rows: blocked.length,
      archived_rows: archived,
    },
    by_block_reason: byBlockReason,
    blocked_sample: blocked.slice(0, 15),
    sample: eligible.slice(0, 10).map((r) => ({
      product_key: r.product_key,
      title: r.title,
      source_domain: r.source_domain,
      canonical_url: r.canonical_url,
      canonical_key: r.canonical_key,
      canonical_domain: r.canonical_domain,
      survivor_canonical_url: r.canonical_canonical_url,
      shared_content_key: r.content_key,
    })),
  };
}

async function main() {
  const write = hasFlag('write');
  const confirm = asString(argValue('confirm'));
  const domain = asString(argValue('domain')).toLowerCase();
  const limit = Math.max(0, Number(argValue('limit', '0')) || 0);
  const batchSize = Math.max(1, Number(argValue('batch-size', String(DEFAULT_BATCH_SIZE))) || DEFAULT_BATCH_SIZE);
  const out = asString(argValue('out'));

  assertWriteConfirmed({ write, confirm });

  const result = await run({ write, confirm, domain, limit, batchSize });
  const report = {
    plan: 'adr020_archive_stranded_external_seed_mirrors',
    generated_at: new Date().toISOString(),
    mode: write ? 'write' : 'dry_run',
    filters: { domain: domain || null, limit: limit || null },
    batch_size: batchSize,
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
  DEFAULT_BATCH_SIZE,
  COHORT_SQL,
  assertWriteConfirmed,
  blockReasonFor,
  isDowngradedUrl,
  fetchCohort,
  archiveBatch,
  run,
};
