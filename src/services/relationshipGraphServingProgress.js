const fs = require('node:fs');
const { query } = require('../db');
const { scanServingLabels, SERVING_SCAN_SQL } = require('./relationshipGraphServingScan');
const { truncateText, wellFormedText } = require('../auroraBff/relationshipSafeText');

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
      'approval_blocked_count', 'approval_blocked_by_code',
      // Why reviews errored (2026-11-02): without it the routine summary had only a count. Counts by
      // code only; sample messages can quote model output and stay in the review's own log summary.
      'review_error_by_code',
      // Rows quarantined for repeated review errors (2026-11-02): skipped, so not in the error rate.
      'error_quarantine_skipped_count', 'error_quarantine_entered_count']
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

// A review error code as it may be counted or stored: an upper-case identifier, or OTHER. Provider and
// API errors can carry arbitrary text in .code; nothing but a known shape reaches a summary or the ledger.
function reviewErrorCodeKey(code) {
  const text = typeof code === 'string' ? code.trim() : '';
  return /^[A-Z0-9_]{1,80}$/.test(text) ? text : 'OTHER';
}

const REVIEW_ERRORS_MARKER = 'RELGRAPH_REVIEW_ERRORS';
const REVIEW_ERROR_SAMPLE_LIMIT = 8;
const REVIEW_ERROR_SAMPLE_CHARS = 240;

// One single-line JSON account of why reviews errored, read from the review's own --out file, or ''
// when none did: counts by code and up to 8 distinct (code, message) samples, each message cut to 240
// characters. The messages can quote model output, so this line goes to the sync routine's stderr
// (the job's logs) and never into a summary or the run ledger.
function reviewErrorRelayLine(decisions = [], { runId = null } = {}) {
  const rows = (Array.isArray(decisions) ? decisions : []).filter((row) => row && row.review_error);
  if (!rows.length) return '';
  const byCode = {};
  const samples = [];
  for (const row of rows) {
    const code = reviewErrorCodeKey(row.review_error.code);
    byCode[code] = (byCode[code] || 0) + 1;
    const raw = typeof row.review_error.message === 'string' ? row.review_error.message.replace(/\s+/g, ' ').trim() : '';
    // The provider quotes model output with its own code-unit slice, which can leave a lone half.
    const message = truncateText(wellFormedText(raw), REVIEW_ERROR_SAMPLE_CHARS);
    if (samples.length < REVIEW_ERROR_SAMPLE_LIMIT && !samples.some((s) => s.code === code && s.message === message)) {
      samples.push({ code, message, label_id: truncateText(String(row.id || ''), 160) });
    }
  }
  return `${JSON.stringify({ severity: 'WARNING', message: REVIEW_ERRORS_MARKER, run_id: runId,
    review_error_count: rows.length, review_error_by_code: byCode, samples })}\n`;
}

// The share of the night's selected work that sat in error quarantine instead of being reviewed.
function reviewQuarantineShare(metrics = {}) {
  const skipped = Number(metrics.error_quarantine_skipped_count) || 0;
  const reviewed = Number(metrics.reviewed_count) || 0;
  return skipped + reviewed > 0 ? skipped / (skipped + reviewed) : 0;
}

// The review gate. Two ways to fail:
// - the error rate of the reviews that ran is above maxReviewErrorRate (after minReviewsForErrorGate);
// - the error quarantine holds at least minReviewsForErrorGate rows AND more than
//   maxReviewQuarantineShare of the night's selected work. Without this a model that fails every row
//   would quarantine the whole queue by night 2 and pass from night 3 on 0 reviews (2026-11-02
//   review of the quarantine). A stable residue beside a normal night's reviews stays under it.
function reviewErrorGateExceeded(metrics, { minReviewsForErrorGate = 20, maxReviewErrorRate = 0.25, maxReviewQuarantineShare = 0.5 } = {}) {
  const rateExceeded = metrics.review_error_denominator >= minReviewsForErrorGate && metrics.review_error_rate > maxReviewErrorRate;
  const skipped = Number(metrics.error_quarantine_skipped_count) || 0;
  const quarantineExceeded = skipped >= minReviewsForErrorGate && reviewQuarantineShare(metrics) > maxReviewQuarantineShare;
  return rateExceeded || quarantineExceeded;
}

// The gate's failure line: what tripped it, and how many rows the error quarantine skipped.
function reviewGateFailureLine(metrics = {}, { minReviewsForErrorGate = 20, maxReviewErrorRate = 0.25, maxReviewQuarantineShare = 0.5 } = {}) {
  const parts = [];
  if (metrics.review_error_denominator >= minReviewsForErrorGate && metrics.review_error_rate > maxReviewErrorRate) {
    parts.push(`review error rate ${metrics.review_error_rate} exceeds ${maxReviewErrorRate}`);
  }
  const skipped = Number(metrics.error_quarantine_skipped_count) || 0;
  const share = reviewQuarantineShare(metrics);
  if (skipped >= minReviewsForErrorGate && share > maxReviewQuarantineShare) {
    parts.push(`error-quarantined share ${Number(share.toFixed(4))} exceeds ${maxReviewQuarantineShare} (${skipped} skipped, ${Number(metrics.reviewed_count) || 0} reviewed)`);
  } else if (skipped > 0) {
    parts.push(`error-quarantined rows skipped ${skipped}`);
  }
  return parts.join('; ');
}

module.exports = { SERVING_PROGRESS_SQL: SERVING_SCAN_SQL, readServingSnapshot, servingProgress, readReviewMetrics, reviewMetrics, reviewErrorGateExceeded,
  reviewQuarantineShare, reviewGateFailureLine,
  REVALIDATION_MISMATCH_MARKER, APPROVAL_BLOCKED_MARKER, approvalBlockedRelayLine,
  REVIEW_ERRORS_MARKER, reviewErrorCodeKey, reviewErrorRelayLine };
