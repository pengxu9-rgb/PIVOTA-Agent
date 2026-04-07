const test = require('node:test');
const assert = require('node:assert/strict');

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
    assert.equal(captured?.transportPolicy?.max_base_urls, 1);
    assert.equal(captured?.transportPolicy?.max_paths, 1);
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
    assert.equal(captured?.transportPolicy?.max_base_urls, 1);
    assert.equal(captured?.transportPolicy?.max_paths, 1);
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
    runConcernSemanticPlanner: async () => {
      observed.plannerCalls += 1;
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
});
