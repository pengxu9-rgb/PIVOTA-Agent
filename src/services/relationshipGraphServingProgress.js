const fs = require('node:fs');
const { query } = require('../db');
const { scanServingLabels, SERVING_SCAN_SQL } = require('./relationshipGraphServingScan');

async function readServingSnapshot({ market = 'US', queryFn = query } = {}) {
  const { servedEdges, anchors } = await scanServingLabels({ market, queryFn, collectAnchors: true });
  return { servedEdges, anchors };
}

function servingProgress(before, after) {
  return {
    served_edges_before: before.servedEdges,
    served_edges_after: after.servedEdges,
    distinct_anchors_served_before: before.anchors.size,
    distinct_anchors_served_after: after.anchors.size,
    anchors_newly_covered: [...after.anchors].filter((ref) => !before.anchors.has(ref)).length,
  };
}

function readReviewMetrics(filePath, { required = false } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    if (required) throw new Error('missing relationship review artifact');
    return reviewMetrics({});
  }
  const artifact = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return reviewMetrics(artifact.summary || artifact);
}

function reviewMetrics(summary = {}) {
  const reviewed = Number(summary.reviewed_count) || 0;
  const errors = Number(summary.review_error_count) || 0;
  const guardBlocked = Number(summary.guard_blocked_count) || 0;
  const lowConfidence = Number(summary.low_confidence_count) || 0;
  const denominator = Math.max(0, reviewed - guardBlocked - lowConfidence);
  return {
    reviewed_count: reviewed,
    review_error_denominator: denominator,
    low_confidence_count: lowConfidence,
    approved_count: Number(summary.approved_count) || 0,
    // Not provider-only: the review counts approvals refused at apply (approval_blocked_count, also
    // passed through below) as review errors, so they share this gate.
    review_error_count: errors,
    review_error_rate: denominator ? errors / denominator : 0,
    guard_blocked_count: guardBlocked,
    // Additive JSON metrics; preserve old artifact shape and eligible denominator.
    ...Object.fromEntries(['useful_approval_by_kind', 'semantic_rejected_count', 'variant_rejected_count',
      'candidate_brand_distribution', 'approved_brand_distribution', 'approved_cross_brand_count',
      // Approvals refused at apply (one row each, the run carries on): surfaced in the routine summary.
      'approval_blocked_count', 'approval_blocked_by_code']
      .filter((key) => summary[key] != null).map((key) => [key, summary[key]])),
  };
}

// A review approval that applyApproval refused with RECOMMENDATION_UTILITY means the validator
// disagreed with itself on a row: a log-based metric counts this message.
const REVALIDATION_MISMATCH_MARKER = 'RELGRAPH_REVIEW_REVALIDATION_MISMATCH';
const APPROVAL_BLOCKED_MARKER = 'RELGRAPH_REVIEW_APPROVAL_BLOCKED';

// One single-line JSON summary of the approvals the review refused at apply, or '' when there were
// none: counts by code and label ids (at most 20), nothing else.
function approvalBlockedRelayLine(metrics = {}, { runId = null, labelIds = [] } = {}) {
  const byCode = metrics && metrics.approval_blocked_by_code;
  if (!byCode || typeof byCode !== 'object' || !Object.keys(byCode).length) return '';
  const mismatch = Number(byCode.RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED) > 0;
  return `${JSON.stringify({
    severity: mismatch ? 'ERROR' : 'WARNING',
    message: mismatch ? REVALIDATION_MISMATCH_MARKER : APPROVAL_BLOCKED_MARKER,
    run_id: runId,
    approval_blocked_count: Number(metrics.approval_blocked_count) || 0,
    approval_blocked_by_code: byCode,
    label_ids: (Array.isArray(labelIds) ? labelIds : []).slice(0, 20),
  })}\n`;
}

function reviewErrorGateExceeded(metrics, { minReviewsForErrorGate = 20, maxReviewErrorRate = 0.25 } = {}) {
  return metrics.review_error_denominator >= minReviewsForErrorGate && metrics.review_error_rate > maxReviewErrorRate;
}

module.exports = { SERVING_PROGRESS_SQL: SERVING_SCAN_SQL, readServingSnapshot, servingProgress, readReviewMetrics, reviewMetrics, reviewErrorGateExceeded,
  REVALIDATION_MISMATCH_MARKER, APPROVAL_BLOCKED_MARKER, approvalBlockedRelayLine };
