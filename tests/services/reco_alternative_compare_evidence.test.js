const {
  normalizeRecoAlternativeCompareEvidence,
  scoreRecoAlternativeCompareEvidence,
  buildRecoAlternativeCompareEvidenceSearchQueries,
} = require('../../src/services/recoAlternativeCompareEvidence');

describe('recoAlternativeCompareEvidence', () => {
  test('normalizes public compare evidence without requiring hard gates', () => {
    const evidence = normalizeRecoAlternativeCompareEvidence({
      comparison_evidence: [
        {
          source_type: 'media_signal',
          mention_type: 'budget dupe',
          summary: 'Frequently mentioned as a lighter SPF alternative.',
          evidence_strength: 'strong',
        },
        {
          sourceType: 'verified_reviews',
          mentionType: 'comparison',
          claim_text: 'Reviewers compare the finish against the anchor.',
        },
      ],
    });

    expect(evidence).toEqual([
      expect.objectContaining({
        source_type: 'editorial_support',
        mention_type: 'budget_alternative',
      }),
      expect.objectContaining({
        source_type: 'user_review_consensus',
        mention_type: 'comparison',
      }),
    ]);
    expect(scoreRecoAlternativeCompareEvidence(evidence)).toBeGreaterThan(0.04);
  });

  test('builds web-evidence queries for offline audit and catalog-intelligence recovery', () => {
    const queries = buildRecoAlternativeCompareEvidenceSearchQueries({
      anchorBrand: 'SKINTIFIC',
      anchorName: 'Matte Fit Serum Sunscreen SPF 50+',
      candidateBrand: 'Skin1004',
      candidateName: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
      role: 'sunscreen',
    });

    expect(queries).toEqual(
      expect.arrayContaining([
        'SKINTIFIC Matte Fit Serum Sunscreen SPF 50+ Skin1004 Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+ comparison',
        'Skin1004 Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+ alternative to SKINTIFIC Matte Fit Serum Sunscreen SPF 50+',
      ]),
    );
    expect(queries.length).toBeLessThanOrEqual(8);
  });
});
