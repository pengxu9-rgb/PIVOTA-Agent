const test = require('node:test');
const assert = require('node:assert/strict');
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

const { createBeautyChatMainlineEntryRuntime } = require('../src/auroraBff/beautyChatMainlineEntry');
const { createBeautyChatMainlineEnvelopeRuntime } = require('../src/auroraBff/beautyChatMainlineEnvelope');
const { resolveRecommendationTargetContext } = require('../src/auroraBff/recommendationSharedStack');

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('deriveBeautyMainlineHandoff keeps explicit sunscreen asks on step-aware sunscreen semantics', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.deriveBeautyMainlineHandoff({
      primaryQuery: 'best sunscreen for oily skin',
      fallbackMessage: 'best sunscreen for oily skin',
      targetContext: resolveRecommendationTargetContext({
        text: 'best sunscreen for oily skin',
        focus: '',
        entryType: 'chat',
      }),
    });

    assert.equal(out.targetContext?.resolved_target_step, 'sunscreen');
    assert.equal(out.targetContext?.primary_role_id, 'daily_sunscreen_finish_fit');
    assert.equal(out.semanticContract?.planner_mode, 'step_aware');
    assert.equal(out.semanticContract?.target_step_family, 'sunscreen');
    assert.equal(out.semanticContract?.primary_role_id, 'daily_sunscreen_finish_fit');
    assert.equal(out.semanticContract?.semantic_family, 'sunscreen');
    assert.deepEqual(out.semanticContract?.ingredient_hypotheses, ['UV filters']);
  } finally {
    delete require.cache[moduleId];
  }
});

test('deriveBeautyMainlineHandoff preserves explicit treatment semantics for oil-control asks', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.deriveBeautyMainlineHandoff({
      primaryQuery: 'oil control treatment',
      fallbackMessage: 'oil control treatment',
      targetContext: resolveRecommendationTargetContext({
        text: 'oil control treatment',
        focus: '',
        entryType: 'chat',
      }),
    });

    assert.equal(out.targetContext?.resolved_target_step, 'treatment');
    assert.equal(out.semanticContract?.planner_mode, 'step_aware');
    assert.equal(out.semanticContract?.target_step_family, 'treatment');
    assert.equal(out.semanticContract?.primary_role_id, 'oil_control_treatment');
    assert.equal(out.semanticContract?.semantic_family, 'oil_control');
    assert.deepEqual(out.semanticContract?.ingredient_hypotheses, ['Niacinamide', 'Zinc PCA', 'Salicylic acid']);
  } finally {
    delete require.cache[moduleId];
  }
});

test('deriveBeautyMainlineHandoff routes bare makeup pilling asks to sunscreen-led routine semantics', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const query = 'My daytime products pill under makeup. What skincare product should I use instead?';
    const out = __internal.deriveBeautyMainlineHandoff({
      primaryQuery: query,
      fallbackMessage: query,
      targetContext: resolveRecommendationTargetContext({
        text: query,
        focus: '',
        entryType: 'chat',
      }),
    });

    assert.equal(out.targetContext?.resolved_target_step, null);
    assert.equal(out.targetContext?.primary_role_id, 'daily_sunscreen_finish_fit');
    assert.deepEqual(
      out.targetContext?.framework_roles?.map((role) => role?.role_id),
      [
        'daily_sunscreen_finish_fit',
        'layering_compatible_moisturizer_or_spf',
        'hydrating_serum_or_essence',
      ],
    );
    assert.equal(out.semanticContract?.planner_mode, 'framework_generic');
    assert.equal(out.semanticContract?.target_step_family, 'sunscreen');
    assert.equal(out.semanticContract?.primary_role_id, 'daily_sunscreen_finish_fit');
    assert.equal(out.semanticContract?.semantic_family, 'sunscreen');
    assert.deepEqual(
      out.semanticContract?.ingredient_hypotheses,
      ['UV filters', 'Glycerin', 'Panthenol', 'Hyaluronic acid'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('classifyBeautyMainlineHandoffFallback preserves weak viable pool reason from local handoff metadata', () => {
  const runtime = createBeautyChatMainlineEnvelopeRuntime({
    classifyRecoUpstreamFailureCode: () => '',
    isTransientRecoUpstreamFailureCode: () => false,
  });
  const fallback = runtime.classifyBeautyMainlineHandoffFallback({
    handoff: {
      attempted: true,
      searchResult: {
        metadata: {
          search_stage_ledger: {
            candidate_drop_stage: 'weak_viable_pool',
            candidate_pool_summary: {
              weak_viable_pool: true,
              viable_pool_strength: 'weak',
            },
          },
        },
      },
    },
  });

  assert.equal(fallback.notice_reason, 'weak_viable_pool');
  assert.equal(fallback.products_empty_reason, 'weak_viable_pool');
  assert.equal(fallback.telemetry_failure_reason, 'weak_viable_pool');
});

test('handoffRecoToBeautyMainlineSearch passes sunscreen-aligned contract to backend search', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    let captured = null;
    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN' },
      primaryQuery: 'best sunscreen for oily skin',
      fallbackMessage: 'best sunscreen for oily skin',
      targetContext: resolveRecommendationTargetContext({
        text: 'best sunscreen for oily skin',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
      searchFn: async (args) => {
        captured = args;
        return {
          ok: true,
          products: [
            {
              product_id: 'spf_1',
              merchant_id: 'merchant_spf',
              title: 'Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
              category: 'Sunscreen',
              product_type: 'sunscreen',
              candidate_step: 'sunscreen',
            },
          ],
          decision_owner: 'shopping_agent_beauty_mainline',
          query_source: 'agent_products_search',
        };
      },
    });

    assert.equal(captured?.query, 'best sunscreen for oily skin');
    assert.equal(captured?.queryStepStrength, 'exact_step');
    assert.equal(captured?.targetStepFamily, 'sunscreen');
    assert.equal(captured?.semanticFamily, 'sunscreen');
    assert.equal(captured?.allowExternalSeed, true);
    assert.equal(captured?.externalSeedStrategy, 'unified_relevance');
    assert.equal(captured?.transportPolicy?.mode, 'step_aware');
    assert.equal(captured?.transportPolicy?.force_multi_source, true);
    assert.equal(captured?.transportPolicy?.prefer_self_proxy_first, true);
    assert.equal(captured?.transportPolicy?.max_base_urls, 2);
    assert.equal(captured?.transportPolicy?.max_paths, 1);
    assert.equal(captured?.transportPolicy?.allow_secondary_base_failover, true);
    assert.equal(captured?.transportPolicy?.allow_secondary_path_failover, false);
    assert.equal(captured?.transportPolicy?.actual_http_attempt_limit_per_query, 2);
    assert.equal(captured?.transportPolicy?.primary_attempt_timeout_cap_ms, 2500);
    assert.equal(captured?.timeoutMs, 65000);
    assert.equal(captured?.semanticContract?.planner_mode, 'step_aware');
    assert.equal(captured?.semanticContract?.primary_role_id, 'daily_sunscreen_finish_fit');
    assert.deepEqual(captured?.semanticContract?.ingredient_hypotheses, ['UV filters']);
    assert.deepEqual(
      out.recommendations.map((item) => item.display_name),
      ['Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch forces self-proxy-first transport for framework beauty asks', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    let captured = null;
    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN' },
      primaryQuery: 'what products should i use for oily skin?',
      fallbackMessage: 'what products should i use for oily skin?',
      targetContext: resolveRecommendationTargetContext({
        text: 'what products should i use for oily skin?',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
      searchFn: async (args) => {
        captured = args;
        return {
          ok: true,
          products: [],
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
          query_source: 'agent_products_search',
          final_selection: {
            selection_owner: 'shopping_agent_beauty_mainline',
            selected_product_ids: [],
            selected_titles: [],
            selection_signature: null,
            mainline_status: 'empty_structured',
          },
          search_stage_ledger: {
            final_selection: {
              selection_owner: 'shopping_agent_beauty_mainline',
              selected_product_ids: [],
              selected_titles: [],
              selection_signature: null,
              mainline_status: 'empty_structured',
            },
          },
          source_breakdown: {
            source_tier_counts: {},
          },
          contract_bridge: {
            attempted_contract: 'agent_v1_search_beauty_mainline',
            resolved_contract: 'agent_v1_search_beauty_mainline',
          },
        };
      },
    });

    assert.equal(captured?.query, 'what products should i use for oily skin?');
    assert.equal(captured?.transportPolicy?.mode, 'framework_first_turn');
    assert.equal(captured?.transportPolicy?.force_multi_source, true);
    assert.equal(captured?.transportPolicy?.prefer_self_proxy_first, true);
    assert.equal(captured?.transportPolicy?.max_base_urls, 2);
    assert.equal(captured?.transportPolicy?.max_paths, 1);
    assert.equal(captured?.transportPolicy?.allow_secondary_base_failover, true);
    assert.equal(captured?.transportPolicy?.allow_secondary_path_failover, false);
    assert.equal(captured?.transportPolicy?.actual_http_attempt_limit_per_query, 2);
    assert.equal(captured?.transportPolicy?.primary_attempt_timeout_cap_ms, 2500);
    assert.equal(captured?.searchSourceOverride, 'aurora-bff');
    assert.equal(captured?.allowExternalSeed, true);
    assert.equal(captured?.externalSeedStrategy, 'unified_relevance');
    assert.equal(captured?.timeoutMs, 30000);
    assert.equal(out?.targetContext?.intent_mode, 'generic_concern');
    assert.equal(out?.targetContext?.step_aware_intent, false);
    assert.equal(out?.targetContext?.primary_role_id, 'oil_control_treatment');
    assert.equal(Array.isArray(out?.targetContext?.framework_roles), true);
    assert.equal(out?.targetContext?.framework_roles?.length, 3);
  } finally {
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch defaults to local beauty mainline over internal primitive for framework asks', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const captured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        captured.push(args);
        const normalizedQuery = String(args?.query || '').trim().toLowerCase();
        const base = {
          ok: true,
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [
            {
              caller_lane: String(args?.callerLane || ''),
              target_base_url: 'https://web-production-fedb.up.railway.app',
              target_path: '/agent/internal/products/search',
              endpoint_kind: 'internal_primitive',
              transport_owner: 'internal_products_search_primitive',
              latency_ms: 12,
              result: normalizedQuery === 'oil control treatment' ? 'ok' : 'empty',
            },
          ],
          transport_hop_count: 1,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
        if (normalizedQuery === 'niacinamide serum oily skin') {
          return {
            ...base,
            products: [
              {
                product_id: 'oil_control_serum_1',
                merchant_id: 'merchant_internal',
                brand: 'GoalSkin',
                name: 'Oil Control Serum',
                display_name: 'GoalSkin Oil Control Serum',
                title: 'GoalSkin Oil Control Serum',
                category: 'Treatment',
                product_type: 'treatment',
                candidate_step: 'treatment',
                retrieval_source: 'internal_search',
                retrieval_reason: 'internal_primitive_match',
              },
            ],
          };
        }
        return {
          ...base,
          products: [],
        };
      },
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_local_handoff' },
      primaryQuery: 'what products should i use for oily skin?',
      fallbackMessage: 'what products should i use for oily skin?',
      targetContext: resolveRecommendationTargetContext({
        text: 'what products should i use for oily skin?',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.equal(captured.length > 0, true);
    assert.equal(captured.every((row) => row?.callerLane === 'beauty_chat_handoff'), true);
    assert.equal(out.searchResult?.query_source, 'beauty_mainline_local_handoff');
    assert.equal(
      out.searchResult?.metadata?.contract_bridge?.resolved_contract,
      'agent_v1_search_beauty_mainline',
    );
    assert.equal(out.searchResult?.metadata?.primary_failure_stage, undefined);
    assert.deepEqual(
      out.searchResult?.metadata?.final_selection?.selected_product_ids,
      ['oil_control_serum_1'],
    );
    assert.deepEqual(
      out.recommendations.map((item) => item.display_name),
      ['GoalSkin Oil Control Serum'],
    );
    assert.deepEqual(
      out.searchResult?.metadata?.semantic_owner_query_attempts?.[0]?.attempted_internal_paths,
      ['/agent/internal/products/search'],
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch clamps local internal primitive timeout by deadline budget', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const captured = [];
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        captured.push({
          timeoutMs: Number(args?.timeoutMs || 0),
          deadlineMs: Number(args?.deadlineMs || 0),
          callerLane: String(args?.callerLane || ''),
        });
        return {
          ok: true,
          products: [],
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
      },
      searchLocalExternalSeedProducts: async (args) => {
        externalCaptured.push({
          query: String(args?.query || ''),
          roleId: String(args?.role?.role_id || ''),
          preferredStep: String(args?.preferredStep || ''),
          transportPolicyMode: String(args?.transportPolicyMode || ''),
        });
        return {
          ok: false,
          products: [],
          reason: 'empty',
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
          local_external_seed_search_mode: 'staged_support_fastpath',
          local_external_seed_category_terms: ['moisturizer', 'sunscreen'],
          local_external_seed_stage_debug: [
            {
              stage: 'support_category_exact',
              row_count: 0,
              cumulative_row_count: 0,
              duration_ms: 12,
              cap: 6,
            },
          ],
        };
      },
    });

    await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_deadline_handoff' },
      primaryQuery: 'what product should i use for oily skin?',
      fallbackMessage: 'what product should i use for oily skin?',
      targetContext: resolveRecommendationTargetContext({
        text: 'what product should i use for oily skin?',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
      deadlineAtMs: Date.now() + 380,
    });

    assert.equal(captured.length > 0, true);
    for (const row of captured) {
      assert.equal(row.callerLane, 'beauty_chat_handoff');
      assert.ok(row.timeoutMs > 0);
      assert.ok(row.timeoutMs < 5000);
      assert.ok(row.timeoutMs <= 380);
      assert.ok(row.deadlineMs > 0);
    }
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch keeps framework local budget when sunscreen is the primary routine role', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const internalCaptured = [];
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        internalCaptured.push({
          query: String(args?.query || ''),
          timeoutMs: Number(args?.timeoutMs || 0),
          callerLane: String(args?.callerLane || ''),
        });
        return {
          ok: true,
          products: [],
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
      },
      searchLocalExternalSeedProducts: async (args) => {
        const roleId = String(args?.role?.role_id || '').trim();
        externalCaptured.push({
          query: String(args?.query || ''),
          roleId,
          preferredStep: String(args?.preferredStep || ''),
        });
        const base = {
          ok: true,
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
        };
        if (roleId === 'daily_sunscreen_finish_fit') {
          return {
            ...base,
            products: [
              {
                product_id: 'mislabelled_wrinkle_corrector',
                merchant_id: 'external_seed',
                title: 'Targeted Wrinkle Corrector',
                display_name: 'Targeted Wrinkle Corrector',
                category: 'Sunscreen',
                product_type: 'Sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['wrinkle', 'fine lines'],
                short_description: 'A wrinkle corrector treatment that is mislabelled as sunscreen.',
                retrieval_source: 'external_seed',
              },
              {
                product_id: 'support_spf_finish_fit',
                merchant_id: 'external_seed',
                title: 'Finish Fit SPF 50 Fluid',
                display_name: 'Finish Fit SPF 50 Fluid',
                category: 'sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['spf', 'under makeup', 'lightweight'],
                short_description: 'A lightweight SPF 50 fluid for daytime layering.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        if (roleId === 'layering_compatible_moisturizer_or_spf') {
          return {
            ...base,
            products: [
              {
                product_id: 'support_layering_water_cream',
                merchant_id: 'external_seed',
                title: 'Oat Water Cream',
                display_name: 'Oat Water Cream',
                category: 'moisturizer',
                product_type: 'moisturizer',
                candidate_step: 'moisturizer',
                benefit_tags: ['lightweight', 'under makeup', 'gel cream'],
                short_description: 'A light water cream for makeup layering.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        return { ...base, products: [], reason: 'empty' };
      },
    });

    const query = 'My daytime products pill under makeup. What skincare product should I use instead?';
    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_framework_sunscreen_budget' },
      primaryQuery: query,
      fallbackMessage: query,
      targetContext: resolveRecommendationTargetContext({
        text: query,
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.equal(out.semanticContract?.planner_mode, 'framework_generic');
    assert.equal(out.semanticContract?.primary_role_id, 'daily_sunscreen_finish_fit');
    assert.equal(internalCaptured.length > 0, true);
    assert.equal(internalCaptured.every((row) => row.callerLane === 'beauty_chat_handoff'), true);
    assert.equal(
      internalCaptured.some((row) => row.timeoutMs === 2500),
      true,
    );
    assert.equal(externalCaptured.some((row) => row.roleId === 'daily_sunscreen_finish_fit'), true);
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.candidate_pool_summary?.hard_reject_preview
        ?.some((row) => (
          row?.title === 'Targeted Wrinkle Corrector'
          && row?.reason === 'framework_sunscreen_identity_conflict'
        )),
      true,
    );
    assert.equal(
      out.recommendations.some((row) => row?.display_name === 'Targeted Wrinkle Corrector'),
      false,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch records primary-first strict-empty ledger without spending support runtime', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const captured = [];
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        captured.push({
          query: String(args?.query || ''),
          callerLane: String(args?.callerLane || ''),
          allowExternalSeed: args?.allowExternalSeed === true,
          timeoutMs: Number(args?.timeoutMs || 0),
          targetStepFamily: String(args?.targetStepFamily || ''),
          semanticFamily: String(args?.semanticFamily || ''),
          queryStepStrength: String(args?.queryStepStrength || ''),
          productOnly: args?.productOnly === true,
          transportPolicy: {
            mode: String(args?.transportPolicy?.mode || ''),
            includeSelfProxy: args?.transportPolicy?.include_self_proxy === true,
            includeLocalFallback: args?.transportPolicy?.include_local_fallback === true,
            forceGenericOnly: args?.transportPolicy?.force_generic_only === true,
            maxBaseUrls: Number(args?.transportPolicy?.max_base_urls || 0),
            maxPaths: Number(args?.transportPolicy?.max_paths || 0),
            actualHttpAttemptLimitPerQuery: Number(
              args?.transportPolicy?.actual_http_attempt_limit_per_query || 0,
            ),
          },
        });
        return {
          ok: true,
          products: [],
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
      },
      searchLocalExternalSeedProducts: async (args) => {
        externalCaptured.push({
          query: String(args?.query || ''),
          roleId: String(args?.role?.role_id || ''),
          preferredStep: String(args?.preferredStep || ''),
          transportPolicyMode: String(args?.transportPolicyMode || ''),
        });
        return {
          ok: false,
          products: [],
          reason: 'empty',
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
          local_external_seed_search_mode: 'staged_support_fastpath',
          local_external_seed_category_terms: ['moisturizer', 'sunscreen'],
          local_external_seed_stage_debug: [
            {
              stage: 'support_category_exact',
              row_count: 0,
              cumulative_row_count: 0,
              duration_ms: 12,
              cap: 6,
            },
          ],
        };
      },
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_skip_duplicate_external_levels' },
      primaryQuery: 'what products should i use for oily skin?',
      fallbackMessage: 'what products should i use for oily skin?',
      targetContext: resolveRecommendationTargetContext({
        text: 'what products should i use for oily skin?',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.deepEqual(
      captured.map((row) => row.query),
      [
        'niacinamide serum oily skin',
        'oil control serum',
      ],
    );
    assert.deepEqual(
      externalCaptured.map((row) => row.query),
      [
        'niacinamide serum oily skin',
        'salicylic acid serum oily skin',
      ],
    );
    assert.equal(captured.every((row) => row.callerLane === 'beauty_chat_handoff'), true);
    assert.equal(captured.slice(0, 2).every((row) => row.timeoutMs === 2500), true);
    assert.equal(captured.slice(2).every((row) => row.timeoutMs === 2400), true);
    assert.equal(captured.every((row) => row.allowExternalSeed === false), true);
    assert.equal(
      captured.slice(0, 2).every((row) =>
        row.targetStepFamily === 'serum'
        && row.semanticFamily === 'oil_control_treatment'
        && row.queryStepStrength === 'strong_goal_family'
        && row.productOnly === true),
      true,
    );
    assert.equal(
      externalCaptured.filter((row) => row.roleId === 'oil_control_treatment').length,
      2,
    );
    assert.equal(
      externalCaptured.filter((row) => row.roleId === 'oil_control_treatment').every((row) =>
        row.roleId === 'oil_control_treatment'
        && row.preferredStep === 'treatment'
        && row.transportPolicyMode === 'framework_first_turn'),
      true,
    );
    assert.equal(
      externalCaptured.filter((row) => row.roleId !== 'oil_control_treatment').map((row) => row.roleId).join(','),
      '',
    );
    assert.equal(
      externalCaptured.filter((row) => row.roleId !== 'oil_control_treatment').every((row) =>
        (
          (row.roleId === 'lightweight_moisturizer' && row.preferredStep === 'moisturizer')
          || (row.roleId === 'daily_sunscreen' && row.preferredStep === 'sunscreen')
        )
        && row.transportPolicyMode === 'framework_first_turn'),
      true,
    );
    assert.equal(out.searchResult?.query_source, 'beauty_mainline_local_handoff');
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.planned_level_count, 6);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_level_count, 4);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_query_count, 13);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.primary_internal_query_cap_applied, true);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.primary_internal_original_query_count, 3);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.primary_internal_executed_query_count, 2);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.routine_support_budget_timeout_cap_ms, undefined);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.primary_external_timeout_cap_applied, undefined);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.support_external_timeout_cap_applied, undefined);
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.primary_search?.execution_lane,
      'beauty_mainline_local_handoff',
    );
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.skipped_external_seed_level_count, 0);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_support_internal_level_count, 2);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.support_internal_fair_round_count, 3);
    assert.deepEqual(
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_support_internal_levels,
      [
        'framework_stage_c_support_lightweight_moisturizer',
        'framework_stage_c_support_daily_sunscreen',
      ],
    );
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_support_external_seed_level_count, 2);
    assert.deepEqual(
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_support_external_seed_levels,
      [
        'framework_stage_c_support_lightweight_moisturizer_external_seed',
        'framework_stage_c_support_daily_sunscreen_external_seed',
      ],
    );
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.routine_support_strategy,
      'primary_external_parallel_support_authority_rounds',
    );
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.primary_external_parallel_round_count,
      2,
    );
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_support_level_count, 4);
    assert.deepEqual(
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_support_levels,
      [
        'framework_stage_c_support_lightweight_moisturizer',
        'framework_stage_c_support_daily_sunscreen',
        'framework_stage_c_support_lightweight_moisturizer_external_seed',
        'framework_stage_c_support_daily_sunscreen_external_seed',
      ],
    );
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.skipped_support_level_count, undefined);
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.transport_policy_mode,
      'framework_first_turn',
    );
    assert.deepEqual(
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts?.map((row) => row?.source_scope),
      ['internal', 'internal', 'external_seed', 'external_seed', 'external_seed', 'internal', 'internal', 'external_seed', 'external_seed', 'external_seed', 'internal', 'internal', 'internal'],
    );
    assert.deepEqual(
      out.searchResult?.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts?.map((row) => row?.source_scope),
      ['internal', 'internal', 'external_seed', 'external_seed', 'external_seed', 'internal', 'internal', 'external_seed', 'external_seed', 'external_seed', 'internal', 'internal', 'internal'],
    );
    const supportAttempts = out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts
      ?.filter((row) => String(row?.ladder_level || '').startsWith('framework_stage_c_support_')) || [];
    assert.equal(supportAttempts.some((row) => row?.reason === 'primary_role_unmatched'), true);
    assert.equal(supportAttempts.some((row) => row?.reason !== 'primary_role_unmatched'), false);
    const skippedSupportExternalAttempt =
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts
        ?.find((row) =>
          row?.ladder_level === 'framework_stage_c_support_lightweight_moisturizer_external_seed'
          && row?.reason === 'primary_role_unmatched')
      || out.searchResult?.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts
        ?.find((row) =>
          row?.ladder_level === 'framework_stage_c_support_lightweight_moisturizer_external_seed'
          && row?.reason === 'primary_role_unmatched');
    assert.ok(skippedSupportExternalAttempt);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.skipped_external_seed_levels, undefined);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.skipped_support_levels, undefined);
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch runs finish-fit sunscreen external queries before broad category heads', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async () => ({
        ok: true,
        products: [],
        attempted_internal_paths: ['/agent/internal/products/search'],
        transport_hops: [],
        transport_hop_count: 0,
        nested_orchestrator_hops: 0,
        primary_transport_owner: 'internal_products_search_primitive',
        primary_endpoint_kind: 'internal_primitive',
      }),
      searchLocalExternalSeedProducts: async (args) => {
        externalCaptured.push({
          query: String(args?.query || ''),
          roleId: String(args?.role?.role_id || ''),
        });
        return {
          ok: false,
          products: [],
          reason: 'empty',
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
          local_external_seed_search_mode: 'staged_support_fastpath',
          local_external_seed_stage_debug: [],
        };
      },
    });

    const query = 'My daytime products pill under makeup. What skincare product should I use instead?';
    await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_makeup_pilling_query_order' },
      primaryQuery: query,
      fallbackMessage: query,
      targetContext: resolveRecommendationTargetContext({
        text: query,
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.deepEqual(
      externalCaptured
        .filter((row) => row.roleId === 'daily_sunscreen_finish_fit')
        .map((row) => row.query),
      [
        'spf fluid oily skin',
        'lightweight sunscreen oily skin',
      ],
    );
    assert.equal(
      externalCaptured.some((row) => row.query === 'sunscreen'),
      false,
    );
    assert.equal(
      externalCaptured.some((row) => /My daytime products pill under makeup/i.test(row.query)),
      false,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch keeps same-role finish-fit external stage open after the first viable query', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async () => ({
        ok: true,
        products: [],
        attempted_internal_paths: ['/agent/internal/products/search'],
        transport_hops: [],
        transport_hop_count: 0,
        nested_orchestrator_hops: 0,
        primary_transport_owner: 'internal_products_search_primitive',
        primary_endpoint_kind: 'internal_primitive',
      }),
      searchLocalExternalSeedProducts: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        const roleId = String(args?.role?.role_id || '');
        externalCaptured.push({ query, roleId });
        const base = {
          ok: true,
          reason: null,
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
          local_external_seed_search_mode: 'staged_support_fastpath',
          local_external_seed_stage_debug: [{ stage: 'support_category_positive', row_count: 1, cumulative_row_count: 1, duration_ms: 4, cap: 6 }],
        };
        if (roleId !== 'daily_sunscreen_finish_fit') {
          return { ...base, ok: false, products: [], reason: 'empty' };
        }
        if (query === 'spf fluid oily skin') {
          return {
            ...base,
            products: [
              {
                product_id: 'same_role_spf_1',
                merchant_id: 'external_seed',
                brand: 'TestSkin',
                name: 'Fluid Shield SPF 50',
                display_name: 'TestSkin Fluid Shield SPF 50',
                title: 'TestSkin Fluid Shield SPF 50',
                category: 'Sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['sunscreen', 'lightweight finish', 'under makeup'],
                short_description: 'A lightweight sunscreen fluid for daytime layering.',
                retrieval_source: 'external_seed',
              },
              {
                product_id: 'same_role_spf_2',
                merchant_id: 'external_seed',
                brand: 'TestSkin',
                name: 'Cloud Veil SPF 45',
                display_name: 'TestSkin Cloud Veil SPF 45',
                title: 'TestSkin Cloud Veil SPF 45',
                category: 'Sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['sunscreen', 'lightweight finish'],
                short_description: 'A lightweight daily sunscreen.',
                retrieval_source: 'external_seed',
              },
              {
                product_id: 'same_role_spf_3',
                merchant_id: 'external_seed',
                brand: 'TestSkin',
                name: 'Soft Screen SPF 40',
                display_name: 'TestSkin Soft Screen SPF 40',
                title: 'TestSkin Soft Screen SPF 40',
                category: 'Sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['sunscreen', 'lightweight'],
                short_description: 'A soft-finish sunscreen for everyday wear.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        if (query === 'sunscreen under makeup') {
          return {
            ...base,
            products: [
              {
                product_id: 'same_role_spf_4',
                merchant_id: 'external_seed',
                brand: 'MineralCo',
                name: 'Silk Mineral Veil SPF 30',
                display_name: 'MineralCo Silk Mineral Veil SPF 30',
                title: 'MineralCo Silk Mineral Veil SPF 30',
                category: 'Sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['sunscreen', 'mineral', 'under makeup'],
                short_description: 'A sheer mineral sunscreen designed for under-makeup wear.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        return {
          ...base,
          ok: false,
          products: [],
          reason: 'empty',
        };
      },
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_same_role_finish_fit_external_open' },
      primaryQuery: 'What should I buy for daytime so my makeup stops pilling?',
      fallbackMessage: 'What should I buy for daytime so my makeup stops pilling?',
      targetContext: {
        primary_role_id: 'daily_sunscreen_finish_fit',
        comparison_mode: 'same_role_comparison',
        routine_mode: 'same_role_comparison',
        semantic_plan: {
          routine_mode: 'same_role_comparison',
          comparison_mode: 'same_role_comparison',
          selection_constraints: { comparison_mode: 'same_role_comparison' },
        },
        framework_summary: {
          concern_text: 'daytime sunscreen under makeup',
        },
        framework_roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            rank: 1,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen finish fit',
            query_terms: ['spf fluid oily skin', 'sunscreen under makeup', 'lightweight sunscreen oily skin'],
            fit_keywords: ['spf', 'lightweight finish', 'makeup friendly', 'under makeup'],
          },
        ],
        support_roles: [],
      },
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.deepEqual(
      externalCaptured.slice(0, 2),
      [
        { query: 'spf fluid oily skin', roleId: 'daily_sunscreen_finish_fit' },
        { query: 'sunscreen under makeup', roleId: 'daily_sunscreen_finish_fit' },
      ],
    );
    const primaryExternalQueries = (out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts || [])
      .filter((row) => row?.ladder_level === 'framework_stage_b_primary_external_seed')
      .map((row) => ({ query: row?.query, result_count: Number(row?.result_count || 0) }));
    assert.deepEqual(
      primaryExternalQueries.slice(0, 2),
      [
        { query: 'spf fluid oily skin', result_count: 3 },
        { query: 'sunscreen under makeup', result_count: 1 },
      ],
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch recovers acne primary from second planned primary query before support', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const internalCaptured = [];
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        internalCaptured.push(query);
        const base = {
          ok: true,
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
        if (query === 'salicylic acid serum clogged pores') {
          return {
            ...base,
            products: [
              {
                product_id: 'acne_primary_1',
                merchant_id: 'merchant_internal',
                brand: 'ClearLab',
                name: 'Pore Clearing BHA Serum',
                display_name: 'ClearLab Pore Clearing BHA Serum',
                title: 'ClearLab Pore Clearing BHA Serum',
                category: 'Serum',
                product_type: 'serum',
                candidate_step: 'treatment',
                benefit_tags: ['clogged pores', 'blemish support'],
                short_description: 'A salicylic acid serum for clogged pores and breakout-prone skin.',
                retrieval_source: 'catalog',
              },
            ],
          };
        }
        return {
          ...base,
          products: [],
        };
      },
      searchLocalExternalSeedProducts: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        externalCaptured.push(query);
        const base = {
          ok: true,
          reason: null,
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
          local_external_seed_search_mode: 'staged_support_fastpath',
          local_external_seed_stage_debug: [{ stage: 'support_category_exact', row_count: 1, cumulative_row_count: 1, duration_ms: 5, cap: 6 }],
        };
        if (query === 'gel cream moisturizer') {
          return {
            ...base,
            products: [
              {
                product_id: 'support_moist_1',
                merchant_id: 'external_seed',
                brand: 'LightLab',
                name: 'Oil-Free Gel Cream',
                display_name: 'LightLab Oil-Free Gel Cream',
                title: 'LightLab Oil-Free Gel Cream',
                category: 'Moisturizer',
                product_type: 'moisturizer',
                candidate_step: 'moisturizer',
                retrieval_source: 'external_seed',
                short_description: 'Lightweight moisturizer for oily skin.',
              },
            ],
          };
        }
        if (query === 'sunscreen') {
          return {
            ...base,
            products: [
              {
                product_id: 'support_spf_1',
                merchant_id: 'external_seed',
                brand: 'SunLab',
                name: 'Daily SPF Fluid',
                display_name: 'SunLab Daily SPF Fluid',
                title: 'SunLab Daily SPF Fluid',
                category: 'Sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                retrieval_source: 'external_seed',
                short_description: 'Lightweight daily sunscreen fluid.',
              },
            ],
          };
        }
        return {
          ...base,
          ok: false,
          products: [],
          reason: 'empty',
        };
      },
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_acne_second_primary_query' },
      primaryQuery: 'acne-prone clogged pores, what product should i use first?',
      fallbackMessage: 'acne-prone clogged pores, what product should i use first?',
      targetContext: resolveRecommendationTargetContext({
        text: 'acne-prone clogged pores, what product should i use first?',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.deepEqual(internalCaptured.slice(0, 2), [
      'Salicylic acid treatment'.toLowerCase(),
      'salicylic acid serum clogged pores',
    ]);
    assert.equal(externalCaptured.includes('niacinamide serum oily skin'), false);
    assert.equal(out.searchResult?.metadata?.candidate_pool_summary?.primary_role_matched, true);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.candidate_drop_stage, 'none');
    assert.deepEqual(
      out.recommendations.map((item) => item.product_id).sort(),
      ['acne_primary_1', 'support_moist_1', 'support_spf_1'].sort(),
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch uses source-aware support authority while primary external is pending', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const internalCaptured = [];
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        internalCaptured.push(query);
        const base = {
          ok: true,
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
        if (query === 'niacinamide serum oily skin') {
          return {
            ...base,
            products: [
              {
                product_id: 'support_oil_1',
                merchant_id: 'merchant_internal',
                brand: 'OilLab',
                name: 'Oil Control Niacinamide Serum',
                display_name: 'OilLab Oil Control Niacinamide Serum',
                title: 'OilLab Oil Control Niacinamide Serum',
                category: 'Serum',
                product_type: 'serum',
                candidate_step: 'treatment',
                benefit_tags: ['oil control', 'shine control'],
                short_description: 'A niacinamide serum for oily skin and makeup-day shine control.',
                retrieval_source: 'catalog',
              },
            ],
          };
        }
        if (query === 'gel cream moisturizer') {
          return {
            ...base,
            products: [
              {
                product_id: 'support_moist_1',
                merchant_id: 'merchant_internal',
                brand: 'LayerLab',
                name: 'Oil-Free Gel Cream',
                display_name: 'LayerLab Oil-Free Gel Cream',
                title: 'LayerLab Oil-Free Gel Cream',
                category: 'Moisturizer',
                product_type: 'moisturizer',
                candidate_step: 'moisturizer',
                benefit_tags: ['lightweight hydration', 'layers under makeup'],
                short_description: 'A lightweight gel cream that layers before sunscreen and makeup.',
                retrieval_source: 'catalog',
              },
            ],
          };
        }
        return {
          ...base,
          products: [],
        };
      },
      searchLocalExternalSeedProducts: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        const roleId = String(args?.role?.role_id || '');
        externalCaptured.push({ query, roleId });
        const base = {
          ok: true,
          reason: null,
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
          local_external_seed_search_mode: 'staged_support_fastpath',
          local_external_seed_stage_debug: [{ stage: 'support_category_exact', row_count: 1, cumulative_row_count: 1, duration_ms: 5, cap: 6 }],
        };
        if (roleId === 'daily_sunscreen_finish_fit' && query === 'spf fluid oily skin') {
          return {
            ...base,
            products: [
              {
                product_id: 'primary_spf_1',
                merchant_id: 'external_seed',
                brand: 'SunLab',
                name: 'Invisible Makeup SPF Fluid',
                display_name: 'SunLab Invisible Makeup SPF Fluid',
                title: 'SunLab Invisible Makeup SPF Fluid',
                category: 'Sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['sunscreen', 'makeup friendly', 'lightweight finish'],
                short_description: 'A lightweight sunscreen fluid designed to sit under makeup.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        return {
          ...base,
          ok: false,
          products: [],
          reason: 'empty',
        };
      },
    });

    const targetContext = {
      primary_role_id: 'daily_sunscreen_finish_fit',
      comparison_mode: 'routine_mix',
      semantic_plan: {
        routine_mode: 'routine_mix',
        comparison_mode: 'routine_mix',
        selection_constraints: { comparison_mode: 'routine_mix' },
      },
      framework_summary: {
        concern_text: 'oily skin sunscreen under makeup',
      },
      framework_roles: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          rank: 31,
          preferred_step: 'sunscreen',
          label: 'Daily sunscreen finish fit',
          query_terms: ['sunscreen', 'spf fluid oily skin'],
          fit_keywords: ['spf', 'lightweight finish', 'makeup friendly'],
        },
        {
          role_id: 'oil_control_treatment',
          rank: 10,
          preferred_step: 'treatment',
          label: 'Oil-control treatment',
          query_terms: ['niacinamide serum oily skin', 'salicylic acid serum clogged pores'],
          fit_keywords: ['oil control', 'shine control', 'niacinamide'],
        },
        {
          role_id: 'lightweight_moisturizer',
          rank: 20,
          preferred_step: 'moisturizer',
          label: 'Lightweight moisturizer',
          query_terms: ['gel cream moisturizer', 'lightweight moisturizer oily skin'],
          fit_keywords: ['gel cream', 'oil-free', 'lightweight'],
        },
      ],
      support_roles: [],
    };

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_sunscreen_support_internal_first' },
      primaryQuery: 'I have oily skin and wear makeup every day. What sunscreen product should I buy?',
      fallbackMessage: 'I have oily skin and wear makeup every day. What sunscreen product should I buy?',
      targetContext,
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.deepEqual(externalCaptured[0], { query: 'spf fluid oily skin', roleId: 'daily_sunscreen_finish_fit' });
    assert.deepEqual(externalCaptured[1], { query: 'niacinamide serum oily skin', roleId: 'oil_control_treatment' });
    assert.equal(
      externalCaptured.some((row) =>
        row?.query === 'gel cream moisturizer' && row?.roleId === 'lightweight_moisturizer'),
      true,
    );
    assert.equal(internalCaptured.includes('niacinamide serum oily skin'), true);
    assert.equal(internalCaptured.includes('gel cream moisturizer'), true);
    const attempts = out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts || [];
    const firstSupportAttempt = attempts.find((row) =>
      String(row?.ladder_level || '').startsWith('framework_stage_c_support_')
      && !String(row?.reason || '').startsWith('skipped_'));
    assert.equal(firstSupportAttempt?.source_scope, 'external_seed');
    assert.equal(firstSupportAttempt?.role_id, 'oil_control_treatment');
    assert.equal(
      attempts.some((row) =>
        row?.source_scope === 'internal'
        && row?.role_id === 'oil_control_treatment'
        && Number(row?.result_count || 0) > 0),
      true,
    );
    assert.equal(
      attempts.some((row) =>
        row?.source_scope === 'internal'
        && row?.role_id === 'lightweight_moisturizer'
        && Number(row?.result_count || 0) > 0),
      true,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch does not let delayed primary external starve planned support roles', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let primaryExternalResolved = false;
    let supportStartedBeforePrimaryResolved = false;
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async () => ({
        ok: true,
        products: [],
        attempted_internal_paths: ['/agent/internal/products/search'],
        transport_hops: [],
        transport_hop_count: 0,
        nested_orchestrator_hops: 0,
        primary_transport_owner: 'internal_products_search_primitive',
        primary_endpoint_kind: 'internal_primitive',
      }),
      searchLocalExternalSeedProducts: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        const roleId = String(args?.role?.role_id || '').trim();
        externalCaptured.push({ query, roleId });
        const base = {
          ok: true,
          reason: null,
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
          local_external_seed_search_mode: 'staged_support_fastpath',
          local_external_seed_stage_debug: [{ stage: 'support_category_exact', row_count: 1, cumulative_row_count: 1, duration_ms: 4, cap: 6 }],
        };
        if (roleId === 'daily_sunscreen_finish_fit') {
          await sleep(240);
          primaryExternalResolved = true;
          return {
            ...base,
            products: [
              {
                product_id: 'primary_delayed_spf',
                merchant_id: 'external_seed',
                brand: 'SunLab',
                name: 'Smooth Makeup SPF Fluid',
                display_name: 'SunLab Smooth Makeup SPF Fluid',
                title: 'SunLab Smooth Makeup SPF Fluid',
                category: 'sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['sunscreen', 'spf', 'under makeup', 'lightweight'],
                short_description: 'A lightweight SPF fluid for daytime makeup layering.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        if (roleId === 'oil_control_treatment') {
          if (!primaryExternalResolved) supportStartedBeforePrimaryResolved = true;
          return {
            ...base,
            products: [
              {
                product_id: 'support_oil_parallel',
                merchant_id: 'external_seed',
                brand: 'OilLab',
                name: 'Oil Control Niacinamide Serum',
                display_name: 'OilLab Oil Control Niacinamide Serum',
                title: 'OilLab Oil Control Niacinamide Serum',
                category: 'serum',
                product_type: 'serum',
                candidate_step: 'treatment',
                benefit_tags: ['oil control', 'shine control', 'niacinamide'],
                short_description: 'A niacinamide serum for visible oil and midday shine.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        if (roleId === 'layering_compatible_moisturizer_or_spf') {
          if (!primaryExternalResolved) supportStartedBeforePrimaryResolved = true;
          return {
            ...base,
            products: [
              {
                product_id: 'support_layering_parallel',
                merchant_id: 'external_seed',
                brand: 'LayerLab',
                name: 'Smooth Layering SPF',
                display_name: 'LayerLab Smooth Layering SPF',
                title: 'LayerLab Smooth Layering SPF',
                category: 'sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['sunscreen', 'spf', 'under makeup', 'lightweight'],
                short_description: 'A lightweight SPF that layers before makeup.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        return {
          ...base,
          ok: false,
          products: [],
          reason: 'empty',
        };
      },
    });

    const targetContext = {
      primary_role_id: 'daily_sunscreen_finish_fit',
      comparison_mode: 'routine_mix',
      semantic_plan: {
        routine_mode: 'routine_mix',
        comparison_mode: 'routine_mix',
        selection_constraints: { comparison_mode: 'routine_mix' },
      },
      framework_summary: {
        concern_text: 'oily skin sunscreen under makeup',
      },
      framework_roles: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          rank: 31,
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
          query_terms: ['gel cream moisturizer', 'lightweight moisturizer oily skin'],
          fit_keywords: ['gel cream', 'under makeup', 'lightweight'],
        },
        {
          role_id: 'oil_control_treatment',
          rank: 10,
          preferred_step: 'treatment',
          label: 'Oil-control treatment',
          query_terms: ['niacinamide serum oily skin', 'salicylic acid serum clogged pores'],
          fit_keywords: ['oil control', 'shine control', 'niacinamide'],
        },
      ],
      support_roles: [],
    };

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_parallel_support_budget' },
      primaryQuery: 'I have oily skin and need sunscreen under makeup. What should I buy?',
      fallbackMessage: 'I have oily skin and need sunscreen under makeup. What should I buy?',
      targetContext,
      timeoutMs: 5000,
      minTimeoutMs: 5000,
      deadlineAtMs: Date.now() + 340,
    });

    assert.equal(supportStartedBeforePrimaryResolved, true);
    assert.equal(externalCaptured[0]?.roleId, 'daily_sunscreen_finish_fit');
    assert.deepEqual(
      externalCaptured.find((row) => row?.roleId === 'layering_compatible_moisturizer_or_spf'),
      {
        query: 'lightweight moisturizer oily skin',
        roleId: 'layering_compatible_moisturizer_or_spf',
      },
    );
    assert.deepEqual(
      out.recommendations.map((item) => item?.product_id).sort(),
      ['primary_delayed_spf', 'support_layering_parallel', 'support_oil_parallel'].sort(),
    );
    const ledger = out.searchResult?.metadata?.search_stage_ledger?.local_handoff || {};
    assert.equal(ledger.pending_primary_support_parallelized, true);
    assert.ok(Number(ledger.support_budget_exhausted_count || 0) < Number(ledger.support_query_count || 0));
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch preserves horizontal comparison across internal and external primary-role candidates', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        if (query === 'oil control serum') {
          return {
            ok: true,
            products: [
              {
                product_id: 'oil_control_internal_1',
                merchant_id: 'merchant_internal',
                title: 'GoalSkin Oil Control Niacinamide Serum',
                display_name: 'GoalSkin Oil Control Niacinamide Serum',
                category: 'Treatment',
                product_type: 'serum',
                candidate_step: 'treatment',
                description: 'Niacinamide serum for oil control and shine reduction.',
                source: 'internal_search',
              },
            ],
            attempted_internal_paths: ['/agent/internal/products/search'],
            transport_hops: [],
            transport_hop_count: 0,
            nested_orchestrator_hops: 0,
            primary_transport_owner: 'internal_products_search_primitive',
            primary_endpoint_kind: 'internal_primitive',
          };
        }
        return {
          ok: true,
          products: [],
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
      },
      searchLocalExternalSeedProducts: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        if (['oil control treatment', 'niacinamide serum oily skin', 'salicylic acid serum oily skin'].includes(query)) {
          return {
            ok: true,
            products: [
              {
                product_id: 'oil_control_external_1',
                merchant_id: 'merchant_external',
                title: 'ClearLab Oil Control Sebum Serum',
                display_name: 'ClearLab Oil Control Sebum Serum',
                category: 'Treatment',
                product_type: 'serum',
                candidate_step: 'treatment',
                description: 'Oil control treatment serum for oily skin and visible shine.',
                retrieval_source: 'external_seed',
                source: 'external_seed',
              },
            ],
            reason: null,
            actual_http_attempt_count: 0,
            attempted_base_urls: [],
            attempted_paths: [],
          };
        }
        return {
          ok: true,
          products: [],
          reason: 'empty',
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
        };
      },
    });

    const targetContext = resolveRecommendationTargetContext({
      text: 'what products should i use for oily skin?',
      focus: '',
      entryType: 'chat',
    });
    targetContext.comparison_mode = 'same_role_comparison';
    targetContext.semantic_plan = {
      ...(targetContext.semantic_plan || {}),
      comparison_mode: 'same_role_comparison',
      selection_constraints: {
        ...(targetContext.semantic_plan?.selection_constraints || {}),
        comparison_mode: 'same_role_comparison',
      },
    };
    targetContext.primary_role_id = 'oil_control_treatment';
    targetContext.framework_roles = [
      {
        role_id: 'oil_control_treatment',
        rank: 10,
        preferred_step: 'treatment',
        label: 'Oil-control treatment',
        query_terms: ['oil control serum', 'shine control serum', 'mattifying serum'],
        fit_keywords: ['oil control', 'shine control', 'mattifying'],
      },
    ];
    targetContext.support_roles = [];

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_multi_source_primary_role_compare' },
      primaryQuery: 'what products should i use for oily skin?',
      fallbackMessage: 'what products should i use for oily skin?',
      targetContext,
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.equal(out.searchResult?.query_source, 'beauty_mainline_local_handoff');
    assert.equal(out.recommendations.length, 2);
    assert.deepEqual(
      out.recommendations.map((item) => item?.product_id).sort(),
      ['oil_control_external_1', 'oil_control_internal_1'],
    );
    assert.deepEqual(
      out.searchResult?.metadata?.final_selection?.selected_product_ids?.slice().sort(),
      ['oil_control_external_1', 'oil_control_internal_1'],
    );
    assert.deepEqual(
      out.searchResult?.metadata?.source_breakdown?.source_tier_counts,
      { fresh_internal: 1, fresh_external: 1 },
    );
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts?.some((row) =>
        row?.source_scope === 'external_seed' && row?.result_count === 1),
      true,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch stops primary external alternates after a viable primary and preserves support role budget', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async () => ({
        ok: true,
        products: [],
        attempted_internal_paths: ['/agent/internal/products/search'],
        transport_hops: [],
        transport_hop_count: 0,
        nested_orchestrator_hops: 0,
        primary_transport_owner: 'internal_products_search_primitive',
        primary_endpoint_kind: 'internal_primitive',
      }),
      searchLocalExternalSeedProducts: async (args) => {
        const roleId = String(args?.role?.role_id || '').trim();
        const query = String(args?.query || '').trim().toLowerCase();
        externalCaptured.push({ query, roleId });
        const base = {
          reason: null,
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
        };
        if (roleId === 'tone_mark_treatment') {
          return {
            ...base,
            ok: true,
            products: [
              {
                product_id: 'tone_primary_external',
                merchant_id: 'merchant_ext_tone',
                title: 'Post-Breakout Mark Serum',
                display_name: 'Post-Breakout Mark Serum',
                brand: 'TestSkin',
                category: 'serum',
                product_type: 'serum',
                candidate_step: 'treatment',
                benefit_tags: ['post-breakout marks', 'uneven tone', 'brightening'],
                short_description: 'A targeted serum for post-breakout marks, uneven tone, and lingering dark spots.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        if (roleId === 'lightweight_moisturizer') {
          return {
            ...base,
            ok: true,
            products: [
              {
                product_id: 'support_moisturizer_external',
                merchant_id: 'merchant_ext_moist',
                title: 'Lightweight Barrier Gel Cream',
                display_name: 'Lightweight Barrier Gel Cream',
                brand: 'TestSkin',
                category: 'moisturizer',
                product_type: 'moisturizer',
                candidate_step: 'moisturizer',
                benefit_tags: ['lightweight hydration', 'barrier support', 'non-greasy'],
                short_description: 'A lightweight gel moisturizer that supports the barrier without a heavy finish.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        if (roleId === 'daily_sunscreen') {
          return {
            ...base,
            ok: true,
            products: [
              {
                product_id: 'support_sunscreen_external',
                merchant_id: 'merchant_ext_spf',
                title: 'Clear Daily Sunscreen SPF 50',
                display_name: 'Clear Daily Sunscreen SPF 50',
                brand: 'TestSkin',
                category: 'sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['spf 50', 'daily sunscreen', 'lightweight'],
                short_description: 'A lightweight daily sunscreen to protect post-breakout marks from darkening.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        return {
          ...base,
          ok: true,
          products: [],
          reason: 'empty',
        };
      },
    });

    const targetContext = {
      primary_role_id: 'tone_mark_treatment',
      comparison_mode: 'routine_mix',
      semantic_plan: {
        routine_mode: 'routine_mix',
        comparison_mode: 'routine_mix',
        selection_constraints: { comparison_mode: 'routine_mix' },
      },
      framework_summary: {
        concern_text: 'post-breakout marks, what should i buy?',
      },
      framework_roles: [
        {
          role_id: 'tone_mark_treatment',
          rank: 10,
          preferred_step: 'treatment',
          label: 'Tone and post-breakout mark treatment',
          query_terms: ['tone and post breakout mark treatment', 'post breakout dark spot serum', 'dark spot serum'],
          fit_keywords: ['post-breakout', 'marks', 'dark spots', 'uneven tone', 'brightening'],
        },
        {
          role_id: 'lightweight_moisturizer',
          rank: 20,
          preferred_step: 'moisturizer',
          label: 'Lightweight moisturizer',
          query_terms: ['lightweight moisturizer post breakout skin', 'barrier gel cream'],
          fit_keywords: ['lightweight', 'barrier', 'non-greasy', 'hydration'],
        },
        {
          role_id: 'daily_sunscreen',
          rank: 30,
          preferred_step: 'sunscreen',
          label: 'Daily sunscreen',
          query_terms: ['daily sunscreen post acne marks', 'lightweight sunscreen'],
          fit_keywords: ['spf', 'daily sunscreen', 'uv protection', 'lightweight'],
        },
      ],
      support_roles: [],
    };

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_primary_external_stop_preserve_support' },
      primaryQuery: 'post-breakout marks, what should i buy?',
      fallbackMessage: 'post-breakout marks, what should i buy?',
      targetContext,
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.equal(
      externalCaptured.filter((row) => row.roleId === 'tone_mark_treatment').length,
      1,
    );
    assert.equal(
      externalCaptured.some((row) => row.roleId === 'lightweight_moisturizer'),
      true,
    );
    assert.equal(
      externalCaptured.some((row) => row.roleId === 'daily_sunscreen'),
      true,
    );
    assert.deepEqual(
      out.recommendations.map((item) => item?.matched_role_id).sort(),
      ['daily_sunscreen', 'lightweight_moisturizer', 'tone_mark_treatment'],
    );
    const primaryExternalRows = out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts
      ?.filter((row) => row?.ladder_level === 'framework_stage_b_primary_external_seed') || [];
    assert.equal(primaryExternalRows.filter((row) => Number(row?.result_count || 0) > 0).length, 1);
    assert.equal(primaryExternalRows.filter((row) => Number(row?.result_count || 0) > 0)[0]?.result_count, 1);
    assert.ok(
      Number(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_query_count || 0) < 16,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch skips primary external seed when internal comparison coverage is already satisfied', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const internalCaptured = [];
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        internalCaptured.push(query);
        if (query === 'niacinamide serum oily skin') {
          return {
            ok: true,
            products: [
              {
                product_id: 'primary_compare_1',
                merchant_id: 'merchant_internal_1',
                title: 'Clarity Lab Oil Balance Serum',
                display_name: 'Clarity Lab Oil Balance Serum',
                category: 'serum',
                product_type: 'serum',
                candidate_step: 'treatment',
                benefit_tags: ['oil control', 'shine control'],
                short_description: 'A mattifying oil-control serum for oily skin.',
                retrieval_source: 'catalog',
              },
            ],
            attempted_internal_paths: ['/agent/internal/products/search'],
            transport_hops: [],
            transport_hop_count: 0,
            nested_orchestrator_hops: 0,
            primary_transport_owner: 'internal_products_search_primitive',
            primary_endpoint_kind: 'internal_primitive',
          };
        }
        if (query === 'oil control serum') {
          return {
            ok: true,
            products: [
              {
                product_id: 'primary_compare_2',
                merchant_id: 'merchant_internal_2',
                title: 'Balance Co Shine Control Serum',
                display_name: 'Balance Co Shine Control Serum',
                category: 'serum',
                product_type: 'serum',
                candidate_step: 'treatment',
                benefit_tags: ['oil control', 'shine control'],
                short_description: 'A lightweight serum that helps manage visible oil through the day.',
                retrieval_source: 'catalog',
              },
            ],
            attempted_internal_paths: ['/agent/internal/products/search'],
            transport_hops: [],
            transport_hop_count: 0,
            nested_orchestrator_hops: 0,
            primary_transport_owner: 'internal_products_search_primitive',
            primary_endpoint_kind: 'internal_primitive',
          };
        }
        return {
          ok: true,
          products: [],
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
      },
      searchLocalExternalSeedProducts: async (args) => {
        externalCaptured.push(String(args?.query || '').trim().toLowerCase());
        return {
          ok: false,
          products: [],
          reason: 'empty',
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
        };
      },
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_skip_primary_external_when_internal_compare_ready' },
      primaryQuery: 'what products should i use for oily skin?',
      fallbackMessage: 'what products should i use for oily skin?',
      targetContext: resolveRecommendationTargetContext({
        text: 'what products should i use for oily skin?',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.deepEqual(
      internalCaptured,
      [
        'niacinamide serum oily skin',
        'gel cream moisturizer',
        'spf fluid oily skin',
        'lightweight moisturizer oily skin',
        'lightweight sunscreen oily skin',
        'oil control sunscreen',
      ],
    );
    assert.deepEqual(
      externalCaptured,
      [
        'gel cream moisturizer',
        'spf fluid oily skin',
        'lightweight moisturizer oily skin',
        'lightweight sunscreen oily skin',
      ],
    );
    const primaryExternalRows = out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts
      ?.filter((row) => row?.ladder_level === 'framework_stage_b_primary_external_seed') || [];
    assert.equal(primaryExternalRows.length, 2);
    assert.equal(
      primaryExternalRows.every((row) => row?.reason === 'skipped_primary_already_satisfied'),
      true,
    );
    assert.deepEqual(
      out.recommendations.map((item) => item?.product_id).sort(),
      ['primary_compare_1'],
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch skips primary external supplement for routine coverage once primary is matched', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        if (query === 'niacinamide serum oily skin') {
          return {
            ok: true,
            products: [
              {
                product_id: 'primary_oil_control',
                merchant_id: 'merchant_internal_primary',
                title: 'Clarity Lab Oil Balance Serum',
                display_name: 'Clarity Lab Oil Balance Serum',
                category: 'serum',
                product_type: 'serum',
                candidate_step: 'treatment',
                benefit_tags: ['oil control', 'shine control'],
                short_description: 'A mattifying oil-control serum for oily skin.',
                retrieval_source: 'catalog',
              },
            ],
            attempted_internal_paths: ['/agent/internal/products/search'],
            transport_hops: [],
            transport_hop_count: 0,
            nested_orchestrator_hops: 0,
            primary_transport_owner: 'internal_products_search_primitive',
            primary_endpoint_kind: 'internal_primitive',
          };
        }
        return {
          ok: true,
          products: [],
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
      },
      searchLocalExternalSeedProducts: async (args) => {
        externalCaptured.push(String(args?.query || '').trim().toLowerCase());
        return {
          ok: false,
          products: [],
          reason: 'empty',
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
        };
      },
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_skip_primary_external_for_routine_support' },
      primaryQuery: 'what products should i use for oily skin?',
      fallbackMessage: 'what products should i use for oily skin?',
      targetContext: resolveRecommendationTargetContext({
        text: 'what products should i use for oily skin?',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.equal(
      externalCaptured.some((query) =>
        ['oil control treatment', 'niacinamide serum oily skin', 'salicylic acid serum oily skin', 'oil control serum'].includes(query)),
      false,
    );
    assert.deepEqual(
      externalCaptured,
      [
        'gel cream moisturizer',
        'spf fluid oily skin',
        'lightweight moisturizer oily skin',
        'lightweight sunscreen oily skin',
      ],
    );
    const primaryExternalRows = out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts
      ?.filter((row) => row?.ladder_level === 'framework_stage_b_primary_external_seed') || [];
    assert.equal(primaryExternalRows.length, 2);
    assert.equal(
      primaryExternalRows.every((row) => row?.reason === 'skipped_primary_already_satisfied'),
      true,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch skips support external supplement once that support role is filled', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        if (query === 'barrier repair moisturizer') {
          return {
            ok: true,
            products: [
              {
                product_id: 'barrier_primary',
                merchant_id: 'merchant_barrier',
                title: 'Barrier Repair Moisturizer',
                display_name: 'Barrier Repair Moisturizer',
                category: 'moisturizer',
                product_type: 'moisturizer',
                candidate_step: 'moisturizer',
                benefit_tags: ['barrier repair', 'ceramide'],
                short_description: 'A barrier repair moisturizer for dry sensitive skin.',
                retrieval_source: 'catalog',
              },
            ],
            attempted_internal_paths: ['/agent/internal/products/search'],
            transport_hops: [],
            transport_hop_count: 0,
            nested_orchestrator_hops: 0,
            primary_transport_owner: 'internal_products_search_primitive',
            primary_endpoint_kind: 'internal_primitive',
          };
        }
        if (query === 'hyaluronic acid serum') {
          return {
            ok: true,
            products: [
              {
                product_id: 'hydrating_support',
                merchant_id: 'merchant_hydrating',
                title: 'Hyaluronic Acid Serum',
                display_name: 'Hyaluronic Acid Serum',
                category: 'serum',
                product_type: 'serum',
                candidate_step: 'serum',
                benefit_tags: ['hydrating', 'hyaluronic acid'],
                short_description: 'A lightweight hydrating serum for dehydrated skin.',
                retrieval_source: 'catalog',
              },
            ],
            attempted_internal_paths: ['/agent/internal/products/search'],
            transport_hops: [],
            transport_hop_count: 0,
            nested_orchestrator_hops: 0,
            primary_transport_owner: 'internal_products_search_primitive',
            primary_endpoint_kind: 'internal_primitive',
          };
        }
        return {
          ok: true,
          products: [],
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
      },
      searchLocalExternalSeedProducts: async (args) => {
        externalCaptured.push(String(args?.query || '').trim().toLowerCase());
        return {
          ok: false,
          products: [],
          reason: 'empty',
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
        };
      },
    });

    const targetContext = {
      primary_role_id: 'hydrating_barrier_moisturizer',
      comparison_mode: 'routine_mix',
      semantic_plan: {
        routine_mode: 'routine_mix',
        comparison_mode: 'routine_mix',
        selection_constraints: { comparison_mode: 'routine_mix' },
      },
      framework_summary: {
        concern_text: 'dry tight skin after washing',
      },
      framework_roles: [
        {
          role_id: 'hydrating_barrier_moisturizer',
          rank: 40,
          preferred_step: 'moisturizer',
          label: 'Hydrating barrier moisturizer',
          query_terms: ['barrier repair moisturizer', 'ceramide cream sensitive skin'],
          fit_keywords: ['barrier repair', 'ceramide', 'dry skin'],
        },
        {
          role_id: 'hydrating_serum_or_essence',
          rank: 42,
          preferred_step: 'serum',
          label: 'Hydrating serum or essence',
          query_terms: ['hyaluronic acid serum', 'hydrating serum dehydrated skin'],
          fit_keywords: ['hydrating', 'hyaluronic acid', 'dehydrated'],
        },
        {
          role_id: 'daily_sunscreen',
          rank: 30,
          preferred_step: 'sunscreen',
          label: 'Daily sunscreen',
          query_terms: ['daily sunscreen skincare', 'lightweight sunscreen'],
          fit_keywords: ['spf', 'uv filters', 'lightweight'],
        },
      ],
      support_roles: [],
    };

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_skip_filled_support_external' },
      primaryQuery: 'my skin feels dry and tight after washing, what should i use first?',
      fallbackMessage: 'my skin feels dry and tight after washing, what should i use first?',
      targetContext,
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.equal(externalCaptured.includes('hyaluronic acid serum'), true);
    assert.equal(externalCaptured.includes('hydrating serum dehydrated skin'), false);
    assert.equal(externalCaptured.includes('lightweight sunscreen'), true);
    const hydratingExternalRows = out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts
      ?.filter((row) => row?.ladder_level === 'framework_stage_c_support_hydrating_serum_or_essence_external_seed') || [];
    assert.equal(hydratingExternalRows.length, 2);
    assert.equal(
      hydratingExternalRows.some((row) => row?.reason === 'skipped_support_role_already_satisfied'),
      true,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch interleaves support external queries across unfilled roles', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        if (
          query === 'niacinamide serum oily skin'
          || query === 'oil control serum'
          || query === 'shine control serum'
        ) {
          return {
            ok: true,
            products: [
              {
                product_id: 'primary_oil_control',
                merchant_id: 'merchant_internal_primary',
                title: 'Clarity Lab Oil Balance Serum',
                display_name: 'Clarity Lab Oil Balance Serum',
                category: 'serum',
                product_type: 'serum',
                candidate_step: 'treatment',
                benefit_tags: ['oil control', 'shine control'],
                short_description: 'A mattifying oil-control serum for oily skin.',
                retrieval_source: 'catalog',
              },
            ],
            attempted_internal_paths: ['/agent/internal/products/search'],
            transport_hops: [],
            transport_hop_count: 0,
            nested_orchestrator_hops: 0,
            primary_transport_owner: 'internal_products_search_primitive',
            primary_endpoint_kind: 'internal_primitive',
          };
        }
        return {
          ok: true,
          products: [],
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
      },
      searchLocalExternalSeedProducts: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        externalCaptured.push(query);
        if (query === 'gel cream moisturizer' || query === 'lightweight moisturizer oily skin') {
          return {
            ok: true,
            products: [
              {
                product_id: 'support_moisturizer',
                merchant_id: 'merchant_ext_moisturizer',
                title: 'Oil-Free Gel Moisturizer',
                display_name: 'Oil-Free Gel Moisturizer',
                brand: 'TestSkin',
                category: 'moisturizer',
                product_type: 'moisturizer',
                candidate_step: 'moisturizer',
                benefit_tags: ['lightweight', 'oil-free', 'gel cream'],
                short_description: 'A lightweight gel moisturizer for oily skin.',
                retrieval_source: 'external_seed',
              },
            ],
            actual_http_attempt_count: 0,
            attempted_base_urls: [],
            attempted_paths: [],
            transport_policy_mode: String(args?.transportPolicyMode || ''),
          };
        }
        if (query === 'spf fluid oily skin' || query === 'sunscreen' || query === 'oil control sunscreen') {
          return {
            ok: true,
            products: [
              {
                product_id: 'support_sunscreen',
                merchant_id: 'merchant_ext_sunscreen',
                title: 'Oil Control Sunscreen SPF 50',
                display_name: 'Oil Control Sunscreen SPF 50',
                brand: 'TestSkin',
                category: 'sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['spf', 'oil control', 'lightweight'],
                short_description: 'A lightweight SPF 50 sunscreen for oily skin.',
                retrieval_source: 'external_seed',
              },
            ],
            actual_http_attempt_count: 0,
            attempted_base_urls: [],
            attempted_paths: [],
            transport_policy_mode: String(args?.transportPolicyMode || ''),
          };
        }
        return {
          ok: true,
          products: [],
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
        };
      },
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_fair_support_external_rounds' },
      primaryQuery: 'what products should i use for oily skin?',
      fallbackMessage: 'what products should i use for oily skin?',
      targetContext: resolveRecommendationTargetContext({
        text: 'what products should i use for oily skin?',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.deepEqual(
      externalCaptured,
      [
        'gel cream moisturizer',
        'spf fluid oily skin',
      ],
    );
    assert.deepEqual(
      out.recommendations.map((item) => item?.matched_role_id).sort(),
      ['daily_sunscreen', 'lightweight_moisturizer', 'oil_control_treatment'],
    );
    const skippedSecondRoundRows = out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts
      ?.filter((row) => row?.fair_support_external_round === 2) || [];
    assert.equal(skippedSecondRoundRows.length, 2);
    assert.equal(
      skippedSecondRoundRows.every((row) => row?.reason === 'skipped_support_role_already_satisfied'),
      true,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('collectRecoCandidatesFromQueryLevels runs primary external authority before support external during primary round', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const startedQueries = [];
    const targetContext = {
      framework_id: 'framework_makeup_pilling_v1',
      primary_role_id: 'daily_sunscreen_finish_fit',
      framework_owner_source: 'llm_concern_planner',
      framework_owner_state: 'trusted',
      comparison_mode: 'routine_mix',
      semantic_plan: {
        routine_mode: 'routine_mix',
        comparison_mode: 'routine_mix',
        selection_constraints: { comparison_mode: 'routine_mix' },
      },
      framework_roles: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          rank: 1,
          preferred_step: 'sunscreen',
          label: 'Daily sunscreen with finish fit',
        },
        {
          role_id: 'layering_compatible_moisturizer_or_spf',
          rank: 2,
          preferred_step: 'moisturizer',
          label: 'Layering-compatible moisturizer',
        },
        {
          role_id: 'hydrating_serum_or_essence',
          rank: 3,
          preferred_step: 'serum',
          label: 'Hydrating serum or essence',
        },
      ],
    };
    const queryLevels = [
      {
        ladder_level: 'framework_stage_c_support_authority_round_1',
        fair_support_authority_round: 1,
        fair_primary_external_round: 1,
        queries: [
          {
            query: 'sunscreen',
            step: 'sunscreen',
            slot: 'sunscreen',
            ladder_level: 'framework_stage_b_primary_external_seed',
            role_id: 'daily_sunscreen_finish_fit',
            role_rank: 1,
            preferred_step: 'sunscreen',
            allow_external_seed: true,
            fair_primary_external_round: 1,
          },
          {
            query: 'gel cream moisturizer',
            step: 'moisturizer',
            slot: 'moisturizer',
            ladder_level: 'framework_stage_c_support_layering_compatible_moisturizer_or_spf',
            role_id: 'layering_compatible_moisturizer_or_spf',
            role_rank: 2,
            preferred_step: 'moisturizer',
            allow_pending_primary_external: true,
          },
          {
            query: 'hyaluronic acid serum',
            step: 'serum',
            slot: 'serum',
            ladder_level: 'framework_stage_c_support_hydrating_serum_or_essence',
            role_id: 'hydrating_serum_or_essence',
            role_rank: 3,
            preferred_step: 'serum',
            allow_pending_primary_external: true,
          },
          {
            query: 'gel cream moisturizer',
            step: 'moisturizer',
            slot: 'moisturizer',
            ladder_level: 'framework_stage_c_support_layering_compatible_moisturizer_or_spf_external_seed',
            role_id: 'layering_compatible_moisturizer_or_spf',
            role_rank: 2,
            preferred_step: 'moisturizer',
            allow_external_seed: true,
            allow_pending_primary_external: true,
            fair_support_external_round: 1,
          },
          {
            query: 'hyaluronic acid serum',
            step: 'serum',
            slot: 'serum',
            ladder_level: 'framework_stage_c_support_hydrating_serum_or_essence_external_seed',
            role_id: 'hydrating_serum_or_essence',
            role_rank: 3,
            preferred_step: 'serum',
            allow_external_seed: true,
            allow_pending_primary_external: true,
            fair_support_external_round: 1,
          },
        ],
      },
    ];

    await __internal.collectRecoCandidatesFromQueryLevels({
      queryLevels,
      targetContext,
      recommendationTaskContext: null,
      logger: null,
      timeoutMs: 5000,
      deadlineMs: Date.now() + 5000,
      limit: 6,
      usePurchasableFallback: false,
      allowExternalSeed: true,
      searchFn: async (args = {}) => {
        startedQueries.push(`${args.sourceScope}:${args.role?.role_id}:${args.query}`);
        if (
          String(args?.sourceScope || '') === 'external_seed'
          && String(args?.role?.role_id || '') === 'daily_sunscreen_finish_fit'
        ) {
          return {
            ok: true,
            products: [
              {
                product_id: 'primary_spf_1',
                merchant_id: 'external_seed',
                brand: 'SunLab',
                name: 'Invisible Makeup SPF Fluid',
                display_name: 'SunLab Invisible Makeup SPF Fluid',
                title: 'SunLab Invisible Makeup SPF Fluid',
                category: 'Sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['sunscreen', 'makeup friendly', 'lightweight finish'],
                short_description: 'A lightweight sunscreen fluid designed to sit under makeup.',
                retrieval_source: 'external_seed',
              },
            ],
            actual_http_attempt_count: 0,
            attempted_base_urls: [],
            attempted_paths: [],
            attempted_request_timeouts_ms: [Number(args.timeoutMs || 0)],
          };
        }
        return {
          ok: true,
          products: [],
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          attempted_request_timeouts_ms: [Number(args.timeoutMs || 0)],
        };
      },
    });

    assert.deepEqual(
      startedQueries.slice(0, 3),
      [
        'external_seed:daily_sunscreen_finish_fit:sunscreen',
        'external_seed:hydrating_serum_or_essence:hyaluronic acid serum',
        'external_seed:layering_compatible_moisturizer_or_spf:gel cream moisturizer',
      ],
    );
    assert.equal(
      startedQueries.indexOf('external_seed:hydrating_serum_or_essence:hyaluronic acid serum')
        < startedQueries.indexOf('internal:hydrating_serum_or_essence:hyaluronic acid serum'),
      true,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('collectRecoCandidatesFromQueryLevels can spend pending support budget without surfacing support when primary remains unmatched', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const startedQueries = [];
    const targetContext = {
      framework_id: 'framework_makeup_pilling_v1',
      primary_role_id: 'daily_sunscreen_finish_fit',
      framework_owner_source: 'llm_concern_planner',
      framework_owner_state: 'trusted',
      comparison_mode: 'routine_mix',
      semantic_plan: {
        routine_mode: 'routine_mix',
        comparison_mode: 'routine_mix',
        selection_constraints: { comparison_mode: 'routine_mix' },
      },
      framework_roles: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          rank: 1,
          preferred_step: 'sunscreen',
          label: 'Daily sunscreen with finish fit',
        },
        {
          role_id: 'layering_compatible_moisturizer_or_spf',
          rank: 2,
          preferred_step: 'moisturizer',
          label: 'Layering-compatible moisturizer',
        },
      ],
    };
    const queryLevels = [
      {
        ladder_level: 'framework_stage_c_support_authority_round_1',
        fair_support_authority_round: 1,
        fair_primary_external_round: 1,
        queries: [
          {
            query: 'sunscreen',
            step: 'sunscreen',
            slot: 'sunscreen',
            ladder_level: 'framework_stage_b_primary_external_seed',
            role_id: 'daily_sunscreen_finish_fit',
            role_rank: 1,
            preferred_step: 'sunscreen',
            allow_external_seed: true,
            fair_primary_external_round: 1,
          },
          {
            query: 'gel cream moisturizer',
            step: 'moisturizer',
            slot: 'moisturizer',
            ladder_level: 'framework_stage_c_support_layering_compatible_moisturizer_or_spf_external_seed',
            role_id: 'layering_compatible_moisturizer_or_spf',
            role_rank: 2,
            preferred_step: 'moisturizer',
            allow_external_seed: true,
            allow_pending_primary_external: true,
            fair_support_external_round: 1,
          },
        ],
      },
    ];

    const out = await __internal.collectRecoCandidatesFromQueryLevels({
      queryLevels,
      targetContext,
      recommendationTaskContext: null,
      logger: null,
      timeoutMs: 5000,
      deadlineMs: Date.now() + 5000,
      limit: 6,
      usePurchasableFallback: false,
      allowExternalSeed: true,
      searchFn: async (args = {}) => {
        startedQueries.push(`${args.sourceScope}:${args.role?.role_id}:${args.query}`);
        return {
          ok: false,
          products: [],
          reason: 'empty',
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          attempted_request_timeouts_ms: [Number(args.timeoutMs || 0)],
        };
      },
    });

    assert.deepEqual(startedQueries, [
      'external_seed:daily_sunscreen_finish_fit:sunscreen',
      'external_seed:layering_compatible_moisturizer_or_spf:gel cream moisturizer',
    ]);
    const attempts = out.searchResults || [];
    assert.equal(
      attempts.some((row) =>
        row?.role_id === 'layering_compatible_moisturizer_or_spf'
        && row?.allow_pending_primary_external === true
        && row?.reason === 'empty'),
      true,
    );
    assert.deepEqual(out.candidateState?.selected_recommendations || [], []);
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch releases support budget to external authority when support internal hangs', async () => {
  const originalSupportInternalTimeout = process.env.AURORA_BFF_RECO_CATALOG_SUPPORT_INTERNAL_QUERY_TIMEOUT_MS;
  process.env.AURORA_BFF_RECO_CATALOG_SUPPORT_INTERNAL_QUERY_TIMEOUT_MS = '200';
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        if (
          query === 'niacinamide serum oily skin'
          || query === 'oil control serum'
          || query === 'shine control serum'
        ) {
          return {
            ok: true,
            products: [
              {
                product_id: 'primary_oil_control_budget',
                merchant_id: 'merchant_internal_primary_budget',
                title: 'Clarity Lab Oil Balance Serum',
                display_name: 'Clarity Lab Oil Balance Serum',
                category: 'serum',
                product_type: 'serum',
                candidate_step: 'treatment',
                benefit_tags: ['oil control', 'shine control'],
                short_description: 'A mattifying oil-control serum for oily skin.',
                retrieval_source: 'catalog',
              },
            ],
            attempted_internal_paths: ['/agent/internal/products/search'],
            transport_hops: [],
            transport_hop_count: 0,
            nested_orchestrator_hops: 0,
            primary_transport_owner: 'internal_products_search_primitive',
            primary_endpoint_kind: 'internal_primitive',
          };
        }
        return new Promise(() => {});
      },
      searchLocalExternalSeedProducts: async (args) => {
        const roleId = String(args?.role?.role_id || '').trim();
        externalCaptured.push(roleId);
        if (roleId === 'lightweight_moisturizer' || roleId === 'daily_sunscreen') {
          await new Promise((resolve) => {
            setTimeout(resolve, 320);
          });
        }
        const base = {
          ok: true,
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
        };
        if (roleId === 'lightweight_moisturizer') {
          return {
            ...base,
            products: [
              {
                product_id: 'support_moisturizer_budget',
                merchant_id: 'merchant_ext_moisturizer_budget',
                title: 'Oil-Free Gel Moisturizer',
                display_name: 'Oil-Free Gel Moisturizer',
                brand: 'TestSkin',
                category: 'moisturizer',
                product_type: 'moisturizer',
                candidate_step: 'moisturizer',
                benefit_tags: ['lightweight', 'oil-free', 'gel cream'],
                short_description: 'A lightweight gel moisturizer for oily skin.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        if (roleId === 'daily_sunscreen') {
          return {
            ...base,
            products: [
              {
                product_id: 'support_sunscreen_budget',
                merchant_id: 'merchant_ext_sunscreen_budget',
                title: 'Oil Control Sunscreen SPF 50',
                display_name: 'Oil Control Sunscreen SPF 50',
                brand: 'TestSkin',
                category: 'sunscreen',
                product_type: 'sunscreen',
                candidate_step: 'sunscreen',
                benefit_tags: ['spf', 'oil control', 'lightweight'],
                short_description: 'A lightweight SPF 50 sunscreen for oily skin.',
                retrieval_source: 'external_seed',
              },
            ],
          };
        }
        return { ...base, products: [], reason: 'empty' };
      },
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_support_internal_hang_external_budget' },
      primaryQuery: 'what products should i use for oily skin?',
      fallbackMessage: 'what products should i use for oily skin?',
      targetContext: resolveRecommendationTargetContext({
        text: 'what products should i use for oily skin?',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.deepEqual(
      out.recommendations.map((item) => item?.matched_role_id).sort(),
      ['daily_sunscreen', 'lightweight_moisturizer', 'oil_control_treatment'],
    );
    assert.deepEqual(
      externalCaptured.slice(0, 2),
      ['lightweight_moisturizer', 'daily_sunscreen'],
    );
    const supportInternalAttempts =
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts
        ?.filter((row) => row?.fair_support_internal_round === 1) || [];
    assert.equal(
      supportInternalAttempts.every((row) => row?.reason === 'upstream_timeout'),
      true,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    if (originalSupportInternalTimeout == null) delete process.env.AURORA_BFF_RECO_CATALOG_SUPPORT_INTERNAL_QUERY_TIMEOUT_MS;
    else process.env.AURORA_BFF_RECO_CATALOG_SUPPORT_INTERNAL_QUERY_TIMEOUT_MS = originalSupportInternalTimeout;
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch prioritizes lightweight layering queries over plain moisturizer under primary query caps', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const internalCaptured = [];
    const externalCaptured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        internalCaptured.push(query);
        return {
          ok: true,
          products: [],
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
      },
      searchLocalExternalSeedProducts: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        const roleId = String(args?.role?.role_id || '').trim();
        externalCaptured.push({ query, roleId });
        return {
          ok: true,
          products: [],
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
          local_external_seed_search_mode: 'staged_support_fastpath',
          local_external_seed_stage_debug: [],
        };
      },
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_makeup_layering_query_priority' },
      primaryQuery: 'My daytime products pill under makeup. What skincare product should I use instead?',
      fallbackMessage: 'My daytime products pill under makeup. What skincare product should I use instead?',
      targetContext: {
        primary_role_id: 'layering_compatible_moisturizer_or_spf',
        comparison_mode: 'routine_mix',
        semantic_plan: {
          routine_mode: 'routine_mix',
          comparison_mode: 'routine_mix',
          selection_constraints: { comparison_mode: 'routine_mix' },
        },
        framework_summary: {
          concern_text: 'products pill under makeup',
        },
        framework_roles: [
          {
            role_id: 'layering_compatible_moisturizer_or_spf',
            rank: 60,
            preferred_step: 'moisturizer',
            label: 'Layering-compatible moisturizer or SPF',
            query_terms: [
              'lightweight moisturizer under makeup',
              'non pilling moisturizer',
              'sunscreen under makeup',
              'gel cream under makeup',
              'makeup compatible spf',
            ],
            fit_keywords: [
              'under makeup',
              'non-pilling',
              'pilling',
              'layering',
              'lightweight',
              'gel cream',
              'makeup compatible',
              'smooth finish',
            ],
          },
          {
            role_id: 'hydrating_serum_or_essence',
            rank: 42,
            preferred_step: 'serum',
            label: 'Hydrating serum or essence',
            query_terms: ['hyaluronic acid serum', 'hydrating serum dehydrated skin'],
            fit_keywords: ['hydrating', 'dehydrated', 'hyaluronic acid'],
          },
          {
            role_id: 'daily_sunscreen_finish_fit',
            rank: 31,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen finish fit',
            query_terms: ['sunscreen', 'spf fluid'],
            fit_keywords: ['spf', 'lightweight finish', 'makeup friendly'],
          },
        ],
      },
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    const attempts = out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts || [];
    const primaryInternalQueries = attempts
      .filter((row) => row?.ladder_level === 'framework_stage_a_primary_internal')
      .map((row) => row?.query);
    const primaryExternalQueries = attempts
      .filter((row) => row?.ladder_level === 'framework_stage_b_primary_external_seed')
      .map((row) => row?.query);

    assert.deepEqual(primaryInternalQueries.slice(0, 2), ['gel cream moisturizer', 'lightweight moisturizer']);
    assert.deepEqual(primaryExternalQueries.slice(0, 2), ['gel cream moisturizer', 'lightweight moisturizer']);
    assert.equal(primaryInternalQueries.includes('moisturizer'), false);
    assert.equal(primaryExternalQueries.includes('moisturizer'), false);
    assert.equal(primaryInternalQueries.includes('makeup layering moisturizer'), false);
    assert.equal(primaryExternalQueries.includes('makeup layering moisturizer'), false);
    assert.equal(internalCaptured.includes('lightweight moisturizer'), true);
    assert.equal(
      externalCaptured.some((row) => row?.query === 'lightweight moisturizer' && row?.roleId === 'layering_compatible_moisturizer_or_spf'),
      true,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('runConcernSemanticPlanner narrows dry use-first asks into moisturizer-led same-slot comparison', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    let capturedArgs = null;
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      capturedArgs = args;
      return {
        ok: true,
        json: {
          primary_concern: 'dry tight skin after washing',
          primary_role_id: 'hydrating_barrier_moisturizer',
          support_role_ids: ['hydrating_serum_or_essence', 'daily_sunscreen'],
          routine_mode: 'routine_mix',
          query_intents: [
            {
              role_id: 'hydrating_barrier_moisturizer',
              intent: 'barrier repair moisturizer',
              query_terms: ['barrier repair moisturizer'],
            },
            {
              role_id: 'hydrating_serum_or_essence',
              intent: 'hydrating serum',
              query_terms: ['hyaluronic acid serum'],
            },
            {
              role_id: 'daily_sunscreen',
              intent: 'daily sunscreen',
              query_terms: ['daily sunscreen'],
            },
          ],
          must_satisfy_constraints: ['start with barrier support', 'avoid over-stripping'],
          comparison_mode: 'routine_mix',
          evidence_needed: ['barrier support', 'hydration', 'daily UV protection'],
          ingredient_hypotheses: ['ceramides', 'hyaluronic acid'],
          product_type_hypotheses: ['moisturizer', 'serum', 'sunscreen'],
        },
        parse_status: 'parsed',
        provider: 'gemini',
        requested_model: args.model,
        effective_model: args.model,
        selection_source: 'local_gemini_rest_direct',
      };
    });

    const out = await __internal.runConcernSemanticPlanner({
      ctx: { lang: 'EN', request_id: 'req_structured_planner_test' },
      requestText: 'my skin feels dry and tight after washing, what should i use first?',
      focus: '',
      deadlineAtMs: Date.now() + 5000,
    });

    assert.equal(capturedArgs?.route, 'aurora_concern_semantic_plan_json');
    assert.equal(capturedArgs?.thinkingLevel, 'minimal');
    assert.equal(capturedArgs?.maxOutputTokens, 700);
    assert.equal(capturedArgs?.responseSchema?.type, 'object');
    assert.equal(out.trace?.planner_failure_class, null);
    assert.equal(out.trace?.planner_attempts?.[0]?.structured_contract, 'json_object');
    assert.equal(out.semanticPlan?.selection_owner_state, 'trusted');
    assert.deepEqual(out.semanticPlan?.core_roles?.map((role) => role?.role_id), ['hydrating_barrier_moisturizer']);
    assert.deepEqual(out.semanticPlan?.support_roles?.map((role) => role?.role_id), []);
    assert.equal(out.semanticPlan?.routine_mode, 'same_role_comparison');
    assert.equal(out.semanticPlan?.comparison_mode, 'same_role_comparison');
    assert.equal(out.semanticPlan?.selection_constraints?.narrowing_reason, 'use_first_or_buy_next_focus');
    assert.equal(out.semanticPlan?.must_satisfy_constraints?.includes('moisturizer-only same-slot comparison'), true);
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    delete require.cache[moduleId];
  }
});

test('runConcernSemanticPlanner forwards analysis handoff targets into prompt and keeps explicit moisturizer follow-up narrowed', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  let capturedArgs = null;
  try {
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
      capturedArgs = args;
      return {
        ok: true,
        json: {
          primary_concern: 'barrier repair after retinoid dryness',
          primary_role_id: 'hydrating_barrier_moisturizer',
          support_role_ids: ['soothing_treatment', 'daily_sunscreen'],
          routine_mode: 'routine_mix',
          query_intents: [
            {
              role_id: 'hydrating_barrier_moisturizer',
              intent: 'barrier moisturizer after retinoid dryness',
              query_terms: ['barrier moisturizer retinoid dryness'],
            },
          ],
          must_satisfy_constraints: ['no more actives'],
          comparison_mode: 'routine_mix',
          evidence_needed: ['barrier support', 'comfort', 'non-active step'],
          ingredient_hypotheses: ['ceramides', 'panthenol'],
          product_type_hypotheses: ['moisturizer', 'serum', 'sunscreen'],
        },
        parse_status: 'parsed',
        provider: 'gemini',
        requested_model: args.model,
        effective_model: args.model,
        selection_source: 'local_gemini_rest_direct',
      };
    });

    const out = await __internal.runConcernSemanticPlanner({
      ctx: { lang: 'EN', request_id: 'req_analysis_handoff_moisturizer_followup' },
      requestText: 'What moisturizer product should I buy next? I do not want another active.',
      focus: 'moisturizer',
      recommendationTaskContext: {
        context_mode: 'latest_reco_context',
        source_detail: 'analysis_handoff',
        primary_target_id: 'hydrating_barrier_moisturizer',
        resolved_target_step: 'moisturizer',
        goal: 'barrier support after retinoid dryness',
        ingredient_query: 'ceramide moisturizer',
        snapshot_fields_used: ['ranked_targets'],
        hard_context_fields_used: ['ranked_targets', 'target_step'],
        ranked_targets: [
          {
            target_id: 'hydrating_barrier_moisturizer',
            target_role: 'primary',
            resolved_target_step: 'moisturizer',
            target_confidence: 'high',
            ingredient_query: 'ceramide moisturizer',
          },
        ],
      },
      deadlineAtMs: Date.now() + 5000,
    });

    assert.match(String(capturedArgs?.userPrompt || ''), /"primary_target_id":"hydrating_barrier_moisturizer"/);
    assert.match(String(capturedArgs?.userPrompt || ''), /"resolved_target_step":"moisturizer"/);
    assert.match(String(capturedArgs?.userPrompt || ''), /"ranked_targets":\[/);
    assert.equal(out.semanticPlan?.selection_owner_state, 'trusted');
    assert.deepEqual(out.semanticPlan?.core_roles?.map((role) => role?.role_id), ['hydrating_barrier_moisturizer']);
    assert.deepEqual(out.semanticPlan?.support_roles?.map((role) => role?.role_id), []);
    assert.equal(out.semanticPlan?.routine_mode, 'same_role_comparison');
    assert.equal(out.semanticPlan?.comparison_mode, 'same_role_comparison');
    assert.equal(out.semanticPlan?.selection_constraints?.narrowing_reason, 'explicit_step_product_request');
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    delete require.cache[moduleId];
  }
});

test('runConcernSemanticPlanner narrows analysis-context makeup layering asks to finish-fit sunscreen comparison', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => ({
      ok: true,
      json: {
        primary_concern: 'daytime layering with sensitivity',
        primary_role_id: 'soothing_treatment',
        support_role_ids: ['layering_compatible_moisturizer_or_spf', 'barrier_moisturizer'],
        routine_mode: 'routine_mix',
        query_intents: [
          {
            role_id: 'soothing_treatment',
            intent: 'soothing serum sensitive skin',
            query_terms: ['soothing serum sensitive skin'],
          },
        ],
        must_satisfy_constraints: ['under makeup', 'daytime wear'],
        comparison_mode: 'routine_mix',
        evidence_needed: ['layering compatibility', 'barrier support'],
        ingredient_hypotheses: ['Panthenol'],
        product_type_hypotheses: ['serum', 'moisturizer'],
      },
      parse_status: 'parsed',
      provider: 'gemini',
      requested_model: args.model,
      effective_model: args.model,
      selection_source: 'local_gemini_rest_direct',
    }));

    const out = await __internal.runConcernSemanticPlanner({
      ctx: { lang: 'EN', request_id: 'req_makeup_layering_analysis_context_repair' },
      requestText: 'Based on my routine and the skin analysis, what should I buy for daytime so my makeup stops pilling?',
      focus: 'sunscreen',
      profileSummary: {
        skinType: 'combination',
        sensitivity: 'high',
        barrierStatus: 'impaired',
        goals: ['smooth layering', 'barrier support', 'daily sunscreen'],
      },
      deadlineAtMs: Date.now() + 5000,
    });

    assert.equal(out.trace?.planner_failure_class, null);
    assert.equal(out.semanticPlan?.selection_owner_state, 'trusted');
    assert.deepEqual(
      out.semanticPlan?.core_roles?.map((role) => role?.role_id).slice(0, 3),
      ['daily_sunscreen_finish_fit'],
    );
    assert.deepEqual(out.semanticPlan?.support_roles?.map((role) => role?.role_id), []);
    assert.equal(out.semanticPlan?.routine_mode, 'same_role_comparison');
    assert.equal(out.semanticPlan?.comparison_mode, 'same_role_comparison');
    assert.equal(out.semanticPlan?.selection_constraints?.narrowing_reason, 'explicit_daytime_layering_request');
  } finally {
    __internal.__resetCallGeminiJsonObjectForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch exposes raw candidate pool sources when only the strong internal winner is selected', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        if (query === 'oil control serum') {
          return {
            ok: true,
            products: [
              {
                product_id: 'strong_anchor',
                merchant_id: 'merchant_catalog_strong_anchor',
                title: 'Strong Oil Control Serum',
                display_name: 'Strong Oil Control Serum',
                category: 'serum',
                product_type: 'serum',
                candidate_step: 'treatment',
                benefit_tags: ['oil control', 'shine control', 'mattifying'],
                search_aliases: ['shine control serum'],
                short_description: 'A mattifying oil-control serum for oily skin.',
                retrieval_source: 'catalog',
              },
            ],
            attempted_internal_paths: ['/agent/internal/products/search'],
            transport_hops: [],
            transport_hop_count: 0,
            nested_orchestrator_hops: 0,
            primary_transport_owner: 'internal_products_search_primitive',
            primary_endpoint_kind: 'internal_primitive',
          };
        }
        return {
          ok: true,
          products: [],
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
      },
      searchLocalExternalSeedProducts: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        if (['oil control treatment', 'niacinamide serum oily skin', 'salicylic acid serum oily skin'].includes(query)) {
          return {
            ok: true,
            products: [
              {
                product_id: 'weak_external_semantic_miss',
                merchant_id: 'external_seed',
                title: 'Alt Niacinamide Serum',
                display_name: 'Alt Niacinamide Serum',
                category: 'serum',
                product_type: 'serum',
                short_description: 'A niacinamide serum for oily skin.',
                retrieval_source: 'external_seed',
              },
            ],
            reason: null,
            actual_http_attempt_count: 0,
            attempted_base_urls: [],
            attempted_paths: [],
          };
        }
        return {
          ok: true,
          products: [],
          reason: 'empty',
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
        };
      },
    });

    const targetContext = resolveRecommendationTargetContext({
      text: 'what products should i use for oily skin?',
      focus: '',
      entryType: 'chat',
    });
    targetContext.comparison_mode = 'same_role_comparison';
    targetContext.semantic_plan = {
      ...(targetContext.semantic_plan || {}),
      comparison_mode: 'same_role_comparison',
      selection_constraints: {
        ...(targetContext.semantic_plan?.selection_constraints || {}),
        comparison_mode: 'same_role_comparison',
      },
    };
    targetContext.primary_role_id = 'oil_control_treatment';
    targetContext.framework_roles = [
      {
        role_id: 'oil_control_treatment',
        rank: 10,
        preferred_step: 'treatment',
        label: 'Oil-control treatment',
        query_terms: ['oil control serum', 'shine control serum', 'mattifying serum'],
        fit_keywords: ['oil control', 'shine control', 'mattifying'],
      },
    ];
    targetContext.support_roles = [];

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_candidate_pool_visibility' },
      primaryQuery: 'what products should i use for oily skin?',
      fallbackMessage: 'what products should i use for oily skin?',
      targetContext,
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.deepEqual(
      out.recommendations.map((item) => item?.product_id),
      ['strong_anchor'],
    );
    assert.deepEqual(
      out.searchResult?.metadata?.source_breakdown?.source_tier_counts,
      { fresh_internal: 1 },
    );
    assert.deepEqual(
      out.searchResult?.metadata?.source_breakdown?.raw_source_tier_counts,
      { fresh_internal: 1, fresh_external: 1 },
    );
    assert.equal(
      out.searchResult?.metadata?.candidate_pool_summary?.raw_source_counts?.external_seed,
      1,
    );
    assert.equal(
      out.searchResult?.metadata?.candidate_pool_summary?.selected_source_counts?.catalog,
      1,
    );
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.candidate_pool_summary?.hard_reject_count,
      1,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch preserves local empty result without proxy rescue', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const localCalls = [];
    let proxyAttempts = 0;
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        localCalls.push({
          query: String(args?.query || ''),
          callerLane: String(args?.callerLane || ''),
        });
        return {
          ok: true,
          products: [],
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
      },
      searchPivotaBackendProducts: async () => {
        proxyAttempts += 1;
        throw new Error('proxy rescue must not run');
      },
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_local_empty_preserved_without_proxy_rescue' },
      primaryQuery: 'what products should i use for oily skin?',
      fallbackMessage: 'what products should i use for oily skin?',
      targetContext: resolveRecommendationTargetContext({
        text: 'what products should i use for oily skin?',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
      deadlineAtMs: Date.now() + 15000,
    });

    assert.equal(localCalls.length > 0, true);
    assert.equal(proxyAttempts, 0);
    assert.deepEqual(out.recommendations, []);
    assert.equal(out.searchResult?.query_source, 'beauty_mainline_local_handoff');
    assert.equal(out.searchResult?.metadata?.final_decision, 'strict_empty');
    assert.equal(out.searchResult?.reason, 'empty');
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch fail-closes before selecting support rows when primary recall is missing', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        const query = String(args?.query || '').trim().toLowerCase();
        const base = {
          ok: true,
          attempted_internal_paths: ['/agent/internal/products/search'],
          transport_hops: [],
          transport_hop_count: 0,
          nested_orchestrator_hops: 0,
          primary_transport_owner: 'internal_products_search_primitive',
          primary_endpoint_kind: 'internal_primitive',
        };
        if (query.includes('sunscreen') || query.includes('spf')) {
          return {
            ...base,
            products: [
              {
                product_id: 'support_spf_1',
                merchant_id: 'mid_support_spf',
                brand: 'SunGuard',
                name: 'Daily UV Fluid SPF 50',
                display_name: 'Daily UV Fluid SPF 50',
                category: 'sunscreen',
                product_type: 'sunscreen',
              },
            ],
          };
        }
        if (query.includes('moisturizer') || query.includes('gel cream') || query.includes('lotion')) {
          return {
            ...base,
            products: [
              {
                product_id: 'support_moist_1',
                merchant_id: 'mid_support_moist',
                brand: 'LightLab',
                name: 'Air Gel Cream',
                display_name: 'Air Gel Cream',
                category: 'moisturizer',
                product_type: 'gel cream',
              },
            ],
          };
        }
        return {
          ...base,
          products: [],
        };
      },
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_support_only_weak_pool' },
      primaryQuery: 'what products should i use for oily skin?',
      fallbackMessage: 'what products should i use for oily skin?',
      targetContext: resolveRecommendationTargetContext({
        text: 'what products should i use for oily skin?',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
      deadlineAtMs: Date.now() + 15000,
    });

    assert.deepEqual(
      out.recommendations.map((item) => item.product_id),
      [],
    );
    assert.equal(
      out.searchResult?.metadata?.candidate_pool_summary?.weak_viable_pool,
      false,
    );
    assert.equal(
      out.searchResult?.metadata?.candidate_pool_summary?.viable_pool_strength,
      'empty',
    );
    assert.equal(
      out.searchResult?.metadata?.candidate_pool_summary?.primary_missing_authoritative_support_selected,
      false,
    );
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.candidate_drop_stage,
      'no_recall_from_planned_sources',
    );
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.primary_failure_stage ?? null,
      'no_recall_from_planned_sources',
    );
    const supportAttempts = out.searchResult?.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts
      ?.filter((row) => String(row?.ladder_level || '').startsWith('framework_stage_c_support_')) || [];
    assert.equal(
      supportAttempts.some((row) => row?.allow_pending_primary_external === true),
      true,
    );
    assert.equal(
      out.searchResult?.metadata?.candidate_pool_summary?.primary_missing_authoritative_support_selected,
      false,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch builds reco rows from canonical final selection instead of raw mixed products', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN' },
      primaryQuery: 'best sunscreen for oily skin',
      fallbackMessage: 'best sunscreen for oily skin',
      targetContext: resolveRecommendationTargetContext({
        text: 'best sunscreen for oily skin',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
      searchFn: async () => ({
        ok: true,
        products: [
          {
            product_id: 'cleanser_1',
            merchant_id: 'merchant_cleanser',
            title: 'Ultra Gentle Cream-to-Foam Face Cleanser Jumbo',
            category: 'Cleanser',
            product_type: 'cleanser',
            candidate_step: 'cleanser',
          },
          {
            product_id: 'spf_1',
            merchant_id: 'merchant_spf',
            title: 'Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
            category: 'Sunscreen',
            product_type: 'sunscreen',
            candidate_step: 'sunscreen',
          },
          {
            product_id: 'balm_1',
            merchant_id: 'merchant_balm',
            title: 'Color Balm 3-in-1 Stick - Mocha',
            category: 'Makeup',
            product_type: 'color balm',
            candidate_step: 'other',
          },
        ],
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner: 'shopping_agent_beauty_mainline',
        query_source: 'agent_products_search',
        final_selection: {
          selection_owner: 'shopping_agent_beauty_mainline',
          selected_product_ids: ['spf_1'],
          selected_titles: ['Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30'],
          selection_signature: 'sel_spf_only',
          mainline_status: 'grounded_success',
        },
        search_stage_ledger: {
          final_selection: {
            selection_owner: 'shopping_agent_beauty_mainline',
            selected_product_ids: ['spf_1'],
            selected_titles: ['Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30'],
            selection_signature: 'sel_spf_only',
            mainline_status: 'grounded_success',
          },
        },
        source_breakdown: {
          source_tier_counts: { fresh_external: 3 },
          top_candidate_provenance: { source_owner: 'external_seed' },
        },
        contract_bridge: {
          attempted_contract: 'agent_v1_search_beauty_mainline',
          resolved_contract: 'agent_v1_search_beauty_mainline',
        },
      }),
    });

    assert.deepEqual(
      out.recommendations.map((item) => item.product_id),
      ['spf_1'],
    );
    assert.equal(out.recommendations[0]?.display_name, 'Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30');
    assert.equal(out.searchResult?.semantic_owner, 'shopping_agent_beauty_mainline');
    assert.equal(out.searchResult?.contract_bridge?.resolved_contract, 'agent_v1_search_beauty_mainline');
  } finally {
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch hydrates reviewed product intel before building mainline reco rows', async () => {
  const productIntelKbStore = require('../src/auroraBff/productIntelKbStore');
  const { moduleId, __internal } = loadRouteInternals();
  try {
    await productIntelKbStore.upsertProductIntelKbEntry({
      kb_key: 'product:spf_insight_1',
      source: 'pivota_product_intel_pilot_selected',
      analysis: {
        product_intel_v1: {
          contract_version: 'pivota.product_intel.v1',
          product_intel_core: {
            what_it_is: {
              body: 'A reviewed sunscreen profile for daily UV protection with a lightweight finish.',
            },
            why_it_stands_out: [
              {
                headline: 'Lightweight SPF fit',
                body: 'The reviewed profile connects daily UV coverage with a lighter finish for under-makeup wear.',
              },
            ],
            best_for: [
              {
                label: 'Daily sunscreen under makeup',
              },
            ],
          },
          shopping_card: {
            title: 'Reviewed SPF',
            subtitle: 'Lightweight sunscreen',
            intro: 'Daily sunscreen profile with reviewed finish context.',
          },
          quality_state: 'limited',
          evidence_profile: 'seller_only',
        },
      },
      source_meta: {
        review_tier: 'assistant_reviewed',
      },
      last_success_at: new Date().toISOString(),
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN' },
      primaryQuery: 'best sunscreen for oily skin',
      fallbackMessage: 'best sunscreen for oily skin',
      targetContext: resolveRecommendationTargetContext({
        text: 'best sunscreen for oily skin',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
      searchFn: async () => ({
        ok: true,
        products: [
          {
            product_id: 'spf_insight_1',
            merchant_id: 'merchant_spf',
            title: 'Reviewed SPF',
            category: 'Sunscreen',
            product_type: 'sunscreen',
            candidate_step: 'sunscreen',
          },
        ],
        decision_owner: 'shopping_agent_beauty_mainline',
        query_source: 'agent_products_search',
      }),
    });

    assert.equal(out.searchResult?.products?.[0]?.metadata?.product_intel_kb_used, true);
    assert.equal(out.recommendations[0]?.product_intel?.contract_version, 'pivota.product_intel.v1');
    assert.equal(
      out.recommendations[0]?.pivota_insights?.what_it_is,
      'A reviewed sunscreen profile for daily UV protection with a lightweight finish.',
    );
    assert.deepEqual(out.recommendations[0]?.compare_highlights, [
      'The reviewed profile connects daily UV coverage with a lighter finish for under-makeup wear.',
      'Suited for Daily sunscreen under makeup',
      'Lightweight sunscreen',
    ]);
  } finally {
    productIntelKbStore.__internal.clearMemoryCacheForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch exposes reviewed intel on hydrated rows for downstream finish-fit reranking', async () => {
  const productIntelKbStore = require('../src/auroraBff/productIntelKbStore');
  const { moduleId, __internal } = loadRouteInternals();
  try {
    await productIntelKbStore.upsertProductIntelKbEntry({
      kb_key: 'product:spf_portable_1',
      source: 'pivota_product_intel_pilot_selected',
      analysis: {
        product_intel_v1: {
          contract_version: 'pivota.product_intel.v1',
          product_intel_core: {
            what_it_is: {
              body: 'A portable chemical-filter sun stick designed for quick daytime reapplication.',
            },
          },
          shopping_card: {
            title: 'Portable SPF stick',
            subtitle: 'Portable SPF touchup',
            intro: 'Portable SPF50+ sun stick for quick daytime touchups.',
          },
          search_card: {
            intro_candidate: 'Portable SPF50+ sun stick for quick daytime touchups.',
          },
          quality_state: 'limited',
          evidence_profile: 'seller_only',
          texture_finish: {
            texture: 'smooth balm stick',
            layering_notes: ['Works best as a portable reapplication format over an existing morning routine.'],
          },
        },
      },
      source_meta: {
        review_tier: 'assistant_reviewed',
      },
      last_success_at: new Date().toISOString(),
    });

    await productIntelKbStore.upsertProductIntelKbEntry({
      kb_key: 'product:spf_fluid_1',
      source: 'pivota_product_intel_pilot_selected',
      analysis: {
        product_intel_v1: {
          contract_version: 'pivota.product_intel.v1',
          product_intel_core: {
            what_it_is: {
              body: 'A lightweight sunscreen fluid built for first-wear daytime layering under makeup.',
            },
          },
          shopping_card: {
            title: 'Finish-fit daily sunscreen',
            subtitle: 'Daily sunscreen',
            intro: 'Lightweight sunscreen fluid that layers smoothly under makeup with no white cast.',
          },
          search_card: {
            intro_candidate: 'Lightweight sunscreen fluid that layers smoothly under makeup with no white cast.',
          },
          quality_state: 'limited',
          evidence_profile: 'seller_plus_formula',
          texture_finish: {
            texture: 'fluid',
            layering_notes: ['Use as the last morning skin-care step before makeup.'],
          },
        },
      },
      source_meta: {
        review_tier: 'assistant_reviewed',
      },
      last_success_at: new Date().toISOString(),
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN' },
      primaryQuery: 'Based on my routine and the skin analysis, what should I buy for daytime so my makeup stops pilling?',
      fallbackMessage: 'Based on my routine and the skin analysis, what should I buy for daytime so my makeup stops pilling?',
      targetContext: {
        entry_type: 'chat',
        intent_mode: 'generic_concern',
        step_aware_intent: false,
        concern: 'makeup pilling',
        primary_concern: 'makeup pilling',
        request_text: 'Based on my routine and the skin analysis, what should I buy for daytime so my makeup stops pilling?',
        primary_role_id: 'daily_sunscreen_finish_fit',
        routine_mode: 'same_role_comparison',
        comparison_mode: 'same_role_comparison',
        framework_roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            rank: 1,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen finish fit',
            why_this_role: 'Use a daily sunscreen that layers cleanly under makeup.',
            query_terms: ['sunscreen under makeup', 'lightweight sunscreen oily skin'],
            fit_keywords: ['under makeup', 'lightweight', 'non-greasy', 'no white cast', 'invisible', 'fluid'],
            ingredient_hypotheses: ['UV filters'],
            product_type_hypotheses: ['sunscreen', 'fluid'],
          },
        ],
        semantic_plan: {
          primary_concern: 'makeup pilling and daytime layering with impaired barrier',
          comparison_mode: 'same_role_comparison',
          routine_mode: 'same_role_comparison',
          must_satisfy_constraints: ['under makeup', 'avoid pilling', 'lightweight finish'],
        },
      },
      timeoutMs: 5000,
      minTimeoutMs: 5000,
      searchFn: async () => ({
        ok: true,
        products: [
          {
            product_id: 'spf_portable_1',
            merchant_id: 'external_seed',
            title: 'Daily Soothing Sun Shield SPF50+ PA++++',
            brand: 'Haruharu Wonder',
            category: 'Sunscreen',
            product_type: 'Sunscreen',
            candidate_step: 'sunscreen',
            retrieval_source: 'external_seed',
            retrieval_reason: 'external_seed_local_search:support_category_exact',
            retrieval_match_stage: 'support_category_exact',
            retrieval_role_id: 'daily_sunscreen_finish_fit',
            retrieval_query: 'sunscreen',
            local_external_seed_role_fit_score: 1.305,
            description: 'Daily sunscreen for daytime UV protection.',
          },
          {
            product_id: 'spf_fluid_1',
            merchant_id: 'external_seed',
            title: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
            brand: 'Beauty of Joseon',
            category: 'Sunscreen',
            product_type: 'Sunscreen',
            candidate_step: 'sunscreen',
            retrieval_source: 'external_seed',
            retrieval_reason: 'external_seed_local_search:support_category_exact',
            retrieval_match_stage: 'support_category_exact',
            retrieval_role_id: 'daily_sunscreen_finish_fit',
            retrieval_query: 'sunscreen',
            local_external_seed_role_fit_score: 1.305,
            description: 'Daily sunscreen for daytime UV protection.',
          },
        ],
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner: 'shopping_agent_beauty_mainline',
        query_source: 'agent_products_search',
      }),
    });

    const rerankedState = __internal.finalizeConcernFrameworkCandidatePools(
      Array.isArray(out.searchResult?.products) ? out.searchResult.products : [],
      {
        targetContext: {
          primary_role_id: 'daily_sunscreen_finish_fit',
          request_text: 'Based on my routine and the skin analysis, what should I buy for daytime so my makeup stops pilling?',
          comparison_mode: 'same_role_comparison',
          routine_mode: 'same_role_comparison',
          semantic_plan: {
            primary_concern: 'makeup pilling and daytime layering with impaired barrier',
            comparison_mode: 'same_role_comparison',
            routine_mode: 'same_role_comparison',
            must_satisfy_constraints: ['under makeup', 'avoid pilling', 'lightweight finish'],
          },
          framework_roles: [
            {
              role_id: 'daily_sunscreen_finish_fit',
              rank: 1,
              preferred_step: 'sunscreen',
              label: 'Daily sunscreen finish fit',
              why_this_role: 'Use a daily sunscreen that layers cleanly under makeup.',
              query_terms: ['sunscreen under makeup', 'lightweight sunscreen oily skin'],
              fit_keywords: ['under makeup', 'lightweight', 'non-greasy', 'no white cast', 'invisible', 'fluid'],
              ingredient_hypotheses: ['UV filters'],
              product_type_hypotheses: ['sunscreen', 'fluid'],
            },
          ],
        },
      },
    );

    assert.deepEqual(
      rerankedState.selected_recommendations.map((item) => item.product_id),
      ['spf_fluid_1', 'spf_portable_1'],
    );
    assert.equal(out.searchResult?.products?.[0]?.metadata?.product_intel_kb_used, true);
    assert.equal(out.searchResult?.products?.[1]?.metadata?.product_intel_kb_used, true);
  } finally {
    productIntelKbStore.__internal.clearMemoryCacheForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch local handoff reranks finish-fit sunscreen picks with reviewed intel', async () => {
  const productIntelKbStore = require('../src/auroraBff/productIntelKbStore');
  const { moduleId, __internal } = loadRouteInternals();
  try {
    await productIntelKbStore.upsertProductIntelKbEntry({
      kb_key: 'product:ext_d4b52c2dad8f0c8ac77ff7ac',
      source: 'pivota_product_intel_pilot_selected',
      analysis: {
        product_intel_v1: {
          contract_version: 'pivota.product_intel.v1',
          product_intel_core: {
            what_it_is: {
              body: 'A portable chemical-filter sun stick designed for quick daytime reapplication.',
            },
          },
          shopping_card: {
            intro: 'Portable SPF50+ sun stick for quick daytime touchups.',
          },
          search_card: {
            intro_candidate: 'Portable SPF50+ sun stick for quick daytime touchups.',
          },
          quality_state: 'limited',
        },
      },
      source_meta: {
        review_tier: 'assistant_reviewed',
      },
      last_success_at: new Date().toISOString(),
    });
    await productIntelKbStore.upsertProductIntelKbEntry({
      kb_key: 'product:ext_f84eb0354d9578e047520615',
      source: 'pivota_product_intel_pilot_selected',
      analysis: {
        product_intel_v1: {
          contract_version: 'pivota.product_intel.v1',
          product_intel_core: {
            what_it_is: {
              body: 'A lightweight sunscreen fluid built for first-wear daytime layering under makeup.',
            },
          },
          shopping_card: {
            intro: 'Lightweight sunscreen fluid that layers smoothly under makeup with no white cast.',
          },
          search_card: {
            intro_candidate: 'Lightweight sunscreen fluid that layers smoothly under makeup with no white cast.',
          },
          quality_state: 'limited',
        },
      },
      source_meta: {
        review_tier: 'assistant_reviewed',
      },
      last_success_at: new Date().toISOString(),
    });

    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async () => ({
        ok: false,
        products: [],
        reason: 'upstream_timeout',
        attempted_internal_paths: ['/agent/internal/products/search'],
        transport_hops: [],
        transport_hop_count: 0,
        nested_orchestrator_hops: 0,
        primary_transport_owner: 'internal_products_search_primitive',
        primary_endpoint_kind: 'internal_primitive',
      }),
      searchLocalExternalSeedProducts: async (args) => {
        if (String(args?.role?.role_id || '') !== 'daily_sunscreen_finish_fit') {
          return {
            ok: true,
            products: [],
            reason: 'empty',
            actual_http_attempt_count: 0,
            attempted_base_urls: [],
            attempted_paths: [],
          };
        }
        return {
          ok: true,
          products: [
            {
              product_id: 'ext_d4b52c2dad8f0c8ac77ff7ac',
              merchant_id: 'external_seed',
              title: 'Daily Soothing Sun Shield SPF50+ PA++++',
              brand: 'Haruharu Wonder',
              category: 'Sunscreen',
              product_type: 'Sunscreen',
              retrieval_source: 'external_seed',
              retrieval_role_id: 'daily_sunscreen_finish_fit',
              retrieval_reason: 'external_seed_local_search:support_category_exact',
              retrieval_match_stage: 'support_category_exact',
              retrieval_query: String(args?.query || ''),
              local_external_seed_role_fit_score: 1.305,
              description: 'Daily sunscreen for daytime UV protection.',
            },
            {
              product_id: 'ext_f84eb0354d9578e047520615',
              merchant_id: 'external_seed',
              title: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
              brand: 'Beauty of Joseon',
              category: 'Sunscreen',
              product_type: 'Sunscreen',
              retrieval_source: 'external_seed',
              retrieval_role_id: 'daily_sunscreen_finish_fit',
              retrieval_reason: 'external_seed_local_search:support_category_exact',
              retrieval_match_stage: 'support_category_exact',
              retrieval_query: String(args?.query || ''),
              local_external_seed_role_fit_score: 1.305,
              description: 'Daily sunscreen for daytime UV protection.',
            },
            {
              product_id: 'ext_03dfb4ac825988a3ae86c1ac',
              merchant_id: 'external_seed',
              title: 'Day Dew Sunscreen 10ml',
              brand: 'Beauty of Joseon',
              category: 'Sunscreen',
              product_type: 'Sunscreen',
              retrieval_source: 'external_seed',
              retrieval_role_id: 'daily_sunscreen_finish_fit',
              retrieval_reason: 'external_seed_local_search:support_category_exact',
              retrieval_match_stage: 'support_category_exact',
              retrieval_query: String(args?.query || ''),
              local_external_seed_role_fit_score: 1.005,
              description: 'Travel sunscreen for trial use.',
            },
          ],
          reason: null,
          actual_http_attempt_count: 0,
          attempted_base_urls: [],
          attempted_paths: [],
          transport_policy_mode: String(args?.transportPolicyMode || ''),
          local_external_seed_search_mode: 'staged_support_fastpath',
          local_external_seed_stage_debug: [],
        };
      },
    });

    const query = 'Based on my routine and the skin analysis, what should I buy for daytime so my makeup stops pilling?';
    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_finish_fit_local_handoff_rerank' },
      primaryQuery: query,
      fallbackMessage: query,
      targetContext: resolveRecommendationTargetContext({
        text: query,
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
    });

    assert.deepEqual(
      out.recommendations.map((item) => item.product_id),
      [
        'ext_f84eb0354d9578e047520615',
        'ext_d4b52c2dad8f0c8ac77ff7ac',
        'ext_03dfb4ac825988a3ae86c1ac',
      ],
    );
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.final_selection?.selected_titles?.[0],
      'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    productIntelKbStore.__internal.clearMemoryCacheForTest();
    delete require.cache[moduleId];
  }
});

test('beauty chat mainline entry keeps framework source mode when real handoff derives generic concern context', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const observed = {
      payloadSourceMode: null,
      payloadTargetContext: null,
    };
    const runtime = createBeautyChatMainlineEntryRuntime({
      RECO_CATALOG_GROUNDED_ENABLED: true,
      RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS: 1000,
      resolveRecommendationTargetContext,
      summarizeProfileForContext: (profile) => profile,
      mergeIngredientRecoContextValue: (left, right) => ({ ...(left || {}), ...(right || {}) }),
      appendLatestRecoContextToSessionPatch: (sessionPatch, recoContext) => {
        sessionPatch.latest_reco_context = recoContext;
      },
      extractRecoFinalSelectionContract: (value) =>
        value?.metadata?.search_stage_ledger?.final_selection
        || value?.search_stage_ledger?.final_selection
        || null,
      buildRouteAwareAssistantText: () => 'framework handoff response',
      makeAssistantMessage: (content) => ({ role: 'assistant', format: 'text', content }),
      buildEnvelope: (_ctx, envelope) => envelope,
      makeEvent: (_ctx, kind, data) => ({ kind, data }),
      applyRecoContractToRecoRequestedEvents: (events) => ({ events }),
      buildRecoRequestedEventData: ({ payload, source }) => ({ payload, source }),
      normalizeRecoSourceDetail: (value) => value,
      stateChangeAllowed: () => false,
      handoffRecoToBeautyMainlineSearch: (args) =>
        __internal.handoffRecoToBeautyMainlineSearch({
          ...args,
          searchFn: async () => ({
            ok: true,
            products: [
              {
                product_id: 'framework_oily_1',
                merchant_id: 'external_seed',
                title: 'Oil Control Serum',
                brand: 'Pivota',
                category: 'Treatment',
                product_type: 'treatment',
                candidate_step: 'treatment',
                matched_role_id: 'oil_control_treatment',
              },
            ],
            decision_owner: 'shopping_agent_beauty_mainline',
            semantic_owner: 'shopping_agent_beauty_mainline',
            query_source: 'agent_products_search',
            metadata: {
              contract_bridge: {
                resolved_contract: 'agent_v1_search_beauty_mainline',
              },
              source_breakdown: {
                source_tier_counts: { fresh_external: 1 },
              },
              search_stage_ledger: {
                final_selection: {
                  selection_owner: 'shopping_agent_beauty_mainline',
                  selected_product_ids: ['framework_oily_1'],
                  selected_titles: ['Oil Control Serum'],
                  selection_signature: 'search_sel_framework_oily',
                  mainline_status: 'grounded_success',
                  source_tier_counts: { fresh_external: 1 },
                },
              },
            },
          }),
        }),
      buildRecoPayloadFromBeautyMainlineHandoff: ({ targetContext, sourceMode }) => {
        observed.payloadTargetContext = targetContext;
        observed.payloadSourceMode = sourceMode;
        return {
          payload: {
            source: 'catalog_grounded_v1',
            mainline_status: 'grounded_success',
            recommendation_meta: {
              source_mode: sourceMode,
            },
          },
          contract: {
            version: 'test_contract',
          },
        };
      },
      classifyBeautyMainlineHandoffFallback: () => ({ reason: 'unreachable' }),
      buildBeautyMainlineHandoffFallbackEnvelope: () => ({ cards: [] }),
      looksLikeRecommendationRequest: () => true,
      sendChatEnvelope: async () => null,
    });

    const result = await runtime.maybeHandleBeautyOwnedChatReco({
      ctx: {
        request_id: 'req_framework_oily',
        trace_id: 'trace_framework_oily',
        lang: 'EN',
        trigger_source: 'chat',
      },
      logger: null,
      message: 'im oily skin, what products should i use?',
      recoEntrySourceDetail: 'typed_reco',
      profile: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'stable',
        goals: ['oil control'],
      },
    });

    assert.equal(result?.handled, true);
    assert.equal(observed.payloadSourceMode, 'framework_mainline');
    assert.equal(observed.payloadTargetContext?.intent_mode, 'generic_concern');
    assert.equal(observed.payloadTargetContext?.primary_role_id, 'oil_control_treatment');
    assert.equal(
      result?.envelope?.cards?.[0]?.payload?.recommendation_meta?.source_mode,
      'framework_mainline',
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('beauty chat mainline entry invokes llm concern planner before deterministic handoff for generic concern asks', async () => {
  const startedAtMs = Date.now();
  const observed = {
    plannerCalls: 0,
    handoffTargetContext: null,
    plannerMeta: null,
    plannerDeadlineAtMs: null,
    handoffDeadlineAtMs: null,
    rewriteDeadlineAtMs: null,
    rewriteBaseText: 'unset',
    rewriteUserRequestText: null,
  };
  const runtime = createBeautyChatMainlineEntryRuntime({
    RECO_CATALOG_GROUNDED_ENABLED: true,
    RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS: 1000,
    AURORA_BFF_CHAT_RECO_BUDGET_MS: 18000,
    resolveRecommendationTargetContext: () => ({
      entry_type: 'chat',
      intent_mode: 'generic_concern',
      step_aware_intent: false,
      resolved_target_step: null,
      primary_role_id: 'oil_control_treatment',
      framework_roles: [
        {
          role_id: 'oil_control_treatment',
          rank: 1,
          preferred_step: 'treatment',
        },
      ],
    }),
    summarizeProfileForContext: (profile) => profile,
    mergeIngredientRecoContextValue: (left, right) => ({ ...(left || {}), ...(right || {}) }),
    appendLatestRecoContextToSessionPatch: (sessionPatch, recoContext) => {
      sessionPatch.latest_reco_context = recoContext;
    },
    extractRecoFinalSelectionContract: () => ({
      selection_owner: 'shopping_agent_beauty_mainline',
    }),
    buildRouteAwareAssistantText: () => 'planned framework handoff response',
    makeAssistantMessage: (content) => ({ role: 'assistant', format: 'text', content }),
    buildEnvelope: (_ctx, envelope) => envelope,
    makeEvent: (_ctx, kind, data) => ({ kind, data }),
    applyRecoContractToRecoRequestedEvents: (events) => ({ events }),
    buildRecoRequestedEventData: ({ payload, source }) => ({ payload, source }),
    normalizeRecoSourceDetail: (value) => value,
    stateChangeAllowed: () => false,
    runConcernSemanticPlanner: async ({ deadlineAtMs }) => {
      observed.plannerCalls += 1;
      observed.plannerDeadlineAtMs = deadlineAtMs;
      return {
        semanticPlan: {
          plan_id: 'llm_broad_oily_plan',
          selection_owner_source: 'llm_concern_planner',
          selection_owner_state: 'trusted',
          framework_summary: {
            concern_text: 'im oily skin, what products should i use?',
          },
          core_roles: [
            {
              role_id: 'oil_control_treatment',
              rank: 1,
              preferred_step: 'treatment',
              label: 'Oil-control treatment',
              why_this_role: 'Targeted oil-control comes first.',
              query_terms: ['oil control treatment'],
              ingredient_hypotheses: ['Niacinamide'],
              product_type_hypotheses: ['treatment'],
              routine_slots: ['pm'],
              frequency: 'daily_once',
            },
          ],
          support_roles: [
            {
              role_id: 'lightweight_moisturizer',
              rank: 2,
              preferred_step: 'moisturizer',
              label: 'Lightweight moisturizer',
              why_this_role: 'Keep hydration light.',
              query_terms: ['lightweight moisturizer oily skin'],
              ingredient_hypotheses: ['Glycerin'],
              product_type_hypotheses: ['moisturizer'],
              routine_slots: ['am', 'pm'],
              frequency: 'daily_twice',
            },
          ],
          ingredient_hypotheses: ['Niacinamide', 'Glycerin'],
        },
        trace: {
          planner_used: true,
          planner_source: 'llm_concern_planner',
          planner_route: 'aurora_concern_semantic_plan_plain_text',
          planner_selection_source: 'local_gemini_direct',
        },
      };
    },
    buildConcernTargetContextFromSemanticPlan: (semanticPlan) => ({
      entry_type: 'chat',
      intent_mode: 'generic_concern',
      step_aware_intent: false,
      resolved_target_step: null,
      framework_id: semanticPlan.plan_id,
      framework_owner_source: semanticPlan.selection_owner_source,
      framework_owner_state: semanticPlan.selection_owner_state,
      framework_roles: semanticPlan.core_roles,
      support_roles: semanticPlan.support_roles,
      primary_role_id: 'oil_control_treatment',
      framework_summary: semanticPlan.framework_summary,
      semantic_plan: semanticPlan,
    }),
    handoffRecoToBeautyMainlineSearch: async (args) => {
      observed.handoffTargetContext = args.targetContext;
      observed.handoffDeadlineAtMs = args.deadlineAtMs;
      return {
        targetContext: args.targetContext,
        recommendations: [
          {
            product_id: 'planned_oily_1',
            display_name: 'Oil Control Serum',
          },
        ],
        searchResult: {
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
          metadata: {
            contract_bridge: {
              resolved_contract: 'agent_v1_search_beauty_mainline',
            },
            source_breakdown: {
              source_tier_counts: { fresh_external: 1 },
            },
            search_stage_ledger: {
              final_selection: {
                selection_owner: 'shopping_agent_beauty_mainline',
                selected_product_ids: ['planned_oily_1'],
                selected_titles: ['Oil Control Serum'],
                selection_signature: 'search_sel_planned_oily',
                mainline_status: 'grounded_success',
                source_tier_counts: { fresh_external: 1 },
              },
            },
          },
        },
      };
    },
    buildRecoPayloadFromBeautyMainlineHandoff: ({ sourceMode, basePayload }) => {
      observed.plannerMeta = basePayload?.recommendation_meta || null;
      return {
        payload: {
          source: 'catalog_grounded_v1',
          mainline_status: 'grounded_success',
          recommendation_meta: {
            ...(basePayload?.recommendation_meta || {}),
            source_mode: sourceMode,
          },
        },
        contract: {
          version: 'test_contract',
        },
      };
    },
    maybeRewriteRecoAssistantTextWithLlm: async ({ deadlineAtMs, baseText, userRequestText }) => {
      observed.rewriteInvokedAtMs = Date.now();
      observed.rewriteDeadlineAtMs = deadlineAtMs;
      observed.rewriteBaseText = baseText;
      observed.rewriteUserRequestText = userRequestText;
      return {
        text: '',
        llm_used: false,
        reason: 'test_passthrough',
        attempt_count: 1,
        attempts: [
          {
            attempt_index: 1,
            compact_context: true,
            effective_timeout_ms: 1200,
            reason: 'test_passthrough',
          },
        ],
      };
    },
    classifyBeautyMainlineHandoffFallback: () => ({
      reason: 'unreachable',
    }),
    buildBeautyMainlineHandoffFallbackEnvelope: () => ({
      cards: [],
    }),
    looksLikeRecommendationRequest: () => true,
    sendChatEnvelope: async () => null,
  });

  const result = await runtime.maybeHandleBeautyOwnedChatReco({
    ctx: {
      request_id: 'req_llm_planned_oily',
      trace_id: 'trace_llm_planned_oily',
      lang: 'EN',
      trigger_source: 'chat',
    },
    logger: null,
    message: 'im oily skin, what products should i use?',
    recoEntrySourceDetail: 'typed_reco',
    profile: {
      skinType: 'oily',
      sensitivity: 'low',
      barrierStatus: 'stable',
      goals: ['oil control'],
    },
  });

  assert.equal(result?.handled, true);
  assert.equal(observed.plannerCalls, 1);
  assert.equal(observed.handoffTargetContext?.framework_owner_source, 'llm_concern_planner');
  assert.equal(observed.handoffTargetContext?.framework_id, 'llm_broad_oily_plan');
  assert.equal(observed.plannerMeta?.chat_planner_used, true);
  assert.equal(observed.plannerMeta?.chat_planner_source, 'llm_concern_planner');
  assert.equal(
    observed.plannerMeta?.chat_planner_route,
    'aurora_concern_semantic_plan_plain_text',
  );
  const payload = result?.envelope?.cards?.[0]?.payload;
  const timingLedger = payload?.metadata?.search_stage_ledger?.chat_mainline_timing;
  assert.equal(timingLedger?.owner, 'beauty_chat_mainline_entry');
  assert.equal(timingLedger?.budget_ms, 18000);
  assert.equal(timingLedger?.planner_used, true);
  assert.equal(timingLedger?.planner_fallback_used, false);
  assert.equal(timingLedger?.selector_attempted, false);
  assert.equal(timingLedger?.selector_applied, false);
  assert.equal(timingLedger?.rewrite_attempted, true);
  assert.equal(timingLedger?.rewrite_llm_used, false);
  assert.equal(timingLedger?.rewrite_attempt_count, 1);
  assert.equal(Number.isFinite(timingLedger?.planner_ms), true);
  assert.equal(Number.isFinite(timingLedger?.handoff_ms), true);
  assert.equal(Number.isFinite(timingLedger?.selector_ms), true);
  assert.equal(Number.isFinite(timingLedger?.rewrite_ms), true);
  assert.equal(Number.isFinite(timingLedger?.total_elapsed_ms), true);
  assert.ok(timingLedger?.total_elapsed_ms >= timingLedger?.planner_ms);
  assert.ok(timingLedger?.total_elapsed_ms >= timingLedger?.handoff_ms);
  assert.equal(Number.isFinite(observed.plannerDeadlineAtMs), true);
  assert.equal(Number.isFinite(observed.handoffDeadlineAtMs), true);
  assert.equal(Number.isFinite(observed.rewriteDeadlineAtMs), true);
  assert.ok(observed.plannerDeadlineAtMs - startedAtMs >= 8500);
  assert.ok(observed.handoffDeadlineAtMs >= observed.plannerDeadlineAtMs);
  assert.ok(observed.handoffDeadlineAtMs - observed.plannerDeadlineAtMs >= 2500);
  assert.ok(observed.rewriteDeadlineAtMs > observed.handoffDeadlineAtMs);
  assert.equal(Number.isFinite(observed.rewriteInvokedAtMs), true);
  assert.ok(observed.rewriteDeadlineAtMs - observed.rewriteInvokedAtMs >= 4500);
  assert.equal(observed.rewriteBaseText, undefined);
  assert.equal(observed.rewriteUserRequestText, 'im oily skin, what products should i use?');
  assert.equal(result?.envelope?.assistant_message, null);
  assert.equal(payload?.recommendation_meta?.assistant_rewrite_llm_used, false);
  assert.equal(payload?.recommendation_meta?.assistant_rewrite_reason, 'test_passthrough');
  assert.deepEqual(payload?.recommendation_meta?.assistant_rewrite_attempts, [
    {
      attempt_index: 1,
      compact_context: true,
      effective_timeout_ms: 1200,
      reason: 'test_passthrough',
    },
  ]);
});

test('beauty chat mainline entry records analysis handoff context usage without changing runtime path', async () => {
  const observed = {
    payloadBaseMeta: null,
    requestedEventData: null,
  };
  const runtime = createBeautyChatMainlineEntryRuntime({
    RECO_CATALOG_GROUNDED_ENABLED: true,
    RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS: 1000,
    resolveRecommendationTargetContext: () => ({
      entry_type: 'chat',
      intent_mode: 'explicit_role',
      step_aware_intent: true,
      resolved_target_step: 'moisturizer',
      resolved_target_step_confidence: 'high',
      resolved_target_step_source: 'explicit_target_step',
    }),
    summarizeProfileForContext: (profile) => profile,
    mergeIngredientRecoContextValue: (left, right) => ({ ...(left || {}), ...(right || {}) }),
    appendLatestRecoContextToSessionPatch: (sessionPatch, recoContext) => {
      sessionPatch.latest_reco_context = recoContext;
    },
    extractRecoFinalSelectionContract: () => ({
      selection_owner: 'shopping_agent_beauty_mainline',
    }),
    makeAssistantMessage: (content) => ({ role: 'assistant', format: 'text', content }),
    buildEnvelope: (_ctx, envelope) => envelope,
    makeEvent: (_ctx, kind, data) => ({ kind, data }),
    applyRecoContractToRecoRequestedEvents: (events) => ({ events }),
    buildRecoRequestedEventData: (eventData) => {
      observed.requestedEventData = eventData;
      return eventData;
    },
    normalizeRecoSourceDetail: (value) => value,
    stateChangeAllowed: () => false,
    handoffRecoToBeautyMainlineSearch: async (args) => ({
      targetContext: args.targetContext,
      recommendations: [
        {
          product_id: 'barrier_moisturizer_1',
          display_name: 'Barrier Repair Moisturizer',
        },
      ],
      searchResult: {
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner: 'shopping_agent_beauty_mainline',
        metadata: {
          search_stage_ledger: {
            final_selection: {
              selection_owner: 'shopping_agent_beauty_mainline',
              selected_product_ids: ['barrier_moisturizer_1'],
              mainline_status: 'grounded_success',
            },
          },
        },
      },
    }),
    buildRecoPayloadFromBeautyMainlineHandoff: ({ sourceMode, basePayload }) => {
      observed.payloadBaseMeta = basePayload?.recommendation_meta || null;
      return {
        payload: {
          source: 'catalog_grounded_v1',
          mainline_status: 'grounded_success',
          recommendation_meta: {
            ...(basePayload?.recommendation_meta || {}),
            source_mode: sourceMode,
          },
        },
        contract: {
          version: 'test_contract',
        },
      };
    },
    classifyBeautyMainlineHandoffFallback: () => ({
      reason: 'unreachable',
    }),
    buildBeautyMainlineHandoffFallbackEnvelope: () => ({
      cards: [],
    }),
    looksLikeRecommendationRequest: () => true,
    sendChatEnvelope: async () => null,
  });

  const result = await runtime.maybeHandleBeautyOwnedChatReco({
    ctx: {
      request_id: 'req_analysis_handoff_usage',
      trace_id: 'trace_analysis_handoff_usage',
      lang: 'EN',
      trigger_source: 'chat',
    },
    logger: null,
    message: 'what should I buy next?',
    recoEntrySourceDetail: 'typed_reco',
    latestRecoContextFromSession: {
      source_detail: 'analysis_handoff',
      trigger_source: 'analysis_handoff',
      context_origin: 'routine_audit_v1',
      artifact_id: 'art_routine_context',
      resolved_target_step: 'moisturizer',
      ingredient_query: 'moisturizer',
      goal: 'barrier support',
      primary_target_id: 'routine_minimal_pm_moisturizer_support',
      ranked_targets: [
        {
          target_id: 'routine_minimal_pm_moisturizer_support',
          ingredient_query: 'moisturizer',
          resolved_target_step: 'moisturizer',
          target_role: 'primary',
        },
      ],
    },
    profile: {
      skinType: 'dry',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['barrier support'],
    },
  });

  assert.equal(result?.handled, true);
  const payload = result?.envelope?.cards?.[0]?.payload;
  const usage = payload?.recommendation_meta?.analysis_context_usage;
  assert.equal(observed.payloadBaseMeta?.analysis_context_usage?.context_source_mode, 'analysis_handoff');
  assert.equal(usage?.analysis_context_available, true);
  assert.equal(usage?.context_source_mode, 'analysis_handoff');
  assert.equal(usage?.context_origin, 'routine_audit_v1');
  assert.equal(usage?.minimum_recommendation_context_satisfied, true);
  assert.equal(usage?.ranked_target_count, 1);
  assert.equal(observed.requestedEventData?.sourceDetail, 'analysis_handoff');
  assert.equal(result?.envelope?.latest_reco_context, undefined);
  assert.equal(result?.envelope?.session_patch?.latest_reco_context?.source_detail, 'analysis_handoff');
});

test('beauty chat mainline entry gives rewrite a fresh bounded deadline after slow upstream work', async () => {
  const observed = {};
  const realDateNow = Date.now;
  let fakeNow = 1_770_000_000_000;
  Date.now = () => fakeNow;
  try {
    const runtime = createBeautyChatMainlineEntryRuntime({
      RECO_CATALOG_GROUNDED_ENABLED: true,
      RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS: 1000,
      AURORA_BFF_CHAT_RECO_BUDGET_MS: 9000,
      resolveRecommendationTargetContext: () => ({
        entry_type: 'chat',
        intent_mode: 'generic_concern',
        step_aware_intent: false,
        resolved_target_step: null,
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            label: 'Oil-control treatment',
          },
        ],
      }),
      summarizeProfileForContext: (profile) => profile,
      mergeIngredientRecoContextValue: (left, right) => ({ ...(left || {}), ...(right || {}) }),
      appendLatestRecoContextToSessionPatch: (sessionPatch, recoContext) => {
        sessionPatch.latest_reco_context = recoContext;
      },
      extractRecoFinalSelectionContract: () => ({
        selection_owner: 'shopping_agent_beauty_mainline',
      }),
      makeAssistantMessage: (content) => ({ role: 'assistant', format: 'text', content }),
      buildEnvelope: (_ctx, envelope) => envelope,
      makeEvent: (_ctx, kind, data) => ({ kind, data }),
      applyRecoContractToRecoRequestedEvents: (events) => ({ events }),
      buildRecoRequestedEventData: ({ payload, source }) => ({ payload, source }),
      normalizeRecoSourceDetail: (value) => value,
      stateChangeAllowed: () => false,
      handoffRecoToBeautyMainlineSearch: async (args) => {
        observed.handoffDeadlineAtMs = args.deadlineAtMs;
        fakeNow += 6000;
        return {
          targetContext: args.targetContext,
          recommendations: [
            {
              product_id: 'planned_oily_1',
              display_name: 'Oil Control Serum',
              matched_role_id: 'oil_control_treatment',
              matched_role_label: 'Oil-control treatment',
              price: { amount: 18, currency: 'USD', unknown: false },
            },
          ],
          searchResult: {
            decision_owner: 'shopping_agent_beauty_mainline',
            semantic_owner: 'shopping_agent_beauty_mainline',
            metadata: {
              contract_bridge: {
                resolved_contract: 'agent_v1_search_beauty_mainline',
              },
              source_breakdown: {
                source_tier_counts: { fresh_external: 1 },
              },
              search_stage_ledger: {
                final_selection: {
                  selection_owner: 'shopping_agent_beauty_mainline',
                  selected_product_ids: ['planned_oily_1'],
                  selected_titles: ['Oil Control Serum'],
                  selection_signature: 'search_sel_planned_oily_fresh_deadline',
                  mainline_status: 'grounded_success',
                  source_tier_counts: { fresh_external: 1 },
                },
              },
            },
          },
        };
      },
      buildRecoPayloadFromBeautyMainlineHandoff: ({ sourceMode, basePayload }) => ({
        payload: {
          source: 'catalog_grounded_v1',
          mainline_status: 'grounded_success',
          recommendations: [
            {
              product_id: 'planned_oily_1',
              display_name: 'Oil Control Serum',
              matched_role_id: 'oil_control_treatment',
              matched_role_label: 'Oil-control treatment',
              price: { amount: 18, currency: 'USD', unknown: false },
            },
          ],
          recommendation_meta: {
            ...(basePayload?.recommendation_meta || {}),
            source_mode: sourceMode,
          },
        },
        contract: {
          version: 'test_contract',
        },
      }),
      maybeRewriteRecoAssistantTextWithLlm: async ({ deadlineAtMs }) => {
        observed.rewriteInvokedAtMs = Date.now();
        observed.rewriteDeadlineAtMs = deadlineAtMs;
        return { text: '', llm_used: false, reason: 'test_passthrough' };
      },
      classifyBeautyMainlineHandoffFallback: () => ({
        reason: 'unreachable',
      }),
      buildBeautyMainlineHandoffFallbackEnvelope: () => ({
        cards: [],
      }),
      looksLikeRecommendationRequest: () => true,
      sendChatEnvelope: async () => null,
    });

    const result = await runtime.maybeHandleBeautyOwnedChatReco({
      ctx: {
        request_id: 'req_rewrite_fresh_deadline',
        trace_id: 'trace_rewrite_fresh_deadline',
        lang: 'EN',
        trigger_source: 'chat',
      },
      logger: null,
      message: 'im oily skin, what products should i use?',
      recoEntrySourceDetail: 'typed_reco',
      profile: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'stable',
        goals: ['oil control'],
      },
    });

    const originalBudgetDeadlineAtMs = 1_770_000_009_000;
    assert.equal(result?.handled, true);
    assert.equal(observed.rewriteInvokedAtMs, 1_770_000_006_000);
    assert.ok(observed.rewriteDeadlineAtMs > originalBudgetDeadlineAtMs);
    assert.equal(observed.rewriteDeadlineAtMs - observed.rewriteInvokedAtMs, 5000);
    assert.ok(observed.rewriteDeadlineAtMs > observed.handoffDeadlineAtMs);
  } finally {
    Date.now = realDateNow;
  }
});

test('beauty chat mainline entry returns only llm rewrite prose on successful rewrite', async () => {
  const observed = {
    rewriteBaseText: 'unset',
    rewriteUserRequestText: null,
  };
  const runtime = createBeautyChatMainlineEntryRuntime({
    RECO_CATALOG_GROUNDED_ENABLED: true,
    RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS: 1000,
    resolveRecommendationTargetContext: () => ({
      entry_type: 'chat',
      intent_mode: 'generic_concern',
      step_aware_intent: false,
      resolved_target_step: null,
      primary_role_id: 'oil_control_treatment',
      framework_roles: [
        {
          role_id: 'oil_control_treatment',
          rank: 1,
          preferred_step: 'treatment',
          label: 'Oil-control treatment',
        },
      ],
    }),
    summarizeProfileForContext: (profile) => profile,
    mergeIngredientRecoContextValue: (left, right) => ({ ...(left || {}), ...(right || {}) }),
    appendLatestRecoContextToSessionPatch: (sessionPatch, recoContext) => {
      sessionPatch.latest_reco_context = recoContext;
    },
    extractRecoFinalSelectionContract: () => ({
      selection_owner: 'shopping_agent_beauty_mainline',
    }),
    makeAssistantMessage: (content) => ({ role: 'assistant', format: 'text', content }),
    buildEnvelope: (_ctx, envelope) => envelope,
    makeEvent: (_ctx, kind, data) => ({ kind, data }),
    applyRecoContractToRecoRequestedEvents: (events) => ({ events }),
    buildRecoRequestedEventData: ({ payload, source }) => ({ payload, source }),
    normalizeRecoSourceDetail: (value) => value,
    stateChangeAllowed: () => false,
    handoffRecoToBeautyMainlineSearch: async (args) => ({
      targetContext: args.targetContext,
      recommendations: [
        {
          product_id: 'oily_pick_1',
          display_name: 'GoalSkin Oil Control Serum',
          matched_role_id: 'oil_control_treatment',
        },
      ],
      searchResult: {
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner: 'shopping_agent_beauty_mainline',
        metadata: {
          contract_bridge: {
            resolved_contract: 'agent_v1_search_beauty_mainline',
          },
          source_breakdown: {
            source_tier_counts: { fresh_external: 1 },
          },
          search_stage_ledger: {
            final_selection: {
              selection_owner: 'shopping_agent_beauty_mainline',
              selected_product_ids: ['oily_pick_1'],
              selected_titles: ['GoalSkin Oil Control Serum'],
              selection_signature: 'search_sel_oily_pick_1',
              mainline_status: 'grounded_success',
              source_tier_counts: { fresh_external: 1 },
            },
          },
        },
      },
    }),
    buildRecoPayloadFromBeautyMainlineHandoff: ({ basePayload }) => ({
      payload: {
        source: 'catalog_grounded_v1',
        mainline_status: 'grounded_success',
        recommendations: [
          {
            product_id: 'oily_pick_1',
            display_name: 'GoalSkin Oil Control Serum',
            matched_role_id: 'oil_control_treatment',
          },
        ],
        recommendation_meta: {
          ...(basePayload?.recommendation_meta || {}),
          primary_target_id: 'oil_control_treatment',
          ranked_targets: [
            {
              target_id: 'oil_control_treatment',
              ingredient_query: 'Niacinamide',
              resolved_target_step: 'treatment',
            },
          ],
          selected_target_ids: ['oil_control_treatment'],
        },
        metadata: {},
      },
      contract: {
        version: 'test_contract',
      },
    }),
    maybeRewriteRecoAssistantTextWithLlm: async ({ baseText, userRequestText }) => {
      observed.rewriteBaseText = baseText;
      observed.rewriteUserRequestText = userRequestText;
      return {
        text: 'Start with GoalSkin Oil Control Serum for oil control, then keep the rest of your routine stable for 1-2 weeks.',
        llm_used: true,
        provider: 'test_provider',
        model: 'test_model',
        reason: null,
      };
    },
    classifyBeautyMainlineHandoffFallback: () => ({
      reason: 'unreachable',
    }),
    buildBeautyMainlineHandoffFallbackEnvelope: () => ({
      cards: [],
    }),
    looksLikeRecommendationRequest: () => true,
    sendChatEnvelope: async () => null,
  });

  const result = await runtime.maybeHandleBeautyOwnedChatReco({
    ctx: {
      request_id: 'req_llm_only_rewrite',
      trace_id: 'trace_llm_only_rewrite',
      lang: 'EN',
      trigger_source: 'chat',
    },
    logger: null,
    message: 'i am oily skin, what product should i use first?',
    recoEntrySourceDetail: 'typed_reco',
    profile: {
      skinType: 'oily',
      sensitivity: 'low',
      barrierStatus: 'stable',
      goals: ['oil control'],
    },
  });

  assert.equal(result?.handled, true);
  assert.equal(observed.rewriteBaseText, undefined);
  assert.equal(observed.rewriteUserRequestText, 'i am oily skin, what product should i use first?');
  assert.equal(
    result?.envelope?.assistant_message?.content,
    'Start with GoalSkin Oil Control Serum for oil control, then keep the rest of your routine stable for 1-2 weeks.',
  );
  assert.doesNotMatch(
    String(result?.envelope?.assistant_message?.content || ''),
    /Primary recommendation focus:|Products actually selected this time:/i,
  );
  assert.equal(
    result?.envelope?.cards?.[0]?.payload?.recommendation_meta?.assistant_rewrite_llm_used,
    true,
  );
  assert.equal(
    result?.envelope?.cards?.[0]?.payload?.recommendation_meta?.assistant_rewrite_provider,
    'test_provider',
  );
  assert.equal(
    result?.envelope?.cards?.[0]?.payload?.recommendation_meta?.assistant_rewrite_model,
    'test_model',
  );
});

test('beauty chat mainline entry fail-closes before deterministic target fallback when planner is untrusted', async () => {
  const observed = {
    handoffTargetContext: null,
    plannerMeta: null,
    fallback: null,
  };
  const runtime = createBeautyChatMainlineEntryRuntime({
    RECO_CATALOG_GROUNDED_ENABLED: true,
    RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS: 1000,
    resolveRecommendationTargetContext: () => ({
      entry_type: 'chat',
      intent_mode: 'generic_concern',
      step_aware_intent: false,
      resolved_target_step: null,
      framework_owner_source: 'generic_concern_framework_resolver',
      framework_owner_state: 'trusted',
      primary_role_id: 'oil_control_treatment',
      framework_roles: [
        {
          role_id: 'oil_control_treatment',
          rank: 1,
          preferred_step: 'treatment',
          label: 'Oil-control treatment',
        },
      ],
      semantic_plan: {
        selection_owner_source: 'generic_concern_framework_resolver',
        selection_owner_state: 'trusted',
      },
    }),
    summarizeProfileForContext: (profile) => profile,
    mergeIngredientRecoContextValue: (left, right) => ({ ...(left || {}), ...(right || {}) }),
    appendLatestRecoContextToSessionPatch: (sessionPatch, recoContext) => {
      sessionPatch.latest_reco_context = recoContext;
    },
    extractRecoFinalSelectionContract: () => ({
      selection_owner: 'shopping_agent_beauty_mainline',
    }),
    buildRouteAwareAssistantText: () => 'deterministic fallback handoff response',
    makeAssistantMessage: (content) => ({ role: 'assistant', format: 'text', content }),
    buildEnvelope: (_ctx, envelope) => envelope,
    makeEvent: (_ctx, kind, data) => ({ kind, data }),
    applyRecoContractToRecoRequestedEvents: (events) => ({ events }),
    buildRecoRequestedEventData: ({ payload, source }) => ({ payload, source }),
    normalizeRecoSourceDetail: (value) => value,
    stateChangeAllowed: () => false,
    runConcernSemanticPlanner: async () => ({
      semanticPlan: {
        selection_owner_source: 'rule_concern_planner_fallback',
        selection_owner_state: 'fallback',
      },
      trace: {
        planner_used: true,
        planner_failure_class: 'planner_untrusted',
      },
    }),
    buildConcernTargetContextFromSemanticPlan: () => ({
      intent_mode: 'generic_concern',
      framework_roles: [],
    }),
    handoffRecoToBeautyMainlineSearch: async (args) => {
      observed.handoffTargetContext = args.targetContext;
      return {
        targetContext: args.targetContext,
        recommendations: [
          {
            product_id: 'fallback_oily_1',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            matched_role_id: 'oil_control_treatment',
          },
        ],
        searchResult: {
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
          metadata: {
            contract_bridge: {
              resolved_contract: 'agent_v1_search_beauty_mainline',
            },
            source_breakdown: {
              source_tier_counts: { fresh_internal: 1 },
            },
            search_stage_ledger: {
              final_selection: {
                selection_owner: 'shopping_agent_beauty_mainline',
                selected_product_ids: ['fallback_oily_1'],
                selected_titles: ['The Ordinary Niacinamide 10% + Zinc 1%'],
                selection_signature: 'search_sel_fallback_oily',
                mainline_status: 'grounded_success',
                source_tier_counts: { fresh_internal: 1 },
              },
            },
          },
        },
      };
    },
    buildRecoPayloadFromBeautyMainlineHandoff: ({ targetContext, basePayload }) => {
      observed.plannerMeta = basePayload?.recommendation_meta || null;
      return {
        payload: {
          source: 'catalog_grounded_v1',
          mainline_status: 'grounded_success',
          recommendation_meta: {
            ...(basePayload?.recommendation_meta || {}),
            source_mode: 'framework_mainline',
          },
          target_context: targetContext,
        },
        contract: {
          version: 'test_contract',
        },
      };
    },
    classifyBeautyMainlineHandoffFallback: () => ({
      reason: 'unreachable',
    }),
    buildBeautyMainlineHandoffFallbackEnvelope: ({ fallback }) => ({
      cards: [
        {
          type: 'confidence_notice',
          payload: {
            mainline_status: 'needs_more_context',
            recommendation_meta: fallback,
          },
        },
      ],
    }),
    looksLikeRecommendationRequest: () => true,
    sendChatEnvelope: async () => null,
  });

  const result = await runtime.maybeHandleBeautyOwnedChatReco({
    ctx: {
      request_id: 'req_det_fallback_oily',
      trace_id: 'trace_det_fallback_oily',
      lang: 'EN',
      trigger_source: 'chat',
    },
    logger: null,
    message: 'im oily skin, what products should i use?',
    recoEntrySourceDetail: 'typed_reco',
    profile: {
      skinType: 'oily',
      goals: ['oil control'],
    },
  });

  assert.equal(result?.handled, true);
  assert.equal(observed.handoffTargetContext, null);
  assert.equal(observed.plannerMeta, null);
  assert.equal(result?.envelope?.cards?.[0]?.type, 'confidence_notice');
  assert.equal(result?.envelope?.cards?.[0]?.payload?.mainline_status, 'needs_more_context');
  assert.equal(result?.envelope?.cards?.[0]?.payload?.recommendation_meta?.products_empty_reason, 'planner_untrusted');
  assert.equal(result?.envelope?.cards?.[0]?.payload?.recommendation_meta?.fallback_or_gate_blocked, true);
});

test('beauty chat mainline entry lets llm selector rerank only grounded primary-role candidates', async () => {
  const observed = {
    selectorCalls: 0,
    handoffSelectedIds: null,
  };
  const semanticPlan = {
    selection_owner_state: 'trusted',
    core_roles: [
      {
        role_id: 'oil_control_treatment',
        rank: 1,
        preferred_step: 'treatment',
        label: 'Oil-control treatment',
      },
    ],
  };
  const runtime = createBeautyChatMainlineEntryRuntime({
    RECO_CATALOG_GROUNDED_ENABLED: true,
    RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS: 1000,
    resolveRecommendationTargetContext: () => ({
      entry_type: 'chat',
      intent_mode: 'generic_concern',
      step_aware_intent: false,
      resolved_target_step: null,
      primary_role_id: 'oil_control_treatment',
      framework_roles: [
        {
          role_id: 'oil_control_treatment',
          rank: 1,
          preferred_step: 'treatment',
          label: 'Oil-control treatment',
        },
      ],
      semantic_plan: semanticPlan,
    }),
    summarizeProfileForContext: (profile) => profile,
    mergeIngredientRecoContextValue: (left, right) => ({ ...(left || {}), ...(right || {}) }),
    appendLatestRecoContextToSessionPatch: (sessionPatch, recoContext) => {
      sessionPatch.latest_reco_context = recoContext;
    },
    extractRecoFinalSelectionContract: (value) =>
      value?.metadata?.final_selection ||
      value?.metadata?.search_stage_ledger?.final_selection ||
      value?.final_selection ||
      null,
    buildRouteAwareAssistantText: () => 'selector framework response',
    makeAssistantMessage: (content) => ({ role: 'assistant', format: 'text', content }),
    buildEnvelope: (_ctx, envelope) => envelope,
    makeEvent: (_ctx, kind, data) => ({ kind, data }),
    applyRecoContractToRecoRequestedEvents: (events) => ({ events }),
    buildRecoRequestedEventData: ({ payload, source }) => ({ payload, source }),
    normalizeRecoSourceDetail: (value) => value,
    stateChangeAllowed: () => false,
    handoffRecoToBeautyMainlineSearch: async (args) => ({
      targetContext: args.targetContext,
      recommendations: [
        {
          product_id: 'primary_1',
          display_name: 'Oil Control Serum A',
          matched_role_id: 'oil_control_treatment',
        },
        {
          product_id: 'primary_2',
          display_name: 'Oil Control Serum B',
          matched_role_id: 'oil_control_treatment',
        },
      ],
      searchResult: {
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner: 'shopping_agent_beauty_mainline',
        metadata: {
          contract_bridge: {
            resolved_contract: 'agent_v1_search_beauty_mainline',
          },
          source_breakdown: {
            source_tier_counts: { fresh_external: 2 },
          },
          search_stage_ledger: {
            final_selection: {
              selection_owner: 'shopping_agent_beauty_mainline',
              selected_product_ids: ['primary_1', 'primary_2'],
              selected_titles: ['Oil Control Serum A', 'Oil Control Serum B'],
              selection_signature: 'search_sel_original_order',
              mainline_status: 'grounded_success',
              source_tier_counts: { fresh_external: 2 },
            },
          },
        },
      },
    }),
    runConcernSelectorRace: async () => {
      observed.selectorCalls += 1;
      return {
        result: {
          top_pick_product_id: 'primary_2',
          ordered_product_ids: ['primary_2', 'primary_1'],
          selection_notes: ['stronger role fit'],
        },
        trace: {
          llm_selector_used: true,
          winner_source: 'llm_selector',
        },
      };
    },
    applyConcernSelectorRaceOrdering: (recommendations, selectorRace) => {
      const byId = new Map(recommendations.map((item) => [item.product_id, item]));
      return {
        recommendations: selectorRace.ordered_product_ids.map((id) => byId.get(id)).filter(Boolean),
        primary_recommendation_id: selectorRace.top_pick_product_id,
        support_roles_surfaced: [],
        winner_source: 'llm_selector',
        selection_notes_by_product_id: {
          primary_2: selectorRace.selection_notes,
        },
      };
    },
    buildRecoPayloadFromBeautyMainlineHandoff: ({ handoff }) => {
      observed.handoffSelectedIds =
        handoff?.searchResult?.metadata?.final_selection?.selected_product_ids || null;
      return {
        payload: {
          source: 'catalog_grounded_v1',
          mainline_status: 'grounded_success',
          recommendations: handoff.recommendations,
          recommendation_meta: {},
          metadata: {},
        },
        contract: {
          version: 'test_contract',
        },
      };
    },
    classifyBeautyMainlineHandoffFallback: () => ({
      reason: 'unreachable',
    }),
    buildBeautyMainlineHandoffFallbackEnvelope: () => ({
      cards: [],
    }),
    looksLikeRecommendationRequest: () => true,
    sendChatEnvelope: async () => null,
  });

  const result = await runtime.maybeHandleBeautyOwnedChatReco({
    ctx: {
      request_id: 'req_llm_selector_oily',
      trace_id: 'trace_llm_selector_oily',
      lang: 'EN',
      trigger_source: 'chat',
    },
    logger: null,
    message: 'im oily skin, what products should i use?',
    recoEntrySourceDetail: 'typed_reco',
    profile: {
      skinType: 'oily',
      sensitivity: 'low',
      barrierStatus: 'stable',
      goals: ['oil control'],
    },
  });

  const payload = result?.envelope?.cards?.[0]?.payload;
  assert.equal(result?.handled, true);
  assert.equal(observed.selectorCalls, 1);
  assert.deepEqual(observed.handoffSelectedIds, ['primary_2', 'primary_1']);
  assert.deepEqual(
    payload?.recommendations?.map((item) => item.product_id),
    ['primary_2', 'primary_1'],
  );
  assert.equal(payload?.recommendation_meta?.llm_selector_used, true);
  assert.equal(payload?.recommendation_meta?.selector_winner_source, 'llm_selector');
  assert.equal(payload?.metadata?.search_stage_ledger?.chat_mainline_timing?.selector_attempted, true);
  assert.equal(payload?.metadata?.search_stage_ledger?.chat_mainline_timing?.selector_applied, true);
  assert.equal(Number.isFinite(payload?.metadata?.search_stage_ledger?.chat_mainline_timing?.selector_ms), true);
});

test('beauty chat mainline entry still runs selector when post-handoff budget only satisfies the bounded rewrite reserve', async () => {
  const observed = {
    selectorCalls: 0,
    selectorDeadlineDeltaMs: null,
  };
  const semanticPlan = {
    comparison_mode: 'same_role_comparison',
    selection_owner_state: 'trusted',
    core_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 1,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen with finish fit',
      },
    ],
  };
  const runtime = createBeautyChatMainlineEntryRuntime({
    RECO_CATALOG_GROUNDED_ENABLED: true,
    AURORA_BFF_CHAT_RECO_BUDGET_MS: 6000,
    AURORA_RECO_ASSISTANT_REWRITE_TIMEOUT_MS: 4500,
    RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS: 1000,
    resolveRecommendationTargetContext: () => ({
      entry_type: 'chat',
      intent_mode: 'generic_concern',
      step_aware_intent: false,
      resolved_target_step: 'sunscreen',
      primary_role_id: 'daily_sunscreen_finish_fit',
      framework_roles: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          rank: 1,
          preferred_step: 'sunscreen',
          label: 'Daily sunscreen with finish fit',
        },
      ],
      semantic_plan: semanticPlan,
    }),
    summarizeProfileForContext: (profile) => profile,
    mergeIngredientRecoContextValue: (left, right) => ({ ...(left || {}), ...(right || {}) }),
    appendLatestRecoContextToSessionPatch: () => {},
    extractRecoFinalSelectionContract: (value) =>
      value?.metadata?.final_selection ||
      value?.metadata?.search_stage_ledger?.final_selection ||
      value?.final_selection ||
      null,
    maybeRewriteRecoAssistantTextWithLlm: async () => ({
      llm_used: true,
      text: 'selector budget check',
    }),
    makeAssistantMessage: (content) => ({ role: 'assistant', format: 'text', content }),
    buildEnvelope: (_ctx, envelope) => envelope,
    makeEvent: (_ctx, kind, data) => ({ kind, data }),
    applyRecoContractToRecoRequestedEvents: (events) => ({ events }),
    buildRecoRequestedEventData: ({ payload, source }) => ({ payload, source }),
    normalizeRecoSourceDetail: (value) => value,
    stateChangeAllowed: () => false,
    handoffRecoToBeautyMainlineSearch: async (args) => {
      await new Promise((resolve) => setTimeout(resolve, 2600));
      return {
        targetContext: args.targetContext,
        recommendations: [
          {
            product_id: 'spf_lead',
            display_name: 'Lead SPF',
            matched_role_id: 'daily_sunscreen_finish_fit',
          },
          {
            product_id: 'spf_alt',
            display_name: 'Alt SPF',
            matched_role_id: 'daily_sunscreen_finish_fit',
          },
        ],
        searchResult: {
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
          metadata: {
            final_selection: {
              selection_owner: 'shopping_agent_beauty_mainline',
              selected_product_ids: ['spf_lead', 'spf_alt'],
              selected_titles: ['Lead SPF', 'Alt SPF'],
              selection_signature: 'search_sel_original_order',
              mainline_status: 'grounded_success',
              source_tier_counts: { fresh_external: 2 },
            },
            search_stage_ledger: {
              final_selection: {
                selection_owner: 'shopping_agent_beauty_mainline',
                selected_product_ids: ['spf_lead', 'spf_alt'],
                selected_titles: ['Lead SPF', 'Alt SPF'],
                selection_signature: 'search_sel_original_order',
                mainline_status: 'grounded_success',
                source_tier_counts: { fresh_external: 2 },
              },
            },
          },
        },
      };
    },
    runConcernSelectorRace: async ({ deadlineAtMs }) => {
      observed.selectorCalls += 1;
      observed.selectorDeadlineDeltaMs = Number(deadlineAtMs || 0) - Date.now();
      return {
        result: {
          top_pick_product_id: 'spf_alt',
          ordered_product_ids: ['spf_alt', 'spf_lead'],
          selection_notes: ['better tradeoff spread'],
        },
        trace: {
          llm_selector_used: true,
          winner_source: 'llm_selector',
        },
      };
    },
    applyConcernSelectorRaceOrdering: (recommendations, selectorRace) => {
      const byId = new Map(recommendations.map((item) => [item.product_id, item]));
      return {
        recommendations: selectorRace.ordered_product_ids.map((id) => byId.get(id)).filter(Boolean),
        primary_recommendation_id: selectorRace.top_pick_product_id,
        support_roles_surfaced: [],
        winner_source: 'llm_selector',
        selection_notes_by_product_id: {
          spf_alt: selectorRace.selection_notes,
        },
      };
    },
    buildRecoPayloadFromBeautyMainlineHandoff: ({ handoff }) => ({
      payload: {
        source: 'catalog_grounded_v1',
        mainline_status: 'grounded_success',
        recommendations: handoff.recommendations,
        recommendation_meta: {},
        metadata: {},
      },
      contract: {
        version: 'test_contract',
      },
    }),
    classifyBeautyMainlineHandoffFallback: () => ({
      reason: 'unreachable',
    }),
    buildBeautyMainlineHandoffFallbackEnvelope: () => ({
      cards: [],
    }),
    looksLikeRecommendationRequest: () => true,
    runConcernSemanticPlanner: async () => ({
      semanticPlan,
      trace: { planner_used: true, planner_fallback_used: false },
    }),
    buildConcernTargetContextFromSemanticPlan: () => ({
      entry_type: 'chat',
      intent_mode: 'generic_concern',
      resolved_target_step: 'sunscreen',
      primary_role_id: 'daily_sunscreen_finish_fit',
      framework_roles: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          rank: 1,
          preferred_step: 'sunscreen',
          label: 'Daily sunscreen with finish fit',
        },
      ],
      semantic_plan: semanticPlan,
      mainline_fallback_policy: 'strict_no_runtime_fallback',
      semantic_planner_required: true,
    }),
    sendChatEnvelope: async () => null,
  });

  const result = await runtime.maybeHandleBeautyOwnedChatReco({
    ctx: {
      request_id: 'req_selector_budget_guard',
      trace_id: 'trace_selector_budget_guard',
      lang: 'EN',
      trigger_source: 'chat',
    },
    logger: null,
    message: 'my sunscreen pills under makeup. what should i buy?',
    recoEntrySourceDetail: 'typed_reco',
    profile: {
      skinType: 'combination',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['smooth layering'],
    },
  });

  const payload = result?.envelope?.cards?.[0]?.payload;
  assert.equal(result?.handled, true);
  assert.equal(observed.selectorCalls, 1);
  assert.equal(Number.isFinite(observed.selectorDeadlineDeltaMs), true);
  assert.match(String(observed.selectorDeadlineDeltaMs), /^[0-9-]+$/);
  assert.ok(observed.selectorDeadlineDeltaMs > 0);
  assert.equal(payload?.metadata?.search_stage_ledger?.chat_mainline_timing?.selector_attempted, true);
  assert.equal(payload?.metadata?.search_stage_ledger?.chat_mainline_timing?.selector_applied, true);
  assert.deepEqual(
    payload?.recommendations?.map((item) => item.product_id),
    ['spf_alt', 'spf_lead'],
  );
});

test('beauty chat mainline entry still runs selector when handoff targetContext only preserves semantic plan contract', async () => {
  const observed = {
    selectorCalls: 0,
  };
  const semanticPlan = {
    intent_mode: 'generic_concern',
    comparison_mode: 'same_role_comparison',
    selection_owner_state: 'trusted',
    primary_role_id: 'daily_sunscreen_finish_fit',
    core_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 1,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen with finish fit',
      },
    ],
  };
  const runtime = createBeautyChatMainlineEntryRuntime({
    RECO_CATALOG_GROUNDED_ENABLED: true,
    AURORA_BFF_CHAT_RECO_BUDGET_MS: 18000,
    AURORA_RECO_ASSISTANT_REWRITE_TIMEOUT_MS: 4500,
    RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS: 1000,
    resolveRecommendationTargetContext: () => ({
      entry_type: 'chat',
      intent_mode: 'generic_concern',
      primary_role_id: 'daily_sunscreen_finish_fit',
      framework_roles: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          rank: 1,
          preferred_step: 'sunscreen',
          label: 'Daily sunscreen with finish fit',
        },
      ],
      semantic_plan: semanticPlan,
    }),
    summarizeProfileForContext: (profile) => profile,
    mergeIngredientRecoContextValue: (left, right) => ({ ...(left || {}), ...(right || {}) }),
    appendLatestRecoContextToSessionPatch: () => {},
    extractRecoFinalSelectionContract: (value) =>
      value?.metadata?.final_selection ||
      value?.metadata?.search_stage_ledger?.final_selection ||
      value?.final_selection ||
      null,
    maybeRewriteRecoAssistantTextWithLlm: async () => ({
      llm_used: true,
      text: 'selector semantic contract check',
    }),
    makeAssistantMessage: (content) => ({ role: 'assistant', format: 'text', content }),
    buildEnvelope: (_ctx, envelope) => envelope,
    makeEvent: (_ctx, kind, data) => ({ kind, data }),
    applyRecoContractToRecoRequestedEvents: (events) => ({ events }),
    buildRecoRequestedEventData: ({ payload, source }) => ({ payload, source }),
    normalizeRecoSourceDetail: (value) => value,
    stateChangeAllowed: () => false,
    handoffRecoToBeautyMainlineSearch: async () => ({
      targetContext: {
        comparison_mode: 'same_role_comparison',
        primary_role_id: 'daily_sunscreen_finish_fit',
        semantic_plan: semanticPlan,
      },
      recommendations: [
        {
          product_id: 'spf_lead',
          display_name: 'Lead SPF',
          matched_role_id: 'daily_sunscreen_finish_fit',
        },
        {
          product_id: 'spf_alt',
          display_name: 'Alt SPF',
          matched_role_id: 'daily_sunscreen_finish_fit',
        },
      ],
      searchResult: {
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner: 'shopping_agent_beauty_mainline',
        metadata: {
          final_selection: {
            selection_owner: 'shopping_agent_beauty_mainline',
            selected_product_ids: ['spf_lead', 'spf_alt'],
            selected_titles: ['Lead SPF', 'Alt SPF'],
            selection_signature: 'search_sel_original_order',
            mainline_status: 'grounded_success',
            source_tier_counts: { fresh_external: 2 },
          },
          search_stage_ledger: {
            final_selection: {
              selection_owner: 'shopping_agent_beauty_mainline',
              selected_product_ids: ['spf_lead', 'spf_alt'],
              selected_titles: ['Lead SPF', 'Alt SPF'],
              selection_signature: 'search_sel_original_order',
              mainline_status: 'grounded_success',
              source_tier_counts: { fresh_external: 2 },
            },
          },
        },
      },
    }),
    runConcernSelectorRace: async () => {
      observed.selectorCalls += 1;
      return {
        result: {
          top_pick_product_id: 'spf_alt',
          ordered_product_ids: ['spf_alt', 'spf_lead'],
          selection_notes: ['semantic contract preserved'],
        },
        trace: {
          llm_selector_used: true,
          winner_source: 'llm_selector',
        },
      };
    },
    applyConcernSelectorRaceOrdering: (recommendations, selectorRace) => {
      const byId = new Map(recommendations.map((item) => [item.product_id, item]));
      return {
        recommendations: selectorRace.ordered_product_ids.map((id) => byId.get(id)).filter(Boolean),
        primary_recommendation_id: selectorRace.top_pick_product_id,
        support_roles_surfaced: [],
        winner_source: 'llm_selector',
      };
    },
    buildRecoPayloadFromBeautyMainlineHandoff: ({ handoff }) => ({
      payload: {
        source: 'catalog_grounded_v1',
        mainline_status: 'grounded_success',
        recommendations: handoff.recommendations,
        recommendation_meta: {},
        metadata: {},
      },
      contract: {
        version: 'test_contract',
      },
    }),
    classifyBeautyMainlineHandoffFallback: () => ({
      reason: 'unreachable',
    }),
    buildBeautyMainlineHandoffFallbackEnvelope: () => ({
      cards: [],
    }),
    looksLikeRecommendationRequest: () => true,
    runConcernSemanticPlanner: async () => ({
      semanticPlan,
      trace: { planner_used: true, planner_fallback_used: false },
    }),
    buildConcernTargetContextFromSemanticPlan: () => ({
      entry_type: 'chat',
      intent_mode: 'generic_concern',
      primary_role_id: 'daily_sunscreen_finish_fit',
      framework_roles: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          rank: 1,
          preferred_step: 'sunscreen',
          label: 'Daily sunscreen with finish fit',
        },
      ],
      semantic_plan: semanticPlan,
      mainline_fallback_policy: 'strict_no_runtime_fallback',
      semantic_planner_required: true,
    }),
    sendChatEnvelope: async () => null,
  });

  const result = await runtime.maybeHandleBeautyOwnedChatReco({
    ctx: {
      request_id: 'req_selector_semantic_contract',
      trace_id: 'trace_selector_semantic_contract',
      lang: 'EN',
      trigger_source: 'chat',
    },
    logger: null,
    message: 'my sunscreen pills under makeup. what should i buy?',
    recoEntrySourceDetail: 'typed_reco',
    profile: {
      skinType: 'combination',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['smooth layering'],
    },
  });

  const payload = result?.envelope?.cards?.[0]?.payload;
  const timingLedger = payload?.metadata?.search_stage_ledger?.chat_mainline_timing;
  assert.equal(result?.handled, true);
  assert.equal(observed.selectorCalls, 1);
  assert.equal(timingLedger?.selector_attempted, true);
  assert.equal(timingLedger?.selector_applied, true);
  assert.equal(timingLedger?.selector_skip_reason, undefined);
  assert.deepEqual(
    payload?.recommendations?.map((item) => item.product_id),
    ['spf_alt', 'spf_lead'],
  );
});
