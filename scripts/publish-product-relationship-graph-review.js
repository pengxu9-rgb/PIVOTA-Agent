#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  validateRelationshipEdge,
  upsertRelationshipEdge,
} = require('../src/auroraBff/productRelationshipGraph');

const REVIEW_PUBLISHER_VERSION = 'product_relationship_graph.review_publish.v1';
const DEFAULT_EXPIRY_DAYS = 90;

function argValue(argv, name, fallback = '') {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function parseArgs(argv = process.argv) {
  return {
    report: argValue(argv, 'report'),
    decisions: argValue(argv, 'decisions'),
    out: argValue(argv, 'out'),
    apply: hasFlag(argv, 'apply'),
  };
}

function resolvePathMaybeRelative(value, cwd = process.cwd()) {
  const text = String(value || '').trim();
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.join(cwd, text);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeLower(value, max = 512) {
  return normalizeString(value, max).toLowerCase();
}

function cloneJson(value) {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function addDaysIso(value, days) {
  const start = new Date(value);
  if (Number.isNaN(start.getTime())) return null;
  start.setUTCDate(start.getUTCDate() + Math.max(1, Number(days) || DEFAULT_EXPIRY_DAYS));
  return start.toISOString();
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readStructuredRecords(filePath) {
  const resolved = resolvePathMaybeRelative(filePath);
  if (!resolved) throw new Error('missing_decisions_path');
  return parseDecisionRecordsText(fs.readFileSync(resolved, 'utf8'), resolved);
}

function parseDecisionRecordsText(body, sourcePath = '') {
  const text = String(body || '').trim();
  if (!text) return [];
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return extractDecisionRecords(JSON.parse(text));
    } catch (error) {
      if (!/\r?\n/.test(text)) throw error;
    }
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid_jsonl_decision:${sourcePath || 'decisions'}:${idx + 1}:${error.message}`);
      }
    })
    .flatMap((record) => extractDecisionRecords(record));
}

function extractDecisionRecords(input) {
  if (Array.isArray(input)) return input.filter((item) => item != null);
  if (!isPlainObject(input)) return [];

  const arrayFields = [
    input.decisions,
    input.review_decisions,
    input.reviewDecisions,
    input.rows,
    input.entries,
    input.approvals,
    input.approved_edges,
    input.approvedEdges,
  ];
  for (const rows of arrayFields) {
    if (Array.isArray(rows)) return rows.filter((item) => item != null);
  }

  if (isPlainObject(input.decisions_by_edge_id)) {
    return Object.entries(input.decisions_by_edge_id).map(([edgeId, value]) => ({
      edge_id: edgeId,
      ...(isPlainObject(value) ? value : { decision: value }),
    }));
  }
  if (isPlainObject(input.decisionsByEdgeId)) {
    return Object.entries(input.decisionsByEdgeId).map(([edgeId, value]) => ({
      edge_id: edgeId,
      ...(isPlainObject(value) ? value : { decision: value }),
    }));
  }

  if (
    input.edge_id ||
    input.edgeId ||
    input.relationship_edge_id ||
    input.relationshipEdgeId ||
    input.decision ||
    input.review_decision ||
    input.reviewDecision ||
    input.review_status ||
    input.reviewStatus ||
    input.approved != null
  ) {
    return [input];
  }

  const values = Object.values(input);
  if (values.length && values.every((item) => isPlainObject(item) || typeof item === 'string' || typeof item === 'boolean')) {
    const keyed = Object.entries(input)
      .filter(([key]) => !['generated_at', 'reviewed_at', 'reviewer', 'market'].includes(normalizeLower(key)))
      .map(([edgeId, value]) => ({
        edge_id: edgeId,
        ...(isPlainObject(value) ? value : { decision: value }),
      }));
    if (keyed.length) return keyed;
  }

  return [input];
}

function edgeIdentity(edge = {}) {
  return [
    normalizeLower(edge.market || 'US'),
    normalizeLower(edge.anchor_type || edge.anchorType || 'product'),
    normalizeLower(edge.anchor_ref || edge.anchorRef),
    normalizeLower(edge.candidate_product_ref || edge.candidateProductRef),
    normalizeLower(edge.relation_type || edge.relationType),
  ].join('|');
}

function decisionIdentity(decision = {}) {
  return [
    normalizeLower(decision.market || 'US'),
    normalizeLower(decision.anchor_type || decision.anchorType || 'product'),
    normalizeLower(decision.anchor_ref || decision.anchorRef),
    normalizeLower(decision.candidate_product_ref || decision.candidateProductRef),
    normalizeLower(decision.relation_type || decision.relationType),
  ].join('|');
}

function decisionId(decision = {}) {
  return normalizeString(
    decision.edge_id ||
      decision.edgeId ||
      decision.relationship_edge_id ||
      decision.relationshipEdgeId ||
      decision.id,
    160,
  );
}

function inferDecisionStatus(record = {}) {
  if (record.approved === true) return 'approved';
  if (record.approved === false) return 'rejected';
  const raw = normalizeLower(
    record.decision ||
      record.review_decision ||
      record.reviewDecision ||
      record.review_status ||
      record.reviewStatus ||
      record.status,
    80,
  );
  if (['approve', 'approved', 'accepted', 'accept', 'publish', 'published', 'yes', 'true'].includes(raw)) {
    return 'approved';
  }
  if (['reject', 'rejected', 'declined', 'deny', 'denied', 'no', 'false'].includes(raw)) {
    return 'rejected';
  }
  if (['skip', 'skipped', 'hold', 'held', 'needs_changes', 'needs-change', 'pending'].includes(raw)) {
    return raw;
  }
  return raw || 'unknown';
}

function normalizeDecisionRecord(input, index = 0) {
  const record = isPlainObject(input) ? input : { decision: input };
  const normalized = {
    ...record,
    edge_id: decisionId(record),
    decision: inferDecisionStatus(record),
    reviewer: normalizeString(record.reviewer || record.reviewed_by || record.reviewedBy || record.operator, 160),
    reviewed_at: toIsoOrNull(record.reviewed_at || record.reviewedAt || record.decided_at || record.decidedAt),
    last_verified_at: toIsoOrNull(record.last_verified_at || record.lastVerifiedAt || record.verified_at || record.verifiedAt),
    expires_at: toIsoOrNull(record.expires_at || record.expiresAt || record.review_expires_at || record.reviewExpiresAt),
    reason: normalizeString(record.reason || record.notes || record.comment || record.comments, 1000),
    source_index: index,
  };
  const identity = decisionIdentity(record);
  if (!normalized.edge_id && !identity.endsWith('|||')) normalized.identity = identity;
  return normalized;
}

function buildDecisionIndex(records) {
  const decisions = (Array.isArray(records) ? records : [])
    .map((record, index) => normalizeDecisionRecord(record, index))
    .filter((record) => record.edge_id || record.identity);
  const byEdgeId = new Map();
  const byIdentity = new Map();
  for (const decision of decisions) {
    if (decision.edge_id) byEdgeId.set(decision.edge_id, decision);
    if (decision.identity) byIdentity.set(decision.identity, decision);
  }
  return {
    decisions,
    byEdgeId,
    byIdentity,
    approvedCount: decisions.filter((decision) => decision.decision === 'approved').length,
    rejectedCount: decisions.filter((decision) => decision.decision !== 'approved').length,
  };
}

function findDecisionForEdge(edge, decisionIndex) {
  const id = normalizeString(edge && edge.id, 160);
  if (id && decisionIndex.byEdgeId.has(id)) return decisionIndex.byEdgeId.get(id);
  return decisionIndex.byIdentity.get(edgeIdentity(edge)) || null;
}

function stampApprovedEdge(edge, decision = {}, options = {}) {
  const nowIso = toIsoOrNull(options.now) || new Date().toISOString();
  const lastVerifiedAt = decision.last_verified_at || toIsoOrNull(edge.last_verified_at) || decision.reviewed_at || nowIso;
  const expiresAt = decision.expires_at || toIsoOrNull(edge.expires_at) || addDaysIso(lastVerifiedAt, options.expiryDays || DEFAULT_EXPIRY_DAYS);
  const next = cloneJson(edge) || {};
  next.review_status = 'approved';
  next.last_verified_at = lastVerifiedAt;
  next.expires_at = expiresAt;
  next.provenance = {
    ...(isPlainObject(next.provenance) ? next.provenance : {}),
    review_publish: {
      contract_version: REVIEW_PUBLISHER_VERSION,
      decision: 'approved',
      decision_edge_id: decision.edge_id || next.id || null,
      reviewer: decision.reviewer || null,
      reviewed_at: decision.reviewed_at || nowIso,
      last_verified_at: lastVerifiedAt,
      expires_at: expiresAt,
      reason: decision.reason || null,
      source_index: Number.isFinite(Number(decision.source_index)) ? Number(decision.source_index) : null,
    },
  };
  return next;
}

function buildPublishPlan(report, decisionRecords, options = {}) {
  const edges = Array.isArray(report && report.edges) ? report.edges : [];
  const decisionIndex = buildDecisionIndex(decisionRecords);
  const nowMs = new Date(toIsoOrNull(options.now) || new Date().toISOString()).getTime();
  const rows = [];

  for (const edge of edges) {
    const decision = findDecisionForEdge(edge, decisionIndex);
    if (!decision) {
      rows.push({
        status: 'skipped',
        reason: 'no_matching_decision',
        edge_id: normalizeString(edge && edge.id, 160),
        anchor_ref: normalizeString(edge && edge.anchor_ref, 260),
        candidate_product_ref: normalizeString(edge && edge.candidate_product_ref, 260),
        relation_type: normalizeString(edge && edge.relation_type, 80),
      });
      continue;
    }
    if (decision.decision !== 'approved') {
      rows.push({
        status: 'skipped',
        reason: `decision_${decision.decision || 'unknown'}`,
        edge_id: normalizeString(edge && edge.id, 160),
        decision,
        anchor_ref: normalizeString(edge && edge.anchor_ref, 260),
        candidate_product_ref: normalizeString(edge && edge.candidate_product_ref, 260),
        relation_type: normalizeString(edge && edge.relation_type, 80),
      });
      continue;
    }

    const approvedEdge = stampApprovedEdge(edge, decision, options);
    const validation = validateRelationshipEdge(approvedEdge, { nowMs });
    if (!validation.ok) {
      rows.push({
        status: 'invalid',
        reason: 'validation_failed',
        errors: validation.errors,
        edge_id: normalizeString(edge && edge.id, 160),
        decision,
        edge: approvedEdge,
      });
      continue;
    }

    rows.push({
      status: 'publishable',
      reason: 'approved',
      edge_id: validation.value.id,
      decision,
      edge: validation.value,
    });
  }

  const matchedDecisionKeys = new Set(
    rows
      .map((row) => row.decision)
      .filter(Boolean)
      .map((decision) => decision.edge_id || decision.identity)
      .filter(Boolean),
  );
  const unmatchedApprovedDecisions = decisionIndex.decisions
    .filter((decision) => decision.decision === 'approved')
    .filter((decision) => !matchedDecisionKeys.has(decision.edge_id || decision.identity))
    .map((decision) => decision.edge_id || decision.identity);

  const summary = {
    report_edges: edges.length,
    approved_decisions: decisionIndex.approvedCount,
    publishable: rows.filter((row) => row.status === 'publishable').length,
    published: 0,
    invalid: rows.filter((row) => row.status === 'invalid').length,
    skipped: rows.filter((row) => row.status === 'skipped').length,
    rejected_decisions: decisionIndex.rejectedCount,
    unmatched_approved_decisions: unmatchedApprovedDecisions.length,
  };

  return {
    summary,
    rows,
    unmatched_approved_decisions: unmatchedApprovedDecisions,
  };
}

async function publishReviewReport({
  report,
  decisions,
  apply = false,
  upsertFn = upsertRelationshipEdge,
  now = new Date(),
  expiryDays = DEFAULT_EXPIRY_DAYS,
} = {}) {
  const plan = buildPublishPlan(report, decisions, { now, expiryDays });
  const rows = plan.rows.map((row) => ({ ...row }));
  let published = 0;

  if (apply) {
    for (const row of rows) {
      if (row.status !== 'publishable') continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await upsertFn(row.edge, { nowMs: new Date(toIsoOrNull(now) || new Date().toISOString()).getTime() });
        row.status = 'published';
        row.reason = 'upserted';
        published += 1;
      } catch (error) {
        row.status = 'invalid';
        row.reason = 'upsert_failed';
        row.errors = Array.isArray(error && error.errors) ? error.errors : [normalizeString(error && error.message) || 'upsert_failed'];
      }
    }
  }

  return {
    generated_at: new Date(toIsoOrNull(now) || new Date().toISOString()).toISOString(),
    dry_run: !apply,
    summary: {
      ...plan.summary,
      publishable: rows.filter((row) => row.status === 'publishable' || row.status === 'published').length,
      published,
      invalid: rows.filter((row) => row.status === 'invalid').length,
      skipped: rows.filter((row) => row.status === 'skipped').length,
    },
    rows,
    unmatched_approved_decisions: plan.unmatched_approved_decisions,
  };
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const reportPath = resolvePathMaybeRelative(args.report);
  const decisionsPath = resolvePathMaybeRelative(args.decisions);
  if (!reportPath) throw new Error('--report is required');
  if (!decisionsPath) throw new Error('--decisions is required');

  const report = readJsonFile(reportPath);
  const decisions = readStructuredRecords(decisionsPath);
  const result = await publishReviewReport({
    report,
    decisions,
    apply: args.apply,
  });
  const output = {
    ...result,
    report: reportPath,
    decisions: decisionsPath,
  };

  const outPath = resolvePathMaybeRelative(args.out);
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(output.summary, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        // Lazy require keeps helper imports pure for tests that mock the graph store only.
        const { closePool } = require('../src/db');
        if (typeof closePool === 'function') await closePool();
      } catch {
        // Nothing to close in test or no-database contexts.
      }
      if (process.exitCode) process.exit(process.exitCode);
    });
}

module.exports = {
  DEFAULT_EXPIRY_DAYS,
  REVIEW_PUBLISHER_VERSION,
  buildDecisionIndex,
  buildPublishPlan,
  edgeIdentity,
  extractDecisionRecords,
  findDecisionForEdge,
  inferDecisionStatus,
  normalizeDecisionRecord,
  parseArgs,
  parseDecisionRecordsText,
  publishReviewReport,
  readStructuredRecords,
  resolvePathMaybeRelative,
  stampApprovedEdge,
};
