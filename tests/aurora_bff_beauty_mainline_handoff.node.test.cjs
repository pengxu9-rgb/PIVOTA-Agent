const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

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
    assert.equal(captured?.timeoutMs, 10000);
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
    await __internal.handoffRecoToBeautyMainlineSearch({
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
