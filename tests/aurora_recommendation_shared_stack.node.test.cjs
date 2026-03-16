const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runRecommendationSharedStack,
  REQUEST_CONTEXT_SIGNATURE_VERSION,
  CANDIDATE_POOL_SIGNATURE_VERSION,
  RECOMMENDATION_STEP_QUERY_POLICY_V1,
  RECOMMENDATION_VIABLE_THRESHOLD_POLICY_V1,
  GROUP_SEMANTICS_VERSION,
  resolveRecommendationTargetContext,
  buildSameFamilyQueryLevels,
  finalizeRecommendationCandidatePools,
  shouldStopStepAwareBroadening,
  deriveStepAwareEmptyReason,
  inferSlotForStep,
} = require('../src/auroraBff/recommendationSharedStack');
const {
  classifyBeautyCoarseCandidate,
  buildBeautySkincareHitQualityDecision,
  scoreBeautyCandidateForTarget,
} = require('../src/shared/beautyRecoCoarseClassifier');

test('step resolution parity keeps moisturizer aliases aligned across direct/chat', () => {
  const aliases = ['moisturizer', 'cream', '面霜', '保湿霜', '日霜'];
  for (const input of aliases) {
    const direct = resolveRecommendationTargetContext({
      focus: input,
      text: `Recommend ${input} for me`,
      entryType: 'direct',
    });
    const chat = resolveRecommendationTargetContext({
      text: `Recommend a ${input} for me`,
      entryType: 'chat',
    });
    assert.equal(direct.resolved_target_step, 'moisturizer');
    assert.equal(chat.resolved_target_step, 'moisturizer');
    assert.equal(direct.resolved_target_step_confidence, 'high');
    assert.equal(chat.resolved_target_step_confidence, 'high');
  }
});

test('direct focus negatives do not escalate to high-confidence hard target', () => {
  for (const input of ['repair', 'hydrating', 'barrier support', 'something for night']) {
    const result = resolveRecommendationTargetContext({
      focus: input,
      text: input,
      entryType: 'direct',
    });
    assert.notEqual(result.resolved_target_step_confidence, 'high');
  }
});

test('same-family ladder never broadens moisturizer into cleanser or sunscreen family', () => {
  const targetContext = resolveRecommendationTargetContext({
    focus: 'moisturizer',
    text: 'Recommend a moisturizer for barrier support',
    entryType: 'chat',
  });
  const levels = buildSameFamilyQueryLevels({
    targetContext,
    profileSummary: { goals: ['barrier repair'] },
    ingredientContext: { query: 'ceramide' },
    lang: 'EN',
  });
  const flattenedQueries = levels.flatMap((level) => level.queries.map((row) => row.query.toLowerCase()));
  const poolState = finalizeRecommendationCandidatePools([
    {
      product_id: 'cream_1',
      merchant_id: 'm1',
      brand: 'GoodSkin',
      name: 'Barrier Cream',
      display_name: 'Barrier Cream',
      category: 'skincare',
    },
    {
      product_id: 'brush_1',
      merchant_id: 'm2',
      brand: 'BrushCo',
      name: 'Small Eyeshadow Brush',
      category: 'makeup brush',
      product_type: 'tool',
    },
  ], { targetContext });

  assert.equal(RECOMMENDATION_STEP_QUERY_POLICY_V1, 'recommendation_step_query_policy_v1');
  assert.equal(RECOMMENDATION_VIABLE_THRESHOLD_POLICY_V1, 'recommendation_viable_threshold_policy_v1');
  assert.equal(GROUP_SEMANTICS_VERSION, 'recommendation_group_semantics_v1');
  assert.equal(inferSlotForStep('moisturizer'), 'other');
  assert.equal(flattenedQueries.some((query) => query.includes('cleanser') || query.includes('sunscreen')), false);
  assert.equal(poolState.viable_candidate_count, 1);
  assert.equal(poolState.hard_reject_count, 1);
  assert.equal(poolState.selected_candidate_count, 1);
  assert.equal(poolState.pre_llm_selected_candidate_count, 1);
  assert.equal(poolState.final_selected_candidate_count, 1);
  assert.equal(poolState.overall_target_fidelity_satisfied, true);
  assert.equal(poolState.viable_pool_strength, 'strong');
  assert.equal(poolState.target_fidelity_level, 'satisfied');
  assert.equal(poolState.reco_policy_version, 'recommendation_step_aware_reco_policy_v1');
  assert.equal(poolState.viable[0].candidate_step, 'moisturizer');
  assert.equal(poolState.viable[0].candidate_step_source, 'text_salvage');
  assert.ok(poolState.candidate_pool_signature);
  assert.ok(poolState.raw_candidate_pool_debug_signature);
});

test('same-family ladder keeps rich moisturizer seeds step-scoped and never emits bare seed queries', () => {
  const targetContext = resolveRecommendationTargetContext({
    focus: 'moisturizer',
    text: 'Recommend a moisturizer for barrier repair',
    entryType: 'chat',
  });
  const levels = buildSameFamilyQueryLevels({
    targetContext,
    profileSummary: { goals: ['barrier repair'] },
    ingredientContext: { query: 'ceramide' },
    seedTerms: ['barrier repair', 'ceramide'],
    lang: 'EN',
  });
  const flattenedQueries = levels.flatMap((level) => level.queries.map((row) => row.query.toLowerCase()));

  assert.equal(flattenedQueries.some((query) => query === 'barrier repair'), false);
  assert.equal(flattenedQueries.some((query) => query === 'ceramide'), false);
  assert.equal(flattenedQueries.some((query) => query.includes('barrier repair moisturizer')), true);
  assert.equal(flattenedQueries.some((query) => query.includes('ceramide moisturizer')), true);
});

test('same-family ladder drops step-incompatible seeds like uv filters from moisturizer queries', () => {
  const targetContext = resolveRecommendationTargetContext({
    focus: 'moisturizer',
    text: 'Recommend a moisturizer for me',
    entryType: 'chat',
  });
  const levels = buildSameFamilyQueryLevels({
    targetContext,
    profileSummary: { goals: ['barrier repair'] },
    ingredientContext: {},
    seedTerms: ['uv filters', 'ceramide', 'barrier repair'],
    lang: 'EN',
  });
  const flattenedQueries = levels.flatMap((level) => level.queries.map((row) => row.query.toLowerCase()));

  assert.equal(flattenedQueries.some((query) => query.includes('uv filters')), false);
  assert.equal(flattenedQueries.some((query) => query.includes('ceramide moisturizer')), true);
  assert.equal(flattenedQueries.some((query) => query.includes('barrier repair moisturizer')), true);
});

test('viability stage rejects non-skincare and preserves moisturizer candidates', () => {
  const targetContext = resolveRecommendationTargetContext({
    focus: 'moisturizer',
    text: 'Recommend a moisturizer for me',
    entryType: 'direct',
  });
  const pool = finalizeRecommendationCandidatePools(
    [
      {
        product_id: 'face_cream_1',
        merchant_id: 'mid_cream',
        brand: 'GoodSkin',
        name: 'Barrier Cream',
        display_name: 'Barrier Cream',
        category: 'skincare',
      },
      {
        product_id: 'brush_1',
        merchant_id: 'mid_brush',
        brand: 'BrushCo',
        name: 'Small Eyeshadow Brush',
        display_name: 'Small Eyeshadow Brush',
        category: 'makeup brush',
        product_type: 'tool',
      },
    ],
    { targetContext },
  );

  assert.equal(pool.viable_candidate_count, 1);
  assert.equal(pool.hard_reject_count, 1);
  assert.equal(pool.selected_candidate_count, 1);
  assert.equal(pool.pre_llm_selected_candidate_count, 1);
  assert.equal(pool.final_selected_candidate_count, 1);
  assert.equal(pool.selected_recommendations[0].product_id, 'face_cream_1');
  assert.equal(pool.viable[0].candidate_step, 'moisturizer');
  assert.equal(pool.viable[0].candidate_step_source, 'text_salvage');
  assert.equal(pool.terminal_success, true);
  assert.equal(pool.viable_pool_strength, 'strong');
  assert.equal(pool.target_fidelity_level, 'satisfied');
  assert.equal(pool.reco_policy_version, 'recommendation_step_aware_reco_policy_v1');
});

test('retrieval_step preserves same-family candidates when category is generic skincare and title is opaque', () => {
  const targetContext = resolveRecommendationTargetContext({
    focus: 'moisturizer',
    text: 'Recommend a moisturizer for barrier repair',
    entryType: 'direct',
  });
  const pool = finalizeRecommendationCandidatePools(
    [
      {
        product_id: 'opaque_brand_1',
        merchant_id: 'mid_opaque',
        brand: 'Brand X',
        name: 'Recovery 001',
        display_name: 'Recovery 001',
        category: 'skincare',
        retrieval_step: 'moisturizer',
      },
    ],
    { targetContext },
  );

  assert.equal(pool.viable_candidate_count, 1);
  assert.equal(pool.selected_candidate_count, 1);
  assert.equal(pool.viable[0].candidate_step, 'moisturizer');
  assert.equal(pool.viable[0].candidate_step_source, 'retrieval_step');
  assert.equal(pool.terminal_success, true);
});

test('artifact-backed context-fit ordering prioritizes barrier-friendly moisturizer and rejects hard avoid conflicts', () => {
  const targetContext = resolveRecommendationTargetContext({
    focus: 'moisturizer',
    text: 'Recommend a moisturizer for barrier repair',
    entryType: 'chat',
  });
  const pool = finalizeRecommendationCandidatePools(
    [
      {
        product_id: 'generic_cream',
        merchant_id: 'm1',
        brand: 'GoodSkin',
        display_name: 'Daily Moisture Cream',
        category: 'skincare',
      },
      {
        product_id: 'barrier_cream',
        merchant_id: 'm2',
        brand: 'BarrierLab',
        display_name: 'Barrier Repair Cream',
        category: 'skincare',
        ingredient_tokens: ['ceramide', 'panthenol'],
      },
      {
        product_id: 'retinol_cream',
        merchant_id: 'm3',
        brand: 'ActiveSkin',
        display_name: 'Retinol Night Cream',
        category: 'skincare',
        ingredient_tokens: ['retinol'],
      },
    ],
    {
      targetContext,
      recoContext: {
        task_hard_context: {
          barrier_status: 'impaired',
          sensitivity: 'high',
          active_goals: ['barrier repair'],
          ingredient_avoid: ['retinol'],
          ingredient_targets: ['ceramide'],
        },
        task_soft_context: {},
      },
    },
  );

  assert.equal(pool.selected_recommendations[0].product_id, 'barrier_cream');
  assert.equal(pool.hard_reject.some((row) => row.product.product_id === 'retinol_cream'), true);
  assert.equal(pool.soft_mismatch.some((row) => row.product.product_id === 'generic_cream'), true);
  assert.equal(pool.viable[0].context_fit_score > pool.soft_mismatch[0].context_fit_score, true);
  assert.equal(pool.artifact_context_applied, true);
});

test('shared coarse classifier keeps body cream and beauty tools out of face-moisturizer valid hits', () => {
  const barrierCream = classifyBeautyCoarseCandidate({
    display_name: 'Barrier Cream',
    category: 'skincare',
  }, { queryTargetStepFamily: 'moisturizer' });
  const bodyCream = classifyBeautyCoarseCandidate({
    display_name: 'Lil Butta Dropz Body Cream Trio',
    category: 'body cream',
  }, { queryTargetStepFamily: 'moisturizer' });
  const brush = classifyBeautyCoarseCandidate({
    display_name: 'Small Eyeshadow Brush',
    category: 'makeup brush',
    product_type: 'tool',
  }, { queryTargetStepFamily: 'moisturizer' });

  assert.equal(barrierCream.domain_scope, 'skincare');
  assert.equal(barrierCream.usage_scope, 'face');
  assert.equal(barrierCream.coarse_valid_for_target, true);
  assert.equal(bodyCream.domain_scope, 'bodycare');
  assert.equal(bodyCream.usage_scope, 'body');
  assert.equal(bodyCream.coarse_valid_for_target, false);
  assert.equal(brush.domain_scope, 'beauty_tool');
  assert.equal(brush.object_type, 'brush');
  assert.equal(brush.coarse_valid_for_target, false);
});

test('guidance-only moisturizer classifier separates strong/supportive rows from noisy moisturizer-like candidates', () => {
  const strong = classifyBeautyCoarseCandidate({
    display_name: 'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
    category: 'moisturizer',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'barrier repair ceramide moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'strong_goal_family',
  });
  const supportive = classifyBeautyCoarseCandidate({
    display_name: 'Lait-Crème Sensitive - Fragrance free',
    category: 'moisturizer',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'fragrance-free barrier moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
  });
  const coreSupportive = classifyBeautyCoarseCandidate({
    display_name: 'Rose Ceramide Cream',
    category: 'moisturizer',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'fragrance-free barrier moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
  });
  const generic = classifyBeautyCoarseCandidate({
    display_name: 'Mattifying Moisturizer',
    category: 'moisturizer',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'barrier repair moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
  });
  const duo = classifyBeautyCoarseCandidate({
    display_name: 'Strength Trainer Peptide Boost Moisturizer Duo',
    category: 'moisturizer',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'barrier repair moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
  });
  const tint = classifyBeautyCoarseCandidate({
    display_name: 'Positive Light Tinted Moisturizer',
    category: 'moisturizer',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'barrier repair moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
  });
  const peel = classifyBeautyCoarseCandidate({
    display_name: 'Hydrating Milky Peel',
    category: 'peel',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'barrier repair moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
  });
  const sample = classifyBeautyCoarseCandidate({
    display_name: '5X Ceramide Barrier Repair Moisture Gel (Mini Sample)',
    category: 'moisturizer',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'barrier repair ceramide moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'strong_goal_family',
  });
  const cleanser = classifyBeautyCoarseCandidate({
    display_name: 'Rose Cream Cleanser',
    category: 'cleanser',
    product_type: 'cleanser',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'barrier repair moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
  });
  const hairStyling = classifyBeautyCoarseCandidate({
    display_name: 'The Protective Type Frizz-Smoothing Heat Protectant Styling Cream',
    category: 'moisturizer',
    product_type: 'moisturizer',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'barrier repair moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
  });
  const routine = classifyBeautyCoarseCandidate({
    display_name: 'Cult Fragrance-Free Skincare Routine',
    category: 'moisturizer',
    description: 'A 2-step fragrance-free moisturizer routine for sensitive face skin',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'fragrance-free barrier moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'strong_goal_family',
  });

  assert.equal(strong.target_relevance_class, 'strong_goal_family');
  assert.equal(strong.coarse_valid_for_target, true);
  assert.equal(supportive.target_relevance_class, 'supportive_family');
  assert.equal(supportive.coarse_valid_for_target, true);
  assert.equal(coreSupportive.target_relevance_class, 'strong_goal_family');
  assert.equal(coreSupportive.relevance_channel, 'ingredient-strong');
  assert.equal(coreSupportive.coarse_valid_for_target, true);
  assert.equal(generic.target_relevance_class, 'generic_family');
  assert.equal(generic.coarse_valid_for_target, false);
  assert.equal(duo.offer_type, 'duo');
  assert.equal(duo.target_relevance_class, 'adjacent_noise');
  assert.equal(duo.coarse_valid_for_target, false);
  assert.equal(tint.target_relevance_class, 'hard_invalid');
  assert.equal(tint.noise_reason, 'tint');
  assert.equal(peel.target_relevance_class, 'hard_invalid');
  assert.equal(peel.noise_reason, 'peel');
  assert.equal(cleanser.target_relevance_class, 'hard_invalid');
  assert.equal(cleanser.noise_reason, 'cleanser');
  assert.equal(hairStyling.target_relevance_class, 'hard_invalid');
  assert.equal(hairStyling.noise_reason, 'hair');
  assert.equal(sample.offer_type, 'sample');
  assert.equal(sample.coarse_valid_for_target, true);
  assert.equal(routine.offer_type, 'bundle');
  assert.equal(routine.target_relevance_class, 'adjacent_noise');
  assert.equal(routine.noise_reason, 'bundle');
});

test('guidance-only moisturizer ranking prefers ceramide core candidates over sensitivity-only supportive candidates', () => {
  const rose = scoreBeautyCandidateForTarget({
    display_name: 'Rose Ceramide Cream',
    category: 'moisturizer',
    description: 'Face moisturizer with ceramides for barrier repair.',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'fragrance-free barrier moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
  });
  const nmf = scoreBeautyCandidateForTarget({
    display_name: 'Natural Moisturizing Factors + PhytoCeramides',
    category: 'moisturizer',
    description: 'Barrier-supporting moisturizer with phytoceramides.',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'fragrance-free barrier moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
  });
  const lait = scoreBeautyCandidateForTarget({
    display_name: 'Lait-Crème Sensitive - Fragrance free',
    category: 'moisturizer',
    description: 'Sensitive skin face cream without fragrance.',
  }, {
    queryTargetStepFamily: 'moisturizer',
    queryText: 'fragrance-free barrier moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
  });

  assert.ok(rose.coarse.target_relevance_class === 'strong_goal_family');
  assert.ok(nmf.coarse.target_relevance_class === 'strong_goal_family');
  assert.ok(lait.coarse.target_relevance_class === 'supportive_family');
  assert.ok(rose.score > lait.score);
  assert.ok(nmf.score > lait.score);
});

test('guidance-only moisturizer decision keeps mini samples behind full-size barrier candidates', () => {
  const decision = buildBeautySkincareHitQualityDecision({
    queryText: 'fragrance-free barrier moisturizer',
    queryTargetStepFamily: 'moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'strong_goal_family',
    mode: 'guidance_only',
    products: [
      {
        product_id: 'sample_1',
        merchant_id: 'external_seed',
        display_name: '5X Ceramide Barrier Repair Moisture Gel (Mini Sample)',
        description: 'Ceramide barrier repair moisturizer for sensitive skin.',
        category: 'moisturizer',
      },
      {
        product_id: 'rose_1',
        merchant_id: 'external_seed',
        display_name: 'Rose Ceramide Cream',
        description: 'Fragrance-free ceramide face cream for sensitive skin.',
        category: 'moisturizer',
      },
      {
        product_id: 'apres_1',
        merchant_id: 'external_seed',
        display_name: 'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
        description: 'Barrier repair moisturizer with ceramides for dry sensitive skin.',
        category: 'moisturizer',
      },
    ],
  });

  const titles = decision.valid_products.map((row) => row.display_name || row.name);
  assert.ok(titles.indexOf('5X Ceramide Barrier Repair Moisture Gel (Mini Sample)') > titles.indexOf('Rose Ceramide Cream'));
  assert.ok(titles.indexOf('5X Ceramide Barrier Repair Moisture Gel (Mini Sample)') > titles.indexOf('Après Skin Rich Rescue Barrier Moisturizer with Ceramides'));
});

test('guidance-only moisturizer display hides weak supportive tails once strong set is sufficient', () => {
  const decision = buildBeautySkincareHitQualityDecision({
    queryText: 'fragrance-free barrier moisturizer',
    queryTargetStepFamily: 'moisturizer',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
    products: [
      {
        product_id: 'apres_1',
        merchant_id: 'external_seed',
        display_name: 'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
        description: 'Barrier repair moisturizer with ceramides for dry sensitive skin.',
        category: 'moisturizer',
      },
      {
        product_id: 'rose_1',
        merchant_id: 'external_seed',
        display_name: 'Rose Ceramide Cream',
        description: 'Fragrance-free ceramide face cream for sensitive skin.',
        category: 'moisturizer',
      },
      {
        product_id: 'nmf_1',
        merchant_id: 'external_seed',
        display_name: 'Natural Moisturizing Factors + PhytoCeramides',
        description: 'Barrier-supporting moisturizer with phytoceramides.',
        category: 'moisturizer',
      },
      {
        product_id: 'sample_1',
        merchant_id: 'external_seed',
        display_name: '5X Ceramide Barrier Repair Moisture Gel (Mini Sample)',
        description: 'Ceramide barrier repair moisturizer for sensitive skin.',
        category: 'moisturizer',
      },
      {
        product_id: 'lait_1',
        merchant_id: 'external_seed',
        display_name: 'Lait-Crème Sensitive - Fragrance free',
        description: 'Sensitive skin face cream without fragrance.',
        category: 'moisturizer',
      },
    ],
  });

  const titles = decision.valid_products.map((row) => row.display_name || row.name);
  assert.deepEqual(titles, [
    'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
    'Rose Ceramide Cream',
    'Natural Moisturizing Factors + PhytoCeramides',
    '5X Ceramide Barrier Repair Moisture Gel (Mini Sample)',
  ]);
});

test('guidance-only serum classifier promotes panthenol repair serum and rejects generic serum fallback', () => {
  const strong = classifyBeautyCoarseCandidate({
    display_name: 'Winona Soothing Repair Serum with Panthenol',
    category: 'serum',
    product_type: 'serum',
  }, {
    queryTargetStepFamily: 'serum',
    queryText: 'panthenol serum',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
  });
  const supportive = classifyBeautyCoarseCandidate({
    display_name: 'Barrier B5 Serum',
    category: 'serum',
    product_type: 'serum',
  }, {
    queryTargetStepFamily: 'serum',
    queryText: 'panthenol serum',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
  });
  const generic = classifyBeautyCoarseCandidate({
    display_name: 'Serum Repulpant Fundamental',
    category: 'serum',
    product_type: 'serum',
  }, {
    queryTargetStepFamily: 'serum',
    queryText: 'panthenol serum',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
  });
  const niacinamide = classifyBeautyCoarseCandidate({
    display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
    category: 'serum',
    product_type: 'serum',
  }, {
    queryTargetStepFamily: 'serum',
    queryText: 'panthenol barrier repair serum',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'strong_goal_family',
    mode: 'guidance_only',
  });
  const tonerEssence = classifyBeautyCoarseCandidate({
    display_name: 'Fat Water Hydrating Milky Toner Essence',
    category: 'essence',
    product_type: 'essence',
  }, {
    queryTargetStepFamily: 'serum',
    queryText: 'panthenol barrier repair serum',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'strong_goal_family',
    mode: 'guidance_only',
  });
  const decision = buildBeautySkincareHitQualityDecision({
    queryText: 'panthenol serum',
    products: [
      {
        title: 'Winona Soothing Repair Serum with Panthenol',
        category: 'serum',
        product_type: 'serum',
      },
      {
        title: 'Barrier B5 Serum',
        category: 'serum',
        product_type: 'serum',
      },
      {
        title: 'Serum Repulpant Fundamental',
        category: 'serum',
        product_type: 'serum',
      },
    ],
    queryTargetStepFamily: 'serum',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
  });

  assert.equal(strong.target_relevance_class, 'strong_goal_family');
  assert.equal(strong.coarse_valid_for_target, true);
  assert.equal(supportive.target_relevance_class, 'strong_goal_family');
  assert.equal(supportive.coarse_valid_for_target, true);
  assert.equal(generic.target_relevance_class, 'generic_family');
  assert.equal(generic.coarse_valid_for_target, false);
  assert.equal(niacinamide.target_relevance_class, 'generic_family');
  assert.equal(niacinamide.coarse_valid_for_target, false);
  assert.equal(tonerEssence.target_relevance_class, 'adjacent_noise');
  assert.equal(tonerEssence.noise_reason, 'adjacent_liquid');
  assert.equal(decision.hit_quality, 'valid_hit');
  assert.equal(decision.step_success_class, 'strong_goal_family');
  assert.equal(decision.success_contract_result?.applied, true);
  assert.equal(decision.success_contract_result?.satisfied, true);
  assert.equal(decision.quality_gate_result?.satisfied, true);
  assert.equal(decision.normalized_intent?.backbone_id, 'serum_panthenol_canary_backbone_v1');
  assert.equal(decision.normalized_intent?.variant_overlay, 'ingredient_fidelity');
  assert.deepEqual(
    decision.valid_products.slice(0, 2).map((product) => String(product?.title || product?.display_name || '')),
    [
      'Winona Soothing Repair Serum with Panthenol',
      'Barrier B5 Serum',
    ],
  );
  assert.equal(
    decision.valid_products.some((product) => /Repulpant/i.test(String(product?.title || product?.display_name || ''))),
    false,
  );
});

test('guidance-only serum classifier still promotes explicit barrier-repair serum without panthenol canary overlay', () => {
  const strong = classifyBeautyCoarseCandidate({
    title: 'Soothing Barrier Repair Serum',
    category: 'serum',
    product_type: 'serum',
  }, {
    queryText: 'barrier repair serum',
    queryTargetStepFamily: 'serum',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
  });

  const decision = buildBeautySkincareHitQualityDecision({
    queryText: 'barrier repair serum',
    products: [
      {
        product_id: 'serum_1',
        merchant_id: 'merchant_serum',
        title: 'Soothing Barrier Repair Serum',
        brand: 'Barrier Lab',
        category: 'serum',
        product_type: 'serum',
      },
    ],
    queryTargetStepFamily: 'serum',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
  });

  assert.equal(strong.target_relevance_class, 'strong_goal_family');
  assert.equal(strong.relevance_channel, 'goal-strong');
  assert.equal(decision.hit_quality, 'valid_hit');
  assert.equal(decision.quality_gate_result?.satisfied, true);
  assert.equal(Array.isArray(decision.valid_products), true);
  assert.equal(decision.valid_products.length, 1);
  assert.equal(String(decision.valid_products[0]?.product_id || ''), 'serum_1');
});

test('guidance-only serum selection applies session exposure penalty and fill metadata', () => {
  const decision = buildBeautySkincareHitQualityDecision({
    queryText: 'panthenol soothing serum',
    products: [
      {
        product_id: 'prod_winona',
        merchant_id: 'merchant_winona',
        title: 'Winona Soothing Repair Serum with Panthenol',
        brand: 'Winona',
        category: 'serum',
        product_type: 'serum',
      },
      {
        product_id: 'prod_b5',
        merchant_id: 'merchant_dermlab',
        title: 'Barrier B5 Serum',
        brand: 'Derm Lab',
        category: 'serum',
        product_type: 'serum',
      },
      {
        product_id: 'prod_cica',
        merchant_id: 'external_seed',
        title: 'Cica Calming Repair Serum',
        brand: 'Skin Calm',
        category: 'serum',
        product_type: 'serum',
      },
    ],
    queryTargetStepFamily: 'serum',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
    sessionSeenProductIds: ['prod_winona'],
  });

  assert.equal(decision.hit_quality, 'valid_hit');
  assert.equal(decision.fill_target_count, 3);
  assert.equal(decision.fill_completed_count, 3);
  assert.equal(decision.coverage_limited_after_fill, false);
  assert.equal(decision.selection_diversity?.session_exposure_penalty_applied, true);
  assert.equal(decision.selection_diversity?.same_canonical_intent_top1_repeat_rate, 0);
  assert.equal(String(decision.valid_products[0]?.product_id || ''), 'prod_b5');
  assert.deepEqual(decision.candidate_origin_counts, {
    internal_live: 2,
    external_supplement: 1,
    stable_prior: 0,
  });
});

test('guidance-only serum keeps stable-prior rows out of normal canary pool when live coverage is sufficient', () => {
  const decision = buildBeautySkincareHitQualityDecision({
    queryText: 'panthenol soothing serum',
    products: [
      {
        product_id: 'prod_winona',
        merchant_id: 'merchant_winona',
        title: 'Winona Soothing Repair Serum with Panthenol',
        brand: 'Winona',
        category: 'serum',
        product_type: 'serum',
      },
      {
        product_id: 'prod_b5',
        merchant_id: 'merchant_dermlab',
        title: 'Barrier B5 Serum',
        brand: 'Derm Lab',
        category: 'serum',
        product_type: 'serum',
      },
      {
        product_id: 'stable_prior_serum',
        merchant_id: 'merchant_prior',
        title: 'Calming Repair Serum',
        brand: 'Legacy Skin',
        category: 'serum',
        product_type: 'serum',
        retrieval_reason: 'catalog_transient_fallback_structured',
      },
    ],
    queryTargetStepFamily: 'serum',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
  });

  assert.equal(decision.hit_quality, 'valid_hit');
  assert.equal(decision.stable_prior_applied, false);
  assert.equal(decision.fallback_mode, 'normal');
  assert.equal(decision.valid_scoping_dropped_count, 1);
  assert.deepEqual(decision.candidate_class_counts, {
    strong_goal_family: 2,
  });
  assert.deepEqual(
    decision.valid_products.map((product) => String(product?.product_id || '')),
    ['prod_winona', 'prod_b5'],
  );
});

test('guidance-only serum can use stable-prior fallback after quality pass when coverage stays below minimum', () => {
  const decision = buildBeautySkincareHitQualityDecision({
    queryText: 'panthenol soothing serum',
    products: [
      {
        product_id: 'prod_winona',
        merchant_id: 'merchant_winona',
        title: 'Winona Soothing Repair Serum with Panthenol',
        brand: 'Winona',
        category: 'serum',
        product_type: 'serum',
      },
      {
        product_id: 'stable_prior_serum',
        merchant_id: 'merchant_prior',
        title: 'Cica Calming Repair Serum',
        brand: 'Legacy Skin',
        category: 'serum',
        product_type: 'serum',
        retrieval_reason: 'catalog_transient_fallback_structured',
      },
    ],
    queryTargetStepFamily: 'serum',
    guidanceOnlyDiscovery: true,
    queryStepStrength: 'supportive_family',
    mode: 'guidance_only',
  });

  assert.equal(decision.hit_quality, 'valid_hit');
  assert.equal(decision.quality_gate_result?.satisfied, true);
  assert.equal(decision.coverage_limited_after_fill, true);
  assert.equal(decision.fill_completed_count, 1);
  assert.equal(decision.stable_prior_applied, true);
  assert.equal(decision.stable_prior_source, 'catalog_transient_fallback');
  assert.equal(decision.fallback_mode, 'stable_prior_fill');
  assert.deepEqual(decision.candidate_origin_counts, {
    internal_live: 1,
    external_supplement: 0,
    stable_prior: 1,
  });
  assert.deepEqual(
    decision.valid_products.map((product) => String(product?.product_id || '')),
    ['prod_winona', 'stable_prior_serum'],
  );
});

test('medium-confidence target only succeeds when same-family viable candidates exist', () => {
  const targetContext = resolveRecommendationTargetContext({
    text: 'I need something for night',
    entryType: 'chat',
  });
  assert.equal(targetContext.resolved_target_step_confidence, 'medium');

  const successPool = finalizeRecommendationCandidatePools(
    [
      {
        product_id: 'night_cream_1',
        merchant_id: 'mid_night_cream',
        brand: 'GoodSkin',
        name: 'Night Barrier Cream',
        display_name: 'Night Barrier Cream',
        category: 'night cream',
        product_type: 'cream',
      },
    ],
    { targetContext },
  );
  assert.equal(successPool.terminal_success, true);

  const clarifyPool = finalizeRecommendationCandidatePools(
    [
      {
        product_id: 'sleep_mask_1',
        merchant_id: 'mid_sleep_mask',
        brand: 'GoodSkin',
        name: 'Sleeping Mask',
        display_name: 'Sleeping Mask',
        category: 'sleeping mask',
        product_type: 'mask',
      },
    ],
    { targetContext },
  );
  assert.equal(clarifyPool.terminal_success, false);
  assert.equal(clarifyPool.viable_candidate_count, 0);
  assert.equal(clarifyPool.soft_mismatch_count, 0);
  assert.equal(clarifyPool.hard_reject_count, 1);
  assert.equal(clarifyPool.weak_viable_pool, false);
  assert.equal(clarifyPool.viable_pool_strength, 'empty');
  assert.equal(clarifyPool.same_family_success_threshold_met, false);
  assert.equal(clarifyPool.success_contract_result?.failure_class, 'hard_invalid_only');
  assert.equal(clarifyPool.retrieval_success_class, 'hard_invalid_only');
});

test('soft-target mainline only succeeds with same-family viable candidates', () => {
  const successTargetContext = resolveRecommendationTargetContext({
    focus: 'barrier cream',
    entryType: 'chat',
  });
  const successState = finalizeRecommendationCandidatePools([
    {
      product_id: 'cream_1',
      merchant_id: 'm1',
      brand: 'GoodSkin',
      name: 'Barrier Cream',
      category: 'face cream',
      product_type: 'cream',
    },
  ], { targetContext: successTargetContext });
  const weakState = finalizeRecommendationCandidatePools([
    {
      product_id: 'mask_1',
      merchant_id: 'm2',
      brand: 'GoodSkin',
      name: 'Sleeping Mask',
      category: 'sleeping mask',
      product_type: 'mask',
    },
  ], { targetContext: successTargetContext });

  assert.equal(successTargetContext.mainline_mode, 'soft_target');
  assert.equal(successState.terminal_success, true);
  assert.equal(shouldStopStepAwareBroadening(successState, { targetContext: successTargetContext }), true);
  assert.equal(weakState.terminal_success, false);
  assert.equal(weakState.weak_viable_pool, false);
  assert.equal(weakState.viable_pool_strength, 'empty');
  assert.equal(weakState.same_family_success_threshold_met, false);
  assert.equal(weakState.success_contract_result?.failure_class, 'hard_invalid_only');
  assert.equal(weakState.retrieval_success_class, 'hard_invalid_only');
  assert.equal(deriveStepAwareEmptyReason(successTargetContext, weakState), 'no_viable_candidates_for_target');
});

test('runRecommendationSharedStack clarifies generic chat reco when minimum context is unsatisfied', async () => {
  let coreRunnerCalled = false;
  const out = await runRecommendationSharedStack({
    entryType: 'chat',
    message: 'Recommend a few products',
    profile: { goals: ['hydration'] },
    coreRunner: async () => {
      coreRunnerCalled = true;
      throw new Error('coreRunner should not be called for clarify-first chat reco');
    },
    coreInput: {},
  });

  assert.equal(coreRunnerCalled, false);
  assert.equal(out.needs_more_context, true);
  assert.equal(out.request_context.context_source_mode, 'explicit_only');
  assert.equal(out.request_context.analysis_context_available, true);
  assert.equal(out.request_context.minimum_recommendation_context_satisfied, false);
  assert.ok(out.request_context.request_context_signature);
  assert.equal(out.request_context.request_context_signature_version, REQUEST_CONTEXT_SIGNATURE_VERSION);
  assert.ok(out.candidate_pool.candidate_pool_signature);
  assert.equal(out.candidate_pool.candidate_pool_signature_version, CANDIDATE_POOL_SIGNATURE_VERSION);
  assert.equal(out.core_result.fallback_mode, 'chat_clarify_needed_for_missing_target_need');
  assert.equal(out.core_result.debug_meta.mainline_status, 'needs_more_context');
});

test('runRecommendationSharedStack executes when explicit-only context satisfies readiness', async () => {
  const out = await runRecommendationSharedStack({
    entryType: 'chat',
    message: 'Recommend a few products',
    profile: {
      skinType: 'dry',
      sensitivity: 'high',
      goals: ['hydration'],
    },
    coreRunner: async (input) => {
      assert.equal(input.sharedRequestContext.minimum_recommendation_context_satisfied, true);
      return {
        norm: {
          payload: {
            recommendations: [{ brand: 'CeraVe', name: 'Hydrating Cleanser' }],
            recommendation_meta: {
              source_mode: 'catalog_grounded',
              analysis_context_usage: input.sharedRequestContext.context_usage,
            },
          },
        },
        mainlineStatus: 'grounded_success',
        candidatePool: [{ product_id: 'sku_1', brand: 'CeraVe', name: 'Hydrating Cleanser' }],
        poolSource: 'catalog_candidates',
      };
    },
    coreInput: {},
  });

  assert.equal(out.needs_more_context, false);
  assert.equal(out.request_context.context_source_mode, 'explicit_only');
  assert.equal(out.request_context.analysis_context_available, true);
  assert.equal(out.request_context.minimum_recommendation_context_satisfied, true);
  assert.equal(out.request_context.request_context_signature_version, REQUEST_CONTEXT_SIGNATURE_VERSION);
  assert.equal(out.candidate_pool.candidate_pool_signature_version, CANDIDATE_POOL_SIGNATURE_VERSION);
  assert.equal(out.core_result.debug_meta.mainline_status, 'grounded_success');
  assert.equal(
    out.raw.norm.payload.recommendation_meta.analysis_context_usage.minimum_recommendation_context_satisfied,
    true,
  );
});
