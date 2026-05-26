#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  edgeToCandidateLabel,
  normalizeLower,
  normalizeString,
  reviewStatusToLabelState,
  toIsoOrNull,
  upsertRelationshipCandidateLabel,
} = require('./backfill-relationship-candidate-labels');

const REVIEW_PUBLISHER_VERSION = 'product_relationship_graph.review_publish.v1';
const DEFAULT_EXPIRY_DAYS = 90;
const RELATION_TYPES = new Set(['dupe', 'competitive_alternative', 'niche_specialist', 'related_product']);
const ANCHOR_TYPES = new Set(['product', 'need']);

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

function cloneJson(value) {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
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
    input.edges,
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
    input.id ||
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
  if (['skip', 'skipped', 'hold', 'held', 'needs_changes', 'needs-change', 'needs_evidence', 'pending'].includes(raw)) {
    return 'pending';
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
    rejectedCount: decisions.filter((decision) => decision.decision === 'rejected').length,
    pendingCount: decisions.filter((decision) => decision.decision === 'pending').length,
  };
}

function findDecisionForEdge(edge, decisionIndex) {
  const id = normalizeString(edge && edge.id, 160);
  if (id && decisionIndex.byEdgeId.has(id)) return decisionIndex.byEdgeId.get(id);
  return decisionIndex.byIdentity.get(edgeIdentity(edge)) || null;
}

function stampDecisionEdge(edge, decision = {}, options = {}) {
  const nowIso = toIsoOrNull(options.now) || new Date().toISOString();
  const next = cloneJson(edge) || {};
  next.review_status = decision.decision === 'approved'
    ? 'approved'
    : decision.decision === 'rejected'
      ? 'rejected'
      : 'pending';

  if (decision.decision === 'approved') {
    const lastVerifiedAt = decision.last_verified_at || toIsoOrNull(edge.last_verified_at) || decision.reviewed_at || nowIso;
    const expiresAt = decision.expires_at || toIsoOrNull(edge.expires_at) || addDaysIso(lastVerifiedAt, options.expiryDays || DEFAULT_EXPIRY_DAYS);
    next.last_verified_at = lastVerifiedAt;
    next.expires_at = expiresAt;
  } else {
    next.last_verified_at = decision.last_verified_at || toIsoOrNull(edge.last_verified_at);
    next.expires_at = decision.expires_at || toIsoOrNull(edge.expires_at);
  }

  if (isPlainObject(decision.human_review || decision.humanReview) && !isPlainObject(next.human_review)) {
    next.human_review = decision.human_review || decision.humanReview;
  }
  next.provenance = {
    ...(isPlainObject(next.provenance) ? next.provenance : {}),
    review_publish: {
      contract_version: REVIEW_PUBLISHER_VERSION,
      decision: decision.decision,
      decision_edge_id: decision.edge_id || next.id || null,
      reviewer: decision.reviewer || null,
      reviewed_at: decision.reviewed_at || nowIso,
      last_verified_at: next.last_verified_at || null,
      expires_at: next.expires_at || null,
      reason: decision.reason || null,
      source_index: Number.isFinite(Number(decision.source_index)) ? Number(decision.source_index) : null,
    },
  };
  return next;
}

function stampApprovedEdge(edge, decision = {}, options = {}) {
  return stampDecisionEdge(edge, { ...decision, decision: 'approved' }, options);
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return toNumberOrNull(value.amount ?? value.value ?? value.price ?? value.min ?? value.sale_price);
  }
  const n = Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function pickFirstString(...values) {
  for (const value of values) {
    const text = normalizeString(value);
    if (text) return text;
  }
  return '';
}

function extractBrand(snapshot) {
  const obj = isPlainObject(snapshot) ? snapshot : {};
  return normalizeLower(
    pickFirstString(obj.brand_id, obj.brandId, obj.brand, obj.brand_name, obj.brandName, obj.vendor),
    200,
  );
}

function extractPrice(snapshot) {
  const obj = isPlainObject(snapshot) ? snapshot : {};
  return toNumberOrNull(obj.price ?? obj.price_amount ?? obj.priceAmount ?? obj.sale_price ?? obj.salePrice);
}

function getPriceRatio(edge) {
  const price = isPlainObject(edge.price_evidence) ? edge.price_evidence : {};
  const explicit = toNumberOrNull(price.price_ratio ?? price.priceRatio);
  if (explicit != null) return explicit;
  const anchorPrice = toNumberOrNull(price.anchor_price_amount ?? price.anchorPriceAmount ?? extractPrice(edge.anchor_snapshot));
  const candidatePrice = toNumberOrNull(
    price.candidate_price_amount ?? price.candidatePriceAmount ?? extractPrice(edge.candidate_snapshot),
  );
  if (anchorPrice == null || candidatePrice == null || anchorPrice <= 0) return null;
  return candidatePrice / anchorPrice;
}

function getCandidatePrice(edge) {
  const price = isPlainObject(edge.price_evidence) ? edge.price_evidence : {};
  return toNumberOrNull(price.candidate_price_amount ?? price.candidatePriceAmount ?? extractPrice(edge.candidate_snapshot));
}

function getPriceObservedAt(edge) {
  const price = isPlainObject(edge.price_evidence) ? edge.price_evidence : {};
  return toIsoOrNull(price.candidate_price_observed_at ?? price.candidatePriceObservedAt ?? price.observed_at ?? price.observedAt);
}

function validateApprovedRuntimeEdge(input = {}, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const edge = isPlainObject(input) ? input : {};
  const errors = [];
  const anchorType = normalizeLower(edge.anchor_type || edge.anchorType || 'product', 24);
  const relationType = normalizeLower(edge.relation_type || edge.relationType, 64);
  const sourceRefs = Array.isArray(edge.source_refs || edge.sourceRefs) ? (edge.source_refs || edge.sourceRefs) : [];
  const scoreTotal = toNumberOrNull(edge.score_total ?? edge.scoreTotal);
  const scoreBreakdown = isPlainObject(edge.score_breakdown || edge.scoreBreakdown)
    ? (edge.score_breakdown || edge.scoreBreakdown)
    : {};

  if (!normalizeString(edge.id, 128)) errors.push('missing_id');
  if (!ANCHOR_TYPES.has(anchorType)) errors.push('invalid_anchor_type');
  if (!normalizeString(edge.anchor_ref || edge.anchorRef, 260)) errors.push('missing_anchor_ref');
  if (!normalizeString(edge.candidate_product_ref || edge.candidateProductRef, 260)) errors.push('missing_candidate_product_ref');
  if (!RELATION_TYPES.has(relationType)) errors.push('invalid_relation_type');
  if (normalizeLower(edge.vertical || 'beauty', 32) !== 'beauty') errors.push('non_beauty_vertical');
  if (!sourceRefs.length) errors.push('missing_source_refs');
  if (scoreTotal == null || scoreTotal < 0 || scoreTotal > 1) errors.push('invalid_score_total');
  if (!toIsoOrNull(edge.last_verified_at || edge.lastVerifiedAt)) errors.push('approved_missing_last_verified_at');
  const expiresAt = toIsoOrNull(edge.expires_at || edge.expiresAt);
  if (!expiresAt) errors.push('approved_missing_expires_at');
  else if (new Date(expiresAt).getTime() <= nowMs) errors.push('approved_edge_expired');

  const anchorBrand = extractBrand(edge.anchor_snapshot || edge.anchorSnapshot);
  const candidateBrand = extractBrand(edge.candidate_snapshot || edge.candidateSnapshot);
  const sameBrand = Boolean(anchorBrand && candidateBrand && anchorBrand === candidateBrand);
  const categoryScore = toNumberOrNull(scoreBreakdown.category_use_case_match);
  if (relationType === 'dupe' || relationType === 'competitive_alternative') {
    if (!anchorBrand || !candidateBrand) errors.push(`${relationType}_brand_missing`);
    if (sameBrand) errors.push(`${relationType}_same_brand_blocked`);
    if (categoryScore == null) errors.push(`${relationType}_category_missing`);
    else if (categoryScore < 0.55) errors.push(`${relationType}_category_below_threshold`);
  }
  if (relationType === 'dupe') {
    const priceRatio = getPriceRatio(edge);
    if (scoreTotal == null || scoreTotal < 0.82) errors.push('dupe_similarity_below_threshold');
    if (getCandidatePrice(edge) == null) errors.push('dupe_candidate_price_missing');
    if (priceRatio == null) errors.push('dupe_price_ratio_missing');
    else if (priceRatio > 1.0) errors.push('dupe_price_ratio_above_threshold');
    if (!getPriceObservedAt(edge)) errors.push('dupe_price_observed_at_missing');
  }

  return {
    ok: errors.length === 0,
    errors,
    value: edge,
  };
}

function buildPublishPlan(report, decisionRecords, options = {}) {
  const edges = Array.isArray(report && report.edges) ? report.edges : [];
  const decisionIndex = buildDecisionIndex(decisionRecords);
  const nowMs = new Date(toIsoOrNull(options.now) || new Date().toISOString()).getTime();
  const rows = [];
  const seenIds = new Map();

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

    const labelState = reviewStatusToLabelState(decision.decision);
    if (!labelState) {
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

    const stampedEdge = stampDecisionEdge(edge, decision, options);
    if (decision.decision === 'approved') {
      const validation = validateApprovedRuntimeEdge(stampedEdge, { nowMs });
      if (!validation.ok) {
        rows.push({
          status: 'invalid',
          reason: 'validation_failed',
          errors: validation.errors,
          edge_id: normalizeString(edge && edge.id, 160),
          decision,
          edge: stampedEdge,
        });
        continue;
      }
    }

    const labelResult = edgeToCandidateLabel(stampedEdge, {
      sourceReport: options.sourceReport,
      fallbackReviewedAt: decision.reviewed_at || options.now,
      seenIds,
    });
    if (!labelResult.ok) {
      rows.push({
        status: 'invalid',
        reason: labelResult.reason,
        edge_id: normalizeString(edge && edge.id, 160),
        decision,
        edge: stampedEdge,
      });
      continue;
    }

    rows.push({
      status: 'publishable',
      reason: labelState,
      edge_id: labelResult.value.edge_id,
      decision,
      edge: decision.decision === 'approved' ? stampedEdge : undefined,
      label: labelResult.value,
      anchor_ref: labelResult.value.anchor_ref,
      candidate_product_ref: labelResult.value.candidate_product_ref,
      relation_type: labelResult.value.relation_type,
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
    rejected_decisions: decisionIndex.rejectedCount,
    pending_decisions: decisionIndex.pendingCount,
    publishable: rows.filter((row) => row.status === 'publishable').length,
    published: 0,
    invalid: rows.filter((row) => row.status === 'invalid').length,
    skipped: rows.filter((row) => row.status === 'skipped').length,
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
  upsertFn = upsertRelationshipCandidateLabel,
  now = new Date(),
  expiryDays = DEFAULT_EXPIRY_DAYS,
  sourceReport = '',
} = {}) {
  const plan = buildPublishPlan(report, decisions, { now, expiryDays, sourceReport });
  const rows = plan.rows.map((row) => ({ ...row }));
  let published = 0;

  if (apply) {
    for (const row of rows) {
      if (row.status !== 'publishable') continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await upsertFn(row.label, { nowMs: new Date(toIsoOrNull(now) || new Date().toISOString()).getTime() });
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
    sourceReport: path.basename(reportPath),
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
  stampDecisionEdge,
  validateApprovedRuntimeEdge,
};
