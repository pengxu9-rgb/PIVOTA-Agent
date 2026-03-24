const {
  normalizeRecoTargetStep,
} = require('../../src/auroraBff/recoTargetStep');
const {
  LOCAL_INGREDIENT_RECALL_REGISTRY,
} = require('../../src/services/ingredientRecallRegistry');
const { _internals } = require('../../src/services/ingredientSkuEvidence');

describe('mandelic step resolution', () => {
  test('maps exfoliator-style PDP text to treatment', () => {
    expect(normalizeRecoTargetStep('Mandelic Acid 10% + HA Exfoliator')).toBe('treatment');
    expect(
      normalizeRecoTargetStep('https://theordinary.com/en-us/mandelic-acid-10-ha-exfoliator-100429.html'),
    ).toBe('treatment');
    expect(normalizeRecoTargetStep('Daily Liquid Exfoliant')).toBe('treatment');
  });

  test('does not short-circuit explicit mandelic seed candidates before evidence scoring', () => {
    const out = _internals.buildCandidateEvidence(
      {
        title: 'Mandelic Acid 10% + HA',
        canonical_url: 'https://theordinary.com/en-us/mandelic-acid-10-ha-exfoliator-100429.html',
      },
      {
        profile: LOCAL_INGREDIENT_RECALL_REGISTRY.mandelic_acid,
        targetStepFamily: 'serum',
        allowFamilyOnly: false,
        queryText: 'mandelic acid serum',
      },
    );

    expect(out).toEqual(
      expect.objectContaining({
        evidence: expect.objectContaining({
          candidate_step: 'treatment',
          family_relation: 'adjacent_family',
          title_exact: 1,
          title_alias: 1,
          url_alias: 2,
          explicit_hits: 4,
        }),
      }),
    );
    expect(out.reject_reason).toBeUndefined();
  });
});
