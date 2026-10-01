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
    review_error_count: errors,
    review_error_rate: denominator ? errors / denominator : 0,
    guard_blocked_count: guardBlocked,
    // Additive JSON metrics; preserve old artifact shape and eligible denominator.
    ...Object.fromEntries(['useful_approval_by_kind', 'semantic_rejected_count', 'variant_rejected_count',
      'candidate_brand_distribution', 'approved_brand_distribution', 'approved_cross_brand_count']
      .filter((key) => summary[key] != null).map((key) => [key, summary[key]])),
  };
}

function reviewErrorGateExceeded(metrics, { minReviewsForErrorGate = 20, maxReviewErrorRate = 0.25 } = {}) {
  return metrics.review_error_denominator >= minReviewsForErrorGate && metrics.review_error_rate > maxReviewErrorRate;
}

module.exports = { SERVING_PROGRESS_SQL: SERVING_SCAN_SQL, readServingSnapshot, servingProgress, readReviewMetrics, reviewMetrics, reviewErrorGateExceeded };
