#!/usr/bin/env node
'use strict';
/**
 * ADR-020 Phase 1 slice 1 — recall-doc projection reconciler.
 *
 * Projects the external-seed recall doc (plus market/tool/availability
 * scoping) into catalog_products so the unified sig-keyed recall lane can
 * serve text search without a per-request external_product_seeds join.
 * Per ADR-012 this is a CONVERGENT RECONCILER, not a sync-time poke:
 *   - chunked set-based batches (--batch-size, default 200);
 *   - stalest-first (ORDER BY recall_doc_updated_at ASC NULLS FIRST) so the
 *     rows furthest behind converge first and interrupted runs resume safely;
 *   - a drift metric (rows where recall_doc IS NULL or recall_doc_updated_at
 *     lags the attached seed's updated_at) reported on every run and
 *     standalone via --drift-only;
 *   - counters count UPDATE rowCount actually landed, never rows attempted.
 *
 * The projected doc mirrors, field for field, what the seed lane searches —
 * EXTERNAL_SEED_RECALL_SQL_FIELDS in src/services/externalSeedRecall.js and
 * the external_product_seeds.search_text arms of migration 057: title,
 * domain, canonical/destination urls, derived.recall retrieval_title/
 * retrieval_summary/retrieval_body/brand/category, ingredient_tokens, and
 * the full alias bundle (alias_tokens + every search_aliases/searchAliases/
 * aliases variant incl. snapshot paths). lower()ed, one field per
 * '\n'-separated line so a pattern cannot span two fields.
 *
 * Acceptance corpus for this phase:
 *   tests/fixtures/adr020_phase1_gap_scope.json — 15 gap queries / 71 unique
 *   products measured 2026-07-30 by scripts/audit-recall-lane-parity.cjs
 *   against prod (queries the seed lane recalls that the catalog lane misses;
 *   the projection must close them).
 *
 * Read-only DRY-RUN by default. Writing requires BOTH --write and
 * --confirm RECONCILE_CATALOG_RECALL_DOC_PROJECTION.
 *
 *   node scripts/reconcile-catalog-recall-doc.cjs                       # dry-run
 *   node scripts/reconcile-catalog-recall-doc.cjs --drift-only         # metric only
 *   node scripts/reconcile-catalog-recall-doc.cjs --max-rows 1000 \
 *     --write --confirm RECONCILE_CATALOG_RECALL_DOC_PROJECTION        # reconcile
 */

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

const CONFIRM_TOKEN = 'RECONCILE_CATALOG_RECALL_DOC_PROJECTION';
const DEFAULT_BATCH_SIZE = 200;

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

/**
 * Flatten any JSON value into searchable text. Arrays join element texts with
 * ' ' (a superset of the SQL `#>>` serialization for LIKE purposes: every
 * token remains a substring). Objects fall back to their JSON text, matching
 * how an unexpected shape would surface through `#>>` in the seed lane.
 */
function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ');
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function getPath(obj, segments) {
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function firstText(seedData, paths) {
  for (const p of paths) {
    const v = textOf(getPath(seedData, p)).trim();
    if (v) return v;
  }
  return '';
}

// Mirrors normalizeSeedAvailability in src/services/externalSeedProducts.js.
function normalizeAvailability(raw) {
  const v = asString(raw).toLowerCase();
  if (!v) return null;
  if (v === 'in stock' || v === 'instock' || v === 'in_stock' || v === 'available') return 'in_stock';
  if (v === 'out of stock' || v === 'outofstock' || v === 'out_of_stock' || v === 'oos') return 'out_of_stock';
  return v;
}

// Same 13 alias paths as EXTERNAL_SEED_RECALL_SQL_FIELDS.aliasTokens
// (src/services/externalSeedRecall.js) and migration 057's alias line.
const ALIAS_BUNDLE_PATHS = Object.freeze([
  ['derived', 'recall', 'alias_tokens'],
  ['search_aliases'],
  ['searchAliases'],
  ['aliases'],
  ['product', 'search_aliases'],
  ['product', 'searchAliases'],
  ['product', 'aliases'],
  ['snapshot', 'search_aliases'],
  ['snapshot', 'searchAliases'],
  ['snapshot', 'aliases'],
  ['snapshot', 'product', 'search_aliases'],
  ['snapshot', 'product', 'searchAliases'],
  ['snapshot', 'product', 'aliases'],
]);

// Line order mirrors external_product_seeds_search_text (migration 057).
const RECALL_DOC_FIELD_ORDER = Object.freeze([
  'title',
  'domain',
  'canonical_url',
  'destination_url',
  'retrieval_title',
  'retrieval_summary',
  'retrieval_body',
  'brand',
  'category',
  'ingredient_tokens',
  'alias_bundle',
]);

/**
 * Pure projection builder. Takes one external_product_seeds row
 * ({ title, domain, canonical_url, destination_url, market, tool,
 *    availability, seed_data }) and returns
 * { recall_doc, recall_market, recall_tool, recall_availability }.
 */
function buildRecallDocProjection(seedRow) {
  const row = seedRow && typeof seedRow === 'object' ? seedRow : {};
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);

  const fields = {
    title: asString(row.title),
    domain: asString(row.domain),
    canonical_url: asString(row.canonical_url),
    destination_url: asString(row.destination_url),
    retrieval_title: firstText(seedData, [['derived', 'recall', 'retrieval_title']]),
    retrieval_summary: firstText(seedData, [['derived', 'recall', 'retrieval_summary']]),
    retrieval_body: firstText(seedData, [['derived', 'recall', 'retrieval_body']]),
    // Coalesce chains mirror EXTERNAL_SEED_RECALL_SQL_FIELDS.brand / .category.
    brand: firstText(seedData, [
      ['derived', 'recall', 'brand'],
      ['brand'],
      ['brand_name'],
      ['vendor'],
      ['vendor_name'],
      ['snapshot', 'brand'],
      ['snapshot', 'brand_name'],
      ['snapshot', 'vendor'],
      ['snapshot', 'vendor_name'],
    ]),
    category: firstText(seedData, [
      ['derived', 'recall', 'category'],
      ['category'],
      ['product', 'category'],
      ['snapshot', 'category'],
      ['product_type'],
      ['product', 'product_type'],
      ['snapshot', 'product_type'],
    ]),
    ingredient_tokens: firstText(seedData, [['derived', 'recall', 'ingredient_tokens']]),
    alias_bundle: ALIAS_BUNDLE_PATHS.map((p) => textOf(getPath(seedData, p)).trim())
      .filter(Boolean)
      .join(' '),
  };

  const recallDoc = RECALL_DOC_FIELD_ORDER.map((name) => fields[name] || '')
    .join('\n')
    .toLowerCase();

  const market = asString(row.market).toUpperCase();
  const tool = asString(row.tool);
  // ||-fallback (not ??) mirrors the seed lane's
  // `row.availability || seedData.availability || snapshot.availability`.
  const availability = normalizeAvailability(
    row.availability || seedData.availability || snapshot.availability,
  );

  return {
    recall_doc: recallDoc,
    recall_market: market || null,
    recall_tool: tool || null,
    recall_availability: availability,
  };
}

/**
 * Drift predicate over one catalog_products row (alias `cp`) joined to its
 * freshest attached seed (alias `eps`): the projection has never landed, or
 * the seed moved after the projection last landed.
 */
function buildDriftPredicateSql(cpAlias = 'cp', epsAlias = 'eps') {
  return `(${cpAlias}.recall_doc IS NULL OR ${cpAlias}.recall_doc_updated_at IS NULL OR ${cpAlias}.recall_doc_updated_at < ${epsAlias}.updated_at)`;
}

// One freshest active seed per graduated catalog row.
const ATTACHED_SEED_LATERAL_SQL = `
  JOIN LATERAL (
    SELECT
      eps.id,
      eps.title,
      eps.domain,
      eps.canonical_url,
      eps.destination_url,
      eps.market,
      eps.tool,
      eps.availability,
      eps.seed_data,
      eps.updated_at
    FROM external_product_seeds eps
    WHERE eps.attached_product_key = cp.product_key
      AND eps.status = 'active'
    ORDER BY eps.updated_at DESC NULLS LAST, eps.id
    LIMIT 1
  ) eps ON true
`;

async function fetchDriftMetric() {
  const res = await query(
    `
      SELECT
        count(*)::int AS attached_rows_total,
        count(*) FILTER (WHERE cp.recall_doc IS NULL)::int AS recall_doc_null,
        count(*) FILTER (
          WHERE cp.recall_doc IS NOT NULL
            AND (cp.recall_doc_updated_at IS NULL OR cp.recall_doc_updated_at < eps.updated_at)
        )::int AS recall_doc_stale,
        count(*) FILTER (WHERE ${buildDriftPredicateSql('cp', 'eps')})::int AS drift_total,
        max(eps.updated_at - cp.recall_doc_updated_at) FILTER (
          WHERE cp.recall_doc_updated_at < eps.updated_at
        )::text AS max_staleness
      FROM catalog_products cp
      ${ATTACHED_SEED_LATERAL_SQL}
      WHERE cp.catalog_track = 'external_referral'
    `,
  );
  const row = res.rows?.[0] || {};
  const total = Number(row.attached_rows_total || 0);
  const drift = Number(row.drift_total || 0);
  return {
    attached_rows_total: total,
    recall_doc_null: Number(row.recall_doc_null || 0),
    recall_doc_stale: Number(row.recall_doc_stale || 0),
    drift_total: drift,
    converged_pct: total ? Math.round(((total - drift) / total) * 1000) / 10 : 100,
    max_staleness: row.max_staleness || null,
  };
}

async function fetchDriftedBatch({ batchSize, offset = 0 }) {
  const res = await query(
    `
      SELECT
        cp.product_key,
        cp.recall_doc AS current_recall_doc,
        cp.recall_doc_updated_at,
        eps.id AS seed_id,
        eps.title,
        eps.domain,
        eps.canonical_url,
        eps.destination_url,
        eps.market,
        eps.tool,
        eps.availability,
        eps.seed_data,
        eps.updated_at AS seed_updated_at
      FROM catalog_products cp
      ${ATTACHED_SEED_LATERAL_SQL}
      WHERE cp.catalog_track = 'external_referral'
        AND ${buildDriftPredicateSql('cp', 'eps')}
      ORDER BY cp.recall_doc_updated_at ASC NULLS FIRST, cp.product_key ASC
      LIMIT $1 OFFSET $2
    `,
    [batchSize, offset],
  );
  return res.rows || [];
}

/**
 * Set-based landing of one batch. Returns the UPDATE rowCount — the number of
 * writes that actually landed (rows may drop out if a concurrent writer
 * changed catalog_track or deleted the row between select and update).
 */
async function landBatch(updates) {
  if (!updates.length) return 0;
  const res = await query(
    `
      UPDATE catalog_products AS cp
      SET
        recall_doc = d.recall_doc,
        recall_market = d.recall_market,
        recall_tool = d.recall_tool,
        recall_availability = d.recall_availability,
        recall_doc_updated_at = now(),
        updated_at = now()
      FROM (
        SELECT
          unnest($1::text[]) AS product_key,
          unnest($2::text[]) AS recall_doc,
          unnest($3::text[]) AS recall_market,
          unnest($4::text[]) AS recall_tool,
          unnest($5::text[]) AS recall_availability
      ) d
      WHERE cp.product_key = d.product_key
        AND cp.catalog_track = 'external_referral'
    `,
    [
      updates.map((u) => u.product_key),
      updates.map((u) => u.projection.recall_doc),
      updates.map((u) => u.projection.recall_market),
      updates.map((u) => u.projection.recall_tool),
      updates.map((u) => u.projection.recall_availability),
    ],
  );
  return Number(res.rowCount || 0);
}

async function reconcile({ write, batchSize, maxRows }) {
  const counters = {
    batches: 0,
    rows_scanned: 0,
    updates_landed: 0, // UPDATE rowCount actually landed, never attempts
    docs_changed: 0, // projection differs from the stored recall_doc
    timestamp_only: 0, // doc identical; write only clears the drift timestamp
  };
  const sample = [];
  // Dry-run never writes, so drifted rows never leave the predicate —
  // paginate by OFFSET there. Write mode always starts at 0: landed rows
  // drop out of the drift predicate, which is what makes the loop converge.
  let dryRunOffset = 0;

  for (;;) {
    const remaining = maxRows > 0 ? maxRows - counters.rows_scanned : batchSize;
    if (remaining <= 0) break;
    const rows = await fetchDriftedBatch({
      batchSize: Math.min(batchSize, remaining),
      offset: write ? 0 : dryRunOffset,
    });
    if (!rows.length) break;
    counters.batches += 1;
    counters.rows_scanned += rows.length;
    dryRunOffset += rows.length;

    const updates = rows.map((row) => ({
      product_key: row.product_key,
      changed: null,
      projection: buildRecallDocProjection(row),
    }));
    for (const u of updates) {
      const before = rows.find((r) => r.product_key === u.product_key)?.current_recall_doc ?? null;
      u.changed = before !== u.projection.recall_doc;
      if (u.changed) counters.docs_changed += 1;
      else counters.timestamp_only += 1;
      if (sample.length < 10) {
        sample.push({
          product_key: u.product_key,
          doc_changed: u.changed,
          recall_market: u.projection.recall_market,
          recall_tool: u.projection.recall_tool,
          recall_availability: u.projection.recall_availability,
          recall_doc_preview: u.projection.recall_doc.slice(0, 160),
        });
      }
    }

    if (write) {
      counters.updates_landed += await landBatch(updates);
    }

    if (rows.length < Math.min(batchSize, remaining)) break;
  }

  return { counters, sample };
}

async function main() {
  const write = hasFlag('write');
  const confirm = asString(argValue('confirm'));
  const driftOnly = hasFlag('drift-only');
  const batchSize = Math.max(1, Number(argValue('batch-size', String(DEFAULT_BATCH_SIZE))) || DEFAULT_BATCH_SIZE);
  const maxRows = Math.max(0, Number(argValue('max-rows', '0')) || 0);
  const out = asString(argValue('out'));

  if (write && confirm !== CONFIRM_TOKEN) {
    throw new Error(`Refusing write without --confirm ${CONFIRM_TOKEN}`);
  }

  const driftBefore = await fetchDriftMetric();
  let reconcileResult = null;
  let driftAfter = null;
  if (!driftOnly) {
    reconcileResult = await reconcile({ write, batchSize, maxRows });
    driftAfter = write ? await fetchDriftMetric() : null;
  }

  const report = {
    plan: 'adr020_phase1_slice1_recall_doc_projection_reconcile',
    generated_at: new Date().toISOString(),
    mode: driftOnly ? 'drift_only' : write ? 'write' : 'dry_run',
    acceptance_corpus: 'tests/fixtures/adr020_phase1_gap_scope.json',
    batch_size: batchSize,
    max_rows: maxRows || null,
    drift_before: driftBefore,
    drift_after: driftAfter,
    ...(reconcileResult
      ? { counters: reconcileResult.counters, sample: reconcileResult.sample }
      : {}),
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
  ALIAS_BUNDLE_PATHS,
  RECALL_DOC_FIELD_ORDER,
  buildRecallDocProjection,
  buildDriftPredicateSql,
  normalizeAvailability,
  textOf,
  fetchDriftMetric,
  fetchDriftedBatch,
  landBatch,
  reconcile,
};
