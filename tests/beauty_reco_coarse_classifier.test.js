const {
  scoreBeautyCandidateForTarget,
  buildBeautySkincareHitQualityDecision,
} = require('../src/shared/beautyRecoCoarseClassifier');

describe('beauty treatment scoring', () => {
  test('oil control treatment query prefers niacinamide zinc treatment over generic acne relief products', () => {
    const niacinamide = scoreBeautyCandidateForTarget(
      {
        title: 'Niacinamide Serum 12% Plus Zinc 2%',
        category: 'skincare',
        product_type: 'serum',
        merchant_id: 'external_seed',
      },
      {
        queryTargetStepFamily: 'treatment',
        queryText: 'oil control treatment',
        mode: 'shopping_agent_beauty_mainline',
      },
    );
    const acneRelief = scoreBeautyCandidateForTarget(
      {
        title: 'Deep Relief Acne Treatment',
        category: 'skincare',
        product_type: 'treatment',
        merchant_id: 'external_seed',
      },
      {
        queryTargetStepFamily: 'treatment',
        queryText: 'oil control treatment',
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
        queryText: 'oil control treatment',
        mode: 'shopping_agent_beauty_mainline',
      },
    );

    expect(niacinamide.score).toBeGreaterThan(acneRelief.score);
    expect(niacinamide.score).toBeGreaterThan(spot.score);
  });

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

  test('oil control treatment decision ranks niacinamide zinc ahead of generic acne treatment family', () => {
    const decision = buildBeautySkincareHitQualityDecision({
      queryText: 'oil control treatment',
      queryTargetStepFamily: 'treatment',
      mode: 'shopping_agent_beauty_mainline',
      products: [
        {
          title: 'Deep Relief Acne Treatment',
          category: 'skincare',
          product_type: 'treatment',
          merchant_id: 'external_seed',
        },
        {
          title: 'Rapid Relief Acne Spot Treatment',
          category: 'skincare',
          product_type: 'treatment',
          merchant_id: 'external_seed',
        },
        {
          title: 'Niacinamide Serum 12% Plus Zinc 2%',
          category: 'skincare',
          product_type: 'serum',
          merchant_id: 'external_seed',
        },
      ],
    });

    expect(decision.valid_products[0]?.title).toBe('Niacinamide Serum 12% Plus Zinc 2%');
  });

  test('oil control treatment query does not let broad brightening serums outrank niacinamide zinc', () => {
    const niacinamide = scoreBeautyCandidateForTarget(
      {
        title: 'Niacinamide Serum 12% Plus Zinc 2%',
        category: 'Serum',
        product_type: 'Serum',
        merchant_id: 'external_seed',
        description: 'Oil control serum for pores and shine.',
        active_ingredients: ['Niacinamide', 'Zinc PCA', 'Salicylic acid'],
      },
      {
        queryTargetStepFamily: 'treatment',
        queryText: 'oil control treatment',
        mode: 'shopping_agent_beauty_mainline',
      },
    );
    const vitaminC = scoreBeautyCandidateForTarget(
      {
        title: 'Vitamin C Super Serum Plus',
        category: 'Serum',
        product_type: 'Serum',
        merchant_id: 'external_seed',
        description: 'Brightening serum for dark spots.',
        active_ingredients: ['Vitamin C (Ascorbic acid)', 'Niacinamide', 'Salicylic acid'],
      },
      {
        queryTargetStepFamily: 'treatment',
        queryText: 'oil control treatment',
        mode: 'shopping_agent_beauty_mainline',
      },
    );
    const tranexamic = scoreBeautyCandidateForTarget(
      {
        title: 'Tranexamic Topical Acid 5%',
        category: 'Serum',
        product_type: 'Serum',
        merchant_id: 'external_seed',
        description: 'Brightening serum for dark spots.',
        active_ingredients: ['Tranexamic acid', 'Niacinamide', 'Salicylic acid'],
      },
      {
        queryTargetStepFamily: 'treatment',
        queryText: 'oil control treatment',
        mode: 'shopping_agent_beauty_mainline',
      },
    );

    expect(niacinamide.score).toBeGreaterThan(vitaminC.score);
    expect(niacinamide.score).toBeGreaterThan(tranexamic.score);
  });
});
