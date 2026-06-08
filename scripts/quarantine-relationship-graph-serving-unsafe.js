#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const { withPostgresAdvisoryLock } = require('./run-relationship-graph-routine-job');
const {
  coerceRelationshipEdge,
  getRelationshipEdgeServingSuppressionReasons,
} = require('../src/auroraBff/productRelationshipGraph');

const CONFIRM_TOKEN = 'QUARANTINE_RELGRAPH_UNSAFE_APPROVED';
const DEFAULT_MARKET = 'US';
const DEFAULT_LIMIT = 0;
const DEFAULT_EXAMPLES_PER_REASON = 8;
const MAX_LIMIT = 250000;
const DEFAULT_DB_LOCK_KEY = 'pivota.relationship_graph.routine';
const DEFAULT_APPLY_CHUNK_SIZE = 500;
const SUPPORTED_MODES = new Set(['needs-evidence', 'expire']);

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeKey(value, fallback = '') {
  return normalizeString(value, 160).toLowerCase() || fallback;
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseDelimitedList(value, max = 5000) {
  return Array.from(new Set(
    normalizeString(value, max)
      .split(/[,\s]+/)
      .map((item) => normalizeKey(item))
      .filter(Boolean),
  ));
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
  const text = normalizeString(filePath, 2000);
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.join(cwd, text);
}

function writeJsonFile(filePath, payload) {
  const resolved = resolvePathMaybeRelative(filePath);
  if (!resolved) return '';
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

function usage() {
  return [
    'Usage:',
    '  DATABASE_URL=... node scripts/quarantine-relationship-graph-serving-unsafe.js [--market US|--all-markets] [--limit N] [--reasons a,b] [--out path]',
    '',
    'Dry-run by default. Apply requires --apply --confirm QUARANTINE_RELGRAPH_UNSAFE_APPROVED.',
    'Default scope is active ai_approved labels only. Use --include-human-approved only for a manual repair run.',
    'Default mode is --mode needs-evidence. Use --mode expire to only expire matching rows.',
    'Use --db-lock to share the relationship graph Postgres advisory lock with routine jobs.',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  if (hasFlag(argv, 'help') || hasFlag(argv, 'h')) return { help: true };
  const allMarkets = hasFlag(argv, 'all-markets');
  const market = allMarkets ? '' : normalizeString(argValue(argv, 'market', DEFAULT_MARKET), 24).toUpperCase();
  const apply = hasFlag(argv, 'apply');
  const confirm = normalizeString(argValue(argv, 'confirm'), 120);
  if (apply && confirm !== CONFIRM_TOKEN) {
    throw new Error(`apply requires --confirm ${CONFIRM_TOKEN}`);
  }
  const mode = normalizeKey(argValue(argv, 'mode', 'needs-evidence')) || 'needs-evidence';
  if (!SUPPORTED_MODES.has(mode)) {
    throw new Error(`unsupported --mode ${mode}; expected ${Array.from(SUPPORTED_MODES).join('|')}`);
  }

  return {
    market: market || (allMarkets ? '' : DEFAULT_MARKET),
    limit: parseInteger(argValue(argv, 'limit'), DEFAULT_LIMIT, { min: 0, max: MAX_LIMIT }),
    applyChunkSize: parseInteger(argValue(argv, 'apply-chunk-size'), DEFAULT_APPLY_CHUNK_SIZE, {
      min: 1,
      max: 2000,
    }),
    examplesPerReason: parseInteger(argValue(argv, 'examples-per-reason'), DEFAULT_EXAMPLES_PER_REASON, {
      min: 0,
      max: 100,
    }),
    reasons: parseDelimitedList(argValue(argv, 'reasons')),
    includeHumanApproved: hasFlag(argv, 'include-human-approved'),
    mode,
    apply,
    confirm,
    dbLock: hasFlag(argv, 'db-lock'),
    dbLockKey: normalizeString(argValue(argv, 'db-lock-key', DEFAULT_DB_LOCK_KEY), 500) || DEFAULT_DB_LOCK_KEY,
    out: normalizeString(argValue(argv, 'out'), 2000),
    auditRunId: normalizeString(argValue(argv, 'audit-run-id'), 200),
  };
}

function labelStatesForOptions(options = {}) {
  const states = ['ai_approved'];
  if (options.includeHumanApproved) states.push('human_approved');
  return states;
}

function buildCandidateRowsSql({
  market = DEFAULT_MARKET,
  limit = DEFAULT_LIMIT,
  includeHumanApproved = false,
} = {}) {
  const params = [];
  const states = labelStatesForOptions({ includeHumanApproved });
  params.push(states);
  const where = [
    "vertical = 'beauty'",
    `label_state = ANY($${params.length}::text[])`,
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
          why_candidate, tradeoffs, watchouts, provenance, reason_flags,
          last_verified_at, expires_at, created_at, updated_at
        FROM relationship_candidate_labels
        WHERE ${where.join('\n          AND ')}
        ORDER BY score_total DESC NULLS LAST, updated_at DESC NULLS LAST${limitSql}
      `,
    params,
  };
}

async function loadQuarantineCandidateRows({
  queryFn = query,
  market = DEFAULT_MARKET,
  limit = DEFAULT_LIMIT,
  includeHumanApproved = false,
} = {}) {
  const { sql, params } = buildCandidateRowsSql({ market, limit, includeHumanApproved });
  const res = await queryFn(sql, params);
  return Array.isArray(res && res.rows) ? res.rows : [];
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

function sortCountObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).sort(([a, aCount], [b, bCount]) => {
      if (bCount !== aCount) return bCount - aCount;
      return a.localeCompare(b);
    }),
  );
}

function sortObjectKeys(value) {
  return Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
}

function reasonFilterMatches(reasons = [], filter = []) {
  if (!Array.isArray(filter) || filter.length === 0) return true;
  const set = new Set(filter.map((item) => normalizeKey(item)));
  return reasons.some((reason) => set.has(normalizeKey(reason)));
}

function selectUnsafeRows(rows = [], {
  reasons: reasonFilter = [],
  examplesPerReason = DEFAULT_EXAMPLES_PER_REASON,
} = {}) {
  const selected = [];
  const safeIds = [];
  const byReason = {};
  const byRelationType = {};
  const byLabelState = {};
  const examplesByReason = {};

  for (const row of Array.isArray(rows) ? rows : []) {
    const edge = coerceRelationshipEdge({ ...row, review_status: row.review_status || 'approved' });
    const reasons = getRelationshipEdgeServingSuppressionReasons(edge);
    if (!reasons.length || !reasonFilterMatches(reasons, reasonFilter)) {
      safeIds.push(edge.id);
      continue;
    }

    selected.push({ row, edge, reasons });
    byRelationType[edge.relation_type] = (byRelationType[edge.relation_type] || 0) + 1;
    byLabelState[edge.label_state] = (byLabelState[edge.label_state] || 0) + 1;
    for (const reason of reasons) {
      byReason[reason] = (byReason[reason] || 0) + 1;
      if (examplesPerReason <= 0) continue;
      if (!examplesByReason[reason]) examplesByReason[reason] = [];
      if (examplesByReason[reason].length < examplesPerReason) {
        examplesByReason[reason].push(buildExample(edge, reasons));
      }
    }
  }

  return {
    selected,
    summary: {
      candidate_rows: Array.isArray(rows) ? rows.length : 0,
      safe_or_filtered_rows: safeIds.length,
      unsafe_rows: selected.length,
      by_reason: sortCountObject(byReason),
      by_relation_type: sortCountObject(byRelationType),
      by_label_state: sortCountObject(byLabelState),
      examples_by_reason: sortObjectKeys(examplesByReason),
    },
  };
}

function buildQuarantinePatch({
  row,
  reasons,
  mode = 'needs-evidence',
  auditRunId = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const reasonFlags = reasons.map((reason) => `serving_guard:${normalizeKey(reason)}`);
  return {
    id: row.id,
    previous_label_state: row.label_state,
    next_label_state: mode === 'needs-evidence' ? 'needs_evidence' : row.label_state,
    expires_now: true,
    mode,
    reason_flags: reasonFlags,
    provenance_patch: {
      action: 'relationship_graph_serving_guard_quarantine',
      mode,
      audit_run_id: normalizeString(auditRunId, 200) || null,
      reasons,
      previous_label_state: row.label_state,
      quarantined_at: generatedAt,
      script: 'quarantine-relationship-graph-serving-unsafe.js',
    },
  };
}

async function applyQuarantinePatch({ queryFn = query, patch } = {}) {
  const rows = await applyQuarantinePatches({ queryFn, patches: [patch], chunkSize: 1 });
  return rows[0] || null;
}

function patchPayload(patches = []) {
  return patches.map((patch) => ({
    id: patch.id,
    next_label_state: patch.next_label_state,
    reason_flags: patch.reason_flags,
    provenance_patch: patch.provenance_patch,
  }));
}

async function applyQuarantinePatchChunk({ queryFn = query, patches = [] } = {}) {
  if (!Array.isArray(patches) || patches.length === 0) return [];
  const res = await queryFn(
    `
      WITH patch AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS p(
          id text,
          next_label_state text,
          reason_flags jsonb,
          provenance_patch jsonb
        )
      )
      UPDATE relationship_candidate_labels
      SET
        label_state = patch.next_label_state,
        expires_at = now(),
        updated_at = now(),
        reason_flags = ARRAY(
          SELECT DISTINCT flag
          FROM unnest(
            COALESCE(relationship_candidate_labels.reason_flags, '{}'::text[]) ||
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(patch.reason_flags, '[]'::jsonb)))
          ) AS flags(flag)
          WHERE flag IS NOT NULL AND flag <> ''
          ORDER BY flag
        ),
        provenance = jsonb_set(
          jsonb_set(
            COALESCE(provenance, '{}'::jsonb),
            '{serving_guard_quarantine}',
            patch.provenance_patch,
            true
          ),
          '{quarantine_history}',
          COALESCE(COALESCE(provenance, '{}'::jsonb)->'quarantine_history', '[]'::jsonb) || jsonb_build_array(patch.provenance_patch),
          true
        )
      FROM patch
      WHERE relationship_candidate_labels.id = patch.id
        AND relationship_candidate_labels.label_state = ANY(ARRAY['ai_approved','human_approved']::text[])
        AND relationship_candidate_labels.last_verified_at IS NOT NULL
        AND relationship_candidate_labels.expires_at > now()
      RETURNING relationship_candidate_labels.id,
        relationship_candidate_labels.label_state,
        relationship_candidate_labels.expires_at,
        relationship_candidate_labels.reason_flags,
        relationship_candidate_labels.provenance
    `,
    [JSON.stringify(patchPayload(patches))],
  );
  return Array.isArray(res && res.rows) ? res.rows : [];
}

async function applyQuarantinePatches({ queryFn = query, patches = [], chunkSize = DEFAULT_APPLY_CHUNK_SIZE } = {}) {
  const out = [];
  const size = parseInteger(chunkSize, DEFAULT_APPLY_CHUNK_SIZE, { min: 1, max: 2000 });
  for (let idx = 0; idx < patches.length; idx += size) {
    const chunk = patches.slice(idx, idx + size);
    // eslint-disable-next-line no-await-in-loop
    const rows = await applyQuarantinePatchChunk({ queryFn, patches: chunk });
    out.push(...rows);
  }
  return out;
}

async function runQuarantine({
  queryFn = query,
  market = DEFAULT_MARKET,
  limit = DEFAULT_LIMIT,
  examplesPerReason = DEFAULT_EXAMPLES_PER_REASON,
  reasons = [],
  includeHumanApproved = false,
  mode = 'needs-evidence',
  apply = false,
  applyChunkSize = DEFAULT_APPLY_CHUNK_SIZE,
  out = '',
  auditRunId = '',
  dbLockInfo = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const rows = await loadQuarantineCandidateRows({ queryFn, market, limit, includeHumanApproved });
  const { selected, summary } = selectUnsafeRows(rows, { reasons, examplesPerReason });
  const patches = selected.map(({ row, reasons: rowReasons }) => buildQuarantinePatch({
    row,
    reasons: rowReasons,
    mode,
    auditRunId,
    generatedAt,
  }));
  const applied = [];
  if (apply) {
    applied.push(...await applyQuarantinePatches({ queryFn, patches, chunkSize: applyChunkSize }));
  }

  const report = {
    generated_at: generatedAt,
    dry_run: !apply,
    apply,
    mode,
    market: normalizeString(market, 24).toUpperCase() || 'all',
    include_human_approved: Boolean(includeHumanApproved),
    reason_filter: reasons,
    audit_run_id: normalizeString(auditRunId, 200) || null,
    db_lock: dbLockInfo
      ? {
        requested: true,
        acquired: true,
        lock_key: dbLockInfo.lock_key,
        key_parts: dbLockInfo.key_parts,
      }
      : { requested: false, acquired: false },
    summary: {
      ...summary,
      patch_count: patches.length,
      applied_count: applied.length,
    },
    patches: patches.map((patch) => ({
      id: patch.id,
      previous_label_state: patch.previous_label_state,
      next_label_state: patch.next_label_state,
      mode: patch.mode,
      reasons: patch.provenance_patch.reasons,
      reason_flags: patch.reason_flags,
    })),
    applied_rows: applied.map((row) => ({
      id: row.id,
      label_state: row.label_state,
      expires_at: row.expires_at,
      reason_flags: row.reason_flags,
    })),
    query: {
      source_table: 'relationship_candidate_labels',
      label_states: labelStatesForOptions({ includeHumanApproved }),
      active_fresh_only: true,
      limit: parseInteger(limit, DEFAULT_LIMIT, { min: 0, max: MAX_LIMIT }),
      apply_chunk_size: parseInteger(applyChunkSize, DEFAULT_APPLY_CHUNK_SIZE, { min: 1, max: 2000 }),
    },
  };
  if (out) report.out = writeJsonFile(out, report);
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const report = await withPostgresAdvisoryLock(
    options,
    {
      script: 'quarantine-relationship-graph-serving-unsafe.js',
      pid: process.pid,
      started_at: new Date().toISOString(),
      audit_run_id: options.auditRunId || null,
      apply: options.apply,
    },
    (dbLockInfo, client) => runQuarantine({
      ...options,
      dbLockInfo,
      queryFn: client ? client.query.bind(client) : query,
    }),
  );
  const printable = options.out
    ? {
      generated_at: report.generated_at,
      dry_run: report.dry_run,
      apply: report.apply,
      mode: report.mode,
      market: report.market,
      db_lock: report.db_lock,
      summary: {
        candidate_rows: report.summary.candidate_rows,
        safe_or_filtered_rows: report.summary.safe_or_filtered_rows,
        unsafe_rows: report.summary.unsafe_rows,
        patch_count: report.summary.patch_count,
        applied_count: report.summary.applied_count,
        by_reason: report.summary.by_reason,
        by_relation_type: report.summary.by_relation_type,
        by_label_state: report.summary.by_label_state,
      },
      out: report.out,
    }
    : report;
  process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
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
  CONFIRM_TOKEN,
  applyQuarantinePatch,
  applyQuarantinePatchChunk,
  applyQuarantinePatches,
  buildCandidateRowsSql,
  buildQuarantinePatch,
  loadQuarantineCandidateRows,
  parseArgs,
  runQuarantine,
  selectUnsafeRows,
};
