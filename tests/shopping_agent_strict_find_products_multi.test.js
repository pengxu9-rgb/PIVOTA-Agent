const {
  createStrictFindProductsMultiRuntime,
} = require('../src/modules/decisioning/shopping_agent/strictFindProductsMulti');

function normalizeSearchTextForMatch(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildBeautyQueryProfile({ rawQuery } = {}) {
  const normalized = normalizeSearchTextForMatch(rawQuery);
  if (/\b(foundation|lipstick|blush|gloss)\b/.test(normalized)) {
    return { isBeautyQuery: true, bucket: 'base_makeup' };
  }
  if (/\b(serum|moisturizer|cleanser|toner|niacinamide|retinol|ceramide|panthenol)\b/.test(normalized)) {
    return { isBeautyQuery: true, bucket: 'skincare' };
  }
  return { isBeautyQuery: false, bucket: 'general' };
}

function pruneEmptyFields(input = {}) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null),
  );
}

function createTestRuntime(overrides = {}) {
  const query = overrides.query || jest.fn(async () => ({ rows: [] }));
  const logger = overrides.logger || { warn: jest.fn() };
  const runtime = createStrictFindProductsMultiRuntime({
    normalizeSearchTextForMatch,
    buildBeautyQueryProfile,
    query,
    buildExternalSeedProduct: overrides.buildExternalSeedProduct || ((row) => ({ ...(row.product || {}) })),
    logger,
    buildSearchProductsV2Body:
      overrides.buildSearchProductsV2Body ||
      (({ search = {}, metadata = {}, clientChannel, gatewayRequestId, defaultSearchAllMerchants }) => ({
        ...search,
        _metadata_source: metadata?.source || null,
        _client_channel: clientChannel || null,
        _gateway_request_id: gatewayRequestId || null,
        _search_all_merchants_defaulted: Boolean(defaultSearchAllMerchants),
      })),
    pruneEmptyFields,
    hasDatabaseUrl: overrides.hasDatabaseUrl !== undefined ? overrides.hasDatabaseUrl : true,
  });
  return { runtime, query, logger };
}

describe('Shopping agent strict find_products_multi runtime', () => {
  afterEach(() => {
    delete process.env.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED;
  });

  test('keeps strict agent-api surface enabled even without a raw query', () => {
    const { runtime } = createTestRuntime({ hasDatabaseUrl: false });

    expect(
      runtime.getStrictFindProductsMultiConstraintDecision({
        search: {},
        metadata: { catalog_surface: 'agent_api' },
      }),
    ).toEqual({
      enabled: true,
      catalogSurface: 'agent_api',
      strictConstraintQuery: false,
      strictConstraintReason: null,
      ingredientIntents: [],
      shadeOptionIntents: [],
    });
  });

  test('classifies ingredient and shade-driven multi-constraint queries', () => {
    const { runtime } = createTestRuntime({ hasDatabaseUrl: false });

    expect(
      runtime.getStrictFindProductsMultiConstraintDecision({
        search: { query: 'niacinamide serum for oily skin' },
        metadata: {},
      }),
    ).toMatchObject({
      enabled: true,
      catalogSurface: 'agent_api',
      strictConstraintQuery: true,
      strictConstraintReason: 'ingredient',
      ingredientIntents: ['niacinamide'],
      shadeOptionIntents: [],
    });

    expect(
      runtime.getStrictFindProductsMultiConstraintDecision({
        search: { query: 'foundation shade warm beige under 30' },
        metadata: {},
      }),
    ).toMatchObject({
      enabled: true,
      catalogSurface: 'agent_api',
      strictConstraintQuery: true,
      strictConstraintReason: 'multi_constraint',
      ingredientIntents: [],
      shadeOptionIntents: ['shade_warm_beige_under_30'],
    });
  });

  test('does not misroute beauty exact title lookup with ingredient tokens into strict ingredient mode', () => {
    const { runtime } = createTestRuntime({ hasDatabaseUrl: false });

    expect(
      runtime.getStrictFindProductsMultiConstraintDecision({
        search: { query: 'The Ordinary Niacinamide 10% + Zinc 1%' },
        metadata: { catalog_surface: 'beauty' },
      }),
    ).toMatchObject({
      enabled: false,
      catalogSurface: null,
      strictConstraintQuery: false,
      strictConstraintReason: null,
      ingredientIntents: ['niacinamide', 'zinc_pca'],
      shadeOptionIntents: [],
    });
  });

  test('can disable auto strict ingredient routing while preserving explicit strict surfaces', () => {
    process.env.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED = 'false';
    const { runtime } = createTestRuntime({ hasDatabaseUrl: false });

    expect(
      runtime.getStrictFindProductsMultiConstraintDecision({
        search: { query: 'niacinamide serum for oily skin' },
        metadata: {},
      }),
    ).toMatchObject({
      enabled: false,
      catalogSurface: null,
      strictConstraintQuery: false,
      strictConstraintReason: null,
      ingredientIntents: ['niacinamide'],
    });

    expect(
      runtime.getStrictFindProductsMultiConstraintDecision({
        search: { query: 'niacinamide serum for oily skin' },
        metadata: { catalog_surface: 'agent_api' },
      }),
    ).toMatchObject({
      enabled: true,
      catalogSurface: 'agent_api',
      strictConstraintQuery: true,
      strictConstraintReason: 'ingredient',
      ingredientIntents: ['niacinamide'],
    });
  });

  test('keeps explicit strict surfaces enabled for exact-title beauty lookups', () => {
    const { runtime } = createTestRuntime({ hasDatabaseUrl: false });

    expect(
      runtime.getStrictFindProductsMultiConstraintDecision({
        search: { query: 'Multi-Calm Cream Cleanser' },
        metadata: { catalog_surface: 'agent_api' },
      }),
    ).toMatchObject({
      enabled: true,
      catalogSurface: 'agent_api',
      strictConstraintQuery: false,
      strictConstraintReason: 'agent_api_surface',
      ingredientIntents: [],
      shadeOptionIntents: [],
    });

    expect(
      runtime.getStrictFindProductsMultiConstraintDecision({
        search: { query: 'Multi-Calm Cream Cleanser' },
        metadata: {},
      }),
    ).toMatchObject({
      enabled: false,
      catalogSurface: null,
      strictConstraintQuery: false,
      strictConstraintReason: null,
      ingredientIntents: [],
      shadeOptionIntents: [],
    });
  });

  test('prefetches only strict ingredient external seed matches', async () => {
    const rows = [
      {
        id: 'seed_1',
        market: 'US',
        tool: 'harvester',
        product: {
          product_id: 'p_1',
          title: 'Niacinamide Balancing Serum',
          category: 'serum',
          ingredient_ids: ['niacinamide'],
          in_stock: true,
        },
      },
      {
        id: 'seed_2',
        market: 'US',
        tool: 'harvester',
        product: {
          product_id: 'p_2',
          title: 'Niacinamide Barrier Moisturizer',
          category: 'moisturizer',
          ingredient_ids: ['niacinamide'],
          in_stock: true,
        },
      },
      {
        id: 'seed_3',
        market: 'US',
        tool: 'harvester',
        product: {
          product_id: 'p_1',
          title: 'Niacinamide Balancing Serum Duplicate',
          category: 'serum',
          ingredient_ids: ['niacinamide'],
          in_stock: true,
        },
      },
    ];
    const { runtime, query } = createTestRuntime({
      query: jest.fn(async () => ({ rows })),
    });

    const decision = runtime.getStrictFindProductsMultiConstraintDecision({
      search: { query: 'niacinamide serum', in_stock_only: true },
      metadata: {},
    });
    const out = await runtime.prefetchStrictIngredientExternalSeedCandidates({
      search: { query: 'niacinamide serum', in_stock_only: true },
      strictInvokeDecision: decision,
      rawQueryText: 'niacinamide serum',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      product_id: 'p_1',
      external_seed_id: 'seed_1',
      market: 'US',
      tool: 'harvester',
    });
  });

  test('builds strict invoke body with normalized surface and raw query carry-through', async () => {
    const { runtime } = createTestRuntime({ hasDatabaseUrl: false });
    const strictInvokeDecision = runtime.getStrictFindProductsMultiConstraintDecision({
      search: {
        query: 'niacinamide serum',
      },
      metadata: {
        catalog_surface: 'acp',
      },
    });

    const out = await runtime.buildFindProductsMultiInvokeBody({
      payload: { search: { query: 'stale text' } },
      search: { query: 'stale text' },
      metadata: { source: 'shopping_agent', catalog_surface: 'acp' },
      clientChannel: 'shop',
      gatewayRequestId: 'req_123',
      defaultSearchAllMerchants: true,
      strictInvokeDecision,
      rawQueryText: 'niacinamide serum',
    });

    expect(out).toEqual({
      operation: 'find_products_multi',
      payload: {
        search: expect.objectContaining({
          query: 'niacinamide serum',
          catalog_surface: 'acp',
          commerce_surface: 'acp',
          _metadata_source: 'shopping_agent',
          _client_channel: 'shop',
          _gateway_request_id: 'req_123',
          _search_all_merchants_defaulted: true,
        }),
      },
      metadata: {
        source: 'shopping_agent',
        catalog_surface: 'acp',
        commerce_surface: 'acp',
      },
    });
  });

  test('builds strict invoke body with eur budget normalized to usd search constraints', async () => {
    const { runtime } = createTestRuntime({
      hasDatabaseUrl: false,
      buildSearchProductsV2Body: ({ search = {}, payload = {}, metadata = {}, clientChannel, gatewayRequestId, defaultSearchAllMerchants }) => ({
        ...search,
        request_context: {
          currency: search.currency,
          user_constraints: payload?.context?.user_constraints,
          _metadata_source: metadata?.source || null,
          _client_channel: clientChannel || null,
          _gateway_request_id: gatewayRequestId || null,
          _search_all_merchants_defaulted: Boolean(defaultSearchAllMerchants),
        },
      }),
    });
    const strictInvokeDecision = runtime.getStrictFindProductsMultiConstraintDecision({
      search: {
        query: 'vitamin c serum under €30',
      },
      metadata: {},
    });

    const out = await runtime.buildFindProductsMultiInvokeBody({
      payload: {
        context: {
          user_constraints: {
            skin_type: 'oily',
          },
        },
      },
      search: { query: 'stale text' },
      metadata: { source: 'shopping_agent' },
      clientChannel: 'shop',
      gatewayRequestId: 'req_budget',
      defaultSearchAllMerchants: true,
      strictInvokeDecision,
      rawQueryText: 'vitamin c serum under €30',
    });

    expect(out.payload.search).toEqual(
      expect.objectContaining({
        query: 'vitamin c serum under €30',
        catalog_surface: 'agent_api',
        commerce_surface: 'agent_api',
        currency: 'USD',
      }),
    );
    expect(out.payload.search.price_min).toBeUndefined();
    expect(out.payload.search.price_max).toBeCloseTo(32.7, 5);
    expect(out.payload.search.request_context).toEqual(
      expect.objectContaining({
        currency: 'USD',
        user_constraints: expect.objectContaining({
          skin_type: 'oily',
          price: expect.objectContaining({
            currency: 'EUR',
            max: 30,
            invoke_currency: 'USD',
            invoke_max: 32.7,
            fx_applied: true,
            fx_rate: 1.09,
          }),
        }),
      }),
    );
  });
});
