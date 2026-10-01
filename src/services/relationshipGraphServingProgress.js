const fs = require('node:fs');
const { query } = require('../db');
const { getRelationshipEdgeServingSuppressionReasons } = require('../auroraBff/productRelationshipGraph');

const SERVING_PROGRESS_SQL = `SELECT id, anchor_type, anchor_ref, anchor_snapshot,
  candidate_product_ref, candidate_snapshot, relation_type, label_state
  FROM relationship_candidate_labels
  WHERE vertical = 'beauty' AND label_state IN ('ai_approved', 'human_approved')
    AND last_verified_at IS NOT NULL AND expires_at > now() AND upper(market) = $1`;

async function readServingSnapshot({ market = 'US', queryFn = query } = {}) {
  const result = await queryFn(SERVING_PROGRESS_SQL, [market.toUpperCase()]);
  const anchors = new Set();
  let servedEdges = 0;
  for (const row of result.rows || []) {
    if (getRelationshipEdgeServingSuppressionReasons(row).length) continue;
    servedEdges += 1;
    anchors.add(`${row.anchor_type}:${row.anchor_ref.trim().toLowerCase()}`);
  }
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
  return {
    reviewed_count: reviewed,
    approved_count: Number(summary.approved_count) || 0,
    review_error_count: errors,
    review_error_rate: reviewed ? errors / reviewed : 0,
    guard_blocked_count: Number(summary.guard_blocked_count) || 0,
  };
}

function reviewErrorGateExceeded(metrics, { minReviewsForErrorGate = 20, maxReviewErrorRate = 0.25 } = {}) {
  return metrics.reviewed_count >= minReviewsForErrorGate && metrics.review_error_rate > maxReviewErrorRate;
}

module.exports = { SERVING_PROGRESS_SQL, readServingSnapshot, servingProgress, readReviewMetrics, reviewMetrics, reviewErrorGateExceeded };
