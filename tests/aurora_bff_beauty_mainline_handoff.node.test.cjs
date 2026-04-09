const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

const { createBeautyChatMainlineEntryRuntime } = require('../src/auroraBff/beautyChatMainlineEntry');
const { resolveRecommendationTargetContext } = require('../src/auroraBff/recommendationSharedStack');

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
    assert.equal(out.targetContext?.primary_role_id, 'daily_sunscreen');
    assert.equal(out.semanticContract?.planner_mode, 'step_aware');
    assert.equal(out.semanticContract?.target_step_family, 'sunscreen');
    assert.equal(out.semanticContract?.primary_role_id, 'daily_sunscreen');
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
    assert.deepEqual(out.semanticContract?.ingredient_hypotheses, ['Niacinamide', 'Zinc PCA']);
  } finally {
    delete require.cache[moduleId];
  }
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
    assert.equal(captured?.transportPolicy?.prefer_self_proxy_first, true);
    assert.equal(captured?.transportPolicy?.max_base_urls, 2);
    assert.equal(captured?.transportPolicy?.max_paths, 1);
    assert.equal(captured?.transportPolicy?.allow_secondary_base_failover, true);
    assert.equal(captured?.transportPolicy?.allow_secondary_path_failover, false);
    assert.equal(captured?.timeoutMs, 65000);
    assert.equal(captured?.semanticContract?.planner_mode, 'step_aware');
    assert.equal(captured?.semanticContract?.primary_role_id, 'daily_sunscreen');
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
    assert.equal(captured?.transportPolicy?.prefer_self_proxy_first, true);
    assert.equal(captured?.transportPolicy?.max_base_urls, 2);
    assert.equal(captured?.transportPolicy?.max_paths, 1);
    assert.equal(captured?.transportPolicy?.allow_secondary_base_failover, true);
    assert.equal(captured?.transportPolicy?.allow_secondary_path_failover, false);
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

test('handoffRecoToBeautyMainlineSearch trims framework local handoff to primary internal preflight and records skipped levels', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const captured = [];
    __internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args) => {
        captured.push({
          query: String(args?.query || ''),
          callerLane: String(args?.callerLane || ''),
          allowExternalSeed: args?.allowExternalSeed === true,
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
        'oil control serum',
        'shine control serum',
        'mattifying serum',
      ],
    );
    assert.equal(captured.every((row) => row.callerLane === 'beauty_chat_handoff'), true);
    assert.equal(captured.every((row) => row.allowExternalSeed !== true), true);
    assert.equal(out.searchResult?.query_source, 'beauty_mainline_local_handoff');
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.planned_level_count, 6);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.executed_level_count, 1);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.skipped_external_seed_level_count, 3);
    assert.equal(out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.skipped_support_level_count, 2);
    assert.deepEqual(
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.skipped_external_seed_levels,
      [
        'framework_stage_b_primary_external_seed',
        'framework_stage_c_support_lightweight_moisturizer_external_seed',
        'framework_stage_c_support_daily_sunscreen_external_seed',
      ],
    );
    assert.deepEqual(
      out.searchResult?.metadata?.search_stage_ledger?.local_handoff?.skipped_support_levels,
      [
        'framework_stage_c_support_lightweight_moisturizer',
        'framework_stage_c_support_daily_sunscreen',
      ],
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch rescues local framework strict-empty via proxy search', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const localCalls = [];
    const proxyCalls = [];
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
      searchPivotaBackendProducts: async (args) => {
        proxyCalls.push({
          query: String(args?.query || ''),
          allowExternalSeed: args?.allowExternalSeed === true,
          externalSeedStrategy: String(args?.externalSeedStrategy || ''),
          deadlineMs: Number(args?.deadlineMs || 0),
        });
        return {
          ok: true,
          products: [
            {
              product_id: 'niacinamide_1',
              merchant_id: 'merchant_proxy',
              title: 'The Ordinary Niacinamide 10% + Zinc 1%',
              display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
              category: 'Serum',
              product_type: 'treatment',
              candidate_step: 'treatment',
              retrieval_source: 'external_seed',
              canonical_pdp_url: 'https://example.com/products/niacinamide-1',
            },
          ],
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
          query_source: 'agent_products_search',
          final_selection: {
            selection_owner: 'shopping_agent_beauty_mainline',
            selected_product_ids: ['niacinamide_1'],
            selected_titles: ['The Ordinary Niacinamide 10% + Zinc 1%'],
            selection_signature: 'sel_proxy_niacinamide_1',
            mainline_status: 'grounded_success',
          },
          search_stage_ledger: {
            final_selection: {
              selection_owner: 'shopping_agent_beauty_mainline',
              selected_product_ids: ['niacinamide_1'],
              selected_titles: ['The Ordinary Niacinamide 10% + Zinc 1%'],
              selection_signature: 'sel_proxy_niacinamide_1',
              mainline_status: 'grounded_success',
            },
          },
          source_breakdown: {
            source_tier_counts: { fresh_external: 1 },
            top_candidate_provenance: { source_owner: 'external_seed' },
          },
          metadata: {
            final_decision: 'products_returned',
            search_stage_ledger: {
              final_selection: {
                selection_owner: 'shopping_agent_beauty_mainline',
                selected_product_ids: ['niacinamide_1'],
                selected_titles: ['The Ordinary Niacinamide 10% + Zinc 1%'],
                selection_signature: 'sel_proxy_niacinamide_1',
                mainline_status: 'grounded_success',
              },
            },
          },
        };
      },
    });

    const handoffDeadlineAtMs = Date.now() + 15000;
    const proxyRescueDeadlineAtMs = handoffDeadlineAtMs + 3200;
    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_proxy_rescue_after_local_empty' },
      primaryQuery: 'what products should i use for oily skin?',
      fallbackMessage: 'what products should i use for oily skin?',
      targetContext: resolveRecommendationTargetContext({
        text: 'what products should i use for oily skin?',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
      deadlineAtMs: handoffDeadlineAtMs,
      proxyRescueDeadlineAtMs,
    });

    assert.equal(localCalls.length > 0, true);
    assert.equal(proxyCalls.length, 1);
    assert.equal(proxyCalls[0]?.query, 'oil control treatment');
    assert.equal(proxyCalls[0]?.allowExternalSeed, true);
    assert.equal(proxyCalls[0]?.externalSeedStrategy, 'unified_relevance');
    assert.equal(proxyCalls[0]?.deadlineMs, proxyRescueDeadlineAtMs);
    assert.deepEqual(
      out.recommendations.map((item) => item.display_name),
      ['The Ordinary Niacinamide 10% + Zinc 1%'],
    );
    assert.equal(out.searchResult?.query_source, 'agent_products_search');
    assert.equal(
      out.searchResult?.metadata?.local_handoff_preflight?.query_source,
      'beauty_mainline_local_handoff',
    );
    assert.equal(
      out.searchResult?.metadata?.local_handoff_preflight?.final_decision,
      'strict_empty',
    );
    assert.equal(
      out.searchResult?.metadata?.local_handoff_preflight?.reason,
      'empty',
    );
    assert.equal(
      out.searchResult?.metadata?.local_handoff_preflight?.search_stage_ledger?.local_handoff?.planned_level_count,
      6,
    );
    assert.equal(
      out.searchResult?.metadata?.local_handoff_preflight?.search_stage_ledger?.local_handoff?.executed_level_count,
      1,
    );
    assert.equal(
      out.searchResult?.metadata?.local_handoff_preflight?.search_stage_ledger?.local_handoff?.skipped_support_level_count,
      2,
    );
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch preserves local empty result when proxy rescue fails', async () => {
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
        throw new Error('proxy rescue failed');
      },
    });

    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN', request_id: 'req_proxy_rescue_fails_preserve_local' },
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
    assert.equal(proxyAttempts, 1);
    assert.deepEqual(out.recommendations, []);
    assert.equal(out.searchResult?.query_source, 'beauty_mainline_local_handoff');
    assert.equal(out.searchResult?.metadata?.final_decision, 'strict_empty');
    assert.equal(out.searchResult?.reason, 'empty');
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
    delete require.cache[moduleId];
  }
});

test('beauty mainline handoff search policy falls through from self proxy timeout to upstream base', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS: 'https://pivota-backend.test',
      AURORA_BFF_RECO_CATALOG_SEARCH_SOURCE: 'aurora-bff',
      AURORA_BFF_RECO_CATALOG_SEARCH_PREFER_CONFIGURED_BASE_URLS: 'true',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'true',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_BASE_URL: 'http://127.0.0.1:3000',
      AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED: 'false',
    },
    async () => {
      const originalGet = axios.get;
      const seen = [];
      axios.get = async (url, config = {}) => {
        const target = String(url || '');
        seen.push({
          url: target,
          timeout: Number(config?.timeout || 0) || null,
        });
        if (target === 'http://127.0.0.1:3000/agent/v1/products/search') {
          const err = new Error('timeout of 5000ms exceeded');
          err.code = 'ECONNABORTED';
          throw err;
        }
        if (target === 'https://pivota-backend.test/agent/v1/products/search') {
          return {
            status: 200,
            data: {
              products: [
                {
                  product_id: 'prod_oil_control_treatment',
                  merchant_id: 'mid_oil_control',
                  brand: 'Test Brand',
                  name: 'Oil Control Treatment',
                  display_name: 'Test Brand Oil Control Treatment',
                  category: 'Serum',
                  product_type: 'serum',
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected axios.get: ${target}`);
      };

      const { moduleId, __internal } = loadRouteInternals();
      try {
        const out = await __internal.handoffRecoToBeautyMainlineSearch({
          ctx: { lang: 'EN', trace_id: 'test_trace_handoff_fallback' },
          primaryQuery: 'oil control treatment',
          fallbackMessage: 'what product should i buy for oily skin?',
          targetContext: resolveRecommendationTargetContext({
            text: 'what product should i buy for oily skin?',
            focus: '',
            entryType: 'chat',
          }),
          timeoutMs: 9000,
          minTimeoutMs: 120,
          searchFn: null,
          deadlineAtMs: Date.now() + 15000,
          proxyRescueDeadlineAtMs: Date.now() + 15000,
        });

        assert.deepEqual(
          seen.map((item) => item.url),
          [
            'http://127.0.0.1:3000/agent/v1/products/search',
            'https://pivota-backend.test/agent/v1/products/search',
          ],
        );
        assert.equal(out?.searchResult?.source_base_url, 'https://pivota-backend.test');
        assert.equal(out?.recommendations?.[0]?.product_id, 'prod_oil_control_treatment');
      } finally {
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
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
    proxyRescueDeadlineAtMs: null,
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
      observed.proxyRescueDeadlineAtMs = args.proxyRescueDeadlineAtMs;
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
      observed.rewriteDeadlineAtMs = deadlineAtMs;
      observed.rewriteBaseText = baseText;
      observed.rewriteUserRequestText = userRequestText;
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
  assert.equal(Number.isFinite(timingLedger?.planner_ms), true);
  assert.equal(Number.isFinite(timingLedger?.handoff_ms), true);
  assert.equal(Number.isFinite(timingLedger?.selector_ms), true);
  assert.equal(Number.isFinite(timingLedger?.rewrite_ms), true);
  assert.equal(Number.isFinite(timingLedger?.total_elapsed_ms), true);
  assert.ok(timingLedger?.total_elapsed_ms >= timingLedger?.planner_ms);
  assert.ok(timingLedger?.total_elapsed_ms >= timingLedger?.handoff_ms);
  assert.equal(Number.isFinite(observed.plannerDeadlineAtMs), true);
  assert.equal(Number.isFinite(observed.handoffDeadlineAtMs), true);
  assert.equal(Number.isFinite(observed.proxyRescueDeadlineAtMs), true);
  assert.equal(Number.isFinite(observed.rewriteDeadlineAtMs), true);
  assert.ok(observed.handoffDeadlineAtMs >= observed.plannerDeadlineAtMs);
  assert.ok(observed.proxyRescueDeadlineAtMs > observed.handoffDeadlineAtMs);
  assert.ok(observed.rewriteDeadlineAtMs > observed.handoffDeadlineAtMs);
  assert.ok(observed.rewriteDeadlineAtMs > observed.proxyRescueDeadlineAtMs);
  assert.equal(observed.rewriteBaseText, undefined);
  assert.equal(observed.rewriteUserRequestText, 'im oily skin, what products should i use?');
  assert.equal(result?.envelope?.assistant_message, null);
  assert.equal(payload?.recommendation_meta?.assistant_rewrite_llm_used, false);
  assert.equal(payload?.recommendation_meta?.assistant_rewrite_reason, 'test_passthrough');
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

test('beauty chat mainline entry falls back to deterministic generic-concern target context when planner is untrusted', async () => {
  const observed = {
    handoffTargetContext: null,
    plannerMeta: null,
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
    buildBeautyMainlineHandoffFallbackEnvelope: () => ({
      cards: [],
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
  assert.equal(observed.handoffTargetContext?.framework_owner_source, 'generic_concern_framework_resolver');
  assert.equal(observed.handoffTargetContext?.primary_role_id, 'oil_control_treatment');
  assert.equal(observed.plannerMeta?.chat_planner_failure_class, 'planner_untrusted');
  assert.equal(observed.plannerMeta?.chat_planner_fallback_used, true);
  assert.equal(result?.envelope?.cards?.[0]?.payload?.mainline_status, 'grounded_success');
  assert.equal(
    result?.envelope?.cards?.[0]?.payload?.metadata?.search_stage_ledger?.chat_mainline_timing?.planner_fallback_used,
    true,
  );
  assert.equal(
    result?.envelope?.cards?.[0]?.payload?.metadata?.search_stage_ledger?.chat_mainline_timing?.rewrite_attempted,
    false,
  );
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
