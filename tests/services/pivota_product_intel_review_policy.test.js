const {
  buildReviewContract,
  deriveReviewContractFromManualOverride,
  deriveReviewContractFromReportRow,
  deriveReviewContractFromSourceMeta,
  isCoveredByReviewMode,
  normalizeReviewMode,
  normalizeReviewerKind,
} = require('../../src/services/pivotaProductIntelReviewPolicy');

describe('pivotaProductIntelReviewPolicy', () => {
  test('treats explicit human-reviewed rows as strict_human', () => {
    const contract = buildReviewContract({
      reviewStatus: 'reviewed',
      reviewDecision: 'rewrite',
      reviewer: 'Alice QA',
      reviewedAt: '2026-04-14T02:00:00Z',
    });

    expect(contract.review_status).toBe('completed');
    expect(contract.review_decision).toBe('rewrite');
    expect(contract.reviewer_kind).toBe('human');
    expect(contract.review_tier).toBe('strict_human');
    expect(isCoveredByReviewMode(contract, 'strict_human')).toBe(true);
  });

  test('classifies codex-reviewed rows as assistant_reviewed', () => {
    const contract = deriveReviewContractFromReportRow({
      review_status: 'completed',
      review_decision: 'pass',
      reviewer: 'codex',
    });

    expect(contract.reviewer_kind).toBe('assistant');
    expect(contract.review_tier).toBe('assistant_reviewed');
    expect(isCoveredByReviewMode(contract, 'strict_human')).toBe(false);
    expect(isCoveredByReviewMode(contract, 'reviewed')).toBe(true);
  });

  test('falls back to legacy review status when strict review fields are absent', () => {
    const contract = deriveReviewContractFromSourceMeta({
      external_highlight_review_status: 'seller_only_fallback',
    });

    expect(contract.review_tier).toBe('legacy_reviewed');
    expect(isCoveredByReviewMode(contract, 'reviewed')).toBe(true);
    expect(isCoveredByReviewMode(contract, 'strict_human')).toBe(false);
  });

  test('manual overrides only count as strict_human when reviewer metadata is present', () => {
    const strictOverride = deriveReviewContractFromManualOverride({
      external_highlight_review_status: 'rewrite',
      review_status: 'completed',
      review_decision: 'rewrite',
      reviewer: 'Human QA',
    });
    const legacyOverride = deriveReviewContractFromManualOverride({
      external_highlight_review_status: 'rewrite',
    });

    expect(strictOverride.review_tier).toBe('strict_human');
    expect(legacyOverride.review_tier).toBe('legacy_reviewed');
  });

  test('normalizes review mode and reviewer kinds defensively', () => {
    expect(normalizeReviewMode('reviewed')).toBe('reviewed');
    expect(normalizeReviewMode('')).toBe('strict_human');
    expect(normalizeReviewerKind('', 'Gemini')).toBe('assistant');
    expect(normalizeReviewerKind('', 'Operations QA')).toBe('human');
  });
});
