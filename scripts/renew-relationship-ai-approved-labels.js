#!/usr/bin/env node
'use strict';

/**
 * Non-LLM renewal for ai_approved relationship_candidate_labels rows.
 *
 * ai_approved rows expire AI_APPROVAL_FRESHNESS_INTERVAL (45 days) after review,
 * and no other code path renews them: applyApproval only flips generated ->
 * ai_approved, and the guarded graph upsert refuses to re-emit reviewed rows as
 * generated. Without renewal the entire ai_approved serving set falls off the
 * product_relationship_edges view in one 45-day cliff (this emptied
 * get_alternatives once already, 2026-07-17..26).
 *
 * Renewal re-verifies each row about to expire (or already expired) without any
 * LLM call:
 *   1. the row passes the CURRENT serving guard
 *      (getRelationshipEdgeServingSuppressionReasons is empty), and
 *   2. anchor and candidate refs still resolve to an active
 *      external_product_seeds row or a catalog_products row.
 * Rows that verify get last_verified_at=now() and expires_at extended by the AI
 * freshness interval. label_state is NEVER modified, and human_approved rows are
 * never touched (selected and updated under label_state='ai_approved' only).
 */

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const { getRelationshipEdgeServingSuppressionReasons } = require('../src/auroraBff/productRelationshipGraph');
const { AI_APPROVAL_FRESHNESS_INTERVAL } = require('./review-relationship-candidate-labels');

const APPLY_CONFIRM_TOKEN = 'APPLY_RELGRAPH_AI_RENEWAL';
const DEFAULT_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS = 60;
const DEFAULT_OPERATOR = 'relgraph_ai_renewal';
const RENEWAL_METHOD = 'seed_catalog_active_check+serving_guard';
const UPDATE_CHUNK_SIZE = 500;

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
    '  DATABASE_URL=... node scripts/renew-relationship-ai-approved-labels.js [--window-days 14] [--market US] [--limit N] [--out path] [--apply --confirm APPLY_RELGRAPH_AI_RENEWAL]',
    '',
    'Dry-run by default. Renews ai_approved relationship_candidate_labels rows whose',
    'expires_at falls within --window-days (already-expired rows included) when they',
    'still pass the serving guard and their anchor/candidate refs still resolve.',
    'Never modifies label_state and never touches human_approved rows.',
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
    market: normalizeString(argValue(argv, 'market'), 24).toUpperCase(),
    limit: parseNumber(argValue(argv, 'limit'), 0, { min: 0, max: 250000 }),
    out: normalizeString(argValue(argv, 'out'), 2000),
    operator: normalizeString(argValue(argv, 'operator'), 120) || DEFAULT_OPERATOR,
  };
}

function stripProductPrefix(ref) {
  return normalizeString(ref, 260).toLowerCase().replace(/^product:/, '');
}

async function loadExpiringAiApprovedRows({ queryFn = query, windowDays = DEFAULT_WINDOW_DAYS, market = '', limit = 0 } = {}) {
  const params = [windowDays];
  const where = [
    "label_state = 'ai_approved'",
    `expires_at <= now() + ($1::int * interval '1 day')`,
  ];
  if (market) {
    params.push(market);
    where.push(`upper(market) = $${params.length}`);
  }
  let limitSql = '';
  if (limit > 0) {
    params.push(limit);
    limitSql = `\n      LIMIT $${params.length}::int`;
  }
  const res = await queryFn(
    `
      SELECT id, edge_id, anchor_type, anchor_ref, anchor_snapshot, candidate_product_ref,
             candidate_snapshot, relation_type, display_label, market, vertical,
             category_taxonomy, use_case, label_state, score_total, score_breakdown,
             price_evidence, source_refs, evidence_grade, why_candidate, tradeoffs,
             watchouts, provenance, last_verified_at, expires_at
      FROM relationship_candidate_labels
      WHERE ${where.join('\n        AND ')}
      ORDER BY expires_at ASC, id ASC${limitSql}
    `,
    params,
  );
  return Array.isArray(res && res.rows) ? res.rows : [];
}

async function loadResolvableRefSets({ queryFn = query } = {}) {
  const seedRes = await queryFn(`
    SELECT lower(external_product_id) AS ref
    FROM external_product_seeds
    WHERE COALESCE(status, 'active') = 'active'
  `);
  const activeSeedRefs = new Set(
    (Array.isArray(seedRes && seedRes.rows) ? seedRes.rows : []).map((row) => row.ref).filter(Boolean),
  );

  const catalogRes = await queryFn(`
    SELECT lower(product_key) AS k1,
           lower(source_product_id) AS k2,
           lower(COALESCE(pivota_signature_id, '')) AS k3
    FROM catalog_products
  `);
  const catalogRefs = new Set();
  for (const row of (Array.isArray(catalogRes && catalogRes.rows) ? catalogRes.rows : [])) {
    if (row.k1) catalogRefs.add(row.k1);
    if (row.k2) catalogRefs.add(row.k2);
    if (row.k3) catalogRefs.add(row.k3);
  }
  return { activeSeedRefs, catalogRefs };
}

function refResolves(rawRef, { activeSeedRefs, catalogRefs }, { allowNeed = false } = {}) {
  const full = normalizeString(rawRef, 260).toLowerCase();
  if (!full) return false;
  if (allowNeed && full.startsWith('need:')) return true;
  const ref = stripProductPrefix(rawRef);
  if (ref.startsWith('ext_')) return activeSeedRefs.has(ref);
  return catalogRefs.has(ref);
}

function evaluateRenewalCandidates(rows = [], refSets, {
  suppressionFn = getRelationshipEdgeServingSuppressionReasons,
} = {}) {
  const renewableIds = [];
  const skipped = { suppressed: 0, anchor_unresolvable: 0, candidate_unresolvable: 0 };
  const suppressionReasons = {};

  for (const row of rows) {
    const reasons = suppressionFn(row);
    if (Array.isArray(reasons) && reasons.length) {
      skipped.suppressed += 1;
      for (const reason of reasons) {
        suppressionReasons[reason] = Number(suppressionReasons[reason] || 0) + 1;
      }
      continue;
    }
    const anchorOk = normalizeString(row.anchor_type, 40).toLowerCase() === 'need'
      || refResolves(row.anchor_ref, refSets, { allowNeed: true });
    if (!anchorOk) {
      skipped.anchor_unresolvable += 1;
      continue;
    }
    if (!refResolves(row.candidate_product_ref, refSets)) {
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
} = {}) {
  const reVerify = JSON.stringify({
    verified_at: generatedAt,
    method: RENEWAL_METHOD,
    operator,
  });
  let renewed = 0;
  for (let i = 0; i < renewableIds.length; i += UPDATE_CHUNK_SIZE) {
    const chunk = renewableIds.slice(i, i + UPDATE_CHUNK_SIZE);
    // label_state='ai_approved' is load-bearing: renewal must never extend or
    // otherwise touch human_approved rows, and must not resurrect a row whose
    // state changed between select and update.
    const res = await queryFn(
      `
        UPDATE relationship_candidate_labels
        SET
          last_verified_at = now(),
          expires_at = now() + $2::interval,
          provenance = jsonb_set(COALESCE(provenance, '{}'::jsonb), '{re_verify}', $3::jsonb, true),
          updated_at = now()
        WHERE id = ANY($1::text[])
          AND label_state = 'ai_approved'
      `,
      [chunk, AI_APPROVAL_FRESHNESS_INTERVAL, reVerify],
    );
    renewed += Number(res && res.rowCount) || 0;
  }
  return renewed;
}

async function runRenewal({
  apply = false,
  windowDays = DEFAULT_WINDOW_DAYS,
  market = '',
  limit = 0,
  operator = DEFAULT_OPERATOR,
  queryFn = query,
  suppressionFn = getRelationshipEdgeServingSuppressionReasons,
  generatedAt = new Date().toISOString(),
} = {}) {
  const rows = await loadExpiringAiApprovedRows({ queryFn, windowDays, market, limit });
  const refSets = await loadResolvableRefSets({ queryFn });
  const { renewableIds, skipped, suppressionReasons } = evaluateRenewalCandidates(rows, refSets, { suppressionFn });

  let renewed = 0;
  if (apply && renewableIds.length) {
    renewed = await applyRenewals(renewableIds, { queryFn, operator, generatedAt });
  }

  return {
    schema_version: 'relationship_graph_ai_renewal.v1',
    generated_at: generatedAt,
    mode: apply ? 'apply' : 'dry-run',
    window_days: windowDays,
    market: market || 'all',
    scanned_rows: rows.length,
    renewable_count: renewableIds.length,
    renewed_count: renewed,
    applied_count: renewed,
    skipped,
    suppression_reasons: suppressionReasons,
    freshness_interval: AI_APPROVAL_FRESHNESS_INTERVAL,
    ok: true,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }

  const report = await runRenewal(options);
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
  DEFAULT_WINDOW_DAYS,
  applyRenewals,
  evaluateRenewalCandidates,
  loadExpiringAiApprovedRows,
  loadResolvableRefSets,
  parseArgs,
  runRenewal,
};
