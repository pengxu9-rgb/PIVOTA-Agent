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
  // The review reports its own denominator (fresh reviews only: without guard-blocked, low-confidence
  // and quarantine-retry rows); older artifacts did not, and are recomputed as before.
  const reported = Number(summary.review_error_denominator);
  const denominator = Number.isFinite(reported) && summary.review_error_denominator != null
    ? Math.max(0, reported) : Math.max(0, reviewed - guardBlocked - lowConfidence);
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
      'error_quarantine_skipped_count', 'error_quarantine_entered_count', 'error_quarantine_retried_count',
      'error_quarantine_retry_error_count']
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

// Rows the error quarantine held back from the night's error rate: skipped inside their window, or
// reviewed again after it (a known-bad row's retry re-quarantines it or clears it; it is not a fresh
// error, or a stable residue would trip the rate every time its window ends together).
function reviewQuarantineHeld(metrics = {}) {
  return (Number(metrics.error_quarantine_skipped_count) || 0) + (Number(metrics.error_quarantine_retried_count) || 0);
}

// The review gate. Two ways to fail:
// - the error rate of the fresh reviews is above maxReviewErrorRate (after minReviewsForErrorGate);
// - NOTHING FRESH TO MEASURE: at least minReviewsForErrorGate rows were held back by the quarantine
//   and fewer than minReviewsForErrorGate fresh reviews ran. A model that fails every row quarantines
//   the queue by night 2; from night 3 the rate has nothing to measure and this trips instead (2026-11-02
//   review of the quarantine). A stable residue beside enough fresh reviews passes, however large it is.
//   Known cost: a healthy LOW-VOLUME night (fewer than the minimum fresh reviews) beside a residue of at
//   least the minimum also trips; that is deliberate, as the two cannot be told apart from one night.
function reviewErrorGateExceeded(metrics, { minReviewsForErrorGate = 20, maxReviewErrorRate = 0.25 } = {}) {
  const rateExceeded = metrics.review_error_denominator >= minReviewsForErrorGate && metrics.review_error_rate > maxReviewErrorRate;
  const nothingFresh = reviewQuarantineHeld(metrics) >= minReviewsForErrorGate && metrics.review_error_denominator < minReviewsForErrorGate;
  return rateExceeded || nothingFresh;
}

// The gate's failure line: what tripped it, and how many rows the error quarantine held back.
function reviewGateFailureLine(metrics = {}, { minReviewsForErrorGate = 20, maxReviewErrorRate = 0.25 } = {}) {
  const parts = [];
  if (metrics.review_error_denominator >= minReviewsForErrorGate && metrics.review_error_rate > maxReviewErrorRate) {
    parts.push(`review error rate ${metrics.review_error_rate} exceeds ${maxReviewErrorRate}`);
  }
  const skipped = Number(metrics.error_quarantine_skipped_count) || 0;
  const retried = Number(metrics.error_quarantine_retried_count) || 0;
  const held = skipped + retried;
  if (held >= minReviewsForErrorGate && metrics.review_error_denominator < minReviewsForErrorGate) {
    parts.push(`nothing fresh to measure: ${metrics.review_error_denominator} fresh reviews, ${held} held back by the error quarantine (${skipped} skipped, ${retried} retried)`);
  } else if (held > 0) {
    parts.push(`error quarantine held back ${held} (${skipped} skipped, ${retried} retried)`);
  }
  return parts.join('; ');
}

module.exports = { SERVING_PROGRESS_SQL: SERVING_SCAN_SQL, readServingSnapshot, servingProgress, readReviewMetrics, reviewMetrics, reviewErrorGateExceeded,
  reviewQuarantineHeld, reviewGateFailureLine,
  REVALIDATION_MISMATCH_MARKER, APPROVAL_BLOCKED_MARKER, approvalBlockedRelayLine,
  REVIEW_ERRORS_MARKER, reviewErrorCodeKey, reviewErrorRelayLine };
