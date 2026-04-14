describe('Celestial commerce core source contracts', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    prevEnv = {
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      API_MODE: process.env.API_MODE,
      DATABASE_URL: process.env.DATABASE_URL,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };
    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.resetModules();
    if (!prevEnv) return;
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('public search preserves external seed strategy overrides while shopping_agent keeps them', () => {
    const app = require('../src/server');
    const { applyFindProductsMultiSourceContract } = app._debug;

    const payload = {
      search: {
        query: 'serum',
        external_seed_strategy: 'unified_relevance',
      },
    };

    const publicOut = applyFindProductsMultiSourceContract(payload, { source: 'search' }, 'find_products_multi');
    expect(publicOut.search.query).toBe('serum');
    expect(publicOut.search.allow_external_seed).toBe(true);
    expect(publicOut.search.external_seed_strategy).toBe('unified_relevance');

    const shoppingOut = applyFindProductsMultiSourceContract(payload, { source: 'shopping_agent' }, 'find_products_multi');
    expect(shoppingOut.search.external_seed_strategy).toBe('unified_relevance');
  });

  test('public search defaults external seed contract when missing', () => {
    const app = require('../src/server');
    const { applyFindProductsMultiSourceContract } = app._debug;

    expect(
      applyFindProductsMultiSourceContract(
        {
          search: {
            query: 'lip balm',
          },
        },
        { source: 'search' },
        'find_products_multi',
      ),
    ).toEqual({
      search: {
        query: 'lip balm',
        allow_external_seed: true,
        catalog_surface: 'beauty',
        commerce_surface: 'beauty',
        external_seed_strategy: 'unified_relevance',
        catalog_surface: 'beauty',
        commerce_surface: 'beauty',
      },
    });
  });

  test('public search query guards leave incoming query params unchanged', () => {
    const app = require('../src/server');
    const { applyShoppingCatalogQueryGuards } = app._debug;

    const guarded = applyShoppingCatalogQueryGuards(
      {
        query: 'serum',
        external_seed_strategy: 'supplement_internal_first',
        page: '1',
      },
      'search',
    );

    expect(guarded.query).toBe('serum');
    expect(guarded.page).toBe('1');
    expect(guarded.external_seed_strategy).toBe('supplement_internal_first');
  });

  test('public explicit beauty category search bridges to discovery mainline unless strict', () => {
    const app = require('../src/server');
    const { shouldBridgePublicBeautySearchToDiscovery } = app._debug;

    const base = {
      operation: 'find_products_multi',
      metadata: {
        source: 'search',
        catalog_surface: 'beauty',
      },
      search: {
        query: 'hair oil',
        catalog_surface: 'beauty',
        allow_external_seed: true,
        external_seed_strategy: 'unified_relevance',
      },
      queryText: 'hair oil',
      queryClass: 'category',
      invokeSearchRail: 'public_observability',
    };

    expect(
      shouldBridgePublicBeautySearchToDiscovery({
        ...base,
        strictDecision: { enabled: false },
      }),
    ).toBe(true);

    expect(
      shouldBridgePublicBeautySearchToDiscovery({
        ...base,
        strictDecision: { enabled: true },
      }),
    ).toBe(false);

    expect(
      shouldBridgePublicBeautySearchToDiscovery({
        ...base,
        search: {
          ...base.search,
          query: 'vitamin c',
        },
        queryText: 'vitamin c',
        queryClass: 'exploratory',
        strictDecision: { enabled: false },
      }),
    ).toBe(true);

    expect(
      shouldBridgePublicBeautySearchToDiscovery({
        ...base,
        search: {
          ...base.search,
          query: 'vitamin c body wash',
        },
        queryText: 'vitamin c body wash',
        queryClass: 'attribute',
        strictDecision: { enabled: false },
      }),
    ).toBe(true);

    expect(
      shouldBridgePublicBeautySearchToDiscovery({
        ...base,
        search: {
          query: 'hair oil',
        },
        metadata: {
          source: 'search',
        },
        strictDecision: { enabled: false },
      }),
    ).toBe(false);
  });

  test('public beauty discovery bridge preserves partial exact-intent underfill', () => {
    const app = require('../src/server');
    const { buildFindProductsMultiDiscoveryBridgeResponse } = app._debug;

    const out = buildFindProductsMultiDiscoveryBridgeResponse({
      discoveryResponse: {
        products: [
          { merchant_id: 'external_seed', product_id: 'ext_hair_oil_1', title: 'Repair Hair Oil' },
          { merchant_id: 'external_seed', product_id: 'ext_hair_oil_2', title: 'Rosemary Hair Oil' },
        ],
        total: 2,
        metadata: {
          candidate_source: 'external_seed_compound_intent',
          compound_intent: 'hair_oil',
          underfilled_reason: 'public_search_underfilled_exact_intent',
          route_health: {
            primary_quality_gate_passed: false,
          },
          provider_breakdown: [
            { provider: 'external_seeds', returned: 2 },
          ],
        },
      },
      search: { query: 'hair oil' },
      metadata: {
        search_request_contract: { primary_lane: 'beauty_discovery_mainline' },
      },
      queryText: 'hair oil',
      page: 1,
      limit: 12,
      offset: 0,
    });

    expect(out.products).toHaveLength(2);
    expect(out.metadata).toEqual(
      expect.objectContaining({
        query_source: 'beauty_discovery_mainline',
        underfilled_reason: 'public_search_underfilled_exact_intent',
        public_search_discovery_bridge: true,
      }),
    );
    expect(out.metadata.strict_empty).toBeUndefined();
    expect(out.metadata.route_health).toEqual(
      expect.objectContaining({
        primary_quality_gate_passed: false,
        primary_exact_intent_underfilled_public_beauty: true,
        fallback_triggered: false,
      }),
    );
    expect(out.metadata.source_breakdown).toEqual(
      expect.objectContaining({
        external_seed_count: 2,
        strategy_applied: 'unified_relevance',
      }),
    );
  });

  test('shopping agent loop-break builds a scenario-aware retry query from short user selection', () => {
    const app = require('../src/server');
    const { uiChatBuildLoopBreakRetryArgs } = app._debug;

    const args = {
      operation: 'find_products_multi',
      payload: {
        search: {
          query: 'serum',
        },
      },
    };

    const messages = [
      { role: 'user', content: '帮我买一款 serum' },
      { role: 'assistant', content: '你更偏哪种场景？' },
      { role: 'user', content: '约会' },
    ];

    const toolResult = {
      clarification: {
        reason_code: 'scenario_missing',
        question: 'Which scenario do you want to prioritize?',
      },
      metadata: {
        search_trace: {
          final_decision: 'clarify',
        },
      },
    };

    const out = uiChatBuildLoopBreakRetryArgs(args, messages, toolResult);
    expect(out).toBeTruthy();
    expect(out.scenario).toBe('date');
    expect(out.baseQuery).toBe('帮我买一款 serum');
    expect(out.nextQuery).toContain('使用场景：约会');
    expect(out.nextArgs.payload.search.query).toContain('使用场景：约会');
    expect(out.nextArgs.metadata.ui_chat_loop_break).toBe('scenario_selection_retry');
  });
});
