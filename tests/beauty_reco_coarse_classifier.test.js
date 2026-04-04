const {
  scoreBeautyCandidateForTarget,
} = require('../src/shared/beautyRecoCoarseClassifier');

describe('beauty treatment scoring', () => {
  test('niacinamide treatment query prefers niacinamide zinc serum over spot treatment', () => {
    const niacinamide = scoreBeautyCandidateForTarget(
      {
        title: 'Niacinamide Serum 12% Plus Zinc 2%',
        category: 'skincare',
        product_type: 'serum',
        merchant_id: 'external_seed',
      },
      {
        queryTargetStepFamily: 'treatment',
        queryText: 'niacinamide treatment',
        mode: 'shopping_agent_beauty_mainline',
      },
    );
    const spot = scoreBeautyCandidateForTarget(
      {
        title: 'Rapid Relief Acne Spot Treatment',
        category: 'skincare',
        product_type: 'treatment',
        merchant_id: 'external_seed',
      },
      {
        queryTargetStepFamily: 'treatment',
        queryText: 'niacinamide treatment',
        mode: 'shopping_agent_beauty_mainline',
      },
    );

    expect(niacinamide.score).toBeGreaterThan(spot.score);
  });

  test('explicit acne spot treatment query still allows spot treatment to outrank niacinamide serum', () => {
    const niacinamide = scoreBeautyCandidateForTarget(
      {
        title: 'Niacinamide Serum 12% Plus Zinc 2%',
        category: 'skincare',
        product_type: 'serum',
        merchant_id: 'external_seed',
      },
      {
        queryTargetStepFamily: 'treatment',
        queryText: 'acne spot treatment',
        mode: 'shopping_agent_beauty_mainline',
      },
    );
    const spot = scoreBeautyCandidateForTarget(
      {
        title: 'Rapid Relief Acne Spot Treatment',
        category: 'skincare',
        product_type: 'treatment',
        merchant_id: 'external_seed',
      },
      {
        queryTargetStepFamily: 'treatment',
        queryText: 'acne spot treatment',
        mode: 'shopping_agent_beauty_mainline',
      },
    );

    expect(spot.score).toBeGreaterThan(niacinamide.score);
  });
});
