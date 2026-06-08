#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const {
  coerceRelationshipEdge,
  getRelationshipEdgeServingSuppressionReasons,
} = require('../src/auroraBff/productRelationshipGraph');

const DEFAULT_MARKET = 'US';
const DEFAULT_LIMIT = 0;
const DEFAULT_EXAMPLES_PER_REASON = 8;
const DEFAULT_QUERY_RETRIES = 2;
const DEFAULT_QUERY_RETRY_BACKOFF_MS = 1000;
const MAX_LIMIT = 250000;

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeKey(value, fallback = 'unknown') {
  return normalizeString(value, 120).toLowerCase() || fallback;
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDbError(err) {
  const code = String(err?.code || '').trim().toUpperCase();
  const message = String(err?.message || err || '').toLowerCase();
  if (code.startsWith('08')) return true;
  return [
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    '57P01',
    '57P02',
    '57P03',
  ].includes(code) ||
    message.includes('connection reset') ||
    message.includes('connection terminated unexpectedly') ||
    message.includes('server closed the connection unexpectedly') ||
    message.includes('client has encountered a connection error') ||
    message.includes('connection terminated');
}

function summarizeError(err) {
  return {
    code: err?.code || null,
    message: normalizeString(err?.message || err, 500),
  };
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

function resolvePathMaybeRelative(filePath, cwd = process.cwd()) {
  const text = normalizeString(filePath);
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.join(cwd, text);
}

function writeJsonFile(filePath, payload) {
  const resolved = resolvePathMaybeRelative(filePath);
  if (!resolved) return;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function usage() {
  return [
    'Usage:',
    '  DATABASE_URL=... node scripts/audit-relationship-graph-serving-guard.js [--market US|--all-markets] [--limit N] [--examples-per-reason N] [--query-retries N] [--out path]',
    '',
    'Read-only audit. Loads active human_approved/ai_approved relationship_candidate_labels rows and applies the runtime serving guard.',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  if (hasFlag(argv, 'help') || hasFlag(argv, 'h')) return { help: true };
  const allMarkets = hasFlag(argv, 'all-markets');
  const market = allMarkets ? '' : normalizeString(argValue(argv, 'market', DEFAULT_MARKET), 24).toUpperCase();
  return {
    market: market || (allMarkets ? '' : DEFAULT_MARKET),
    limit: parseInteger(argValue(argv, 'limit'), DEFAULT_LIMIT, { min: 0, max: MAX_LIMIT }),
    examplesPerReason: parseInteger(argValue(argv, 'examples-per-reason'), DEFAULT_EXAMPLES_PER_REASON, {
      min: 0,
      max: 100,
    }),
    queryRetries: parseInteger(argValue(argv, 'query-retries'), DEFAULT_QUERY_RETRIES, { min: 0, max: 5 }),
    queryRetryBackoffMs: parseInteger(argValue(argv, 'query-retry-backoff-ms'), DEFAULT_QUERY_RETRY_BACKOFF_MS, {
      min: 0,
      max: 30000,
    }),
    out: normalizeString(argValue(argv, 'out')),
  };
}

function buildServedRowsSql({ market = DEFAULT_MARKET, limit = DEFAULT_LIMIT } = {}) {
  const params = [];
  const where = [
    "vertical = 'beauty'",
    "label_state IN ('human_approved','ai_approved')",
    'last_verified_at IS NOT NULL',
    'expires_at > now()',
  ];
  const normalizedMarket = normalizeString(market, 24).toUpperCase();
  if (normalizedMarket) {
    params.push(normalizedMarket);
    where.push(`upper(market) = $${params.length}`);
  }
  const normalizedLimit = parseInteger(limit, DEFAULT_LIMIT, { min: 0, max: MAX_LIMIT });
  let limitSql = '';
  if (normalizedLimit > 0) {
    params.push(normalizedLimit);
    limitSql = `\n        LIMIT $${params.length}::int`;
  }

  return {
    sql: `
        SELECT
          id, anchor_type, anchor_ref, anchor_snapshot, candidate_product_ref, candidate_snapshot,
          relation_type, display_label, market, vertical, category_taxonomy, use_case,
          score_total, score_breakdown, price_evidence, source_refs, evidence_grade,
          'approved'::text AS review_status, label_state,
          why_candidate, tradeoffs, watchouts, provenance,
          last_verified_at, expires_at, created_at, updated_at
        FROM relationship_candidate_labels
        WHERE ${where.join('\n          AND ')}
        ORDER BY score_total DESC NULLS LAST, updated_at DESC NULLS LAST${limitSql}
      `,
    params,
  };
}

async function loadServedRelationshipRows({ queryFn = query, market = DEFAULT_MARKET, limit = DEFAULT_LIMIT } = {}) {
  const { sql, params } = buildServedRowsSql({ market, limit });
  const res = await queryFn(sql, params);
  return Array.isArray(res && res.rows) ? res.rows : [];
}

async function loadServedRelationshipRowsWithRetry({
  queryFn = query,
  closePoolFn = closePool,
  market = DEFAULT_MARKET,
  limit = DEFAULT_LIMIT,
  queryRetries = DEFAULT_QUERY_RETRIES,
  queryRetryBackoffMs = DEFAULT_QUERY_RETRY_BACKOFF_MS,
} = {}) {
  const maxRetries = parseInteger(queryRetries, DEFAULT_QUERY_RETRIES, { min: 0, max: 5 });
  const backoffMs = parseInteger(queryRetryBackoffMs, DEFAULT_QUERY_RETRY_BACKOFF_MS, { min: 0, max: 30000 });
  const errors = [];
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const rows = await loadServedRelationshipRows({ queryFn, market, limit });
      return {
        rows,
        retry: {
          attempts: attempt,
          max_retries: maxRetries,
          errors,
        },
      };
    } catch (err) {
      if (!isTransientDbError(err) || attempt >= maxRetries) throw err;
      errors.push({
        attempt: attempt + 1,
        ...summarizeError(err),
      });
      if (typeof closePoolFn === 'function') {
        try {
          await closePoolFn();
        } catch (_closeErr) {
          // Best effort: the next retry will create a fresh pool if possible.
        }
      }
      await sleep(backoffMs * (attempt + 1));
    }
  }
  throw new Error('unreachable');
}

function pct(part, total) {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(2));
}

function ensureBucket(map, key) {
  const normalized = normalizeKey(key);
  if (!map[normalized]) {
    map[normalized] = {
      total: 0,
      safe: 0,
      suppressed: 0,
      suppressed_pct: 0,
    };
  }
  return map[normalized];
}

function bumpBucket(map, key, suppressed) {
  const bucket = ensureBucket(map, key);
  bucket.total += 1;
  if (suppressed) bucket.suppressed += 1;
  else bucket.safe += 1;
  bucket.suppressed_pct = pct(bucket.suppressed, bucket.total);
}

function sortObjectKeys(value) {
  return Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
}

function sortCountObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).sort(([a, aCount], [b, bCount]) => {
      if (bCount !== aCount) return bCount - aCount;
      return a.localeCompare(b);
    }),
  );
}

function snapshotTitle(snapshot) {
  const obj = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  return normalizeString(obj.title || obj.name || obj.display_name || obj.displayName || obj.product_name || obj.productName, 220);
}

function snapshotBrand(snapshot) {
  const obj = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  return normalizeString(obj.brand || obj.brand_name || obj.brandName || obj.vendor || obj.vendor_name || obj.vendorName, 160);
}

function buildExample(edge, reasons) {
  return {
    id: edge.id,
    relation_type: edge.relation_type,
    label_state: edge.label_state,
    market: edge.market,
    anchor_ref: edge.anchor_ref,
    candidate_product_ref: edge.candidate_product_ref,
    anchor_brand: snapshotBrand(edge.anchor_snapshot),
    anchor_title: snapshotTitle(edge.anchor_snapshot),
    candidate_brand: snapshotBrand(edge.candidate_snapshot),
    candidate_title: snapshotTitle(edge.candidate_snapshot),
    reasons,
  };
}

function summarizeSuppressionRows(rows = [], { examplesPerReason = DEFAULT_EXAMPLES_PER_REASON, generatedAt = new Date().toISOString() } = {}) {
  const byReason = {};
  const byRelationType = {};
  const byLabelState = {};
  const byRelationTypeAndLabelState = {};
  const examplesByReason = {};
  let safeRows = 0;
  let suppressedRows = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const edge = coerceRelationshipEdge({ ...row, review_status: row.review_status || 'approved' });
    const reasons = getRelationshipEdgeServingSuppressionReasons(edge);
    const suppressed = reasons.length > 0;
    if (suppressed) suppressedRows += 1;
    else safeRows += 1;

    bumpBucket(byRelationType, edge.relation_type, suppressed);
    bumpBucket(byLabelState, edge.label_state, suppressed);
    bumpBucket(byRelationTypeAndLabelState, `${normalizeKey(edge.relation_type)}:${normalizeKey(edge.label_state)}`, suppressed);

    if (!suppressed) continue;
    for (const reason of reasons) {
      byReason[reason] = (byReason[reason] || 0) + 1;
      if (examplesPerReason <= 0) continue;
      if (!examplesByReason[reason]) examplesByReason[reason] = [];
      if (examplesByReason[reason].length < examplesPerReason) {
        examplesByReason[reason].push(buildExample(edge, reasons));
      }
    }
  }

  const totalRows = safeRows + suppressedRows;
  return {
    generated_at: generatedAt,
    total_rows: totalRows,
    safe_rows: safeRows,
    suppressed_rows: suppressedRows,
    suppressed_pct: pct(suppressedRows, totalRows),
    by_reason: sortCountObject(byReason),
    by_relation_type: sortObjectKeys(byRelationType),
    by_label_state: sortObjectKeys(byLabelState),
    by_relation_type_and_label_state: sortObjectKeys(byRelationTypeAndLabelState),
    examples_by_reason: sortObjectKeys(examplesByReason),
  };
}

async function runServingGuardAudit({
  queryFn = query,
  closePoolFn = closePool,
  market = DEFAULT_MARKET,
  limit = DEFAULT_LIMIT,
  examplesPerReason = DEFAULT_EXAMPLES_PER_REASON,
  queryRetries = DEFAULT_QUERY_RETRIES,
  queryRetryBackoffMs = DEFAULT_QUERY_RETRY_BACKOFF_MS,
  generatedAt = new Date().toISOString(),
} = {}) {
  const { rows, retry } = await loadServedRelationshipRowsWithRetry({
    queryFn,
    closePoolFn,
    market,
    limit,
    queryRetries,
    queryRetryBackoffMs,
  });
  const summary = summarizeSuppressionRows(rows, { examplesPerReason, generatedAt });
  return {
    ...summary,
    query: {
      source_table: 'relationship_candidate_labels',
      market: normalizeString(market, 24).toUpperCase() || 'all',
      limit: parseInteger(limit, DEFAULT_LIMIT, { min: 0, max: MAX_LIMIT }),
      examples_per_reason: examplesPerReason,
      retry,
      predicate:
        "vertical = 'beauty' AND label_state IN ('human_approved','ai_approved') AND last_verified_at IS NOT NULL AND expires_at > now()",
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const audit = await runServingGuardAudit(options);
  if (options.out) writeJsonFile(options.out, audit);
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  return audit;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  }).finally(() => {
    closePool().catch(() => {});
  });
}

module.exports = {
  buildServedRowsSql,
  loadServedRelationshipRows,
  loadServedRelationshipRowsWithRetry,
  summarizeSuppressionRows,
  runServingGuardAudit,
  isTransientDbError,
  parseArgs,
};
