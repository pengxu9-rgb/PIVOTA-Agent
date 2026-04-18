const {
  classifyBeautyCoarseCandidate,
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

  test('oil control treatment treats ingredient-list-only niacinamide on brightening serum as weak evidence', () => {
    const niacinamide = scoreBeautyCandidateForTarget(
      {
        title: 'Niacinamide Serum 12% Plus Zinc 2%',
        category: 'Serum',
        product_type: 'Serum',
        merchant_id: 'external_seed',
        description: 'Oil control serum for pores and shine.',
        active_ingredients: ['Niacinamide', 'Zinc PCA'],
      },
      {
        queryTargetStepFamily: 'treatment',
        queryText: 'oil control treatment',
        mode: 'shopping_agent_beauty_mainline',
      },
    );
    const pollutedBrightening = scoreBeautyCandidateForTarget(
      {
        title: 'Vitamin C Super Serum Plus',
        category: 'Serum',
        product_type: 'Serum',
        merchant_id: 'external_seed',
        description: 'Brightening serum for dark spots and radiance.',
        active_ingredients: ['Vitamin C', 'Niacinamide', 'Zinc PCA', 'Salicylic acid', 'Tranexamic acid'],
        ingredient_tokens: ['vitamin c', 'niacinamide', 'zinc pca', 'salicylic acid', 'tranexamic acid'],
      },
      {
        queryTargetStepFamily: 'treatment',
        queryText: 'oil control treatment',
        mode: 'shopping_agent_beauty_mainline',
      },
    );

    expect(niacinamide.score).toBeGreaterThan(pollutedBrightening.score);
  });

  test('oil control treatment decision demotes generic acne relief below niacinamide family', () => {
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
          title: 'Niacinamide Serum 12% Plus Zinc 2%',
          category: 'skincare',
          product_type: 'serum',
          merchant_id: 'external_seed',
        },
        {
          title: 'Vitamin C Super Serum Plus',
          category: 'skincare',
          product_type: 'serum',
          merchant_id: 'external_seed',
          description: 'Brightening serum.',
          active_ingredients: ['Vitamin C', 'Niacinamide', 'Tranexamic acid'],
        },
      ],
    });

    expect(decision.valid_products[0]?.title).toBe('Niacinamide Serum 12% Plus Zinc 2%');
    expect(decision.valid_products[1]?.title).toBe('Deep Relief Acne Treatment');
  });

  test('broad sunscreen query prefers real sunscreen formats over uv-filter serum shapes', () => {
    const sunscreen = scoreBeautyCandidateForTarget(
      {
        title: 'Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
        category: 'sunscreen',
        product_type: 'sunscreen',
        merchant_id: 'external_seed',
        description: 'Lightweight face sunscreen for oily skin with zinc oxide.',
      },
      {
        queryTargetStepFamily: 'sunscreen',
        queryText: 'best sunscreen for oily skin',
        mode: 'shopping_agent_beauty_mainline',
      },
    );
    const serum = scoreBeautyCandidateForTarget(
      {
        title: 'UV Filters SPF 45 Serum',
        category: 'serum',
        product_type: 'serum',
        merchant_id: 'external_seed',
        description: 'Daily lightweight SPF 45 serum for oily skin with broad spectrum UV filters.',
      },
      {
        queryTargetStepFamily: 'sunscreen',
        queryText: 'best sunscreen for oily skin',
        mode: 'shopping_agent_beauty_mainline',
      },
    );

    expect(sunscreen.score).toBeGreaterThan(serum.score);
  });

  test('sunscreen query does not trust mislabelled structured category without SPF identity evidence', () => {
    const mislabeledTreatment = classifyBeautyCoarseCandidate(
      {
        title: 'Targeted Wrinkle Corrector',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        merchant_id: 'external_seed',
        url: 'https://www.murad.com/products/targeted-wrinkle-corrector',
        description: 'Targeted treatment for the look of fine lines.',
      },
      {
        queryTargetStepFamily: 'sunscreen',
        queryText: 'daily sunscreen with finish fit',
        mode: 'shopping_agent_beauty_mainline',
      },
    );
    const realSunscreen = classifyBeautyCoarseCandidate(
      {
        title: 'Superactive Moisturizer SPF 50: Wrinkle-Fighting',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        merchant_id: 'external_seed',
        url: 'https://www.murad.com/products/superactive-moisturizer-spf-50-wrinkle-fighting',
        description: 'Broad spectrum SPF 50 moisturizer.',
      },
      {
        queryTargetStepFamily: 'sunscreen',
        queryText: 'daily sunscreen with finish fit',
        mode: 'shopping_agent_beauty_mainline',
      },
    );

    expect(mislabeledTreatment.candidate_step).toBe('treatment');
    expect(mislabeledTreatment.candidate_step_source).toBe('structured_category_identity_conflict');
    expect(mislabeledTreatment.target_relevance_class).toBe('hard_invalid');
    expect(mislabeledTreatment.noise_reason).toBe('spf_missing');
    expect(realSunscreen.candidate_step).toBe('sunscreen');
    expect(realSunscreen.target_relevance_class).toBe('strong_goal_family');
  });

  test('explicit sunscreen serum query can still keep sunscreen serum competitive', () => {
    const sunscreen = scoreBeautyCandidateForTarget(
      {
        title: 'Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
        category: 'sunscreen',
        product_type: 'sunscreen',
        merchant_id: 'external_seed',
        description: 'Lightweight face sunscreen for oily skin with zinc oxide.',
      },
      {
        queryTargetStepFamily: 'sunscreen',
        queryText: 'spf serum for oily skin',
        mode: 'shopping_agent_beauty_mainline',
      },
    );
    const serum = scoreBeautyCandidateForTarget(
      {
        title: 'UV Filters SPF 45 Serum',
        category: 'serum',
        product_type: 'serum',
        merchant_id: 'external_seed',
        description: 'Daily lightweight SPF 45 serum for oily skin with broad spectrum UV filters.',
      },
      {
        queryTargetStepFamily: 'sunscreen',
        queryText: 'spf serum for oily skin',
        mode: 'shopping_agent_beauty_mainline',
      },
    );

    expect(serum.score).toBeGreaterThan(0);
    expect(sunscreen.score).toBeGreaterThanOrEqual(serum.score);
  });
});
