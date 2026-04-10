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
