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
        if (normalizedQuery === 'oil control serum') {
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

test('handoffRecoToBeautyMainlineSearch executes primary external supplement and planned routine support with runtime contract ledger', async () => {
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
        'shine control serum',
        'lightweight moisturizer oily skin',
        'barrier lotion oily skin',
        'oil control sunscreen',
        'lightweight sunscreen oily skin',
        'lightweight sunscreen',
      ],
    );
    assert.deepEqual(
      externalCaptured.map((row) => row.query),
      [
        'oil control treatment',
        'niacinamide serum oily skin',
        'salicylic acid serum oily skin',
        'oil control serum',
        'lightweight moisturizer oily skin',
        'oil control sunscreen',
        'barrier lotion oily skin',
        'lightweight sunscreen oily skin',
      ],
    );
    assert.equal(captured.every((row) => row.callerLane === 'beauty_chat_handoff'), true);
    assert.equal(captured.every((row) => row.timeoutMs === 10500), true);
    assert.equal(captured.every((row) => row.allowExternalSeed === false), true);
    assert.equal(
      captured.slice(0, 3).every((row) =>
        row.targetStepFamily === 'serum'
        && row.semanticFamily === 'oil_control_treatment'
        && row.queryStepStrength === 'strong_goal_family'
        && row.productOnly === true),
      true,
    );
    assert.equal(
      externalCaptured.slice(0, 4).every((row) =>
        row.roleId === 'oil_control_treatment'
        && row.preferredStep === 'treatment'
        && row.transportPolicyMode === 'framework_first_turn'),
      true,
    );
    assert.equal(
      externalCaptured.slice(4).map((row) => row.roleId).join(','),
      'lightweight_moisturizer,daily_sunscreen,lightweight_moisturizer,daily_sunscreen',
    );
    assert.equal(
      externalCaptured.slice(4).every((row) =>
        (
          (row.roleId === 'lightweight_moisturizer' && row.preferredStep === 'moisturizer')
          || (row.roleId === 'daily_sunscreen' && row.preferredStep === 'sunscreen')
        )
        && row.transportPolicyMode === 'framework_first_turn'),
      true,
    );
    assert.equal(out.searchResult?.query_source, 'beauty_mainline_local_handoff');
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.planned_level_count, 6);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_level_count, 6);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_query_count, 16);
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.primary_search?.execution_lane,
      'beauty_mainline_local_handoff',
    );
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.skipped_external_seed_level_count, 0);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_support_internal_level_count, 2);
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
      'primary_plus_internal_then_external_support',
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
      ['internal', 'internal', 'internal', 'external_seed', 'external_seed', 'external_seed', 'external_seed', 'internal', 'internal', 'internal', 'internal', 'internal', 'external_seed', 'external_seed', 'external_seed', 'external_seed'],
    );
    assert.deepEqual(
      out.searchResult?.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts?.map((row) => row?.source_scope),
      ['internal', 'internal', 'internal', 'external_seed', 'external_seed', 'external_seed', 'external_seed', 'internal', 'internal', 'internal', 'internal', 'internal', 'external_seed', 'external_seed', 'external_seed', 'external_seed'],
    );
    const firstSupportExternalAttempt =
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts
        ?.find((row) =>
          row?.ladder_level === 'framework_stage_c_support_lightweight_moisturizer_external_seed'
          && row?.local_external_seed_search_mode)
      || out.searchResult?.metadata?.search_stage_ledger?.primary_search?.query_pack_attempts
        ?.find((row) =>
          row?.ladder_level === 'framework_stage_c_support_lightweight_moisturizer_external_seed'
          && row?.local_external_seed_search_mode);
    assert.equal(firstSupportExternalAttempt?.local_external_seed_search_mode, 'staged_support_fastpath');
    assert.deepEqual(firstSupportExternalAttempt?.local_external_seed_category_terms, ['moisturizer', 'sunscreen']);
    assert.equal(firstSupportExternalAttempt?.local_external_seed_stage_debug?.[0]?.stage, 'support_category_exact');
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.skipped_external_seed_levels, undefined);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.skipped_support_levels, undefined);
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
        if (query === 'oil control treatment') {
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
        'oil control serum',
        'shine control serum',
        'lightweight moisturizer oily skin',
        'barrier lotion oily skin',
        'oil control sunscreen',
        'lightweight sunscreen oily skin',
        'lightweight sunscreen',
      ],
    );
    assert.deepEqual(
      externalCaptured,
      [
        'lightweight moisturizer oily skin',
        'oil control sunscreen',
        'barrier lotion oily skin',
        'lightweight sunscreen oily skin',
      ],
    );
    const primaryExternalRows = out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts
      ?.filter((row) => row?.ladder_level === 'framework_stage_b_primary_external_seed') || [];
    assert.equal(primaryExternalRows.length, 4);
    assert.equal(
      primaryExternalRows.every((row) => row?.reason === 'skipped_primary_already_satisfied'),
      true,
    );
    assert.deepEqual(
      out.recommendations.map((item) => item?.product_id).sort(),
      ['primary_compare_1', 'primary_compare_2'],
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
        if (query === 'oil control serum') {
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
        'lightweight moisturizer oily skin',
        'oil control sunscreen',
        'barrier lotion oily skin',
        'lightweight sunscreen oily skin',
      ],
    );
    const primaryExternalRows = out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts
      ?.filter((row) => row?.ladder_level === 'framework_stage_b_primary_external_seed') || [];
    assert.equal(primaryExternalRows.length, 4);
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

    assert.equal(externalCaptured.includes('hyaluronic acid serum'), false);
    assert.equal(externalCaptured.includes('hydrating serum dehydrated skin'), false);
    assert.deepEqual(
      externalCaptured,
      ['lightweight sunscreen', 'daily sunscreen'],
    );
    const hydratingExternalRows = out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.query_pack_attempts
      ?.filter((row) => row?.ladder_level === 'framework_stage_c_support_hydrating_serum_or_essence_external_seed') || [];
    assert.equal(hydratingExternalRows.length, 2);
    assert.equal(
      hydratingExternalRows.every((row) => row?.reason === 'skipped_support_role_already_satisfied'),
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
        if (query === 'lightweight moisturizer oily skin') {
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
        if (query === 'oil control sunscreen') {
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
        'lightweight moisturizer oily skin',
        'oil control sunscreen',
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

test('runConcernSemanticPlanner uses structured Gemini JSON with minimal thinking', async () => {
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
    assert.deepEqual(
      out.semanticPlan?.core_roles?.map((role) => role?.role_id).slice(0, 3),
      ['hydrating_barrier_moisturizer', 'hydrating_serum_or_essence', 'daily_sunscreen'],
    );
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
        if (query === 'oil control treatment') {
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

test('handoffRecoToBeautyMainlineSearch keeps authoritative support roles when primary recall is missing', async () => {
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
      ['support_moist_1', 'support_spf_1'],
    );
    assert.equal(
      out.searchResult?.metadata?.candidate_pool_summary?.weak_viable_pool,
      false,
    );
    assert.equal(
      out.searchResult?.metadata?.candidate_pool_summary?.viable_pool_strength,
      'strong',
    );
    assert.equal(
      out.searchResult?.metadata?.candidate_pool_summary?.primary_missing_authoritative_support_selected,
      true,
    );
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.candidate_drop_stage,
      'none',
    );
    assert.equal(
      out.searchResult?.metadata?.search_stage_ledger?.primary_failure_stage ?? null,
      null,
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
  assert.equal(timingLedger?.budget_ms, 9000);
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
