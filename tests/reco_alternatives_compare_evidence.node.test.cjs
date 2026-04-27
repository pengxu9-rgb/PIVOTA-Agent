const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');

test('open-world alternatives keep external compare evidence as ranking signal, not a gate', () => {
  const row = __internal.normalizeOpenWorldAlternativeRow(
    {
      brand: 'Skin1004',
      name: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
      product_type: 'Sunscreen',
      reasons: ['Often discussed as a lightweight SPF comparison for serum-style sunscreens.'],
      tradeoff_notes: ['Finish and filter details still need PDP verification before substituting.'],
      comparison_evidence: [
        {
          source_type: 'editorial',
          mention_type: 'alternative',
          summary: 'Editorial-style comparisons often group it with lightweight serum sunscreens.',
          evidence_strength: 'moderate',
        },
        {
          source_type: 'user_reviews',
          mention_type: 'comparison',
          summary: 'User discussions compare the light finish against similar daily SPFs.',
        },
      ],
    },
    {
      targetSignals: {
        brand: 'SKINTIFIC',
        name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
        usageRole: 'sunscreen',
        productType: 'Sunscreen',
        roleScope: 'daily_sunscreen_finish_fit',
        textureHints: ['matte finish'],
        primaryClaims: ['lightweight finish'],
      },
      anchorLabel: 'SKINTIFIC Matte Fit Serum Sunscreen SPF 50+ PA++++',
      anchorNameTokens: ['skintific', 'matte', 'fit', 'serum', 'sunscreen'],
      claimTokens: ['lightweight finish'],
      textureTokens: ['matte finish'],
    },
  );

  assert.equal(row.candidate_origin, 'open_world');
  assert.equal(row.grounding_status, 'name_only');
  assert.equal(row.metadata.external_compare_evidence_count, 2);
  assert.ok(row.metadata.external_compare_evidence_score > 0);
  assert.ok(row.metadata.ranking_signals_used.includes('external_compare_evidence_boost'));
  assert.ok(row.metadata.external_compare_evidence_search_queries.length >= 3);
});

test('mixed ranking uses compare evidence as a soft boost', () => {
  const base = {
    candidate_origin: 'pool',
    grounding_status: 'catalog_verified',
    similarity_score: 70,
    product: { brand: 'A', name: 'Plain SPF' },
  };
  const evidenceBacked = {
    ...base,
    product: { brand: 'B', name: 'Evidence SPF' },
    metadata: {
      external_compare_evidence_score: 0.06,
    },
  };

  const plainScore = __internal.getRecoAlternativeMixedRankingScore(base, { useExperienceQualityBonus: true });
  const evidenceScore = __internal.getRecoAlternativeMixedRankingScore(evidenceBacked, { useExperienceQualityBonus: true });
  assert.ok(evidenceScore > plainScore);
});
