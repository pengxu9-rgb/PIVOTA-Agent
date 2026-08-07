#!/usr/bin/env node
'use strict';
/**
 * Backfill catalog_products.product_payload->>'product_family'.
 *
 * WHY: src/services/externalSeedProductKind.js already classifies rows into
 * set_or_collection / single_formula / sample / accessory / non_merch, and the
 * sync path stamps it — but only ~2.5% of live external_referral rows carry a
 * value (prod 2026-08-07: 291 classified, 11,529 empty). Anything that wants to
 * reason about product kind is therefore reading a field that is null for 97%
 * of the catalog. Measured over the empty rows, the existing classifier would
 * assign:
 *
 *     single_formula     8,125
 *     set_or_collection  1,892   <- 31x the 62 currently known
 *     unknown_product      696
 *     accessory            684
 *     non_merch             76
 *     sample                56
 *
 * The immediate consumer is the bundle-crowding defect: on multi-word queries
 * where the rank text-ladder is inert, every candidate ties and multi-product
 * sets take the top slots because nothing in the ranker can tell a set from a
 * single product. A populated product_family is the precondition for either a
 * diversity cap or a user-facing "Sets & Kits" facet.
 *
 * CLASSIFICATION IS NOT REIMPLEMENTED HERE. This calls the same
 * classifyExternalSeedProductKind the sync path uses, fed from the row's own
 * product_payload (which buildMirror composes from seed_data + snapshot), so a
 * backfilled row lands on the same value a re-sync would produce.
 *
 * SCOPE: live external_referral rows with no existing value. Rows that already
 * carry a family are never overwritten — the sync path is authoritative for
 * those, and re-deriving could churn a value a later slice deliberately set.
 *
 * NOTE (open decision): product_family lives inside the product_payload JSON
 * blob. Ranking on it means a JSON extraction in the hot path or promoting it
 * to an indexed column. This script writes where the existing readers look
 * (pdpBuilder.js, pdpSchemaProfile.js, server.js all read
 * product_payload->>'product_family'); promoting it to a column is a separate
 * migration and does not block this backfill.
 *
 * Read-only DRY-RUN by default. Writing requires BOTH --write and
 * --confirm BACKFILL_CATALOG_PRODUCT_FAMILY.
 *
 *   node scripts/backfill-catalog-product-family.cjs                 # dry-run
 *   node scripts/backfill-catalog-product-family.cjs --limit 200
 *   node scripts/backfill-catalog-product-family.cjs \
 *     --write --confirm BACKFILL_CATALOG_PRODUCT_FAMILY
 */

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const { classifyExternalSeedProductKind } = require('../src/services/externalSeedProductKind');

const CONFIRM_TOKEN = 'BACKFILL_CATALOG_PRODUCT_FAMILY';
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_TRACK = 'external_referral';

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

function asObject(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function assertWriteConfirmed({ write, confirm }) {
  if (write && asString(confirm) !== CONFIRM_TOKEN) {
    throw new Error(`Refusing write without --confirm ${CONFIRM_TOKEN}`);
  }
}

/**
 * Assemble the classifier input for one catalog row, mirroring how
 * classifyMirrorProductKind feeds it during sync: the row's own text fields
 * plus its payload standing in for seed_data/snapshot. Pure — no I/O.
 */
function buildClassifierInput(row) {
  const r = row && typeof row === 'object' ? row : {};
  const payload = asObject(r.product_payload);
  const snapshot = asObject(payload.snapshot);
  const category = asString(r.category || payload.category);
  const productType = asString(r.product_type || payload.product_type || category);
  const categoryPath = asString(r.category_path || payload.category_path);
  return {
    ...payload,
    title: asString(r.title || payload.title),
    brand: asString(r.brand || payload.brand),
    description: asString(r.description || payload.description),
    category,
    product_type: productType,
    category_path: categoryPath,
    catalog_category_path: categoryPath,
    seed_data: {
      ...payload,
      category,
      product_type: productType,
      category_path: categoryPath,
      catalog_category_path: categoryPath,
      snapshot: { ...snapshot, category, product_type: productType, category_path: categoryPath },
    },
  };
}

/**
 * Pure decision for one row: { action, family, reason }. A row only gets a
 * value when the classifier returns one; 'unknown_product' is treated as no
 * information and skipped rather than stamped, so a later classifier
 * improvement can still claim the row.
 */
function planFor(row) {
  const r = row && typeof row === 'object' ? row : {};
  if (asString(r.existing_family)) {
    return { action: 'skip', reason: 'already_classified' };
  }
  let out = null;
  try {
    out = classifyExternalSeedProductKind(buildClassifierInput(r));
  } catch {
    return { action: 'skip', reason: 'classifier_error' };
  }
  const family = asString(out?.family);
  if (!family) return { action: 'skip', reason: 'no_family_returned' };
  if (family === 'unknown_product') return { action: 'skip', reason: 'unknown_product' };
  return { action: 'stamp', family };
}

async function fetchBatch({ track, batchSize, offset }) {
  const res = await query(
    `
      SELECT row_to_json(t) AS j FROM (
        SELECT cp.product_key, cp.title, cp.brand, cp.description,
               cp.category, cp.product_type, cp.category_path,
               cp.product_payload,
               coalesce(cp.product_payload->>'product_family', '') AS existing_family
        FROM catalog_products cp
        WHERE cp.sync_status = 'live'
          AND cp.catalog_track = $1
          AND coalesce(cp.product_payload->>'product_family', '') = ''
        ORDER BY cp.product_key
        LIMIT $2 OFFSET $3
      ) t
    `,
    [track, batchSize, offset],
  );
  return (res.rows || []).map((r) => r.j);
}

/**
 * Set-based stamp. Re-asserts the cohort predicate inside the UPDATE — still
 * live, still empty — so a row the sync classified between SELECT and UPDATE is
 * skipped rather than overwritten. Returns the rowCount actually landed.
 */
async function stampBatch(updates) {
  if (!updates.length) return 0;
  const res = await query(
    `
      UPDATE catalog_products AS cp
      SET product_payload = jsonb_set(
            coalesce(cp.product_payload, '{}'::jsonb),
            '{product_family}',
            to_jsonb(d.family),
            true
          ),
          updated_at = now()
      FROM (
        SELECT unnest($1::text[]) AS product_key,
               unnest($2::text[]) AS family
      ) d
      WHERE cp.product_key = d.product_key
        AND cp.sync_status = 'live'
        AND coalesce(cp.product_payload->>'product_family', '') = ''
    `,
    [updates.map((u) => u.product_key), updates.map((u) => u.family)],
  );
  return Number(res.rowCount || 0);
}

async function run({ write, confirm, track, batchSize, maxRows }) {
  assertWriteConfirmed({ write, confirm });

  const byFamily = {};
  const bySkip = {};
  const samples = {};
  let scanned = 0;
  let stamped = 0;
  // Stamped rows leave the cohort, so they do not shift the window — but
  // SKIPPED rows (unknown_product, already_classified) stay in it. Reading from
  // offset 0 every batch would therefore re-read a growing block of skips and
  // stall: observed on prod, a 3,000-row window yielded 631 stamps and 2,369
  // re-reads of the same head rows. The offset advances by the skipped count so
  // each batch steps past them. Dry-run stamps nothing, so it advances by the
  // full batch.
  let offset = 0;

  for (;;) {
    const remaining = maxRows > 0 ? maxRows - scanned : batchSize;
    if (remaining <= 0) break;
    const rows = await fetchBatch({
      track,
      batchSize: Math.min(batchSize, remaining),
      offset,
    });
    if (!rows.length) break;
    scanned += rows.length;

    const updates = [];
    for (const row of rows) {
      const plan = planFor(row);
      if (plan.action === 'stamp') {
        byFamily[plan.family] = (byFamily[plan.family] || 0) + 1;
        updates.push({ product_key: row.product_key, family: plan.family });
        if (!samples[plan.family]) samples[plan.family] = [];
        if (samples[plan.family].length < 5) samples[plan.family].push(asString(row.title).slice(0, 60));
      } else {
        bySkip[plan.reason] = (bySkip[plan.reason] || 0) + 1;
      }
    }

    if (write && updates.length) stamped += await stampBatch(updates);
    // Step past the rows that stayed in the cohort (see the offset note above).
    offset += write ? rows.length - updates.length : rows.length;
    if (rows.length < Math.min(batchSize, remaining)) break;
  }

  return {
    counters: {
      rows_scanned: scanned,
      would_stamp: Object.values(byFamily).reduce((a, b) => a + b, 0),
      skipped: Object.values(bySkip).reduce((a, b) => a + b, 0),
      rows_stamped: stamped,
    },
    by_family: byFamily,
    by_skip_reason: bySkip,
    samples,
  };
}

async function main() {
  const write = hasFlag('write');
  const confirm = asString(argValue('confirm'));
  const track = asString(argValue('track', DEFAULT_TRACK)) || DEFAULT_TRACK;
  const batchSize = Math.max(1, Number(argValue('batch-size', String(DEFAULT_BATCH_SIZE))) || DEFAULT_BATCH_SIZE);
  const maxRows = Math.max(0, Number(argValue('limit', '0')) || 0);
  const out = asString(argValue('out'));

  assertWriteConfirmed({ write, confirm });

  const result = await run({ write, confirm, track, batchSize, maxRows });
  const report = {
    plan: 'backfill_catalog_product_family',
    generated_at: new Date().toISOString(),
    mode: write ? 'write' : 'dry_run',
    catalog_track: track,
    batch_size: batchSize,
    limit: maxRows || null,
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
  DEFAULT_TRACK,
  assertWriteConfirmed,
  buildClassifierInput,
  planFor,
  fetchBatch,
  stampBatch,
  run,
};
