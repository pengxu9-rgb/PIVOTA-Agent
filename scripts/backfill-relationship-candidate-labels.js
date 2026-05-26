#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');

const DEFAULT_REPORTS_DIR = path.join('reports', 'product_relationship_graph');
const REPORT_SUFFIX = '_consensus_publish_ready_report.json';
const RELATION_TYPES = new Set(['dupe', 'competitive_alternative', 'niche_specialist', 'related_product']);
const ANCHOR_TYPES = new Set(['product', 'need']);
const LABEL_STATES = ['human_approved', 'human_rejected', 'needs_evidence'];

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

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function jsonbParam(value) {
  if (value == null) return null;
  return JSON.stringify(value);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function hashText(value, size = 24) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, size);
}

function reviewStatusToLabelState(status) {
  const normalized = normalizeLower(status, 80);
  if (normalized === 'approved') return 'human_approved';
  if (normalized === 'rejected') return 'human_rejected';
  if (normalized === 'pending') return 'needs_evidence';
  return '';
}

function hasHumanReview(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function extractReasonFlags(humanReview) {
  if (!hasHumanReview(humanReview)) return [];
  const reviewerDecisions = humanReview.reviewer_decisions || humanReview.reviewerDecisions;
  const decisions = Array.isArray(reviewerDecisions)
    ? reviewerDecisions
    : isPlainObject(reviewerDecisions)
      ? Object.values(reviewerDecisions)
      : [];
  const flags = new Set();
  for (const decision of decisions) {
    if (!isPlainObject(decision)) continue;
    const rawFlags = Array.isArray(decision.flags) ? decision.flags : [];
    for (const raw of rawFlags) {
      const flag = normalizeLower(raw, 160);
      if (flag) flags.add(flag);
    }
  }
  return Array.from(flags).sort();
}

function labelIdentity(edge = {}) {
  return [
    normalizeString(edge.market || 'US', 24).toUpperCase(),
    normalizeLower(edge.anchor_type || edge.anchorType || 'product', 24),
    normalizeLower(edge.anchor_ref || edge.anchorRef, 260),
    normalizeLower(edge.candidate_product_ref || edge.candidateProductRef, 260),
    normalizeLower(edge.relation_type || edge.relationType, 64),
  ].join('|');
}

function reserveLabelId(originalId, identity, sourceReport, seenIds) {
  const base =
    normalizeString(originalId, 128) ||
    `rcl_${hashText(`${identity}|${sourceReport || ''}`, 24)}`;
  const priorIdentity = seenIds.get(base);
  if (!priorIdentity || priorIdentity === identity) {
    seenIds.set(base, identity);
    return base;
  }

  let id = `${base}_rcl_${hashText(`${identity}|${sourceReport || ''}`, 10)}`;
  while (seenIds.has(id) && seenIds.get(id) !== identity) {
    id = `${base}_rcl_${hashText(`${identity}|${sourceReport || ''}|${id}`, 10)}`;
  }
  seenIds.set(id, identity);
  return id;
}

function edgeToCandidateLabel(edge, options = {}) {
  const src = isPlainObject(edge) ? edge : {};
  const labelState = reviewStatusToLabelState(src.review_status || src.reviewStatus);
  if (!labelState) {
    return {
      ok: false,
      reason: `unknown_review_status:${normalizeString(src.review_status || src.reviewStatus, 80) || 'missing'}`,
    };
  }

  const anchorType = normalizeLower(src.anchor_type || src.anchorType || 'product', 24);
  const relationType = normalizeLower(src.relation_type || src.relationType, 64);
  const anchorRef = normalizeString(src.anchor_ref || src.anchorRef, 260);
  const candidateProductRef = normalizeString(
    src.candidate_product_ref || src.candidateProductRef,
    260,
  );
  if (!ANCHOR_TYPES.has(anchorType)) return { ok: false, reason: 'invalid_anchor_type' };
  if (!RELATION_TYPES.has(relationType)) return { ok: false, reason: 'invalid_relation_type' };
  if (!anchorRef) return { ok: false, reason: 'missing_anchor_ref' };
  if (!candidateProductRef) return { ok: false, reason: 'missing_candidate_product_ref' };

  const market = normalizeString(src.market || 'US', 24).toUpperCase() || 'US';
  const vertical = normalizeLower(src.vertical || 'beauty', 32) || 'beauty';
  if (vertical !== 'beauty') return { ok: false, reason: 'non_beauty_vertical' };

  const sourceReport = normalizeString(options.sourceReport, 260);
  const identity = labelIdentity({
    market,
    anchor_type: anchorType,
    anchor_ref: anchorRef,
    candidate_product_ref: candidateProductRef,
    relation_type: relationType,
  });
  const humanReview = hasHumanReview(src.human_review || src.humanReview)
    ? (src.human_review || src.humanReview)
    : null;
  const scoreTotal = Number(src.score_total ?? src.scoreTotal);
  const reviewedAt =
    toIsoOrNull(humanReview && humanReview.consensus_timestamp) ||
    toIsoOrNull(options.fallbackReviewedAt) ||
    toIsoOrNull(options.fileMtime) ||
    null;

  return {
    ok: true,
    value: {
      id: reserveLabelId(src.id, identity, sourceReport, options.seenIds || new Map()),
      edge_id: normalizeString(src.id, 128) || null,
      anchor_type: anchorType,
      anchor_ref: anchorRef,
      anchor_snapshot: isPlainObject(src.anchor_snapshot || src.anchorSnapshot)
        ? (src.anchor_snapshot || src.anchorSnapshot)
        : {},
      candidate_product_ref: candidateProductRef,
      candidate_snapshot: isPlainObject(src.candidate_snapshot || src.candidateSnapshot)
        ? (src.candidate_snapshot || src.candidateSnapshot)
        : {},
      relation_type: relationType,
      display_label: normalizeString(src.display_label || src.displayLabel, 120) || null,
      market,
      vertical,
      category_taxonomy: src.category_taxonomy || src.categoryTaxonomy || [],
      use_case: normalizeString(src.use_case || src.useCase, 240) || null,
      label_state: labelState,
      score_total: Number.isFinite(scoreTotal) ? scoreTotal : null,
      score_breakdown: isPlainObject(src.score_breakdown || src.scoreBreakdown)
        ? (src.score_breakdown || src.scoreBreakdown)
        : null,
      price_evidence: isPlainObject(src.price_evidence || src.priceEvidence)
        ? (src.price_evidence || src.priceEvidence)
        : null,
      source_refs: Array.isArray(src.source_refs || src.sourceRefs) ? (src.source_refs || src.sourceRefs) : [],
      evidence_grade: normalizeString(src.evidence_grade || src.evidenceGrade, 16) || null,
      why_candidate: src.why_candidate || src.whyCandidate || null,
      tradeoffs: src.tradeoffs || null,
      watchouts: src.watchouts || null,
      human_review: humanReview,
      reason_flags: extractReasonFlags(humanReview),
      source_report: sourceReport || null,
      provenance: isPlainObject(src.provenance) ? src.provenance : null,
      reviewed_at: reviewedAt,
      last_verified_at: toIsoOrNull(src.last_verified_at || src.lastVerifiedAt),
      expires_at: toIsoOrNull(src.expires_at || src.expiresAt),
      created_at: toIsoOrNull(src.created_at || src.createdAt),
      updated_at: toIsoOrNull(src.updated_at || src.updatedAt),
    },
  };
}

function summarizeLabels(labels, skippedByReason = {}) {
  const stateCounts = Object.fromEntries(LABEL_STATES.map((state) => [state, 0]));
  let humanReviewRows = 0;
  let noHumanReviewRows = 0;
  for (const label of labels) {
    if (stateCounts[label.label_state] == null) stateCounts[label.label_state] = 0;
    stateCounts[label.label_state] += 1;
    if (label.human_review) humanReviewRows += 1;
    else noHumanReviewRows += 1;
  }
  return {
    rows_planned: labels.length,
    state_counts: stateCounts,
    human_review_rows: humanReviewRows,
    no_human_review_rows: noHumanReviewRows,
    skipped_by_reason: { ...skippedByReason },
  };
}

function listReportFiles(reportsDir) {
  const resolved = path.resolve(reportsDir || DEFAULT_REPORTS_DIR);
  return fs
    .readdirSync(resolved)
    .filter((name) => name.endsWith(REPORT_SUFFIX))
    .sort()
    .map((name) => path.join(resolved, name));
}

function loadLabelsFromReports({ reportsDir = DEFAULT_REPORTS_DIR } = {}) {
  const files = listReportFiles(reportsDir);
  const seenIds = new Map();
  const labels = [];
  const skippedByReason = {};
  let rowsSeen = 0;

  for (const filePath of files) {
    const report = readJsonFile(filePath);
    const edges = Array.isArray(report && report.edges) ? report.edges : [];
    const stat = fs.statSync(filePath);
    const sourceReport = path.basename(filePath);
    for (const edge of edges) {
      rowsSeen += 1;
      const result = edgeToCandidateLabel(edge, {
        sourceReport,
        fileMtime: stat.mtime,
        seenIds,
      });
      if (!result.ok) {
        skippedByReason[result.reason] = (skippedByReason[result.reason] || 0) + 1;
        continue;
      }
      labels.push(result.value);
    }
  }

  return {
    files,
    labels,
    summary: {
      source_files: files.length,
      rows_seen: rowsSeen,
      rows_skipped: Object.values(skippedByReason).reduce((sum, count) => sum + count, 0),
      ...summarizeLabels(labels, skippedByReason),
    },
  };
}

function relationshipCandidateLabelParams(label) {
  return [
    label.id,
    label.edge_id,
    label.anchor_type,
    label.anchor_ref,
    jsonbParam(label.anchor_snapshot || {}),
    label.candidate_product_ref,
    jsonbParam(label.candidate_snapshot || {}),
    label.relation_type,
    label.display_label,
    label.market,
    label.vertical,
    jsonbParam(label.category_taxonomy || []),
    label.use_case,
    label.label_state,
    label.score_total,
    jsonbParam(label.score_breakdown),
    jsonbParam(label.price_evidence),
    jsonbParam(label.source_refs || []),
    label.evidence_grade,
    jsonbParam(label.why_candidate),
    jsonbParam(label.tradeoffs),
    jsonbParam(label.watchouts),
    jsonbParam(label.human_review),
    label.reason_flags || [],
    label.source_report,
    jsonbParam(label.provenance),
    label.reviewed_at,
    label.last_verified_at,
    label.expires_at,
    label.created_at,
    label.updated_at,
  ];
}

async function upsertRelationshipCandidateLabel(label, { queryFn = query } = {}) {
  const res = await queryFn(
    `
      INSERT INTO relationship_candidate_labels (
        id, edge_id, anchor_type, anchor_ref, anchor_snapshot,
        candidate_product_ref, candidate_snapshot, relation_type,
        display_label, market, vertical, category_taxonomy, use_case,
        label_state, score_total, score_breakdown, price_evidence,
        source_refs, evidence_grade, why_candidate, tradeoffs, watchouts,
        human_review, reason_flags, source_report, provenance,
        reviewed_at, last_verified_at, expires_at, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5::jsonb,
        $6, $7::jsonb, $8,
        $9, $10, $11, $12::jsonb, $13,
        $14, $15, $16::jsonb, $17::jsonb,
        $18::jsonb, $19, $20::jsonb, $21::jsonb, $22::jsonb,
        $23::jsonb, $24::text[], $25, $26::jsonb,
        $27::timestamptz, $28::timestamptz, $29::timestamptz,
        COALESCE($30::timestamptz, now()), COALESCE($31::timestamptz, now())
      )
      ON CONFLICT (market, anchor_type, (lower(anchor_ref)), (lower(candidate_product_ref)), relation_type)
      DO UPDATE SET
        id = EXCLUDED.id,
        edge_id = EXCLUDED.edge_id,
        anchor_snapshot = EXCLUDED.anchor_snapshot,
        candidate_snapshot = EXCLUDED.candidate_snapshot,
        display_label = EXCLUDED.display_label,
        vertical = EXCLUDED.vertical,
        category_taxonomy = EXCLUDED.category_taxonomy,
        use_case = EXCLUDED.use_case,
        label_state = EXCLUDED.label_state,
        score_total = EXCLUDED.score_total,
        score_breakdown = EXCLUDED.score_breakdown,
        price_evidence = EXCLUDED.price_evidence,
        source_refs = EXCLUDED.source_refs,
        evidence_grade = EXCLUDED.evidence_grade,
        why_candidate = EXCLUDED.why_candidate,
        tradeoffs = EXCLUDED.tradeoffs,
        watchouts = EXCLUDED.watchouts,
        human_review = EXCLUDED.human_review,
        reason_flags = EXCLUDED.reason_flags,
        source_report = EXCLUDED.source_report,
        provenance = EXCLUDED.provenance,
        reviewed_at = EXCLUDED.reviewed_at,
        last_verified_at = EXCLUDED.last_verified_at,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
      RETURNING (xmax = 0) AS inserted, label_state
    `,
    relationshipCandidateLabelParams(label),
  );
  return res && res.rows && res.rows[0] ? res.rows[0] : { inserted: false };
}

async function fetchFinalLabelCounts({ queryFn = query } = {}) {
  const stateRes = await queryFn(
    `
      SELECT label_state, COUNT(*)::int AS count
      FROM relationship_candidate_labels
      GROUP BY label_state
      ORDER BY label_state
    `,
  );
  const humanRes = await queryFn(
    `
      SELECT
        COUNT(*) FILTER (WHERE human_review IS NOT NULL)::int AS human_review_rows,
        COUNT(*) FILTER (WHERE human_review IS NULL)::int AS no_human_review_rows
      FROM relationship_candidate_labels
    `,
  );
  const stateCounts = Object.fromEntries(LABEL_STATES.map((state) => [state, 0]));
  for (const row of stateRes.rows || []) {
    stateCounts[row.label_state] = Number(row.count) || 0;
  }
  const human = humanRes.rows && humanRes.rows[0] ? humanRes.rows[0] : {};
  return {
    state_counts: stateCounts,
    human_review_rows: Number(human.human_review_rows) || 0,
    no_human_review_rows: Number(human.no_human_review_rows) || 0,
  };
}

async function applyCandidateLabels(labels, { queryFn = query } = {}) {
  let inserted = 0;
  let updated = 0;
  for (const label of labels) {
    // eslint-disable-next-line no-await-in-loop
    const result = await upsertRelationshipCandidateLabel(label, { queryFn });
    if (result.inserted === true || result.inserted === 't' || result.inserted === 1) inserted += 1;
    else updated += 1;
  }
  const finalCounts = await fetchFinalLabelCounts({ queryFn });
  return {
    rows_inserted: inserted,
    rows_updated: updated,
    final_state_counts: finalCounts.state_counts,
    final_human_review_rows: finalCounts.human_review_rows,
    final_no_human_review_rows: finalCounts.no_human_review_rows,
  };
}

function parseArgs(argv = process.argv) {
  const args = {
    reportsDir: DEFAULT_REPORTS_DIR,
    dryRun: false,
    apply: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--reports-dir') {
      args.reportsDir = argv[i + 1] || '';
      i += 1;
    }
  }
  return args;
}

async function runBackfill(options = {}) {
  const loaded = loadLabelsFromReports({ reportsDir: options.reportsDir || DEFAULT_REPORTS_DIR });
  const baseSummary = {
    ...loaded.summary,
    mode: options.apply ? 'apply' : 'dry-run',
    rows_inserted: 0,
    rows_updated: 0,
    final_state_counts: loaded.summary.state_counts,
    final_human_review_rows: loaded.summary.human_review_rows,
    final_no_human_review_rows: loaded.summary.no_human_review_rows,
  };
  if (!options.apply) {
    return {
      ...loaded,
      summary: baseSummary,
    };
  }

  const applied = await applyCandidateLabels(loaded.labels, { queryFn: options.queryFn || query });
  return {
    ...loaded,
    summary: {
      ...baseSummary,
      ...applied,
    },
  };
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.dryRun === args.apply) {
    throw new Error('Pass exactly one of --dry-run or --apply');
  }
  const result = await runBackfill({
    reportsDir: args.reportsDir,
    apply: args.apply,
  });
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
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
  DEFAULT_REPORTS_DIR,
  REPORT_SUFFIX,
  applyCandidateLabels,
  edgeToCandidateLabel,
  extractReasonFlags,
  fetchFinalLabelCounts,
  hasHumanReview,
  labelIdentity,
  listReportFiles,
  loadLabelsFromReports,
  normalizeLower,
  normalizeString,
  parseArgs,
  relationshipCandidateLabelParams,
  reviewStatusToLabelState,
  runBackfill,
  toIsoOrNull,
  upsertRelationshipCandidateLabel,
};
