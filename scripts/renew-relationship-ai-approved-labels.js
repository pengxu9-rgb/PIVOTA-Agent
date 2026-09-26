#!/usr/bin/env node
'use strict';

/**
 * Non-LLM renewal for ai_approved relationship_candidate_labels rows.
 *
 * ai_approved rows expire AI_APPROVAL_FRESHNESS_INTERVAL (45 days) after review,
 * and no other code path renews them: applyApproval only flips generated ->
 * ai_approved, and the guarded graph upsert refuses to re-emit reviewed rows as
 * generated. Without renewal the whole ai_approved serving set falls off the
 * product_relationship_edges view in one 45-day cliff (this emptied
 * get_alternatives once already, 2026-07-17..26).
 *
 * Renewal re-verifies each row about to expire (or already expired) without any
 * LLM call:
 *   1. the row passes the CURRENT serving guard
 *      (getRelationshipEdgeServingSuppressionReasons is empty),
 *   2. anchor and candidate refs still resolve to an active external seed, an
 *      actively-serving catalog product (activeCatalogProductSourceWhere — the
 *      same liveness predicate the serving read paths use, so a deactivated
 *      merchant's products stop renewing), or a product group (pg_*), and
 *   3. the AI verdict is younger than --max-age-days (default 180): renewal
 *      must not keep an AI verdict alive forever without a fresh review. Age is
 *      measured from the verdict, not the row: provenance.re_verify
 *      .first_verified_at when a renewal already stamped it, else
 *      last_verified_at (set at approval time) — NEVER created_at, which for
 *      backfilled rows predates the verdict and would silently age-cap whole
 *      cohorts. The UPDATE preserves first_verified_at (from the row's own
 *      prior value) before overwriting last_verified_at, so the verdict date
 *      survives every renewal.
 * Rows that verify get last_verified_at/expires_at extended by the AI freshness
 * interval. label_state is NEVER modified, and human_approved rows are never
 * touched (selected and updated under label_state='ai_approved' only).
 */

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const { getRelationshipEdgeServingSuppressionReasons } = require('../src/auroraBff/productRelationshipGraph');
const { activeCatalogProductSourceWhere } = require('../src/services/activeCatalogSourceSql');
const { AI_APPROVAL_FRESHNESS_INTERVAL } = require('./review-relationship-candidate-labels');

const APPLY_CONFIRM_TOKEN = 'APPLY_RELGRAPH_AI_RENEWAL';
const DEFAULT_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS = 60;
const DEFAULT_MAX_AGE_DAYS = 180;
const DEFAULT_OPERATOR = 'relgraph_ai_renewal';
const RENEWAL_METHOD = 'seed_catalog_active_check+serving_guard';
const UPDATE_CHUNK_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function argValue(argv, name, fallback = '') {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function parseNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function usage() {
  return [
    'Usage:',
    '  DATABASE_URL=... node scripts/renew-relationship-ai-approved-labels.js [--window-days 14] [--max-age-days 180] [--market US] [--limit N] [--deadline-ms N] [--out path] [--apply --confirm APPLY_RELGRAPH_AI_RENEWAL]',
    '',
    'Dry-run by default. Renews ai_approved relationship_candidate_labels rows whose',
    'expires_at falls within --window-days (already-expired rows included) when they',
    'still pass the serving guard, their anchor/candidate refs still resolve to an',
    'actively-serving seed/catalog/group entity, and the row is younger than',
    '--max-age-days. Never modifies label_state and never touches human_approved rows.',
    'Exits non-zero if apply mode found renewable rows but renewed none.',
    '',
    '--deadline-ms stops SCANNING once the budget is spent, then applies what was',
    'already verified and reports truncated=true. Renewed rows leave the expiring',
    'window, so the next run resumes on what is left. Progress is written to stderr',
    'as it happens so a killed run still leaves a trail.',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  if (hasFlag(argv, 'help') || hasFlag(argv, 'h')) return { help: true };

  const apply = hasFlag(argv, 'apply');
  const confirm = normalizeString(argValue(argv, 'confirm'), 120);
  if (apply && confirm !== APPLY_CONFIRM_TOKEN) {
    throw new Error(`--apply requires --confirm ${APPLY_CONFIRM_TOKEN}`);
  }

  return {
    apply,
    windowDays: parseNumber(argValue(argv, 'window-days'), DEFAULT_WINDOW_DAYS, { min: 0, max: MAX_WINDOW_DAYS }),
    maxAgeDays: parseNumber(argValue(argv, 'max-age-days'), DEFAULT_MAX_AGE_DAYS, { min: 1, max: 3650 }),
    market: normalizeString(argValue(argv, 'market'), 24).toUpperCase(),
    limit: parseNumber(argValue(argv, 'limit'), 0, { min: 0, max: 250000 }),
    deadlineMs: parseNumber(argValue(argv, 'deadline-ms'), 0, { min: 0, max: 12 * 60 * 60 * 1000 }),
    out: normalizeString(argValue(argv, 'out'), 2000),
    operator: normalizeString(argValue(argv, 'operator'), 120) || DEFAULT_OPERATOR,
  };
}

function stripProductPrefix(ref) {
  return normalizeString(ref, 260).toLowerCase().replace(/^product:/, '');
}

// Cursor-paginated: the rows carry full anchor/candidate snapshots, and a
// single unbounded SELECT of the whole backlog gets the connection dropped by
// the Railway public proxy. Keyset pagination on (expires_at, id) matches the
// ORDER BY, so batches are exact.
//
// Paging alone does NOT bound memory — see iterateExpiringAiApprovedRowBatches.
const SELECT_BATCH_SIZE = 500;

// Yields one batch at a time and retains nothing. The snapshot columns are why
// this has to stream rather than narrow: anchor_snapshot and candidate_snapshot
// are full product blobs that getRelationshipEdgeServingSuppressionReasons
// reads (titles and brands), so they cannot be dropped from the SELECT — the
// only lever left is to never hold more than one batch of them at once.
async function* iterateExpiringAiApprovedRowBatches({
  queryFn = query,
  windowDays = DEFAULT_WINDOW_DAYS,
  market = '',
  limit = 0,
  batchSize = SELECT_BATCH_SIZE,
} = {}) {
  let cursor = null;
  let seen = 0;
  for (;;) {
    const take = limit > 0 ? Math.min(batchSize, limit - seen) : batchSize;
    if (take <= 0) break;
    const params = [windowDays];
    const where = [
      "label_state = 'ai_approved'",
      `expires_at <= now() + ($1::int * interval '1 day')`,
    ];
    if (market) {
      params.push(market);
      where.push(`upper(market) = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor.expiresAt, cursor.id);
      where.push(`(expires_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::text)`);
    }
    params.push(take);
    // expires_at_cursor is the keyset key as Postgres text, microseconds and
    // all. The `expires_at` column itself comes back as a JS Date, and node-pg
    // serializes a Date parameter at MILLISECOND precision — so a cursor built
    // from `last.expires_at` is truncated (…27.207882 → …27.207) and every row
    // in the same tie group satisfies `expires_at > cursor` again. Rows renewed
    // in one UPDATE chunk share one `now()`, so the tie groups are 500+ deep and
    // the scan re-read the same page until the step timeout (2026-08-13..16
    // production ticks: 3.6M "renewable" ids from a 6,620-row backlog).
    // eslint-disable-next-line no-await-in-loop
    const res = await queryFn(
      `
        SELECT id, edge_id, anchor_type, anchor_ref, anchor_snapshot, candidate_product_ref,
               candidate_snapshot, relation_type, display_label, market, vertical,
               category_taxonomy, use_case, label_state, score_total, score_breakdown,
               price_evidence, source_refs, evidence_grade, why_candidate, tradeoffs,
               watchouts, provenance, last_verified_at, expires_at,
               expires_at::text AS expires_at_cursor
        FROM relationship_candidate_labels
        WHERE ${where.join('\n          AND ')}
        ORDER BY expires_at ASC, id ASC
        LIMIT $${params.length}::int
      `,
      params,
    );
    const batch = Array.isArray(res && res.rows) ? res.rows : [];
    if (batch.length) {
      seen += batch.length;
      yield batch;
    }
    if (batch.length < take) break;
    const last = batch[batch.length - 1];
    const next = { expiresAt: last.expires_at_cursor, id: last.id };
    if (!next.expiresAt || !next.id) {
      const err = new Error('renewal_cursor_missing');
      err.code = 'RENEWAL_CURSOR_MISSING';
      throw err;
    }
    // A keyset scan must strictly advance. If a full page ends on the exact key
    // it started after, the WHERE clause is not excluding what it should and
    // the loop would run until the step timeout — fail loudly instead.
    if (cursor && cursor.expiresAt === next.expiresAt && cursor.id === next.id) {
      const err = new Error('renewal_cursor_did_not_advance');
      err.code = 'RENEWAL_CURSOR_DID_NOT_ADVANCE';
      err.cursor = next;
      throw err;
    }
    cursor = next;
  }
}

// Materializes the whole backlog. Kept for tests and bounded ad-hoc use — do
// NOT put it on the cron path: retaining every row is exactly what produced the
// 4GB V8 heap OOM in the 2026-08-11T10:37Z production run. runRenewal streams.
async function loadExpiringAiApprovedRows(options = {}) {
  const rows = [];
  for await (const batch of iterateExpiringAiApprovedRowBatches(options)) {
    rows.push(...batch);
  }
  return rows;
}

// Per-batch evaluations fold into one report. Only ids and counters survive a
// batch; the rows themselves are garbage as soon as the batch is folded.
function createRenewalTally() {
  return {
    scannedRows: 0,
    renewableIds: [],
    skipped: {
      suppressed: 0,
      anchor_unresolvable: 0,
      candidate_unresolvable: 0,
      age_capped: 0,
    },
    suppressionReasons: {},
  };
}

function foldRenewalBatch(tally, batchLength, evaluation = {}) {
  const { renewableIds = [], skipped = {}, suppressionReasons = {} } = evaluation;
  tally.scannedRows += batchLength;
  for (const id of renewableIds) tally.renewableIds.push(id);
  for (const key of Object.keys(tally.skipped)) {
    tally.skipped[key] += Number(skipped[key] || 0);
  }
  for (const [reason, count] of Object.entries(suppressionReasons)) {
    tally.suppressionReasons[reason] = Number(tally.suppressionReasons[reason] || 0) + Number(count || 0);
  }
  return tally;
}

// One union set of every id form edges are anchored on in this codebase (see
// productRelationshipGraphSources ref matching): external seed id /
// external_product_id / attached_product_key, catalog product_key /
// source_product_id / pivota_signature_id / content_key, and pg_* group ids.
// Membership is checked after stripping the optional product: prefix, so no
// prefix-dispatch assumptions can silently orphan a ref form.
const REF_SET_COLUMNS = ['k1', 'k2', 'k3', 'k4'];

async function loadResolvableRefSet({ queryFn = query } = {}) {
  const resolvableRefs = new Set();
  // Explicit column allow-list: only k1..k4 id aliases from the SELECTs below
  // may enter the set — adding a display column to a query must not silently
  // turn its values into valid product refs.
  const addRow = (row) => {
    for (const key of REF_SET_COLUMNS) {
      const ref = normalizeString(row && row[key], 260).toLowerCase();
      if (ref) resolvableRefs.add(ref);
    }
  };

  const seedRes = await queryFn(`
    SELECT lower(id) AS k1,
           lower(external_product_id) AS k2,
           lower(COALESCE(attached_product_key, '')) AS k3
    FROM external_product_seeds
    WHERE COALESCE(status, 'active') = 'active'
  `);
  for (const row of (Array.isArray(seedRes && seedRes.rows) ? seedRes.rows : [])) addRow(row);

  const catalogRes = await queryFn(`
    SELECT lower(cp.product_key) AS k1,
           lower(cp.source_product_id) AS k2,
           lower(COALESCE(cp.pivota_signature_id, '')) AS k3,
           lower(COALESCE(cp.content_key, '')) AS k4
    FROM catalog_products cp
    LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
    WHERE ${activeCatalogProductSourceWhere('cp', 'cm')}
  `);
  for (const row of (Array.isArray(catalogRes && catalogRes.rows) ? catalogRes.rows : [])) addRow(row);

  const groupRes = await queryFn(`
    SELECT DISTINCT lower(product_group_id) AS k1
    FROM product_group_members
    WHERE product_group_id IS NOT NULL
  `);
  for (const row of (Array.isArray(groupRes && groupRes.rows) ? groupRes.rows : [])) addRow(row);

  return resolvableRefs;
}

function refResolves(rawRef, resolvableRefs, { allowNeed = false } = {}) {
  const full = normalizeString(rawRef, 260).toLowerCase();
  if (!full) return false;
  if (allowNeed && full.startsWith('need:')) return true;
  return resolvableRefs.has(stripProductPrefix(rawRef));
}

// The AI-verdict date: first_verified_at stamped by a prior renewal, else
// last_verified_at (written at approval). created_at is deliberately NOT a
// fallback for the cap — backfilled rows are created long before their verdict.
function verdictDateMs(row = {}) {
  let provenance = row.provenance;
  if (typeof provenance === 'string') {
    try {
      provenance = JSON.parse(provenance);
    } catch {
      provenance = null;
    }
  }
  const firstVerifiedAt = provenance && provenance.re_verify && provenance.re_verify.first_verified_at;
  const basis = firstVerifiedAt || row.last_verified_at;
  const ms = new Date(basis || '').getTime();
  return Number.isFinite(ms) ? ms : null;
}

function evaluateRenewalCandidates(rows = [], resolvableRefs, {
  suppressionFn = getRelationshipEdgeServingSuppressionReasons,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  nowMs = Date.now(),
} = {}) {
  const renewableIds = [];
  const skipped = {
    suppressed: 0,
    anchor_unresolvable: 0,
    candidate_unresolvable: 0,
    age_capped: 0,
  };
  const suppressionReasons = {};
  const maxAgeMs = maxAgeDays * DAY_MS;

  for (const row of rows) {
    const verdictMs = verdictDateMs(row);
    if (verdictMs != null && nowMs - verdictMs > maxAgeMs) {
      skipped.age_capped += 1;
      continue;
    }
    const reasons = suppressionFn(row);
    if (Array.isArray(reasons) && reasons.length) {
      skipped.suppressed += 1;
      for (const reason of reasons) {
        suppressionReasons[reason] = Number(suppressionReasons[reason] || 0) + 1;
      }
      continue;
    }
    const anchorOk = normalizeString(row.anchor_type, 40).toLowerCase() === 'need'
      || refResolves(row.anchor_ref, resolvableRefs, { allowNeed: true });
    if (!anchorOk) {
      skipped.anchor_unresolvable += 1;
      continue;
    }
    if (!refResolves(row.candidate_product_ref, resolvableRefs)) {
      skipped.candidate_unresolvable += 1;
      continue;
    }
    renewableIds.push(row.id);
  }

  return { renewableIds, skipped, suppressionReasons };
}

async function applyRenewals(renewableIds, {
  queryFn = query,
  operator = DEFAULT_OPERATOR,
  generatedAt = new Date().toISOString(),
  onProgress = () => {},
} = {}) {
  let renewed = 0;
  for (let i = 0; i < renewableIds.length; i += UPDATE_CHUNK_SIZE) {
    const chunk = renewableIds.slice(i, i + UPDATE_CHUNK_SIZE);
    // label_state='ai_approved' is load-bearing: renewal must never extend or
    // otherwise touch human_approved rows, and must not resurrect a row whose
    // state changed between select and update.
    //
    // re_verify is built row-side so first_verified_at preserves the ORIGINAL
    // AI-verdict date (prior first_verified_at, else the pre-update
    // last_verified_at) before last_verified_at is overwritten — losing it
    // would make the max-age cap unenforceable forever. No synthetic terminal
    // fallback: a row with neither value keeps first_verified_at as JSON null
    // (honestly unknown) rather than acquiring a fabricated verdict date.
    const res = await queryFn(
      `
        UPDATE relationship_candidate_labels
        SET
          last_verified_at = now(),
          expires_at = now() + $2::interval,
          provenance = jsonb_set(
            COALESCE(provenance, '{}'::jsonb),
            '{re_verify}',
            jsonb_build_object(
              'verified_at', $3::text,
              'method', $4::text,
              'operator', $5::text,
              'first_verified_at', COALESCE(
                provenance #>> '{re_verify,first_verified_at}',
                to_char(last_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              )
            ),
            true
          ),
          updated_at = now()
        WHERE id = ANY($1::text[])
          AND label_state = 'ai_approved'
      `,
      [chunk, AI_APPROVAL_FRESHNESS_INTERVAL, generatedAt, RENEWAL_METHOD, operator],
    );
    renewed += Number(res && res.rowCount) || 0;
    onProgress({ phase: 'apply', applied: Math.min(i + UPDATE_CHUNK_SIZE, renewableIds.length), total: renewableIds.length, renewed });
  }
  return renewed;
}

async function runRenewal({
  apply = false,
  windowDays = DEFAULT_WINDOW_DAYS,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  market = '',
  limit = 0,
  batchSize = SELECT_BATCH_SIZE,
  operator = DEFAULT_OPERATOR,
  queryFn = query,
  suppressionFn = getRelationshipEdgeServingSuppressionReasons,
  generatedAt = new Date().toISOString(),
  deadlineMs = 0,
  clock = () => Date.now(),
  onProgress = () => {},
} = {}) {
  // The 2026-08-12 production tick spent the sync routine's entire 20-minute
  // step budget here and was SIGKILLed, so it wrote no report, renewed nothing,
  // and left no trace of which phase was slow. Two things follow from that: the
  // run reports progress as it happens (stderr survives the kill; the /tmp
  // report does not), and it stops itself before the parent does.
  const startedMs = clock();
  const elapsedMs = () => clock() - startedMs;
  const outOfBudget = () => deadlineMs > 0 && elapsedMs() >= deadlineMs;

  // Ref set first: it is needed to evaluate the very first batch, and loading
  // it up front keeps the streaming loop below free of per-batch setup.
  const resolvableRefs = await loadResolvableRefSet({ queryFn });
  onProgress({ phase: 'ref_set', refs: resolvableRefs.size, elapsed_ms: elapsedMs() });
  const nowMs = new Date(generatedAt).getTime() || Date.now();

  // Stream. Every row carries two full product snapshots, so holding the whole
  // expiring backlog is what OOMed this step in production; only the id list
  // and the counters cross a batch boundary here.
  //
  // READS MUST ALL FINISH BEFORE THE FIRST WRITE. applyRenewals sets
  // expires_at = now() + interval, which moves a renewed row FORWARD past the
  // (expires_at, id) keyset cursor — applying per batch mid-pagination would
  // re-surface rows this run already processed. Do not "optimize" the apply
  // into the loop.
  const tally = createRenewalTally();
  let batchesScanned = 0;
  // Truncation stops READS ONLY, and only at a batch boundary — the apply below
  // still runs on everything verified so far. Renewing pushes expires_at past
  // the end of the window, so those rows are gone from the next run's SELECT
  // and it resumes on the remainder: partial progress is durable progress.
  // Rows that were skipped stay in the window and get re-evaluated next run,
  // which is cheap (evaluation is pure and microseconds per row).
  let truncated = outOfBudget();
  if (!truncated) {
    for await (const batch of iterateExpiringAiApprovedRowBatches({ queryFn, windowDays, market, limit, batchSize })) {
      batchesScanned += 1;
      foldRenewalBatch(tally, batch.length, evaluateRenewalCandidates(batch, resolvableRefs, {
        suppressionFn,
        maxAgeDays,
        nowMs,
      }));
      onProgress({
        phase: 'scan',
        batch: batchesScanned,
        rows: batch.length,
        scanned_rows: tally.scannedRows,
        renewable: tally.renewableIds.length,
        elapsed_ms: elapsedMs(),
      });
      if (outOfBudget()) {
        truncated = true;
        break;
      }
    }
  }
  const { renewableIds, skipped, suppressionReasons } = tally;

  let renewed = 0;
  if (apply && renewableIds.length) {
    onProgress({ phase: 'apply_start', renewable: renewableIds.length, elapsed_ms: elapsedMs() });
    renewed = await applyRenewals(renewableIds, {
      queryFn,
      operator,
      generatedAt,
      onProgress: (progress) => onProgress({ ...progress, elapsed_ms: elapsedMs() }),
    });
  }

  // Apply mode that found renewable rows but renewed none is an inert no-op
  // behind a success signal — fail loudly instead. A run that burned its whole
  // budget without reading a single batch is the same kind of lie: it renews
  // nothing and would otherwise report success.
  const ok = (!truncated || tally.scannedRows > 0)
    && (!apply || !renewableIds.length || renewed > 0);
  const skippedTotal = Object.values(skipped).reduce((sum, n) => sum + n, 0);

  return {
    schema_version: 'relationship_graph_ai_renewal.v1',
    generated_at: generatedAt,
    mode: apply ? 'apply' : 'dry-run',
    window_days: windowDays,
    max_age_days: maxAgeDays,
    market: market || 'all',
    deadline_ms: deadlineMs || null,
    elapsed_ms: elapsedMs(),
    truncated,
    batches_scanned: batchesScanned,
    scanned_rows: tally.scannedRows,
    renewable_count: renewableIds.length,
    renewed_count: renewed,
    applied_count: renewed,
    skipped,
    skipped_total: skippedTotal,
    suppression_reasons: suppressionReasons,
    freshness_interval: AI_APPROVAL_FRESHNESS_INTERVAL,
    ok,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }

  // stderr, not stdout: the parent routine captures stderr from a step it kills,
  // and stdout here is the report itself. This is the only output a run that
  // exceeds its parent's timeout will ever produce.
  const report = await runRenewal({
    ...options,
    onProgress: (progress) => process.stderr.write(`renewal progress ${JSON.stringify(progress)}\n`),
  });
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  }).finally(() => {
    closePool().catch(() => {});
  });
}

module.exports = {
  APPLY_CONFIRM_TOKEN,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_WINDOW_DAYS,
  applyRenewals,
  evaluateRenewalCandidates,
  iterateExpiringAiApprovedRowBatches,
  loadExpiringAiApprovedRows,
  loadResolvableRefSet,
  parseArgs,
  runRenewal,
};
