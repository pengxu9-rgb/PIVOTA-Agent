#!/usr/bin/env node
'use strict';

const { closePool, query } = require('../src/db');

const DEFAULT_MARKET = 'US';
const DEFAULT_LIMIT = 0;
const DEFAULT_TOP_ANCHORS = 10;
const MAX_LIMIT = 250000;
const MAX_TOP_ANCHORS = 100;

const ALTERNATIVE_RELATION_TYPES = new Set(['dupe', 'competitive_alternative']);
const DEFAULT_THRESHOLDS = {
  minAnchorCount: 200,
  minApprovedAlternativeAnchorPct: 70,
  minNicheSpecialistCount: 100,
};

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeKey(value, fallback = 'unknown') {
  return normalizeString(value, 120).toLowerCase() || fallback;
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

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseNumber(value, fallback, { min = -Number.MAX_VALUE, max = Number.MAX_VALUE } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function pct(part, total) {
  if (!total) return 0;
  return Number(((Number(part || 0) / Number(total || 0)) * 100).toFixed(2));
}

function sortCountObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).sort(([a, aCount], [b, bCount]) => {
      if (bCount !== aCount) return bCount - aCount;
      return a.localeCompare(b);
    }),
  );
}

function usage() {
  return [
    'Usage:',
    '  DATABASE_URL=... node scripts/report-relationship-graph-serving-status.js [--market US|--all-markets] [--limit N] [--top-anchors N] [--fail-on-readiness] [--json]',
    '',
    'Read-only live serving coverage report for active relationship_candidate_labels rows.',
    '',
    'Readiness thresholds default to the v1 pilot runbook:',
    '  --min-anchor-count 200',
    '  --min-approved-alternative-anchor-pct 70',
    '  --min-niche-specialist-count 100',
    '',
    'Optional gates:',
    '  --max-expiring-7d N',
    '  --max-ai-approved-pct N',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  if (hasFlag(argv, 'help') || hasFlag(argv, 'h')) return { help: true };
  const allMarkets = hasFlag(argv, 'all-markets');
  const market = allMarkets ? '' : normalizeString(argValue(argv, 'market', DEFAULT_MARKET), 24).toUpperCase();
  const maxExpiring7dInput = normalizeString(argValue(argv, 'max-expiring-7d'), 32);
  const maxAiApprovedPctInput = normalizeString(argValue(argv, 'max-ai-approved-pct'), 32);

  return {
    market: market || (allMarkets ? '' : DEFAULT_MARKET),
    limit: parseInteger(argValue(argv, 'limit'), DEFAULT_LIMIT, { min: 0, max: MAX_LIMIT }),
    topAnchors: parseInteger(argValue(argv, 'top-anchors'), DEFAULT_TOP_ANCHORS, {
      min: 0,
      max: MAX_TOP_ANCHORS,
    }),
    thresholds: {
      minAnchorCount: parseInteger(
        argValue(argv, 'min-anchor-count'),
        DEFAULT_THRESHOLDS.minAnchorCount,
        { min: 0, max: MAX_LIMIT },
      ),
      minApprovedAlternativeAnchorPct: parseNumber(
        argValue(argv, 'min-approved-alternative-anchor-pct'),
        DEFAULT_THRESHOLDS.minApprovedAlternativeAnchorPct,
        { min: 0, max: 100 },
      ),
      minNicheSpecialistCount: parseInteger(
        argValue(argv, 'min-niche-specialist-count'),
        DEFAULT_THRESHOLDS.minNicheSpecialistCount,
        { min: 0, max: MAX_LIMIT },
      ),
      maxExpiring7d: maxExpiring7dInput
        ? parseInteger(maxExpiring7dInput, null, { min: 0, max: MAX_LIMIT })
        : null,
      maxAiApprovedPct: maxAiApprovedPctInput
        ? parseNumber(maxAiApprovedPctInput, null, { min: 0, max: 100 })
        : null,
    },
    failOnReadiness: hasFlag(argv, 'fail-on-readiness'),
    json: hasFlag(argv, 'json'),
  };
}

function buildServingStatusSql({ market = DEFAULT_MARKET, limit = DEFAULT_LIMIT } = {}) {
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
    limitSql = `\n      LIMIT $${params.length}::int`;
  }

  return {
    sql: `
      SELECT
        id,
        anchor_type,
        anchor_ref,
        candidate_product_ref,
        relation_type,
        label_state,
        market,
        vertical,
        score_total,
        last_verified_at,
        expires_at,
        created_at,
        updated_at
      FROM relationship_candidate_labels
      WHERE ${where.join('\n        AND ')}
      ORDER BY updated_at DESC NULLS LAST, score_total DESC NULLS LAST, id ASC${limitSql}
    `,
    params,
  };
}

async function loadServingStatusRows({ queryFn = query, market = DEFAULT_MARKET, limit = DEFAULT_LIMIT } = {}) {
  const { sql, params } = buildServingStatusSql({ market, limit });
  const res = await queryFn(sql, params);
  return Array.isArray(res && res.rows) ? res.rows : [];
}

function toTimestampMs(value) {
  const ms = new Date(value || '').getTime();
  return Number.isFinite(ms) ? ms : null;
}

function bucketCount(target, key) {
  const normalized = normalizeKey(key);
  target[normalized] = Number(target[normalized] || 0) + 1;
}

function thresholdGate(name, metric, threshold, unit = 'count') {
  if (threshold == null) {
    return { name, status: 'not_applicable', metric, threshold: null, unit };
  }
  const numericMetric = Number(metric);
  return {
    name,
    status: Number.isFinite(numericMetric) && numericMetric >= Number(threshold) ? 'pass' : 'fail',
    metric,
    threshold,
    unit,
  };
}

function maxGate(name, metric, threshold, unit = 'count') {
  if (threshold == null) {
    return { name, status: 'not_applicable', metric, threshold: null, unit };
  }
  const numericMetric = Number(metric);
  return {
    name,
    status: Number.isFinite(numericMetric) && numericMetric <= Number(threshold) ? 'pass' : 'fail',
    metric,
    threshold,
    unit,
  };
}

function summarizeServingStatusRows(rows = [], {
  generatedAt = new Date().toISOString(),
  topAnchors = DEFAULT_TOP_ANCHORS,
  thresholds = DEFAULT_THRESHOLDS,
} = {}) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const nowMs = toTimestampMs(generatedAt) || Date.now();
  const anchors = new Set();
  const candidates = new Set();
  const alternativeAnchors = new Set();
  const byRelationType = {};
  const byLabelState = {};
  const byMarket = {};
  const byRelationTypeAndLabelState = {};
  const anchorCounts = new Map();
  const expiry = {
    expiring_7d: 0,
    expiring_14d: 0,
    expiring_30d: 0,
    expiring_45d: 0,
    missing_expiry: 0,
    expired: 0,
    min_expires_at: null,
    max_expires_at: null,
  };
  let humanApprovedRows = 0;
  let aiApprovedRows = 0;
  let nicheSpecialistCount = 0;

  for (const row of normalizedRows) {
    const anchorRef = normalizeString(row.anchor_ref, 260).toLowerCase();
    const candidateRef = normalizeString(row.candidate_product_ref, 260).toLowerCase();
    const relationType = normalizeKey(row.relation_type);
    const labelState = normalizeKey(row.label_state);
    const market = normalizeString(row.market, 24).toUpperCase() || 'UNKNOWN';

    if (anchorRef) anchors.add(anchorRef);
    if (candidateRef) candidates.add(candidateRef);
    if (anchorRef && ALTERNATIVE_RELATION_TYPES.has(relationType)) alternativeAnchors.add(anchorRef);
    if (relationType === 'niche_specialist') nicheSpecialistCount += 1;
    if (labelState === 'human_approved') humanApprovedRows += 1;
    if (labelState === 'ai_approved') aiApprovedRows += 1;

    bucketCount(byRelationType, relationType);
    bucketCount(byLabelState, labelState);
    bucketCount(byMarket, market);
    bucketCount(byRelationTypeAndLabelState, `${relationType}:${labelState}`);
    if (anchorRef) {
      anchorCounts.set(anchorRef, Number(anchorCounts.get(anchorRef) || 0) + 1);
    }

    const expiresMs = toTimestampMs(row.expires_at);
    if (expiresMs == null) {
      expiry.missing_expiry += 1;
    } else {
      const iso = new Date(expiresMs).toISOString();
      if (!expiry.min_expires_at || expiresMs < toTimestampMs(expiry.min_expires_at)) expiry.min_expires_at = iso;
      if (!expiry.max_expires_at || expiresMs > toTimestampMs(expiry.max_expires_at)) expiry.max_expires_at = iso;
      const days = (expiresMs - nowMs) / (24 * 60 * 60 * 1000);
      if (days <= 0) expiry.expired += 1;
      if (days > 0 && days <= 7) expiry.expiring_7d += 1;
      if (days > 0 && days <= 14) expiry.expiring_14d += 1;
      if (days > 0 && days <= 30) expiry.expiring_30d += 1;
      if (days > 0 && days <= 45) expiry.expiring_45d += 1;
    }
  }

  const totalRows = normalizedRows.length;
  const anchorCount = anchors.size;
  const approvedAlternativeAnchorCount = alternativeAnchors.size;
  const approvedAlternativeAnchorPct = pct(approvedAlternativeAnchorCount, anchorCount);
  const aiApprovedPct = pct(aiApprovedRows, totalRows);
  const safeThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(thresholds && typeof thresholds === 'object' ? thresholds : {}),
  };
  const checks = {
    anchor_count: thresholdGate(
      'anchor_count',
      anchorCount,
      safeThresholds.minAnchorCount,
      'count',
    ),
    approved_alternative_anchor_pct: thresholdGate(
      'approved_alternative_anchor_pct',
      approvedAlternativeAnchorPct,
      safeThresholds.minApprovedAlternativeAnchorPct,
      'percent',
    ),
    niche_specialist_count: thresholdGate(
      'niche_specialist_count',
      nicheSpecialistCount,
      safeThresholds.minNicheSpecialistCount,
      'count',
    ),
    expiring_7d: maxGate('expiring_7d', expiry.expiring_7d, safeThresholds.maxExpiring7d, 'count'),
    ai_approved_pct: maxGate('ai_approved_pct', aiApprovedPct, safeThresholds.maxAiApprovedPct, 'percent'),
  };
  const ok = Object.values(checks).every((gate) => gate.status !== 'fail');
  const topAnchorLimit = parseInteger(topAnchors, DEFAULT_TOP_ANCHORS, { min: 0, max: MAX_TOP_ANCHORS });
  const topAnchorRows = Array.from(anchorCounts.entries())
    .sort(([a, aCount], [b, bCount]) => {
      if (bCount !== aCount) return bCount - aCount;
      return a.localeCompare(b);
    })
    .slice(0, topAnchorLimit)
    .map(([anchor_ref, edge_count]) => ({ anchor_ref, edge_count }));

  return {
    schema_version: 'relationship_graph_serving_status.v1',
    generated_at: generatedAt,
    ok,
    coverage: {
      total_rows: totalRows,
      distinct_anchor_count: anchorCount,
      distinct_candidate_count: candidates.size,
      approved_alternative_anchor_count: approvedAlternativeAnchorCount,
      approved_alternative_anchor_pct: approvedAlternativeAnchorPct,
      niche_specialist_count: nicheSpecialistCount,
      human_approved_rows: humanApprovedRows,
      ai_approved_rows: aiApprovedRows,
      ai_approved_pct: aiApprovedPct,
    },
    expiry_windows: expiry,
    checks,
    by_relation_type: sortCountObject(byRelationType),
    by_label_state: sortCountObject(byLabelState),
    by_market: sortCountObject(byMarket),
    by_relation_type_and_label_state: sortCountObject(byRelationTypeAndLabelState),
    top_anchors: topAnchorRows,
  };
}

function compactValue(value) {
  if (value == null || value === '') return '-';
  return String(value);
}

function formatServingStatusText(report = {}) {
  const coverage = report.coverage || {};
  const expiry = report.expiry_windows || {};
  const lines = [];
  lines.push(`relationship graph serving status: ${report.ok ? 'ready' : 'not_ready'}`);
  lines.push([
    `rows=${compactValue(coverage.total_rows)}`,
    `anchors=${compactValue(coverage.distinct_anchor_count)}`,
    `candidates=${compactValue(coverage.distinct_candidate_count)}`,
    `alt_anchor_pct=${compactValue(coverage.approved_alternative_anchor_pct)}`,
    `niche_specialist=${compactValue(coverage.niche_specialist_count)}`,
    `ai_approved_pct=${compactValue(coverage.ai_approved_pct)}`,
  ].join(' '));
  lines.push([
    `expiring_7d=${compactValue(expiry.expiring_7d)}`,
    `expiring_14d=${compactValue(expiry.expiring_14d)}`,
    `expiring_30d=${compactValue(expiry.expiring_30d)}`,
    `min_expires_at=${compactValue(expiry.min_expires_at)}`,
  ].join(' '));
  lines.push('checks:');
  for (const gate of Object.values(report.checks || {})) {
    lines.push(`- ${gate.name}: ${gate.status} metric=${compactValue(gate.metric)} threshold=${compactValue(gate.threshold)} ${gate.unit || ''}`.trim());
  }
  lines.push(`relation_types=${JSON.stringify(report.by_relation_type || {})}`);
  lines.push(`label_states=${JSON.stringify(report.by_label_state || {})}`);
  if (Array.isArray(report.top_anchors) && report.top_anchors.length) {
    lines.push('top_anchors:');
    for (const row of report.top_anchors) {
      lines.push(`- ${row.anchor_ref} edges=${row.edge_count}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function runServingStatusReport({
  queryFn = query,
  market = DEFAULT_MARKET,
  limit = DEFAULT_LIMIT,
  topAnchors = DEFAULT_TOP_ANCHORS,
  thresholds = DEFAULT_THRESHOLDS,
  generatedAt = new Date().toISOString(),
} = {}) {
  const rows = await loadServingStatusRows({ queryFn, market, limit });
  const report = summarizeServingStatusRows(rows, { generatedAt, topAnchors, thresholds });
  return {
    ...report,
    query: {
      source_table: 'relationship_candidate_labels',
      market: normalizeString(market, 24).toUpperCase() || 'all',
      limit: parseInteger(limit, DEFAULT_LIMIT, { min: 0, max: MAX_LIMIT }),
      predicate:
        "vertical = 'beauty' AND label_state IN ('human_approved','ai_approved') AND last_verified_at IS NOT NULL AND expires_at > now()",
    },
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      ...(thresholds && typeof thresholds === 'object' ? thresholds : {}),
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }

  const report = await runServingStatusReport(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatServingStatusText(report));
  }
  if (options.failOnReadiness && !report.ok) process.exitCode = 1;
  return report;
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
  DEFAULT_THRESHOLDS,
  buildServingStatusSql,
  formatServingStatusText,
  parseArgs,
  runServingStatusReport,
  summarizeServingStatusRows,
};
