const PRODUCT_INTEL_REVIEW_CONTRACT_VERSION = 'pivota.product_intel.review.v1';

const APPROVED_REVIEW_DECISIONS = new Set([
  'pass',
  'rewrite',
  'reject_external',
  'seller_only_fallback',
]);

const REVIEW_MODES = new Set(['strict_human', 'reviewed', 'any_kb']);

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function normalizeReviewMode(value) {
  const normalized = asString(value).toLowerCase();
  if (REVIEW_MODES.has(normalized)) return normalized;
  return 'strict_human';
}

function normalizeReviewStatus(value) {
  const normalized = asString(value).toLowerCase();
  if (!normalized) return '';
  if (normalized === 'reviewed' || normalized === 'complete' || normalized === 'completed') {
    return 'completed';
  }
  if (normalized === 'pending' || normalized === 'queued' || normalized === 'todo') {
    return 'pending';
  }
  return normalized;
}

function normalizeReviewDecision(value) {
  const normalized = asString(value).toLowerCase().replace(/\s+/g, '_');
  if (normalized === 'approved' || normalized === 'approve') return 'pass';
  return normalized;
}

function normalizeReviewerKind(value, reviewer = '') {
  const normalized = asString(value).toLowerCase();
  if (normalized === 'ai' || normalized === 'bot' || normalized === 'automation') {
    return 'assistant';
  }
  if (normalized === 'human' || normalized === 'assistant' || normalized === 'system') {
    return normalized;
  }

  const reviewerName = asString(reviewer).toLowerCase();
  if (!reviewerName) return '';
  if (/^(system|automation|cron|script|pipeline)$/.test(reviewerName)) return 'system';
  if (/(codex|chatgpt|gpt-?\d*|gemini|claude|assistant|bot|llm|openai|anthropic|google ai|model)/.test(reviewerName)) {
    return 'assistant';
  }
  return 'human';
}

function normalizeTimestamp(value) {
  const text = asString(value);
  if (!text) return '';
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function isApprovedReviewDecision(value) {
  return APPROVED_REVIEW_DECISIONS.has(normalizeReviewDecision(value));
}

function deriveReviewTier({
  reviewStatus = '',
  reviewDecision = '',
  reviewer = '',
  reviewerKind = '',
  legacyReviewStatus = '',
} = {}) {
  const normalizedStatus = normalizeReviewStatus(reviewStatus);
  const normalizedDecision = normalizeReviewDecision(reviewDecision);
  const normalizedReviewer = asString(reviewer);
  const normalizedReviewerKind = normalizeReviewerKind(reviewerKind, normalizedReviewer);
  const normalizedLegacyStatus = normalizeReviewDecision(legacyReviewStatus);

  if (normalizedStatus === 'completed' && isApprovedReviewDecision(normalizedDecision)) {
    if (normalizedReviewer && normalizedReviewerKind === 'human') return 'strict_human';
    return 'assistant_reviewed';
  }
  if (isApprovedReviewDecision(normalizedLegacyStatus)) return 'legacy_reviewed';
  return 'unreviewed';
}

function buildReviewContract({
  reviewStatus = '',
  reviewDecision = '',
  reviewer = '',
  reviewerKind = '',
  reviewedAt = '',
  legacyReviewStatus = '',
} = {}) {
  const normalizedStatus = normalizeReviewStatus(reviewStatus);
  const normalizedDecision = normalizeReviewDecision(reviewDecision);
  const normalizedReviewer = asString(reviewer);
  const normalizedReviewerKind = normalizeReviewerKind(reviewerKind, normalizedReviewer);
  const normalizedReviewedAt = normalizeTimestamp(reviewedAt);
  const normalizedLegacyStatus = normalizeReviewDecision(legacyReviewStatus);
  const reviewTier = deriveReviewTier({
    reviewStatus: normalizedStatus,
    reviewDecision: normalizedDecision,
    reviewer: normalizedReviewer,
    reviewerKind: normalizedReviewerKind,
    legacyReviewStatus: normalizedLegacyStatus,
  });

  return {
    review_contract_version: PRODUCT_INTEL_REVIEW_CONTRACT_VERSION,
    review_status: normalizedStatus,
    review_decision: normalizedDecision,
    reviewer: normalizedReviewer,
    reviewer_kind: normalizedReviewerKind,
    reviewed_at: normalizedReviewedAt,
    legacy_review_status: normalizedLegacyStatus,
    review_tier: reviewTier,
    approved: reviewTier !== 'unreviewed',
  };
}

function deriveReviewContractFromReportRow(row) {
  const reportRow = asPlainObject(row) || {};
  const provenance = asPlainObject(reportRow?.selected?.bundle?.provenance) || {};
  return buildReviewContract({
    reviewStatus: reportRow.review_status || provenance.review_status,
    reviewDecision:
      reportRow.review_decision || reportRow.decision || provenance.review_decision,
    reviewer: reportRow.reviewer || provenance.reviewer,
    reviewerKind: reportRow.reviewer_kind || provenance.reviewer_kind,
    reviewedAt: reportRow.reviewed_at || provenance.reviewed_at,
    legacyReviewStatus:
      provenance.external_highlight_review_status ||
      reportRow.review_decision ||
      reportRow.decision,
  });
}

function deriveReviewContractFromSourceMeta(sourceMeta) {
  const meta = asPlainObject(sourceMeta) || {};
  return buildReviewContract({
    reviewStatus: meta.review_status,
    reviewDecision: meta.review_decision || meta.decision,
    reviewer: meta.reviewer,
    reviewerKind: meta.reviewer_kind,
    reviewedAt: meta.reviewed_at,
    legacyReviewStatus: meta.external_highlight_review_status,
  });
}

function deriveReviewContractFromManualOverride(override) {
  const meta = asPlainObject(override) || {};
  return buildReviewContract({
    reviewStatus: meta.review_status,
    reviewDecision: meta.review_decision || meta.decision,
    reviewer: meta.reviewer,
    reviewerKind: meta.reviewer_kind,
    reviewedAt: meta.reviewed_at,
    legacyReviewStatus: meta.external_highlight_review_status,
  });
}

function isCoveredByReviewMode(reviewSource, reviewMode = 'strict_human') {
  const normalizedMode = normalizeReviewMode(reviewMode);
  if (normalizedMode === 'any_kb') return true;
  const contract =
    reviewSource && typeof reviewSource === 'object' && !Array.isArray(reviewSource)
      ? reviewSource.review_tier
        ? reviewSource
        : deriveReviewContractFromSourceMeta(reviewSource)
      : buildReviewContract();

  if (normalizedMode === 'reviewed') {
    return (
      contract.review_tier === 'strict_human' ||
      contract.review_tier === 'assistant_reviewed' ||
      contract.review_tier === 'legacy_reviewed'
    );
  }
  return contract.review_tier === 'strict_human';
}

module.exports = {
  APPROVED_REVIEW_DECISIONS,
  PRODUCT_INTEL_REVIEW_CONTRACT_VERSION,
  buildReviewContract,
  deriveReviewContractFromManualOverride,
  deriveReviewContractFromReportRow,
  deriveReviewContractFromSourceMeta,
  deriveReviewTier,
  isApprovedReviewDecision,
  isCoveredByReviewMode,
  normalizeReviewDecision,
  normalizeReviewMode,
  normalizeReviewStatus,
  normalizeReviewerKind,
};
