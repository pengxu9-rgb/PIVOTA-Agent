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
const { classifyBeautyCoarseCandidate } = require('../src/shared/beautyRecoCoarseClassifier');

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
  assert.equal(pool.viable[0].context_fit_score > pool.viable[1].context_fit_score, true);
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
  assert.equal(clarifyPool.soft_mismatch_count, 1);
  assert.equal(clarifyPool.weak_viable_pool, true);
  assert.equal(clarifyPool.viable_pool_strength, 'weak');
  assert.equal(clarifyPool.same_family_success_threshold_met, false);
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
  assert.equal(weakState.weak_viable_pool, true);
  assert.equal(weakState.viable_pool_strength, 'weak');
  assert.equal(weakState.same_family_success_threshold_met, false);
  assert.equal(deriveStepAwareEmptyReason(successTargetContext, weakState), 'weak_viable_pool_for_target');
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
