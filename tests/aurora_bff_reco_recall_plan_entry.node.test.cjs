const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');

test('framework external-seed recall entry uses strict ingredient-intent search params without semantic mainline contract', async () => {
  const calls = [];
  const recallPlan = {
    mode: 'framework_generic',
    entries: [
      {
        query: 'niacinamide serum oily skin',
      },
    ],
    stages: [
      {
        stage_id: 'framework_stage_b_primary_external_seed',
        role_id: 'oil_control_treatment',
        role_rank: 1,
        source_scope: 'external_seed',
        concurrency: 1,
        max_attempts_for_stage: 1,
        entries: [
          {
            query: 'niacinamide serum oily skin',
            role_id: 'oil_control_treatment',
            role_rank: 1,
            preferred_step: 'treatment',
            semantic_family: 'oil_control',
            source_scope: 'external_seed',
            external_seed_strategy: 'stage_planned',
          },
        ],
      },
    ],
  };

  await __internal.collectRecoCandidatesFromRecallPlan({
    recallPlan,
    targetContext: {
      primary_role_id: 'oil_control_treatment',
      framework_roles: [
        {
          role_id: 'oil_control_treatment',
          rank: 1,
          preferred_step: 'treatment',
          semantic_family: 'oil_control',
        },
      ],
    },
    logger: null,
    timeoutMs: 1000,
    limit: 6,
    usePurchasableFallback: false,
    semanticContract: {
      version: 'beauty_semantic_contract_v1',
      planner_mode: 'framework_generic',
      target_step_family: 'treatment',
      primary_role_id: 'oil_control_treatment',
      semantic_family: 'oil_control',
    },
    searchFn: async (params) => {
      calls.push({
        allowExternalSeed: params.allowExternalSeed === true,
        externalSeedStrategy: params.externalSeedStrategy,
        fastMode: params.fastMode === true,
        catalogSurface: params.catalogSurface,
        productOnly: params.productOnly === true,
        targetStepFamily: String(params.targetStepFamily || ''),
        semanticFamily: String(params.semanticFamily || ''),
        queryStepStrength: String(params.queryStepStrength || ''),
        semanticContract: params.semanticContract ?? null,
        transportPolicyMode: params.transportPolicy?.mode || null,
        transportForceGenericOnly: params.transportPolicy?.force_generic_only === true,
        transportIncludeSelfProxy: params.transportPolicy?.include_self_proxy === true,
        transportPreferSelfProxyFirst: params.transportPolicy?.prefer_self_proxy_first === true,
      });
      return {
        ok: true,
        products: [
          {
            product_id: 'ext_niacinamide_1',
            merchant_id: 'external_seed',
            display_name: 'Niacinamide Oil Control Serum',
            category: 'serum',
            candidate_step: 'treatment',
            source: 'external_seed',
            retrieval_source: 'external_seed',
          },
        ],
      };
    },
  });

  assert.deepEqual(calls, [
    {
      allowExternalSeed: true,
      externalSeedStrategy: 'stage_planned',
      fastMode: true,
      catalogSurface: 'beauty',
      productOnly: true,
      targetStepFamily: 'treatment',
      semanticFamily: 'oil_control',
      queryStepStrength: 'strong_goal_family',
      semanticContract: null,
      transportPolicyMode: 'framework_first_turn',
      transportForceGenericOnly: true,
      transportIncludeSelfProxy: false,
      transportPreferSelfProxyFirst: false,
    },
  ]);
});

test('framework recall planner honors targetContext primary role over lower numeric rank', () => {
  const targetContext = {
    primary_role_id: 'hydrating_barrier_moisturizer',
    framework_summary: {
      concern_text: 'my skin feels dry and tight, what should i use first?',
    },
    framework_roles: [
      {
        role_id: 'daily_sunscreen',
        rank: 30,
        preferred_step: 'sunscreen',
        query_terms: ['oil control sunscreen', 'lightweight sunscreen', 'spf fluid'],
      },
      {
        role_id: 'hydrating_barrier_moisturizer',
        rank: 40,
        preferred_step: 'moisturizer',
        query_terms: ['barrier moisturizer', 'ceramide moisturizer', 'hydrating gel cream'],
      },
      {
        role_id: 'hydrating_serum_or_essence',
        rank: 42,
        preferred_step: 'serum',
        query_terms: ['hyaluronic acid serum', 'hydrating serum'],
      },
    ],
  };

  const plan = __internal.buildRecoRecallPlan({
    mode: 'framework_generic',
    targetContext,
  });

  assert.equal(plan.stages[0]?.stage_id, 'framework_stage_a_primary_internal');
  assert.equal(plan.stages[0]?.role_id, 'hydrating_barrier_moisturizer');
  assert.equal(plan.stages[1]?.stage_id, 'framework_stage_b_primary_external_seed');
  assert.equal(plan.stages[1]?.role_id, 'hydrating_barrier_moisturizer');
  assert.ok(plan.stages.slice(2).some((stage) => stage?.role_id === 'daily_sunscreen'));
  assert.ok(
    plan.stages
      .slice(0, 2)
      .flatMap((stage) => Array.isArray(stage?.entries) ? stage.entries : [])
      .every((entry) => entry?.role_id === 'hydrating_barrier_moisturizer'),
  );
  assert.ok(
    plan.stages
      .slice(0, 2)
      .flatMap((stage) => Array.isArray(stage?.entries) ? stage.entries : [])
      .every((entry) => /moisturizer|cream|barrier|ceramide/i.test(String(entry?.query || ''))),
  );

  const queryLevels = __internal.buildRecoCatalogQueryLevels({ targetContext });
  assert.equal(queryLevels[0]?.ladder_level, 'framework_stage_a_primary_internal');
  assert.equal(queryLevels[1]?.ladder_level, 'framework_stage_b_primary_external_seed');
  assert.ok(queryLevels[0]?.queries?.every((entry) => entry.role_id === 'hydrating_barrier_moisturizer'));
  assert.ok(queryLevels[1]?.queries?.every((entry) => entry.role_id === 'hydrating_barrier_moisturizer'));
  assert.ok(
    queryLevels
      .slice(2)
      .some((level) => String(level?.ladder_level || '').includes('daily_sunscreen')),
  );
});

test('framework recall planner keeps barrier support queries role-specific', () => {
  const targetContext = {
    primary_role_id: 'soothing_treatment',
    framework_summary: {
      concern_text: 'redness and stinging due to high sensitivity and impaired barrier',
    },
    framework_roles: [
      {
        role_id: 'soothing_treatment',
        rank: 70,
        preferred_step: 'treatment',
        label: 'Soothing treatment',
        query_terms: ['soothing serum sensitive skin', 'cica serum redness', 'panthenol treatment'],
        fit_keywords: ['soothing', 'cica', 'panthenol', 'redness', 'calming'],
      },
      {
        role_id: 'barrier_moisturizer',
        rank: 41,
        preferred_step: 'moisturizer',
        label: 'Barrier-support moisturizer',
        query_terms: ['barrier repair moisturizer', 'ceramide cream sensitive skin', 'soothing moisturizer'],
        fit_keywords: ['barrier repair', 'ceramide', 'soothing', 'sensitive skin', 'fragrance free'],
      },
      {
        role_id: 'daily_sunscreen',
        rank: 30,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen',
        query_terms: ['daily sunscreen skincare', 'broad spectrum sunscreen', 'lightweight sunscreen'],
        fit_keywords: ['spf', 'uv filters', 'broad spectrum', 'lightweight'],
      },
    ],
  };

  const plan = __internal.buildRecoRecallPlan({
    mode: 'framework_generic',
    targetContext,
  });
  const barrierStage = plan.stages.find((stage) => stage?.stage_id === 'framework_stage_c_support_barrier_moisturizer');
  const barrierQueries = (barrierStage?.entries || []).map((entry) => entry.query);

  assert.deepEqual(
    barrierQueries,
    ['barrier repair moisturizer', 'ceramide cream sensitive skin'],
  );
  assert.equal(barrierQueries.includes('lightweight moisturizer'), false);
});

test('framework recall planner does not let global makeup-layering context override barrier support queries', () => {
  const targetContext = {
    primary_role_id: 'daily_sunscreen_finish_fit',
    framework_summary: {
      concern_text: 'daytime products pill under makeup with impaired barrier',
    },
    framework_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 30,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen finish fit',
        query_terms: ['sunscreen', 'spf fluid oily skin'],
        fit_keywords: ['spf', 'lightweight finish', 'makeup friendly'],
      },
      {
        role_id: 'layering_compatible_moisturizer_or_spf',
        rank: 60,
        preferred_step: 'moisturizer',
        label: 'Layering-compatible moisturizer or SPF',
        query_terms: ['gel cream moisturizer', 'lightweight moisturizer', 'makeup layering'],
        fit_keywords: ['lightweight', 'layering', 'non-greasy', 'makeup'],
      },
      {
        role_id: 'barrier_moisturizer',
        rank: 41,
        preferred_step: 'moisturizer',
        label: 'Barrier-support moisturizer',
        query_terms: ['barrier repair moisturizer', 'ceramide cream sensitive skin', 'soothing moisturizer'],
        fit_keywords: ['barrier repair', 'ceramide', 'soothing', 'sensitive skin'],
      },
    ],
  };

  const plan = __internal.buildRecoRecallPlan({
    mode: 'framework_generic',
    targetContext,
  });
  const layeringStage = plan.stages.find((stage) =>
    stage?.stage_id === 'framework_stage_c_support_layering_compatible_moisturizer_or_spf'
  );
  const barrierStage = plan.stages.find((stage) => stage?.stage_id === 'framework_stage_c_support_barrier_moisturizer');
  const layeringQueries = (layeringStage?.entries || []).map((entry) => entry.query);
  const barrierQueries = (barrierStage?.entries || []).map((entry) => entry.query);

  assert.deepEqual(layeringQueries.slice(0, 2), ['gel cream moisturizer', 'lightweight moisturizer']);
  assert.deepEqual(barrierQueries.slice(0, 2), ['barrier repair moisturizer', 'ceramide cream sensitive skin']);
  assert.equal(barrierQueries.includes('gel cream moisturizer'), false);
});

test('framework recall planner preserves semantic support role order after primary promotion', () => {
  const targetContext = {
    primary_role_id: 'soothing_treatment',
    framework_summary: {
      concern_text: 'redness and stinging due to high sensitivity and impaired barrier',
    },
    framework_roles: [
      {
        role_id: 'soothing_treatment',
        rank: 70,
        preferred_step: 'treatment',
        label: 'Soothing treatment',
        query_terms: ['soothing serum sensitive skin', 'cica serum redness', 'panthenol treatment'],
      },
      {
        role_id: 'barrier_moisturizer',
        rank: 41,
        preferred_step: 'moisturizer',
        label: 'Barrier-support moisturizer',
        query_terms: ['barrier repair moisturizer', 'ceramide cream sensitive skin', 'soothing moisturizer'],
      },
      {
        role_id: 'daily_sunscreen',
        rank: 30,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen',
        query_terms: ['daily sunscreen skincare', 'broad spectrum sunscreen', 'lightweight sunscreen'],
      },
    ],
  };

  const plan = __internal.buildRecoRecallPlan({
    mode: 'framework_generic',
    targetContext,
  });

  assert.deepEqual(
    plan.stages.map((stage) => [stage?.stage_id, stage?.source_scope, stage?.role_id]),
    [
      ['framework_stage_a_primary_internal', 'internal', 'soothing_treatment'],
      ['framework_stage_b_primary_external_seed', 'external_seed', 'soothing_treatment'],
      ['framework_stage_c_support_barrier_moisturizer', 'internal', 'barrier_moisturizer'],
      ['framework_stage_c_support_barrier_moisturizer_external_seed', 'external_seed', 'barrier_moisturizer'],
      ['framework_stage_c_support_daily_sunscreen', 'internal', 'daily_sunscreen'],
      ['framework_stage_c_support_daily_sunscreen_external_seed', 'external_seed', 'daily_sunscreen'],
    ],
  );
});

test('framework recall planner preserves exact product anchor queries ahead of generic sunscreen queries', () => {
  const targetContext = {
    primary_role_id: 'daily_sunscreen_finish_fit',
    comparison_mode: 'same_role_comparison',
    framework_summary: {
      concern_text: 'oily skin sunscreen under makeup',
    },
    framework_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 1,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen with finish fit',
        query_terms: ['spf fluid oily skin', 'sunscreen under makeup', 'lightweight sunscreen oily skin'],
        exact_product_anchor_query_terms: [
          'Beauty of Joseon Relief Sun Aqua-Fresh Rice + B5 SPF50+ PA++++',
          'Relief Sun Aqua-Fresh Rice + B5 SPF50+ PA++++',
          'Beauty of Joseon Relief Sun Aqua-Fresh Rice B5 SPF50',
        ],
        fit_keywords: ['oily skin', 'under makeup', 'fluid'],
      },
    ],
  };

  const plan = __internal.buildRecoRecallPlan({
    mode: 'framework_generic',
    targetContext,
  });
  const primaryExternalStage = plan.stages.find(
    (stage) => stage?.stage_id === 'framework_stage_b_primary_external_seed',
  );
  const queries = (primaryExternalStage?.entries || []).map((entry) => entry.query);

  assert.deepEqual(queries.slice(0, 3), [
    'Beauty of Joseon Relief Sun Aqua-Fresh Rice + B5 SPF50+ PA++++',
    'Relief Sun Aqua-Fresh Rice + B5 SPF50+ PA++++',
    'Beauty of Joseon Relief Sun Aqua-Fresh Rice B5 SPF50',
  ]);
  assert.ok(queries.some((query) => /spf fluid oily skin|sunscreen under makeup|lightweight sunscreen/i.test(query)));
});
