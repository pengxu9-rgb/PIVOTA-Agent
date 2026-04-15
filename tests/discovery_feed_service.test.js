const nock = require('nock');
const axios = require('axios');
const {
  DiscoveryCatalogUnavailableError,
  buildDiscoveryProfile,
  getDiscoveryFeed,
  _internals,
} = require('../src/services/discoveryFeed');
const {
  getLastDiscoverySnapshot,
  renderDiscoveryMetricsPrometheus,
  resetDiscoveryMetricsForTest,
} = require('../src/observability/discoveryMetrics');

function makeProduct({
  merchant_id = 'merch_a',
  product_id,
  title,
  description = '',
  brand,
  category,
  product_type,
  price = 20,
  currency = 'USD',
  inventory_quantity = 10,
  canonical_url,
  destination_url,
  url,
} = {}) {
  return {
    merchant_id,
    product_id,
    title: title || product_id,
    description,
    ...(brand ? { brand } : {}),
    ...(category ? { category } : {}),
    ...(product_type ? { product_type } : {}),
    price,
    currency,
    inventory_quantity,
    ...(canonical_url ? { canonical_url } : {}),
    ...(destination_url ? { destination_url } : {}),
    ...(url ? { url } : {}),
    status: 'active',
  };
}

function makeExternalSeedRow({
  id,
  external_product_id,
  title,
  brand = 'Pixi Beauty',
  category = 'Toner',
  product_type = 'Toner',
  description = '',
  canonical_url,
  destination_url,
} = {}) {
  const resolvedExternalProductId = external_product_id || `ext_${String(id || title || 'seed').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
  const resolvedCanonicalUrl =
    canonical_url || `https://example.com/products/${resolvedExternalProductId}`;
  const resolvedDestinationUrl = destination_url || resolvedCanonicalUrl;
  const imageUrl = `https://cdn.example.com/${resolvedExternalProductId}.jpg`;
  return {
    id: id || `eps_${resolvedExternalProductId}`,
    external_product_id: resolvedExternalProductId,
    destination_url: resolvedDestinationUrl,
    canonical_url: resolvedCanonicalUrl,
    domain: 'example.com',
    title,
    image_url: imageUrl,
    price_amount: 24,
    price_currency: 'USD',
    availability: 'in_stock',
    updated_at: '2026-04-12T10:00:00Z',
    created_at: '2026-04-12T09:00:00Z',
    seed_data: {
      title,
      brand,
      category,
      product_type,
      description,
      snapshot: {
        title,
        brand,
        category,
        product_type,
        description,
        canonical_url: resolvedCanonicalUrl,
        destination_url: resolvedDestinationUrl,
        image_url: imageUrl,
      },
      derived: {
        recall: {
          retrieval_title: title,
          retrieval_summary: description,
          brand,
          category,
          vertical: 'skincare',
        },
      },
    },
  };
}

describe('discovery feed service', () => {
  let previousEnv;

  beforeEach(() => {
    previousEnv = {
      DISCOVERY_PRODUCTS_SEARCH_BASE_URL: process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL,
      DISCOVERY_PRODUCTS_SEARCH_API_KEY: process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY,
      PIVOTA_BACKEND_BASE_URL: process.env.PIVOTA_BACKEND_BASE_URL,
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_BACKEND_AGENT_API_KEY: process.env.PIVOTA_BACKEND_AGENT_API_KEY,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      SHOP_GATEWAY_AGENT_API_KEY: process.env.SHOP_GATEWAY_AGENT_API_KEY,
      PIVOTA_AGENT_API_KEY: process.env.PIVOTA_AGENT_API_KEY,
      AGENT_API_KEY: process.env.AGENT_API_KEY,
      DISCOVERY_PRODUCTS_SEARCH_MAX_CALLS: process.env.DISCOVERY_PRODUCTS_SEARCH_MAX_CALLS,
      DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS: process.env.DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS,
      DISCOVERY_BRAND_DIRECT_PREFETCH_DELAY_MS: process.env.DISCOVERY_BRAND_DIRECT_PREFETCH_DELAY_MS,
      DISCOVERY_RECALL_BUDGET_MS: process.env.DISCOVERY_RECALL_BUDGET_MS,
      DISCOVERY_POOL_CACHE_TTL_MS: process.env.DISCOVERY_POOL_CACHE_TTL_MS,
      DISCOVERY_SERVING_SHADOW_TIMEOUT_MS: process.env.DISCOVERY_SERVING_SHADOW_TIMEOUT_MS,
      CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET: process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET,
      CATALOG_SERVING_INDEX_BASE_URL: process.env.CATALOG_SERVING_INDEX_BASE_URL,
      CATALOG_SERVING_INDEX_NAME: process.env.CATALOG_SERVING_INDEX_NAME,
      CATALOG_SERVING_INDEX_API_KEY: process.env.CATALOG_SERVING_INDEX_API_KEY,
      CATALOG_SERVING_INDEX_SHADOW_READ_ENABLED: process.env.CATALOG_SERVING_INDEX_SHADOW_READ_ENABLED,
      DATABASE_URL: process.env.DATABASE_URL,
    };
    resetDiscoveryMetricsForTest();
    _internals.resetBrowsePoolCache();
    _internals.resetBrowseCatalogCountCache();
    _internals.resetDiscoveryDependencyProbeCache();
    _internals.resetProductIntelKbStoreCache();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  test('buildDiscoveryProfile dedupes views and infers merged personalization source', () => {
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'home_hot_deals',
      context: {
        auth_state: 'authenticated',
        recent_views: [
          {
            merchant_id: 'm1',
            product_id: 'p1',
            title: 'Acme Repair Serum',
            brand: 'Acme',
            category: 'Skincare',
            product_type: 'Serum',
            viewed_at: '2026-04-04T10:00:00Z',
            history_source: 'account',
          },
          {
            merchant_id: 'm1',
            product_id: 'p1',
            title: 'Acme Repair Serum',
            brand: 'Acme',
            category: 'Skincare',
            product_type: 'Serum',
            viewed_at: '2026-04-03T10:00:00Z',
            history_source: 'session',
          },
          {
            merchant_id: 'm2',
            product_id: 'p2',
            title: 'Glow Lip Oil',
            brand: 'Glow',
            category: 'Makeup',
            product_type: 'Lip',
            viewed_at: '2026-04-02T10:00:00Z',
            history_source: 'session',
          },
        ],
        recent_queries: ['repair serum', 'lip oil'],
      },
    });

    const profile = buildDiscoveryProfile(request.context);

    expect(profile.historyItemsUsed).toBe(2);
    expect(profile.personalizationSource).toBe('merged');
    expect(profile.anchors).toHaveLength(2);
    expect(profile.brandAffinity.get('acme')).toBeGreaterThan(profile.brandAffinity.get('glow'));
    expect(profile.categoryAffinity.get('serum')).toBeGreaterThan(0);
    expect(profile.queryTokens.has('repair')).toBe(true);
  });

  test('buildDiscoveryRecallPlan prioritizes explicit query text for anonymous browse search', () => {
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      query: {
        text: 'Naturium The Brightener Vitamin C Brightening Body Wash',
      },
      context: {
        auth_state: 'anonymous',
        recent_views: [],
        recent_queries: [],
        locale: 'en-US',
      },
    });
    const profile = buildDiscoveryProfile(request.context);

    const plan = _internals.buildDiscoveryRecallPlan(request, profile, 48);

    expect(Array.isArray(plan)).toBe(true);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      label: 'browse_pool',
      query: 'Naturium The Brightener Vitamin C Brightening Body Wash',
    });
  });

  test('explicit beauty seed recall keeps multi-word query phrases ahead of broad token patterns', () => {
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      query: {
        text: 'hair oil',
      },
      context: {
        auth_state: 'anonymous',
        recent_views: [],
        recent_queries: [],
        locale: 'en-US',
      },
    });
    const profile = buildDiscoveryProfile(request.context);

    const recallTerms = _internals.buildBeautyInterestRecallTerms(request, profile, ['hair oil']);

	    expect(recallTerms.patterns).toEqual(expect.arrayContaining(['%hair oil%', '%hair%oil%']));
	    expect(recallTerms.patterns).not.toContain('%hair%');
	    expect(recallTerms.patterns).not.toContain('%oil%');
	    expect(recallTerms.compoundIntent).toBe('hair_oil');
	    expect(recallTerms.primaryCategoryTerms).toEqual(expect.arrayContaining(['hair oil']));
	    expect(recallTerms.primaryCategoryTerms).not.toContain('haircare');
	    expect(recallTerms.weakCategoryTerms).toEqual(
	      expect.arrayContaining(['hair treatment', 'hair care', 'haircare']),
	    );
	    expect(recallTerms.categoryTerms).toEqual(expect.arrayContaining(['hair oil', 'haircare']));
	    expect(recallTerms.verticalTerms).toEqual(expect.arrayContaining(['haircare']));
	  });

  test('public explicit browse external seed recall includes global and creator seed scopes', () => {
    const explicitRequest = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      query: {
        text: 'lip balm',
      },
      context: {
        auth_state: 'anonymous',
        recent_views: [],
        recent_queries: [],
        locale: 'en-US',
      },
    });
    const genericRequest = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      context: {
        auth_state: 'anonymous',
        recent_views: [],
        recent_queries: [],
        locale: 'en-US',
      },
    });

    expect(_internals.resolveDiscoveryExternalSeedToolScopes(explicitRequest, 'creator_agents')).toEqual([
      '*',
      'creator_agents',
    ]);
    expect(_internals.resolveDiscoveryExternalSeedToolScopes(genericRequest, 'creator_agents')).toEqual([
      '*',
      'creator_agents',
    ]);
  });

  test('explicit browse query uses staged external seed mainline without cold-start beauty fallback terms', async () => {
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY;
    delete process.env.PIVOTA_BACKEND_AGENT_API_KEY;
    delete process.env.PIVOTA_API_KEY;
    delete process.env.DATABASE_URL;

    const internalSpy = jest.fn(async () => []);
    const externalSpy = jest.fn(async ({ queries }) =>
      Array.from({ length: 12 }, (_, idx) =>
        makeProduct({
          merchant_id: 'external_seed',
          product_id: `lip_balm_${idx + 1}`,
          title: `Lip Balm ${idx + 1}`,
          brand: `Seeded Beauty ${idx + 1}`,
          category: 'Lip Balm',
          product_type: 'Lip Balm',
        }),
      ).map((product) => ({
        ...product,
        observed_queries: queries,
      })),
    );

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: {
          text: 'lip balm',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    const externalCall = externalSpy.mock.calls[0]?.[0] || {};
    const recallSummaryText = JSON.stringify(response.metadata.rank_debug.recall_summary);

    expect(response.products).toHaveLength(12);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(externalCall.queries).toEqual(['lip balm']);
    expect(recallSummaryText).not.toMatch(/niacinamide|vitamin c|barrier moisturizer/i);
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          skipped: true,
          skip_reason: 'explicit_compound_external_seed_mainline',
        }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'explicit_compound_external_seed_mainline',
        }),
        expect.objectContaining({ provider: 'external_seeds', successful: true, returned: 12 }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          label: 'products_search_pool',
          skipped: true,
          skip_reason: 'explicit_compound_external_seed_mainline',
        }),
        expect.objectContaining({
          provider: 'external_seeds',
          label: 'external_seed_pool',
          query: 'lip balm',
          status: 200,
          returned: 12,
        }),
      ]),
    );
  });

  test('explicit browse query keeps external seeds enabled even when products_search is already sufficient', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'bridge-key';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_BACKEND_AGENT_API_KEY;
    delete process.env.PIVOTA_API_KEY;
    delete process.env.DATABASE_URL;

    const productsSearchProducts = Array.from({ length: 24 }, (_, idx) =>
      makeProduct({
        merchant_id: 'products_search',
        product_id: `search_lip_balm_${idx + 1}`,
        title: `Search Lip Balm ${idx + 1}`,
        brand: `Search Beauty ${idx + 1}`,
        category: 'Lip Balm',
        product_type: 'Lip Balm',
      }),
    );
    const internalSpy = jest.fn(async () => []);
    const externalSpy = jest.fn(async () =>
      Array.from({ length: 12 }, (_, idx) =>
        makeProduct({
          merchant_id: 'external_seed',
          product_id: `seed_lip_balm_${idx + 1}`,
          title: `Seed Lip Balm ${idx + 1}`,
          brand: `Seed Beauty ${idx + 1}`,
          category: 'Lip Balm',
          product_type: 'Lip Balm',
        }),
      ),
    );

    nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query((query) => String(query.query || '') === 'lip balm')
      .reply(200, { products: productsSearchProducts });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: {
          text: 'lip balm',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(nock.isDone()).toBe(false);
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(response.products).toHaveLength(12);
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          skipped: true,
          skip_reason: 'explicit_compound_external_seed_mainline',
        }),
        expect.objectContaining({ provider: 'external_seeds', successful: true, returned: 12 }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'explicit_compound_external_seed_mainline',
        }),
      ]),
    );
  });

  test('ingredient-like exact phrase browse uses external seed exact-intent mainline without products_search', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'bridge-key';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_BACKEND_AGENT_API_KEY;
    delete process.env.PIVOTA_API_KEY;
    delete process.env.DATABASE_URL;

    const externalSpy = jest.fn(async () => {
      return Array.from({ length: 10 }, (_, idx) =>
        makeProduct({
          merchant_id: 'external_seed',
          product_id: `seed_glycolic_acid_${idx + 1}`,
          title: `Seed Glycolic Acid Peel ${idx + 1}`,
          brand: `Seed Beauty ${idx + 1}`,
          category: 'Exfoliant',
          product_type: 'Exfoliant',
        }),
      );
    });
    const internalSpy = jest.fn(async () => []);

    const productsSearchScope = nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query((query) => String(query.query || '') === 'glycolic acid')
      .reply(200, { products: [] });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: {
          text: 'glycolic acid',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(productsSearchScope.isDone()).toBe(false);
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(response.products).toHaveLength(10);
    expect(response.metadata.candidate_source).toBe('external_seed_exact_intent');
    expect(response.metadata.underfilled_reason).toBe('public_search_underfilled_exact_intent');
    expect(response.metadata.route_health.primary_quality_gate_passed).toBe(false);
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'external_seeds', successful: true, returned: 10 }),
        expect.objectContaining({
          provider: 'products_search',
          skipped: true,
          skip_reason: 'explicit_exact_intent_external_seed_mainline',
        }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'explicit_exact_intent_external_seed_mainline',
        }),
      ]),
    );
  });

  test('category exact phrase browse does not run products_search supplement when external seeds underfill', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'bridge-key';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_BACKEND_AGENT_API_KEY;
    delete process.env.PIVOTA_API_KEY;
    delete process.env.DATABASE_URL;

    const externalSpy = jest.fn(async () =>
      Array.from({ length: 10 }, (_, idx) =>
        makeProduct({
          merchant_id: 'external_seed',
          product_id: `seed_shampoo_${idx + 1}`,
          title: `Seed Shampoo ${idx + 1}`,
          brand: `Seed Beauty ${idx + 1}`,
          category: 'Hair Care',
          product_type: 'Shampoo',
        }),
      ),
    );
    const internalSpy = jest.fn(async () => []);
    const productsSearchScope = nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query((query) => String(query.query || '') === 'shampoo')
      .reply(200, {
        products: [
          makeProduct({
            merchant_id: 'products_search',
            product_id: 'search_shampoo_should_not_be_called',
            title: 'Search Shampoo Should Not Be Called',
            brand: 'Search Beauty',
            category: 'Hair Care',
            product_type: 'Shampoo',
          }),
        ],
      });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: {
          text: 'shampoo',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(productsSearchScope.isDone()).toBe(false);
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(response.products).toHaveLength(10);
    expect(response.products.every((product) => /shampoo/i.test(product.title))).toBe(true);
    expect(response.metadata.candidate_source).toBe('external_seed_exact_intent');
    expect(response.metadata.underfilled_reason).toBe('public_search_underfilled_exact_intent');
    expect(response.metadata.route_health.primary_quality_gate_passed).toBe(false);
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'external_seeds', successful: true, returned: 10 }),
        expect.objectContaining({
          provider: 'products_search',
          skipped: true,
          skip_reason: 'explicit_exact_intent_external_seed_mainline',
        }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'explicit_exact_intent_external_seed_mainline',
        }),
      ]),
    );
  });

  test('explicit non-compound browse still uses products_search when external seed mainline underfills for non exact-intent query', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'bridge-key';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_BACKEND_AGENT_API_KEY;
    delete process.env.PIVOTA_API_KEY;
    delete process.env.DATABASE_URL;

    const externalSpy = jest.fn(async () =>
      Array.from({ length: 4 }, (_, idx) =>
        makeProduct({
          merchant_id: 'external_seed',
          product_id: `seed_vitamin_c_underfill_${idx + 1}`,
          title: `Vitamin C Glow Serum ${idx + 1}`,
          brand: `Seed Beauty ${idx + 1}`,
          category: 'Skincare',
          product_type: 'Serum',
        }),
      ),
    );
    const internalSpy = jest.fn(async () => []);
    const productsSearchProducts = Array.from({ length: 8 }, (_, idx) =>
      makeProduct({
        merchant_id: 'products_search',
        product_id: `products_vitamin_c_${idx + 1}`,
        title: `Products Vitamin C Serum ${idx + 1}`,
        brand: `Catalog Beauty ${idx + 1}`,
        category: 'Skincare',
        product_type: 'Serum',
      }),
    );

    const productsSearchScope = nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query((query) => String(query.query || '') === 'vitamin c')
      .reply(200, { products: productsSearchProducts });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: {
          text: 'vitamin c',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(productsSearchScope.isDone()).toBe(true);
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(response.products).toHaveLength(12);
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'external_seeds', successful: true, returned: 4 }),
        expect.objectContaining({ provider: 'products_search', successful: true, returned: 8 }),
      ]),
    );
    expect(response.metadata.route_health.primary_quality_gate_passed).toBe(true);
    expect(response.metadata.underfilled_reason).toBeUndefined();
  });

  test('ingredient-like exact phrase browse keeps exact-intent mainline even when external seed underfills', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'bridge-key';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_BACKEND_AGENT_API_KEY;
    delete process.env.PIVOTA_API_KEY;
    delete process.env.DATABASE_URL;

    const externalSpy = jest.fn(async () =>
      Array.from({ length: 4 }, (_, idx) =>
        makeProduct({
          merchant_id: 'external_seed',
          product_id: `seed_glycolic_underfill_${idx + 1}`,
          title: `Seed Glycolic Acid Underfill ${idx + 1}`,
          brand: `Seed Beauty ${idx + 1}`,
          category: 'Exfoliant',
          product_type: 'Exfoliant',
        }),
      ),
    );
    const internalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'internal_catalog',
        product_id: 'internal_noise_brush',
        title: 'Large Powder Brush',
        category: 'Makeup Brush',
        product_type: 'Makeup Brush',
      }),
    ]);

    const productsSearchScope = nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query((query) => String(query.query || '') === 'glycolic acid')
      .reply(200, {
        products: [
          makeProduct({
            merchant_id: 'products_search',
            product_id: 'products_glycolic_noise',
            title: 'Products Glycolic Acid Noise',
            category: 'Exfoliant',
            product_type: 'Exfoliant',
          }),
        ],
      });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: {
          text: 'glycolic acid',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(productsSearchScope.isDone()).toBe(false);
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(response.products).toHaveLength(4);
    expect(response.metadata.candidate_source).toBe('external_seed_exact_intent');
    expect(response.metadata.underfilled_reason).toBe('public_search_underfilled_exact_intent');
    expect(response.metadata.route_health.primary_quality_gate_passed).toBe(false);
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'external_seeds', successful: true, returned: 4 }),
        expect.objectContaining({
          provider: 'products_search',
          skipped: true,
          skip_reason: 'explicit_exact_intent_external_seed_mainline',
        }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'explicit_exact_intent_external_seed_mainline',
        }),
      ]),
    );
  });

  test('explicit compound browse marks partial page as exact-intent underfilled', async () => {
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY;
    delete process.env.PIVOTA_BACKEND_AGENT_API_KEY;
    delete process.env.PIVOTA_API_KEY;
    delete process.env.DATABASE_URL;

    const externalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'hair_mask_1',
        title: 'Intensive Repair Hair Mask',
        brand: 'Seed Beauty',
        category: 'Hair Mask',
        product_type: 'Hair Mask',
      }),
    ]);

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: {
          text: 'hair mask',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: jest.fn(async () => []),
          external_seeds: externalSpy,
        },
      },
    );

    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(response.products).toHaveLength(1);
    expect(response.metadata.compound_intent).toBe('hair_mask');
    expect(response.metadata.underfilled_reason).toBe('public_search_underfilled_exact_intent');
    expect(response.metadata.route_health.primary_quality_gate_passed).toBe(false);
  });

  test('explicit compound browse reports strict empty instead of falling through to broad providers', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'bridge-key';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_BACKEND_AGENT_API_KEY;
    delete process.env.PIVOTA_API_KEY;
    delete process.env.DATABASE_URL;

    const productsSearchScope = nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        products: [
          makeProduct({
            product_id: 'broad_serum_noise',
            title: 'Generic Face Serum',
            brand: 'Noise Beauty',
            category: 'Serum',
            product_type: 'Serum',
          }),
        ],
      });
    const internalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'internal',
        product_id: 'internal_serum_noise',
        title: 'Internal Hair Growth Serum',
        brand: 'Internal Beauty',
        category: 'Serum',
        product_type: 'Serum',
      }),
    ]);
    const externalSpy = jest.fn(async () => []);

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: {
          text: 'scalp serum',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(productsSearchScope.isDone()).toBe(false);
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(response.products).toHaveLength(0);
    expect(response.metadata.candidate_source).toBe('external_seed_compound_intent');
    expect(response.metadata.strict_empty_reason).toBe('public_search_empty_exact_intent');
    expect(response.metadata.route_health.primary_quality_gate_passed).toBe(false);
    expect(response.metadata.route_health.strict_empty_reason).toBe('public_search_empty_exact_intent');
    expect(response.metadata.search_decision.final_decision).toBe('strict_empty');
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          skipped: true,
          skip_reason: 'explicit_compound_external_seed_mainline',
        }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'explicit_compound_external_seed_mainline',
        }),
      ]),
    );
  });

  test('explicit narrow browse query uses external seed mainline without products_search or internal broad pool', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'bridge-key';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_BACKEND_AGENT_API_KEY;
    delete process.env.PIVOTA_API_KEY;
    delete process.env.DATABASE_URL;

    const externalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'vitamin_c_body_wash_exact',
        title: 'The Brightener Vitamin C Brightening Body Wash',
        brand: 'Naturium',
        category: 'Body Wash',
        product_type: 'Body Wash',
      }),
    ]);
    const internalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'internal_catalog',
        product_id: 'broad_cleanser_noise',
        title: 'Generic Cleanser',
        category: 'Cleanser',
        product_type: 'Cleanser',
      }),
    ]);

    const productsSearchScope = nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        products: [
          makeProduct({
            merchant_id: 'products_search',
            product_id: 'products_search_noise',
            title: 'Generic Vitamin C Serum',
            category: 'Serum',
            product_type: 'Serum',
          }),
        ],
      });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: {
          text: 'vitamin c body wash',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(productsSearchScope.isDone()).toBe(false);
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(response.products.map((product) => product.title)).toEqual([
      'The Brightener Vitamin C Brightening Body Wash',
    ]);
    expect(response.metadata.candidate_source).toBe('external_seed_narrow_query');
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'external_seeds', successful: true, returned: 1 }),
        expect.objectContaining({
          provider: 'products_search',
          skipped: true,
          skip_reason: 'explicit_narrow_external_seed_mainline',
        }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'explicit_narrow_external_seed_mainline',
        }),
      ]),
    );
  });

  test('explicit browse query does not let broad internal catalog matches starve external seed candidates', async () => {
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY;
    delete process.env.PIVOTA_BACKEND_AGENT_API_KEY;
    delete process.env.PIVOTA_API_KEY;
    delete process.env.DATABASE_URL;

    const internalSpy = jest.fn(async () =>
      Array.from({ length: 48 }, (_, idx) =>
        makeProduct({
          merchant_id: 'internal_catalog',
          product_id: `horse_hair_brush_${idx + 1}`,
          title: `Horse Hair Makeup Brush ${idx + 1}`,
          brand: 'Brush House',
          category: 'Makeup Brush',
          product_type: 'Makeup Brush',
        }),
      ),
    );
    const externalSpy = jest.fn(async () =>
      Array.from({ length: 12 }, (_, idx) =>
        makeProduct({
          merchant_id: 'external_seed',
          product_id: `hair_oil_${idx + 1}`,
          title: `Nourishing Hair Oil ${idx + 1}`,
          brand: `Seeded Haircare ${idx + 1}`,
          category: 'Hair Oil',
          product_type: 'Hair Oil',
        }),
      ),
    );

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: {
          text: 'hair oil',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(response.products).toHaveLength(12);
    expect(response.products.every((product) => /hair oil/i.test(product.title))).toBe(true);
    expect(response.metadata.selected_source_breakdown).toEqual(
      expect.objectContaining({ external_seeds: 12 }),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'external_seeds',
          label: 'external_seed_pool',
          query: 'hair oil',
          returned: 12,
          status: 200,
        }),
        expect.objectContaining({
          provider: 'internal_catalog',
          label: 'internal_catalog_pool',
          query: 'hair oil',
          skipped: true,
          skip_reason: 'explicit_compound_external_seed_mainline',
        }),
      ]),
    );
  });

  test('explicit browse query uses compound external seed intent instead of raw description matches', async () => {
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY;
    delete process.env.PIVOTA_BACKEND_AGENT_API_KEY;
    delete process.env.PIVOTA_API_KEY;
    delete process.env.DATABASE_URL;

    const internalSpy = jest.fn(async () =>
      Array.from({ length: 24 }, (_, idx) =>
        makeProduct({
          merchant_id: 'internal_catalog',
          product_id: `horse_hair_brush_${idx + 1}`,
          title: `Horse Hair Makeup Brush ${idx + 1}`,
          brand: 'Brush House',
          category: 'Makeup Brush',
          product_type: 'Makeup Brush',
        }),
      ),
    );
    const broadHaircareSeeds = Array.from({ length: 12 }, (_, idx) =>
      makeProduct({
        merchant_id: 'external_seed',
        product_id: `haircare_shampoo_${idx + 1}`,
        title: `High Shine Shampoo ${idx + 1}`,
        brand: `Seeded Haircare ${idx + 1}`,
        category: 'Shampoo',
        product_type: 'Shampoo',
        description: 'Cleanses hair with fermented camellia oil for a glossy finish.',
      }),
    );
    const hairOilSeeds = Array.from({ length: 12 }, (_, idx) =>
      makeProduct({
        merchant_id: 'external_seed',
        product_id: `hair_oil_seed_${idx + 1}`,
        title: `Beauty Oil ${idx + 1}`,
        brand: `Seeded Haircare ${idx + 1}`,
        category: 'Haircare',
        product_type: 'Haircare',
      }),
    );
    const externalSpy = jest.fn(async () =>
      broadHaircareSeeds.concat(hairOilSeeds),
    );

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: {
          text: 'hair oil',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(response.products).toHaveLength(12);
    expect(response.products.every((product) => /Beauty Oil/.test(product.title))).toBe(true);
	    expect(response.metadata.selected_source_breakdown).toEqual(
	      expect.objectContaining({ external_seeds: 12 }),
	    );
	    expect(response.metadata.candidate_counts.raw).toBe(12);
	    expect(response.metadata.filter_counts.filtered_query_text || 0).toBe(0);
	  });

  test('explicit browse lookup short-circuits external seed recall with exact-title fastpath', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-exact-title-fastpath';
    const dbQueryMock = jest.fn(async () => ({
      rows: [
        makeExternalSeedRow({
          id: 'eps_pixi_original',
          external_product_id: 'ext_pixi_original',
          title: 'Vitamin-C Tonic Original Size',
          description: 'Even tone + daily glow',
        }),
        makeExternalSeedRow({
          id: 'eps_pixi_sample',
          external_product_id: 'ext_pixi_sample',
          title: 'Vitamin-C Tonic Sample Size',
          description: 'Even tone + daily glow',
        }),
        makeExternalSeedRow({
          id: 'eps_pixi_travel',
          external_product_id: 'ext_pixi_travel',
          title: 'Vitamin-C Tonic Travel Size',
          description: 'Even tone + daily glow',
        }),
        makeExternalSeedRow({
          id: 'eps_pixi_bundle',
          external_product_id: 'ext_pixi_bundle',
          title: 'Best of Tonics Vault',
          description: 'Bundle that should not be treated as the exact tonic lookup hit.',
        }),
      ],
    }));
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const {
        buildDiscoveryProfile: freshBuildDiscoveryProfile,
        _internals: freshInternals,
      } = require('../src/services/discoveryFeed');
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        query: {
          text: 'PIXI BEAUTY Vitamin-C Tonic',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      });

      const result = await freshInternals.fetchExternalSeedCandidates({
        request,
        profile: freshBuildDiscoveryProfile(request.context),
        queries: [request.query.text],
        limit: 20,
      });

      expect(result.products.map((product) => product.title)).toEqual([
        'Vitamin-C Tonic Original Size',
        'Vitamin-C Tonic Sample Size',
        'Vitamin-C Tonic Travel Size',
      ]);
      expect(result.recallSummary).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: 'external_seeds',
            label: 'external_seed_exact_title_pool',
            status: 200,
            returned: 3,
          }),
        ]),
      );
      expect(dbQueryMock).toHaveBeenCalledTimes(1);
      expect(String(dbQueryMock.mock.calls[0]?.[0] || '')).not.toContain('match_score');
    } finally {
      jest.dontMock('../src/db');
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });

  test('exact-title primary path bypasses generic provider waterfall for anonymous browse search', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-exact-title-primary';
    const dbQueryMock = jest.fn(async () => ({
      rows: [
        makeExternalSeedRow({
          id: 'eps_dermalogica_exact',
          external_product_id: 'ext_dermalogica_exact',
          title: 'biolumin c vitamin c gel moisturizer',
          brand: 'Dermalogica',
          category: 'Moisturizer',
          product_type: 'Moisturizer',
          description: 'Radiance boost + weightless hydration',
        }),
      ],
    }));
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const {
        buildDiscoveryProfile: freshBuildDiscoveryProfile,
        _internals: freshInternals,
      } = require('../src/services/discoveryFeed');
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        query: {
          text: 'Dermalogica biolumin-c vitamin c gel moisturizer',
        },
        context: {
          auth_state: 'anonymous',
          recent_views: [],
          recent_queries: [],
          locale: 'en-US',
        },
      });

      const result = await freshInternals.loadCatalogCandidates({
        request,
        profile: freshBuildDiscoveryProfile(request.context),
        limit: 24,
      });

      expect(result.products.map((product) => product.title)).toEqual([
        'biolumin c vitamin c gel moisturizer',
      ]);
      expect(result.candidateSource).toBe('exact_title_primary');
      expect(result.primaryPathUsed).toBe('exact_title_primary');
      expect(result.recallSummary).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: 'external_seeds',
            label: 'external_seed_exact_title_pool',
            status: 200,
            returned: 1,
          }),
          expect.objectContaining({
            provider: 'products_search',
            label: 'products_search_pool',
            skipped: true,
            skip_reason: 'exact_title_primary_used',
          }),
          expect.objectContaining({
            provider: 'internal_catalog',
            label: 'internal_catalog_pool',
            skipped: true,
            skip_reason: 'exact_title_primary_used',
          }),
        ]),
      );
      expect(result.recallSummary.some((step) => step?.label === 'external_seed_pool')).toBe(false);
      expect(dbQueryMock).toHaveBeenCalledTimes(1);
      expect(dbQueryMock.mock.calls[0]?.[1]?.[2]).toEqual(
        expect.arrayContaining([
          'dermalogica biolumin c vitamin c gel moisturizer',
          'biolumin c vitamin c gel moisturizer',
        ]),
      );
    } finally {
      jest.dontMock('../src/db');
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });

  test('buildDiscoveryProfile treats recent queries as user behavior signals', () => {
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      limit: 12,
      context: {
        auth_state: 'authenticated',
        recent_views: [],
        recent_queries: ['niacinamide serum', 'vitamin c serum'],
      },
    });

    const profile = buildDiscoveryProfile(request.context);
    const recallPlan = _internals.buildDiscoveryRecallPlan(request, profile, 12);

    expect(profile.historyItemsUsed).toBe(0);
    expect(profile.queryHistoryItemsUsed).toBe(2);
    expect(profile.hasInterestSignals).toBe(true);
    expect(profile.personalizationSource).toBe('account_history');
    expect(profile.dominantDomain).toBe('beauty');
    expect(profile.preferredBeautyBucket).toBe('skincare');
    expect(recallPlan[0]?.query).toMatch(/niacinamide|vitamin c|serum/i);
  });

  test('beauty personalized query builder uses anchor descriptors instead of generic beauty umbrella queries', () => {
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'home_hot_deals',
      context: {
        auth_state: 'authenticated',
        locale: 'en-US',
        recent_views: [
          {
            merchant_id: 'm1',
            product_id: 'view_1',
            title: 'Winona Soothing Repair Serum',
            brand: 'Winona',
            category: 'Skincare',
            product_type: 'Serum',
            viewed_at: '2026-04-05T10:00:00Z',
          },
        ],
        recent_queries: ['Serum'],
      },
    });
    const profile = buildDiscoveryProfile(request.context);

    const beautyQueries = _internals.buildBeautyPersonalizedQueries(request, profile);

    expect(beautyQueries.primary).toContain('serum');
    expect(beautyQueries.primary).toMatch(/repair|soothing|winona/i);
    expect(beautyQueries.providerQueries).not.toContain('beauty skincare');
    expect(_internals.buildDiscoveryInterestQuery(request, profile)).toBe(beautyQueries.primary);
    expect(_internals.buildDiscoveryExpansionQuery(request, profile)).toBe(beautyQueries.expansion);
    expect(_internals.buildDiscoverySeededBrowseQuery(request, profile)).toBe(beautyQueries.browse);
  });

  test('database discovery terms drop generic-only cold-start umbrella phrases when specific variants exist', () => {
    const terms = _internals.buildDiscoveryDatabaseSearchTerms([
      'beauty skincare serum',
      'niacinamide serum',
      'vitamin c serum',
      'barrier moisturizer',
    ]);

    expect(terms.phrases).toEqual(['niacinamide serum', 'vitamin c serum', 'barrier moisturizer']);
    expect(terms.tokens).toEqual(expect.arrayContaining(['niacinamide', 'vitamin', 'barrier']));
    expect(terms.tokens).not.toEqual(expect.arrayContaining(['beauty', 'skincare', 'serum']));
  });

  test('buildDiscoveryProfile infers skincare beauty bucket from serum history', () => {
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'home_hot_deals',
      context: {
        auth_state: 'authenticated',
        recent_views: [
          {
            merchant_id: 'm1',
            product_id: 'p1',
            title: 'Barrier Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
            viewed_at: '2026-04-04T10:00:00Z',
          },
        ],
        recent_queries: ['niacinamide serum', 'serum for oily skin'],
      },
    });

    const profile = buildDiscoveryProfile(request.context);

    expect(profile.dominantDomain).toBe('beauty');
    expect(profile.preferredBeautyBucket).toBe('skincare');
    expect(profile.preferredBeautyBucketScore).toBeGreaterThan(0);
  });

  test('buildDiscoveryProfile treats query-only authenticated context as personalized interest', () => {
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'home_hot_deals',
      context: {
        auth_state: 'authenticated',
        recent_views: [],
        recent_queries: ['niacinamide serum'],
      },
    });

    const profile = buildDiscoveryProfile(request.context);

    expect(profile.hasInterestSignals).toBe(true);
    expect(profile.personalizationSource).toBe('account_history');
    expect(profile.queryItemsUsed).toBe(1);
    expect(profile.dominantDomain).toBe('beauty');
  });

  test('discovery step timeout clamps to remaining recall budget', () => {
    expect(_internals.computeDiscoveryStepTimeoutMs(1800, 6500)).toBe(1650);
    expect(_internals.computeDiscoveryStepTimeoutMs(900, 1200)).toBe(750);
    expect(_internals.computeDiscoveryStepTimeoutMs(120, 6500)).toBe(0);
  });

  test('discovery database probe reports schema_missing when required tables are absent', async () => {
    process.env.DATABASE_URL = 'postgres://catalog.test/discovery';

    const queryFn = async (sql) => {
      if (/information_schema\.columns/i.test(sql)) {
        return { rows: [] };
      }
      if (/pg_indexes/i.test(sql)) {
        return { rows: [] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    };

    const snapshot = await _internals.probeDiscoveryDatabaseDependencies({
      force: true,
      queryFn,
    });
    const health = await _internals.getDiscoveryHealthSnapshot({
      force: true,
      queryFn,
    });

    expect(snapshot.code).toBe('schema_missing');
    expect(snapshot.internal_catalog).toEqual(
      expect.objectContaining({
        ready: false,
        code: 'schema_missing',
        missing_tables: ['products_cache'],
      }),
    );
    expect(snapshot.external_seeds).toEqual(
      expect.objectContaining({
        ready: false,
        code: 'schema_missing',
        missing_tables: ['external_product_seeds'],
      }),
    );
    expect(health.db_backed_providers_ready).toBe(false);
    expect(health.discovery_ready).toBe(false);
  });

  test('buildDiscoveryRecallPlan keeps a home fill step and seeds browse recall for skincare history', () => {
    const homeRequest = _internals.normalizeDiscoveryRequest({
      surface: 'home_hot_deals',
      page: 1,
      limit: 6,
      context: {
        auth_state: 'authenticated',
        recent_views: [
          {
            merchant_id: 'm1',
            product_id: 'p1',
            title: 'Barrier Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
            viewed_at: '2026-04-04T10:00:00Z',
          },
        ],
        recent_queries: ['niacinamide serum'],
      },
    });
    const profile = buildDiscoveryProfile(homeRequest.context);

    const homePlan = _internals.buildDiscoveryRecallPlan(homeRequest, profile, 60);
    const browsePlan = _internals.buildDiscoveryRecallPlan(
      _internals.normalizeDiscoveryRequest({
        ...homeRequest,
        surface: 'browse_products',
      }),
      profile,
      30,
    );

    expect(homePlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'interest_pool' }),
        expect.objectContaining({ label: 'expansion_pool' }),
      ]),
    );
    expect(String(homePlan[1].query || '').trim()).not.toBe('');
    expect(String(browsePlan[0].query || '').trim()).not.toBe('');
    expect(browsePlan[0].query).toMatch(/skincare|serum/i);
  });

  test('buildDiscoveryRecallPlan skips cold-start home fill for no-signal discovery', () => {
    const homeRequest = _internals.normalizeDiscoveryRequest({
      surface: 'home_hot_deals',
      page: 1,
      limit: 10,
      context: {
        auth_state: 'authenticated',
        recent_views: [],
        recent_queries: [],
      },
    });
    const profile = buildDiscoveryProfile(homeRequest.context);

    const homePlan = _internals.buildDiscoveryRecallPlan(homeRequest, profile, 48);

    expect(homePlan).toHaveLength(1);
    expect(homePlan[0]).toEqual(
      expect.objectContaining({
        label: 'cold_start_curated',
        allow_early_exit: true,
      }),
    );
    expect(homePlan.map((step) => step.label)).not.toContain('cold_start_fill');
  });

  test('brand-scoped browse recall switches to brand_pool queries', () => {
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      page: 1,
      limit: 12,
      sort: 'popular',
      scope: {
        brand_names: ['Tom Ford Beauty'],
      },
      query: {
        text: 'lip',
      },
      context: {
        recent_queries: ['lip color'],
      },
    });

    const profile = buildDiscoveryProfile(request.context);
    const plan = _internals.buildDiscoveryRecallPlan(request, profile, 48);

    expect(plan[0]).toEqual(
      expect.objectContaining({
        label: 'brand_pool',
        query: expect.stringMatching(/Tom Ford Beauty/i),
      }),
    );
    expect(plan[0].query).toMatch(/lip/i);
  });

  test('brand scope matches truncated brand fields and title-derived brand entities', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        debug: true,
        scope: {
          brand_names: ['Tom Ford Beauty'],
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'rose_prick',
            title: 'Rose Prick Eau de Parfum',
            brand: 'Tom Ford Bea',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 410,
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'electric_cherry',
            title: 'Tom Ford Beauty Electric Cherry Eau de Parfum',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 395,
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'gypsy_water',
            title: 'Gypsy Water',
            brand: 'Byredo',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 320,
          }),
        ],
      },
    );

    expect(response.products.map((product) => product.product_id)).toEqual([
      'rose_prick',
      'electric_cherry',
    ]);
    expect(response.metadata.brand_scope_applied).toEqual(['Tom Ford Beauty']);
  });

  test('brand-scoped discovery supplements existing brand pool with direct brand recall before recommendations', async () => {
    let recommendCalls = 0;
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        debug: true,
        scope: {
          brand_names: ['Tom Ford Beauty'],
        },
        source_product_ref: {
          product_id: 'ext_seed_1',
          merchant_id: 'external_seed',
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'rose_prick',
            title: 'Rose Prick Eau de Parfum',
            brand: 'Tom Ford Beauty',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 410,
          }),
          makeProduct({
            merchant_id: 'm9',
            product_id: 'other_brand',
            title: 'Hydrating Serum',
            brand: 'Acme',
            category: 'Skincare',
            product_type: 'Serum',
          }),
        ],
        brandFallbackFetchInternalCandidatesFn: async () => [
          makeProduct({
            merchant_id: 'm2',
            product_id: 'electric_cherry',
            title: 'Electric Cherry Eau de Parfum',
            brand: 'Tom Ford',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 395,
          }),
        ],
        brandFallbackFetchExternalCandidatesFn: async () => [
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'lost_cherry',
            title: 'Lost Cherry Eau de Parfum',
            brand: 'Tom Ford Beauty',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 550,
          }),
        ],
        brandFallbackRecommendFn: async () => {
          recommendCalls += 1;
          return { items: [] };
        },
      },
    );

    expect(response.products.map((product) => product.product_id)).toEqual([
      'rose_prick',
      'electric_cherry',
      'lost_cherry',
    ]);
    expect(response.metadata.candidate_source).toBe('override+brand_direct');
    expect(recommendCalls).toBe(0);
  });

  test('brand-scoped browse prefers direct brand pool over generic internal and external expansion', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'bridge-key';
    process.env.DISCOVERY_BRAND_DIRECT_PREFETCH_DELAY_MS = '0';

    const internalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'internal_1',
        product_id: 'internal_fenty_1',
        title: 'Internal Fenty Candidate',
        brand: 'Fenty Beauty',
        category: 'Makeup',
        product_type: 'Lip Gloss',
      }),
    ]);
    const externalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'external_fenty_1',
        title: 'External Fenty Candidate',
        brand: 'Fenty Beauty',
        category: 'Makeup',
        product_type: 'Lip Gloss',
      }),
    ]);
    const brandDirectInternalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'brand_direct_internal',
        product_id: 'brand_direct_internal_1',
        title: 'Brand Direct Internal Candidate',
        brand: 'Fenty Beauty',
        category: 'Makeup',
        product_type: 'Lip Gloss',
        price: 29,
      }),
    ]);
    const brandDirectExternalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'brand_direct_external',
        product_id: 'brand_direct_external_1',
        title: 'Brand Direct External Candidate',
        brand: 'Fenty Beauty',
        category: 'Concealer',
        product_type: 'Concealer',
        price: 30,
      }),
    ]);

    nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        products: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'fenty_gloss_1',
            title: 'Fenty Gloss Bomb 1',
            brand: 'Fenty Beauty',
            category: 'Makeup',
            product_type: 'Lip Gloss',
            price: 22,
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'fenty_gloss_2',
            title: 'Fenty Gloss Bomb 2',
            brand: 'Fenty Beauty',
            category: 'Makeup',
            product_type: 'Lip Gloss',
            price: 24,
          }),
        ],
      });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        debug: true,
        scope: {
          brand_names: ['Fenty Beauty'],
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
        brandFallbackFetchInternalCandidatesFn: brandDirectInternalSpy,
        brandFallbackFetchExternalCandidatesFn: brandDirectExternalSpy,
      },
    );

    expect(internalSpy).not.toHaveBeenCalled();
    expect(externalSpy).not.toHaveBeenCalled();
    expect(brandDirectInternalSpy).toHaveBeenCalledTimes(1);
    expect(brandDirectExternalSpy).toHaveBeenCalledTimes(1);
    expect(response.products).toHaveLength(4);
    expect(response.products.map((product) => product.product_id)).toEqual(
      expect.arrayContaining([
        'brand_direct_external_1',
        'brand_direct_internal_1',
        'fenty_gloss_2',
        'fenty_gloss_1',
      ]),
    );
    expect(response.metadata.candidate_source).toBe('multi_provider+brand_direct');
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'products_search', successful: true, returned: 2 }),
        expect.objectContaining({
          provider: 'internal_catalog',
          attempted: true,
          successful: false,
          returned: 0,
          skipped: true,
        }),
        expect.objectContaining({
          provider: 'external_seeds',
          attempted: true,
          successful: false,
          returned: 0,
          skipped: true,
        }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'brand_direct_pool_supersedes_brand_expansion',
        }),
        expect.objectContaining({
          provider: 'external_seeds',
          skipped: true,
          skip_reason: 'brand_direct_pool_supersedes_brand_expansion',
        }),
        expect.objectContaining({
          provider: null,
          label: 'brand_direct_pool',
          returned: 2,
        }),
      ]),
    );
  });

  test('brand-scoped browse from source product uses direct brand pool as the primary path', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'bridge-key';

    const axiosGetSpy = jest.spyOn(axios, 'get').mockImplementation(async () => {
      throw new Error('products_search should not be called for brand-direct primary');
    });
    const recommendSpy = jest.fn(async () => ({ items: [] }));

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        debug: true,
        scope: {
          brand_names: ['KraveBeauty'],
        },
        source_product_ref: {
          product_id: 'ext_670fd3f47ecd319d143f8c65',
          merchant_id: 'external_seed',
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        brandFallbackFetchInternalCandidatesFn: async () => [
          makeProduct({
            merchant_id: 'products_cache',
            product_id: 'krave_internal_1',
            title: 'Oat So Simple Water Cream',
            brand: 'KraveBeauty',
            category: 'Skincare',
            product_type: 'Moisturizer',
          }),
        ],
        brandFallbackFetchExternalCandidatesFn: async () => [
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'krave_external_1',
            title: 'Matcha Hemp Hydrating Cleanser',
            brand: 'KraveBeauty',
            category: 'Skincare',
            product_type: 'Cleanser',
          }),
        ],
        brandFallbackRecommendFn: recommendSpy,
      },
    );

    expect(axiosGetSpy).not.toHaveBeenCalled();
    expect(recommendSpy).not.toHaveBeenCalled();
    expect(response.products.map((product) => product.product_id)).toEqual(
      expect.arrayContaining(['krave_external_1', 'krave_internal_1']),
    );
    expect(response.metadata.candidate_source).toBe('brand_direct_primary');
    expect(response.metadata.primary_path_used).toBe('brand_direct_pool');
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          attempted: true,
          successful: false,
          returned: 0,
          skipped: true,
          skip_reason: 'brand_direct_pool_primary_used',
        }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: null,
          label: 'brand_direct_pool',
          returned: 2,
        }),
        expect.objectContaining({
          provider: 'products_search',
          label: 'brand_pool',
          skipped: true,
          skip_reason: 'brand_direct_pool_primary_used',
        }),
      ]),
    );
  });

  test('brand-scoped browse with a brand-only query uses direct brand pool as the primary path', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;

    const axiosGetSpy = jest.spyOn(axios, 'get').mockImplementation(async () => {
      throw new Error('products_search should not be called for brand-only direct primary');
    });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        debug: true,
        scope: {
          brand_names: ['Tom Ford'],
        },
        query: {
          text: 'tom ford',
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        brandFallbackFetchInternalCandidatesFn: async () => [],
        brandFallbackFetchExternalCandidatesFn: async () => [
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'tom_ford_lost_cherry',
            title: 'Lost Cherry Eau de Parfum',
            brand: 'Tom Ford Beauty',
            category: 'Fragrance',
            product_type: 'Perfume',
          }),
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'tom_ford_brow_pencil',
            title: 'Architecture Brow Pencil',
            brand: 'Tom Ford Beauty',
            category: 'Brow',
            product_type: 'Brow Pencil',
          }),
        ],
      },
    );

    expect(axiosGetSpy).not.toHaveBeenCalled();
    expect(response.products.map((product) => product.product_id)).toEqual(
      expect.arrayContaining(['tom_ford_lost_cherry', 'tom_ford_brow_pencil']),
    );
    expect(response.metadata.candidate_source).toBe('brand_direct_primary');
    expect(response.metadata.primary_path_used).toBe('brand_direct_pool');
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          skipped: true,
          skip_reason: 'brand_direct_pool_primary_used',
        }),
      ]),
    );
  });

  test('brand-scoped external seed recall matches normalized hyphenated brand names', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevMarket = process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET;
    process.env.DATABASE_URL = 'postgres://brand-hyphen-test';
    process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET = 'US';

    const dbQueryMock = jest.fn(async (sql, params) => {
      const text = String(sql || '');
      if (text.includes('FROM external_product_seeds')) {
        if (text.includes('EXISTS')) return { rows: [] };
        expect(text).toContain('regexp_replace');
        expect(params[2]).toEqual(expect.arrayContaining(['la roche posay']));
        expect(params[5]).toEqual(expect.arrayContaining(['larocheposay']));
        return {
          rows: [
            {
              id: 'eps_lrp_anthelios',
              external_product_id: 'ext_lrp_anthelios',
              destination_url: 'https://www.laroche-posay.us/anthelios-aox',
              canonical_url: 'https://www.laroche-posay.us/anthelios-aox',
              domain: 'laroche-posay.us',
              title: 'Anthelios AOX Daily Antioxidant Face Serum SPF 50',
              image_url: 'https://cdn.example.com/lrp.jpg',
              price_amount: 44.99,
              price_currency: 'USD',
              availability: 'in_stock',
              updated_at: '2026-04-15T10:00:00Z',
              created_at: '2026-04-15T09:00:00Z',
              seed_recall: {
                retrieval_title: 'Anthelios AOX Daily Antioxidant Face Serum SPF 50',
                retrieval_summary: 'Daily antioxidant face serum sunscreen.',
                brand: 'La Roche-Posay',
                category: 'Sunscreen',
                vertical: 'skincare',
              },
              seed_brand: 'la roche-posay',
              seed_category: 'sunscreen',
            },
          ],
        };
      }
      return { rows: [] };
    });

    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const fresh = require('../src/services/discoveryFeed');
      const products = await fresh._internals.fetchBrandScopedExternalSeedCandidates({
        brandAliases: ['la roche posay'],
        limit: 24,
        orderByRecency: false,
      });
      expect(products).toHaveLength(1);
      expect(products[0]).toEqual(
        expect.objectContaining({
          merchant_id: 'external_seed',
          product_id: 'ext_lrp_anthelios',
          title: 'Anthelios AOX Daily Antioxidant Face Serum SPF 50',
          brand: 'La Roche-Posay',
        }),
      );
    } finally {
      jest.dontMock('../src/db');
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevMarket === undefined) delete process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET;
      else process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET = prevMarket;
    }
  });

  test('brand-scoped browse keeps total stable across page-size budgets', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'bridge-key';

    const searchProducts = Array.from({ length: 48 }, (_, index) =>
      makeProduct({
        merchant_id: 'products_search',
        product_id: `fenty_search_${index + 1}`,
        title: `Fenty Search Product ${index + 1}`,
        brand: 'Fenty Beauty',
        category: index % 2 === 0 ? 'Moisturizer' : 'Concealer',
        product_type: index % 2 === 0 ? 'Moisturizer' : 'Concealer',
        price: 20 + (index % 40),
      }),
    );
    const brandDirectProducts = Array.from({ length: 144 }, (_, index) =>
      makeProduct({
        merchant_id: 'external_seed',
        product_id: `fenty_direct_${index + 1}`,
        title: `Fenty Direct Product ${index + 1}`,
        brand: 'Fenty Beauty',
        category: index % 3 === 0 ? 'Foundation' : 'Lipstick',
        product_type: index % 3 === 0 ? 'Foundation' : 'Lipstick',
        price: 18 + (index % 50),
      }),
    );

    nock('http://discovery-catalog.test')
      .persist()
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, (uri) => {
        const params = new URLSearchParams(String(uri).split('?')[1] || '');
        const offset = Number.parseInt(params.get('offset') || '0', 10);
        const limit = Number.parseInt(params.get('limit') || '24', 10);
        return {
          products: searchProducts.slice(offset, offset + limit),
        };
      });

    const fetchFeed = (limit) =>
      getDiscoveryFeed(
        {
          surface: 'browse_products',
          page: 1,
          limit,
          sort: 'popular',
          debug: true,
          scope: {
            brand_names: ['Fenty Beauty'],
          },
          context: {
            locale: 'en-US',
          },
        },
        {
          providerOverrides: {
            internal_catalog: jest.fn(async () => []),
            external_seeds: jest.fn(async () => []),
          },
          brandFallbackFetchInternalCandidatesFn: jest.fn(async () => []),
          brandFallbackFetchExternalCandidatesFn: jest.fn(async ({ limit: requestedLimit }) =>
            brandDirectProducts.slice(0, requestedLimit),
          ),
        },
      );

    const compactPage = await fetchFeed(12);
    _internals.resetBrowsePoolCache();
    const standardPage = await fetchFeed(24);

    expect(compactPage.total).toBe(standardPage.total);
    expect(compactPage.total).toBe(48);
    expect(compactPage.page_size).toBe(12);
    expect(standardPage.page_size).toBe(24);
    expect(compactPage.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          label: 'brand_pool',
          returned: 48,
        }),
      ]),
    );
    expect(compactPage.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'internal_catalog', skipped: true }),
        expect.objectContaining({ provider: 'external_seeds', skipped: true }),
      ]),
    );
  });

  test('brand-scoped discovery dedupes repeated external seed products by canonical identity', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        scope: {
          brand_names: ['Tom Ford Beauty'],
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'soleil_1',
            title: 'Soleil Summer Lip Balm',
            brand: 'Tom Ford Beauty',
            category: 'Makeup',
            product_type: 'Lip Balm',
            canonical_url: 'https://www.tomfordbeauty.com/products/soleil-summer-lip-balm?variant=1',
          }),
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'soleil_2',
            title: 'Soleil Summer Lip Balm',
            brand: 'Tom Ford',
            category: 'Makeup',
            product_type: 'Lip Balm',
            canonical_url: 'https://www.tomfordbeauty.com/products/soleil-summer-lip-balm?variant=2',
          }),
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'soleil_3',
            title: 'Soleil Summer Lip Balm',
            brand: 'Tom Ford Beauty',
            category: 'Makeup',
            product_type: 'Lip Balm',
            destination_url: 'https://www.tomfordbeauty.com/products/soleil-summer-lip-balm',
          }),
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'rose_prick',
            title: 'Rose Prick Eau de Parfum',
            brand: 'Tom Ford Beauty',
            category: 'Fragrance',
            product_type: 'Perfume',
          }),
        ],
      },
    );

    expect(response.products.map((product) => product.product_id)).toEqual([
      'soleil_1',
      'rose_prick',
    ]);
  });

  test('brand-scoped discovery collapses approved identity graph exact-item duplicates across internal and external listings', async () => {
    const identityResolver = jest.fn(async ({ sourceListingRefs }) => {
      expect(sourceListingRefs).toEqual(
        expect.arrayContaining([
          'merch_krave:gbr_internal',
          'external_seed:gbr_external',
        ]),
      );
      return [
        {
          source_listing_ref: 'merch_krave:gbr_internal',
          merchant_id: 'merch_krave',
          product_id: 'gbr_internal',
          source_kind: 'internal_product',
          source_tier: 'merchant',
          sellable_item_group_id: 'sig_krave_gbr_45ml',
          product_line_id: 'pl_krave_gbr',
          review_family_id: 'rf_krave_gbr',
          identity_confidence: 0.86,
          match_basis: ['brand:kravebeauty', 'title_core:great barrier relief', 'axis:volume:45ml'],
        },
        {
          source_listing_ref: 'external_seed:gbr_external',
          merchant_id: 'external_seed',
          product_id: 'gbr_external',
          source_kind: 'external_seed',
          source_tier: 'brand',
          sellable_item_group_id: 'sig_krave_gbr_45ml',
          product_line_id: 'pl_krave_gbr',
          review_family_id: 'rf_krave_gbr',
          identity_confidence: 0.94,
          match_basis: ['official_url:https://kravebeauty.com/products/great-barrier-relief', 'axis:volume:45ml'],
        },
      ];
    });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        source_product_ref: {
          merchant_id: 'external_seed',
          product_id: 'gbr_external',
        },
        scope: {
          brand_names: ['KraveBeauty'],
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'merch_krave',
            product_id: 'gbr_internal',
            title: 'KraveBeauty Great Barrier Relief',
            brand: 'KraveBeauty',
            category: 'Serum',
            product_type: 'Serum',
            price: 28,
            canonical_url: 'https://shopify-preview.test/products/gbr-preview',
          }),
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'gbr_external',
            title: 'Great Barrier Relief',
            brand: 'KraveBeauty',
            category: 'Serum',
            product_type: 'Barrier-repair serum',
            price: 28,
            canonical_url: 'https://kravebeauty.com/products/great-barrier-relief',
          }),
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'oat_cream',
            title: 'Oat So Simple Water Cream',
            brand: 'KraveBeauty',
            category: 'Moisturizer',
            product_type: 'Moisturizer',
            price: 28,
          }),
        ],
        identityGraphRowsResolverFn: identityResolver,
      },
    );

    expect(response.products.map((product) => product.product_id)).toEqual([
      'gbr_external',
      'oat_cream',
    ]);
    expect(response.products[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'gbr_external',
        sellable_item_group_id: 'sig_krave_gbr_45ml',
        product_line_id: 'pl_krave_gbr',
        review_family_id: 'rf_krave_gbr',
        canonical_scope: 'synthetic',
      }),
    );
    expect(response.products[0].group_members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ merchant_id: 'merch_krave', product_id: 'gbr_internal' }),
        expect.objectContaining({ merchant_id: 'external_seed', product_id: 'gbr_external' }),
      ]),
    );
    expect(response.metadata.identity_graph).toEqual(
      expect.objectContaining({
        applied: true,
        matched_candidates: 2,
        groups_collapsed: 1,
        duplicate_candidates_dropped: 1,
      }),
    );
    expect(response.metadata.candidate_counts.identity_graph_deduped).toBe(1);
  });

  test('brand-scoped discovery does not mix source-product recommendations into brand catalog when brand pool is empty', async () => {
    let recommendCalls = 0;
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        debug: true,
        scope: {
          brand_names: ['Tom Ford Beauty'],
        },
        source_product_ref: {
          product_id: 'ext_seed_1',
          merchant_id: 'external_seed',
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'generic_serum',
            title: 'Hydrating Serum',
            brand: 'Acme',
            category: 'Skincare',
            product_type: 'Serum',
          }),
        ],
        brandFallbackFetchInternalCandidatesFn: async () => [],
        brandFallbackFetchExternalCandidatesFn: async () => [],
        brandFallbackRecommendFn: async () => {
          recommendCalls += 1;
          return {
            items: [
              makeProduct({
                merchant_id: 'external_seed',
                product_id: 'rose_prick',
                title: 'Rose Prick Eau de Parfum',
                brand: 'Tom Ford Beauty',
                category: 'Fragrance',
                product_type: 'Perfume',
                price: 410,
              }),
              makeProduct({
                merchant_id: 'm2',
                product_id: 'electric_cherry',
                title: 'Electric Cherry Eau de Parfum',
                brand: 'Tom Ford',
                category: 'Fragrance',
                product_type: 'Perfume',
                price: 395,
              }),
            ],
          };
        },
      },
    );

    expect(response.products).toEqual([]);
    expect(response.metadata.candidate_source).toBe('override');
    expect(response.metadata.brand_empty_reason).toBe('no_matching_brand_candidates');
    expect(response.metadata.route_health.brand_empty_reason).toBe('no_matching_brand_candidates');
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'brand_catalog',
          skipped: true,
          skip_reason: 'brand_recommendation_fallback_disabled',
        }),
      ]),
    );
    expect(recommendCalls).toBe(0);
  });

  test('brand-scoped discovery returns empty brand results instead of recommendation fallback when brand pool times out', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'bridge-key';
    process.env.DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS = '50';
    const axiosGetSpy = jest
      .spyOn(axios, 'get')
      .mockRejectedValue(new Error('timeout of 50ms exceeded'));

    let recommendCalls = 0;
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        debug: true,
        scope: {
          brand_names: ['KraveBeauty'],
        },
        source_product_ref: {
          product_id: 'ext_670fd3f47ecd319d143f8c65',
          merchant_id: 'external_seed',
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        brandFallbackFetchInternalCandidatesFn: async () => [],
        brandFallbackFetchExternalCandidatesFn: async () => [],
        brandFallbackRecommendFn: async () => {
          recommendCalls += 1;
          return {
            items: [
              makeProduct({
                merchant_id: 'external_seed',
                product_id: 'krave_matcha',
                title: 'Matcha Hemp Hydrating Cleanser',
                brand: 'KraveBeauty',
                category: 'Skincare',
                product_type: 'Cleanser',
              }),
            ],
          };
        },
      },
    );

    expect(response.products).toEqual([]);
    expect(response.metadata.candidate_source).toBe('multi_provider');
    expect(response.metadata.brand_empty_reason).toBe('brand_catalog_providers_unavailable');
    expect(response.metadata.route_health.brand_empty_reason).toBe('brand_catalog_providers_unavailable');
    expect(recommendCalls).toBe(0);
    expect(axiosGetSpy).toHaveBeenCalled();
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          attempted: true,
          successful: false,
          returned: 0,
          failure_reason: 'timeout',
          zero_recall_reason: 'timeout',
        }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          label: 'brand_pool',
          returned: 0,
          error: expect.stringMatching(/timeout/i),
        }),
      ]),
    );
  });

  test('browse selection applies explicit query text filtering within a brand scope', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        scope: {
          brand_names: ['Tom Ford Beauty'],
        },
        query: {
          text: 'cherry',
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'rose_prick',
            title: 'Rose Prick Eau de Parfum',
            brand: 'Tom Ford Beauty',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 410,
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'electric_cherry',
            title: 'Electric Cherry Eau de Parfum',
            brand: 'Tom Ford',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 395,
          }),
        ],
      },
    );

    expect(response.products.map((product) => product.product_id)).toEqual(['electric_cherry']);
    expect(response.metadata.query_text).toBe('cherry');
  });

  test('brand-scoped browse exposes category facets from the full eligible pool, not only the current page slice', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 1,
        sort: 'popular',
        scope: {
          brand_names: ['Tom Ford Beauty'],
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'rose_prick',
            title: 'Rose Prick Eau de Parfum',
            brand: 'Tom Ford Beauty',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 410,
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'soleil',
            title: 'Soleil Summer Lip Balm',
            brand: 'Tom Ford Beauty',
            category: 'Makeup',
            product_type: 'Lip Balm',
            price: 62,
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'shade_illuminate',
            title: 'Shade and Illuminate Concealer',
            brand: 'Tom Ford Beauty',
            category: 'Complexion',
            product_type: 'Concealer',
            price: 95,
          }),
        ],
      },
    );

    expect(response.products).toHaveLength(1);
    expect(response.total).toBe(3);
    expect(response.metadata.facets.categories).toEqual([
      expect.objectContaining({ value: 'concealer', label: 'Concealer', count: 1 }),
      expect.objectContaining({ value: 'lip balm', label: 'Lip Balm', count: 1 }),
      expect.objectContaining({ value: 'perfume', label: 'Perfume', count: 1 }),
    ]);
  });

  test('brand-scoped browse applies category scope while keeping facet counts from the broader query pool', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        scope: {
          brand_names: ['Tom Ford Beauty'],
          categories: ['lip balm'],
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'rose_prick',
            title: 'Rose Prick Eau de Parfum',
            brand: 'Tom Ford Beauty',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 410,
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'soleil',
            title: 'Soleil Summer Lip Balm',
            brand: 'Tom Ford Beauty',
            category: 'Makeup',
            product_type: 'Lip Balm',
            price: 62,
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'brush',
            title: 'Cream Foundation Brush',
            brand: 'Tom Ford Beauty',
            category: 'Tools',
            product_type: 'Brush',
            price: 82,
          }),
        ],
      },
    );

    expect(response.products.map((product) => product.product_id)).toEqual(['soleil']);
    expect(response.total).toBe(1);
    expect(response.metadata.category_scope_applied).toEqual(['lip balm']);
    expect(response.metadata.facets.categories).toEqual([
      expect.objectContaining({ value: 'brush', count: 1 }),
      expect.objectContaining({ value: 'lip balm', count: 1 }),
      expect.objectContaining({ value: 'perfume', count: 1 }),
    ]);
  });

  test('browse_products card response detail trims heavy product payload fields', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        response_detail: 'card',
        scope: {
          brand_names: ['Tom Ford Beauty'],
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          {
            ...makeProduct({
              merchant_id: 'm1',
              product_id: 'rose_prick',
              title: 'Rose Prick Eau de Parfum',
              brand: 'Tom Ford Beauty',
              category: 'Fragrance',
              product_type: 'Perfume',
              price: 410,
            }),
            image_url: 'https://example.com/rose-prick.jpg',
            image_urls: ['https://example.com/rose-prick.jpg', 'https://example.com/rose-prick-2.jpg'],
            variants: [{ id: 'variant_1', image_urls: ['https://example.com/variant.jpg'] }],
            raw_detail: { giant_blob: true },
            review_summary: { rating: 4.9, review_count: 128 },
            tags: ['editorial: top pick'],
            attributes: { badge: 'Top Pick' },
          },
        ],
      },
    );

    expect(response.products).toHaveLength(1);
    expect(response.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'rose_prick',
        merchant_id: 'm1',
        title: 'Rose Prick Eau de Parfum',
        price: 410,
        currency: 'USD',
        image_url: 'https://example.com/rose-prick.jpg',
        brand: 'Tom Ford Beauty',
        category: 'Fragrance',
        product_type: 'Perfume',
        in_stock: true,
        review_summary: { rating: 4.9, review_count: 128 },
        tags: ['editorial: top pick'],
        attributes: { badge: 'Top Pick' },
        card_title: 'Rose Prick Eau de Parfum',
        card_subtitle: 'Perfume',
        card_badge: '4.9★ (128)',
        search_card: {
          title_candidate: 'Rose Prick Eau de Parfum',
          compact_candidate: 'Perfume',
          proof_badge_candidate: '4.9★ (128)',
        },
        shopping_card: {
          contract_version: 'pivota.shopping_card.v1',
          title: 'Rose Prick Eau de Parfum',
          subtitle: 'Perfume',
          proof_badge: '4.9★ (128)',
          market_signal_badges: [
            { badge_type: 'review_signal', badge_label: '4.9★ (128)' },
          ],
        },
        market_signal_badges: [
          { badge_type: 'review_signal', badge_label: '4.9★ (128)' },
        ],
      }),
    );
    expect(response.products[0]).not.toHaveProperty('variants');
    expect(response.products[0]).not.toHaveProperty('image_urls');
    expect(response.products[0]).not.toHaveProperty('raw_detail');
  });

  test('browse_products card response detail exposes explicit normalized shopping card fields when present', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        response_detail: 'card',
        scope: {
          brand_names: ['Nike'],
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          {
            ...makeProduct({
              merchant_id: 'm2',
              product_id: 'air_max',
              title: 'Air Max Special Edition',
              brand: 'Nike',
              category: 'Sneakers',
              product_type: 'Running shoes',
              price: 120,
            }),
            image_url: 'https://example.com/air-max.jpg',
            card_title: 'Nike Air Max Running Shoes',
            search_card: {
              compact_candidate: 'Men’s black air-cushion sneaker',
              highlight_candidate: 'Visible air cushioning',
              intro_candidate: 'Running shoe with visible air cushioning.',
            },
            market_signal_badges: [
              {
                badge_type: 'editorial_signal',
                badge_label: 'Seen in 4 editor picks',
              },
            ],
            evidence_profile: 'mixed',
          },
        ],
      },
    );

    expect(response.products).toHaveLength(1);
    expect(response.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'air_max',
        card_title: 'Nike Air Max Running Shoes',
        card_subtitle: 'Men’s black air-cushion sneaker',
        card_highlight: 'Visible air cushioning',
        card_intro: 'Running shoe with visible air cushioning.',
        search_card: {
          title_candidate: 'Nike Air Max Running Shoes',
          compact_candidate: 'Men’s black air-cushion sneaker',
          highlight_candidate: 'Visible air cushioning',
          intro_candidate: 'Running shoe with visible air cushioning.',
        },
        shopping_card: {
          contract_version: 'pivota.shopping_card.v1',
          title: 'Nike Air Max Running Shoes',
          subtitle: 'Men’s black air-cushion sneaker',
          highlight: 'Visible air cushioning',
          intro: 'Running shoe with visible air cushioning.',
          evidence_profile: 'mixed',
        },
      }),
    );
  });

  test('browse_products card response detail hydrates reviewed shopping card fields from product intel KB', async () => {
    const kbStore = require('../src/auroraBff/productIntelKbStore');
    const kbEntry = {
      kb_key: 'product:ext_13c520e764f9f7d7f23c611b',
      analysis: {
        product_intel_v1: {
          evidence_profile: 'seller_only',
          review_summary: {
            rating: 4.9,
            review_count: 128,
          },
          community_signals: {
            status: 'available',
            source_counts: {
              editorial: 4,
            },
          },
          market_signal_badges: [
            {
              badge_type: 'review_signal',
              badge_label: '4.9★ (128)',
            },
          ],
          shopping_card: {
            contract_version: 'pivota.shopping_card.v1',
            title: 'Naturium Vitamin C Super Serum Plus - Jumbo',
            subtitle: 'Vitamin C + retinol serum',
            highlight: 'Creator-noted smooth finish',
            proof_badge: '4.9★ (128)',
            intro:
              'A multi-active treatment serum that combines vitamin C, retinol, niacinamide, hyaluronic acid, and salicylic acid.',
          },
          search_card: {
            title_candidate: 'Naturium Vitamin C Super Serum Plus - Jumbo',
            compact_candidate: 'Vitamin C + retinol serum',
            highlight_candidate: 'Creator-noted smooth finish',
            proof_badge_candidate: '4.9★ (128)',
            intro_candidate:
              'A multi-active treatment serum that combines vitamin C, retinol, niacinamide, hyaluronic acid, and salicylic acid.',
          },
        },
      },
    };
    jest.spyOn(kbStore, 'getProductIntelKbEntry').mockResolvedValue(kbEntry);
    jest
      .spyOn(kbStore, 'getProductIntelKbEntries')
      .mockResolvedValue(new Map([[kbEntry.kb_key, kbEntry]]));

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        response_detail: 'card',
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'ext_13c520e764f9f7d7f23c611b',
              title: 'Vitamin C Super Serum Plus - Jumbo',
              brand: 'Naturium',
              category: 'Serum',
              product_type: 'Serum',
              price: 33,
            }),
          },
        ],
      },
    );

    expect(response.products).toHaveLength(1);
    expect(response.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'ext_13c520e764f9f7d7f23c611b',
        review_summary: {
          rating: 4.9,
          review_count: 128,
        },
        card_title: 'Naturium Vitamin C Super Serum Plus - Jumbo',
        card_subtitle: 'Vitamin C + retinol serum',
        card_highlight: 'Creator-noted smooth finish',
        card_badge: '4.9★ (128)',
        card_intro:
          'Multi-active serum with vitamin C, retinol, niacinamide, hyaluronic and salicylic acids.',
        search_card: expect.objectContaining({
          title_candidate: 'Naturium Vitamin C Super Serum Plus - Jumbo',
          compact_candidate: 'Vitamin C + retinol serum',
          highlight_candidate: 'Creator-noted smooth finish',
          proof_badge_candidate: '4.9★ (128)',
          intro_candidate:
            'Multi-active serum with vitamin C, retinol, niacinamide, hyaluronic and salicylic acids.',
        }),
        shopping_card: expect.objectContaining({
          contract_version: 'pivota.shopping_card.v1',
          title: 'Naturium Vitamin C Super Serum Plus - Jumbo',
          subtitle: 'Vitamin C + retinol serum',
          highlight: 'Creator-noted smooth finish',
          proof_badge: '4.9★ (128)',
          intro:
            'Multi-active serum with vitamin C, retinol, niacinamide, hyaluronic and salicylic acids.',
        }),
        market_signal_badges: [
          {
            badge_type: 'review_signal',
            badge_label: '4.9★ (128)',
          },
        ],
      }),
    );
  });

  test('browse_products card response detail batches product intel KB hydration when the store supports bulk reads', async () => {
    const kbStore = require('../src/auroraBff/productIntelKbStore');
    const bulkSpy = jest.spyOn(kbStore, 'getProductIntelKbEntries').mockResolvedValue(
      new Map([
        [
          'product:ext_batch_one',
          {
            kb_key: 'product:ext_batch_one',
            analysis: {
              product_intel_v1: {
                shopping_card: {
                  contract_version: 'pivota.shopping_card.v1',
                  title: 'Batch One Reviewed Title',
                  subtitle: 'Serum',
                  highlight: 'Batch hydrated highlight',
                },
              },
            },
          },
        ],
        [
          'product:ext_batch_two',
          {
            kb_key: 'product:ext_batch_two',
            analysis: {
              product_intel_v1: {
                shopping_card: {
                  contract_version: 'pivota.shopping_card.v1',
                  title: 'Batch Two Reviewed Title',
                  subtitle: 'Cream',
                  highlight: 'Batch hydrated cream highlight',
                },
              },
            },
          },
        ],
      ]),
    );
    const singleSpy = jest.spyOn(kbStore, 'getProductIntelKbEntry').mockResolvedValue(null);

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        response_detail: 'card',
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'ext_batch_one',
            title: 'Batch One',
            brand: 'Naturium',
            category: 'Serum',
            product_type: 'Serum',
            price: 31,
          }),
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'ext_batch_two',
            title: 'Batch Two',
            brand: 'Byoma',
            category: 'Cream',
            product_type: 'Cream',
            price: 29,
          }),
        ],
      },
    );

    expect(bulkSpy).toHaveBeenCalledWith(['product:ext_batch_one', 'product:ext_batch_two']);
    expect(singleSpy).not.toHaveBeenCalled();
    expect(response.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_id: 'ext_batch_one',
          card_title: 'Batch One Reviewed Title',
          card_highlight: 'Batch hydrated highlight',
        }),
        expect.objectContaining({
          product_id: 'ext_batch_two',
          card_title: 'Batch Two Reviewed Title',
          card_highlight: 'Batch hydrated cream highlight',
        }),
      ]),
    );
  });

  test('browse_products default response still hydrates reviewed card fields from product intel KB', async () => {
    const kbStore = require('../src/auroraBff/productIntelKbStore');
    const kbEntry = {
      kb_key: 'product:ext_13c520e764f9f7d7f23c611b',
      analysis: {
        product_intel_v1: {
          evidence_profile: 'seller_only',
          shopping_card: {
            contract_version: 'pivota.shopping_card.v1',
            title: 'Naturium Vitamin C Super Serum Plus - Jumbo',
            subtitle: 'Vitamin C + retinol serum',
            highlight: 'Five actives in one serum step',
            intro:
              'A multi-active treatment serum that combines vitamin C, retinol, niacinamide, hyaluronic acid, and salicylic acid.',
          },
          search_card: {
            title_candidate: 'Naturium Vitamin C Super Serum Plus - Jumbo',
            compact_candidate: 'Vitamin C + retinol serum',
            highlight_candidate: 'Five actives in one serum step',
            intro_candidate:
              'A multi-active treatment serum that combines vitamin C, retinol, niacinamide, hyaluronic acid, and salicylic acid.',
          },
        },
      },
    };
    jest.spyOn(kbStore, 'getProductIntelKbEntry').mockResolvedValue(kbEntry);
    jest
      .spyOn(kbStore, 'getProductIntelKbEntries')
      .mockResolvedValue(new Map([[kbEntry.kb_key, kbEntry]]));

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'ext_13c520e764f9f7d7f23c611b',
              title: 'Vitamin C Super Serum Plus - Jumbo',
              brand: 'Naturium',
              category: 'Serum',
              product_type: 'Serum',
              price: 33,
            }),
          },
        ],
      },
    );

    expect(response.products).toHaveLength(1);
    expect(response.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'ext_13c520e764f9f7d7f23c611b',
        title: 'Vitamin C Super Serum Plus - Jumbo',
        card_title: 'Naturium Vitamin C Super Serum Plus - Jumbo',
        card_subtitle: 'Vitamin C + retinol serum',
        card_highlight: 'Five actives in one serum step',
        card_intro:
          'Multi-active serum with vitamin C, retinol, niacinamide, hyaluronic and salicylic acids.',
        search_card: expect.objectContaining({
          compact_candidate: 'Vitamin C + retinol serum',
          highlight_candidate: 'Five actives in one serum step',
        }),
        shopping_card: expect.objectContaining({
          highlight: 'Five actives in one serum step',
        }),
      }),
    );
  });

  test('browse_products suppresses pending external highlight text from hydrated KB bundles', async () => {
    const kbStore = require('../src/auroraBff/productIntelKbStore');
    const kbEntry = {
      kb_key: 'product:ext_pending_highlight_1',
      analysis: {
        product_intel_v1: {
          evidence_profile: 'mixed',
          provenance: {
            external_highlight_review_status: 'pending',
            external_evidence_generated_at: '2026-04-11T00:00:00.000Z',
          },
          external_highlight_signals: [
            {
              signal_id: 'sig_1',
              source_type: 'verified_reviews',
              claim_type: 'card_hook',
              claim_text: 'Reviewers often mention the smooth, quick-drying finish.',
              surface_text: 'Quick-drying smooth finish',
              rating_summary: {
                rating: 4.8,
                review_count: 212,
              },
              evidence_strength: 'strong',
              independence_count: 212,
              surface_targets: ['shopping_card_highlight'],
            },
          ],
          shopping_card: {
            contract_version: 'pivota.shopping_card.v1',
            title: 'Demo Brightening Serum',
            subtitle: 'Vitamin C + retinol serum',
            highlight: 'Quick-drying smooth finish',
          },
          search_card: {
            title_candidate: 'Demo Brightening Serum',
            compact_candidate: 'Vitamin C + retinol serum',
            highlight_candidate: 'Quick-drying smooth finish',
          },
        },
      },
    };
    jest.spyOn(kbStore, 'getProductIntelKbEntry').mockResolvedValue(kbEntry);
    jest
      .spyOn(kbStore, 'getProductIntelKbEntries')
      .mockResolvedValue(new Map([[kbEntry.kb_key, kbEntry]]));

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        response_detail: 'card',
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'ext_pending_highlight_1',
              title: 'Demo Brightening Serum',
              brand: 'Demo',
              category: 'Serum',
              product_type: 'Serum',
              price: 28,
            }),
          },
        ],
      },
    );

    expect(response.products).toHaveLength(1);
    expect(response.products[0].card_subtitle).toBe('Vitamin C + retinol serum');
    expect(response.products[0].card_highlight).toBeUndefined();
    expect(response.products[0].search_card.highlight_candidate).toBeUndefined();
    expect(response.products[0].shopping_card.highlight).toBeUndefined();
  });

  test('browse_products falls back to approved external highlight when explicit card highlight duplicates subtitle', async () => {
    const kbStore = require('../src/auroraBff/productIntelKbStore');
    const kbEntry = {
      kb_key: 'product:ext_duplicate_highlight_1',
      analysis: {
        product_intel_v1: {
          evidence_profile: 'mixed',
          provenance: {
            external_highlight_review_status: 'rewrite',
            external_evidence_generated_at: '2026-04-11T00:00:00.000Z',
          },
          external_highlight_signals: [
            {
              signal_id: 'sig_verified_1',
              source_type: 'verified_reviews',
              claim_type: 'card_hook',
              claim_text: 'Reviewers often call out the quick-absorbing, makeup-friendly finish.',
              surface_text: 'Quick-absorbing under makeup',
              rating_summary: {
                rating: 4.7,
                review_count: 318,
              },
              evidence_strength: 'strong',
              independence_count: 318,
              surface_targets: ['shopping_card_highlight'],
            },
          ],
          shopping_card: {
            contract_version: 'pivota.shopping_card.v1',
            title: 'Demo Barrier Cream',
            subtitle: 'Barrier-support cream',
            highlight: 'Barrier-support cream',
          },
          search_card: {
            title_candidate: 'Demo Barrier Cream',
            compact_candidate: 'Barrier-support cream',
            highlight_candidate: 'Barrier-support cream',
          },
        },
      },
    };
    jest.spyOn(kbStore, 'getProductIntelKbEntry').mockResolvedValue(kbEntry);
    jest
      .spyOn(kbStore, 'getProductIntelKbEntries')
      .mockResolvedValue(new Map([[kbEntry.kb_key, kbEntry]]));

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        response_detail: 'card',
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'ext_duplicate_highlight_1',
              title: 'Demo Barrier Cream',
              brand: 'Demo',
              category: 'Moisturizer',
              product_type: 'Moisturizer',
              price: 32,
            }),
          },
        ],
      },
    );

    expect(response.products).toHaveLength(1);
    expect(response.products[0].card_subtitle).toBe('Barrier-support cream');
    expect(response.products[0].card_highlight).toBe('Quick-absorbing under makeup');
    expect(response.products[0].search_card.highlight_candidate).toBe(
      'Quick-absorbing under makeup',
    );
    expect(response.products[0].shopping_card.highlight).toBe(
      'Quick-absorbing under makeup',
    );
  });

  test('card response detail suppresses weak card fallbacks and overlong highlight text', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        response_detail: 'card',
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'ext_uncovered_card_gap',
              title: 'Vitamin-C Serum',
              brand: 'Pixi',
              category: 'External',
              product_type: 'External',
              price: 24,
            }),
            search_card: {
              highlight_candidate:
                'This highlight is too long to safely fit into the compact shopping card slot.',
              intro_candidate:
                'A vitamin C facial serum with antioxidant brightening focus, supported by seller-listed ferulic acid, citrus extracts, and aloe.',
            },
          },
        ],
      },
    );

    expect(response.products).toHaveLength(1);
    expect(response.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'ext_uncovered_card_gap',
        card_title: 'Vitamin-C Serum',
        card_intro: 'Vitamin C + ferulic serum for antioxidant brightening.',
        search_card: expect.objectContaining({
          title_candidate: 'Vitamin-C Serum',
          intro_candidate: 'Vitamin C + ferulic serum for antioxidant brightening.',
        }),
      }),
    );
    expect(response.products[0].card_subtitle).toBeUndefined();
    expect(response.products[0].card_highlight).toBeUndefined();
    expect(response.products[0].search_card.compact_candidate).toBeUndefined();
    expect(response.products[0].search_card.highlight_candidate).toBeUndefined();
  });

  test('card response detail suppresses generic subtitle-like compact highlights', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        response_detail: 'card',
        context: {
          locale: 'en-US',
        },
      },
      {
        candidateProducts: [
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'ext_generic_highlight_gap',
              title: 'Daily Shield Cream SPF 50',
              brand: 'Demo',
              category: 'Moisturizer',
              product_type: 'Moisturizer',
              price: 26,
            }),
            search_card: {
              compact_candidate: 'SPF moisturizer',
              highlight_candidate: 'SPF moisturizer',
              intro_candidate: 'Daily moisturizer with SPF 50 for daytime wear.',
            },
          },
        ],
      },
    );

    expect(response.products).toHaveLength(1);
    expect(response.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'ext_generic_highlight_gap',
        card_subtitle: 'SPF moisturizer',
      }),
    );
    expect(response.products[0].card_highlight).toBeUndefined();
    expect(response.products[0].search_card.highlight_candidate).toBeUndefined();
    expect(response.products[0].shopping_card.highlight).toBeUndefined();
  });

  test('brand-scoped browse skips supplemental providers once products_search already has enough primary brand candidates', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://wrong-backend.test';
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'bridge-key';

    const products = Array.from({ length: 36 }, (_, idx) =>
      makeProduct({
        merchant_id: `m${idx + 1}`,
        product_id: `fenty_${idx + 1}`,
        title: `Fenty Gloss Bomb ${idx + 1}`,
        brand: 'Fenty Beauty',
        category: 'Makeup',
        product_type: 'Lip Gloss',
        price: 22 + idx,
      }),
    );
    const internalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'internal_1',
        product_id: 'internal_fenty_1',
        title: 'Internal Fenty Candidate',
        brand: 'Fenty Beauty',
        category: 'Makeup',
        product_type: 'Lip Gloss',
      }),
    ]);
    const externalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'external_fenty_1',
        title: 'External Fenty Candidate',
        brand: 'Fenty Beauty',
        category: 'Makeup',
        product_type: 'Lip Gloss',
      }),
    ]);
    const brandDirectInternalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'brand_direct_internal',
        product_id: 'brand_direct_internal_1',
        title: 'Brand Direct Internal Candidate',
        brand: 'Fenty Beauty',
        category: 'Makeup',
        product_type: 'Lip Gloss',
      }),
    ]);
    const brandDirectExternalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'brand_direct_external',
        product_id: 'brand_direct_external_1',
        title: 'Brand Direct External Candidate',
        brand: 'Fenty Beauty',
        category: 'Makeup',
        product_type: 'Lip Gloss',
      }),
    ]);

    nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query(true)
      .delay(25)
      .reply(200, { products });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
        debug: true,
        scope: {
          brand_names: ['Fenty Beauty'],
        },
        context: {
          locale: 'en-US',
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
        brandFallbackFetchInternalCandidatesFn: brandDirectInternalSpy,
        brandFallbackFetchExternalCandidatesFn: brandDirectExternalSpy,
      },
    );

    expect(response.products).toHaveLength(12);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(externalSpy).not.toHaveBeenCalled();
    expect(brandDirectInternalSpy).not.toHaveBeenCalled();
    expect(brandDirectExternalSpy).not.toHaveBeenCalled();
    expect(response.metadata.candidate_source).toBe('multi_provider');
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'products_search', successful: true, returned: 36 }),
        expect.objectContaining({ provider: 'internal_catalog', skipped: true }),
        expect.objectContaining({ provider: 'external_seeds', skipped: true }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'internal_catalog', skipped: true, skip_reason: 'sufficient_brand_primary_candidates' }),
        expect.objectContaining({ provider: 'external_seeds', skipped: true, skip_reason: 'sufficient_brand_primary_candidates' }),
        expect.objectContaining({ provider: null, label: 'brand_direct_pool', skipped: true, skip_reason: 'sufficient_brand_primary_candidates' }),
      ]),
    );
  });

  test('home_hot_deals excludes exact recent views and caps same brand at two items', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 4,
        context: {
          auth_state: 'authenticated',
          locale: 'en-US',
          recent_views: [
            {
              merchant_id: 'm1',
              product_id: 'exact_viewed',
              title: 'Alpha Repair Serum',
              brand: 'Alpha',
              category: 'Skincare',
              product_type: 'Serum',
              viewed_at: '2026-04-04T10:00:00Z',
            },
          ],
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'exact_viewed',
            title: 'Alpha Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm1',
            product_id: 'alpha_1',
            title: 'Alpha Night Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm1',
            product_id: 'alpha_2',
            title: 'Alpha Barrier Cream',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Cream',
          }),
          makeProduct({
            merchant_id: 'm1',
            product_id: 'alpha_3',
            title: 'Alpha Daily Lotion',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Lotion',
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'beta_1',
            title: 'Beta Repair Serum',
            brand: 'Beta',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'gamma_1',
            title: 'Gamma Repair Toner',
            brand: 'Gamma',
            category: 'Skincare',
            product_type: 'Toner',
          }),
        ],
      },
    );

    const ids = response.products.map((product) => product.product_id);
    const alphaCount = response.products.filter((product) => product.brand === 'Alpha').length;

    expect(response.metadata.discovery_strategy).toBe('personalized_interest');
    expect(ids).not.toContain('exact_viewed');
    expect(alphaCount).toBeLessThanOrEqual(2);
  });

  test('brand-scoped browse keeps matching viewed items, filters other brands, and supports price sort', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 3,
        sort: 'price_desc',
        scope: {
          brand_names: ['Tom Ford Beauty'],
        },
        query: {
          text: 'fragrance',
        },
        context: {
          auth_state: 'authenticated',
          locale: 'en-US',
          recent_views: [
            {
              merchant_id: 'm1',
              product_id: 'rose_prick',
              title: 'Rose Prick Eau de Parfum',
              brand: 'Tom Ford Beauty',
              category: 'Fragrance',
              product_type: 'Perfume',
              viewed_at: '2026-04-04T10:00:00Z',
            },
          ],
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'rose_prick',
            title: 'Rose Prick Eau de Parfum',
            brand: 'Tom Ford Beauty',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 410,
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'electric_cherry',
            title: 'Electric Cherry Eau de Parfum',
            brand: 'Tom Ford',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 395,
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'lost_cherry',
            title: 'Lost Cherry Eau de Parfum',
            brand: 'Tom Ford Beauty',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 550,
          }),
          makeProduct({
            merchant_id: 'm4',
            product_id: 'other_brand',
            title: 'Other Brand Perfume',
            brand: 'Byredo',
            category: 'Fragrance',
            product_type: 'Perfume',
            price: 600,
          }),
        ],
      },
    );

    expect(response.products.map((product) => product.product_id)).toEqual([
      'lost_cherry',
      'rose_prick',
      'electric_cherry',
    ]);
    expect(response.products.every((product) => /tom ford/i.test(String(product.brand || '')))).toBe(true);
    expect(response.metadata).toEqual(
      expect.objectContaining({
        sort_applied: 'price_desc',
        brand_scope_applied: ['Tom Ford Beauty'],
        query_text: 'fragrance',
        has_more: false,
      }),
    );
  });

  test('emits rank debug, candidate metadata, and discovery metrics for discovery feed requests', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 4,
        debug: true,
        context: {
          auth_state: 'authenticated',
          locale: 'en-US',
          recent_views: [
            {
              merchant_id: 'm1',
              product_id: 'exact_viewed',
              title: 'Alpha Repair Serum',
              brand: 'Alpha',
              category: 'Skincare',
              product_type: 'Serum',
              viewed_at: '2026-04-04T10:00:00Z',
            },
          ],
          recent_queries: ['repair serum'],
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'exact_viewed',
            title: 'Alpha Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm1',
            product_id: 'alpha_1',
            title: 'Alpha Night Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm1',
            product_id: 'alpha_2',
            title: 'Alpha Barrier Cream',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Cream',
          }),
          makeProduct({
            merchant_id: 'm1',
            product_id: 'alpha_3',
            title: 'Alpha Daily Lotion',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Lotion',
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'beta_1',
            title: 'Beta Repair Serum',
            brand: 'Beta',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'gamma_1',
            title: 'Gamma Repair Toner',
            brand: 'Gamma',
            category: 'Skincare',
            product_type: 'Toner',
          }),
        ],
      },
    );

    expect(response.metadata).toEqual(
      expect.objectContaining({
        candidate_source: 'override',
        candidate_counts: expect.objectContaining({
          raw: 6,
          normalized: 6,
          scored: 6,
          eligible_pool: 5,
          returned: 4,
        }),
        request_latency_ms: expect.any(Number),
        rank_debug: expect.any(Object),
      }),
    );
    expect(response.metadata.rank_debug.profile_summary.top_brands[0]).toEqual(
      expect.objectContaining({ key: 'alpha' }),
    );

    const decisions = new Map(
      response.metadata.rank_debug.top_candidates.map((candidate) => [candidate.product_id, candidate.decision]),
    );
    expect(decisions.get('exact_viewed')).toBe('filtered_recent_view');
    expect(Array.from(decisions.values())).toContain('filtered_brand_cap');

    const snapshot = getLastDiscoverySnapshot('home_hot_deals');
    expect(snapshot).toEqual(
      expect.objectContaining({
        surface: 'home_hot_deals',
        status: 'success',
        strategy: 'personalized_interest',
        candidate_source: 'override',
      }),
    );
    expect(snapshot.candidate_counts).toEqual(
      expect.objectContaining({
        raw: 6,
        returned: 4,
      }),
    );

    const metrics = renderDiscoveryMetricsPrometheus();
    expect(metrics).toContain(
      'discovery_feed_requests_total{candidate_source="override",personalization_source="account_history",reason="none",status="success",strategy="personalized_interest",surface="home_hot_deals"} 1',
    );
    expect(metrics).toContain(
      'discovery_feed_latency_ms_count{status="success",surface="home_hot_deals"} 1',
    );
    expect(metrics).toContain(
      'discovery_feed_candidates_count{stage="returned",surface="home_hot_deals"} 1',
    );
    expect(metrics).toContain('discovery_feed_recall_requests_total 0');
  });

  test('loads discovery candidates from products/search and emits recall summary in debug mode', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.PIVOTA_API_KEY = 'test-key';

    const capturedParams = [];
    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query((params) => {
        capturedParams.push(params);
        return true;
      })
      .times(2)
      .reply(200, {
        products: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'alpha_serum',
            title: 'Alpha Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'alpha_cream',
            title: 'Alpha Barrier Cream',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Cream',
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'beta_toner',
            title: 'Beta Repair Toner',
            brand: 'Beta',
            category: 'Skincare',
            product_type: 'Toner',
          }),
        ],
      });

    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 3,
        debug: true,
        context: {
          auth_state: 'authenticated',
          locale: 'en-US',
          recent_views: [
            {
              merchant_id: 'm1',
              product_id: 'seed_alpha',
              title: 'Alpha Repair Serum',
              brand: 'Alpha',
              category: 'Skincare',
              product_type: 'Serum',
              viewed_at: '2026-04-04T10:00:00Z',
            },
          ],
          recent_queries: ['repair serum'],
        },
      },
      { candidateLimit: 120 },
    );

    expect(response.metadata).toEqual(
      expect.objectContaining({
        candidate_source: 'beauty_interest_mainline+multi_provider',
        primary_path_used: 'beauty_interest_mainline',
        fallback_triggered: true,
        provider_breakdown: expect.any(Array),
        rank_debug: expect.any(Object),
      }),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'interest_pool', status: 200, latency_ms: expect.any(Number) }),
        expect.objectContaining({ label: 'expansion_pool', status: 200, latency_ms: expect.any(Number) }),
      ]),
    );
    expect(capturedParams.some((params) => String(params.query || '').trim().length > 0)).toBe(true);
    expect(capturedParams).toHaveLength(2);
    const metrics = renderDiscoveryMetricsPrometheus();
    expect(metrics).toContain(
      'discovery_feed_recall_requests_total{cache_hit="false",status="success",step="interest_pool",surface="home_hot_deals"} 1',
    );
    expect(metrics).toContain(
      'discovery_feed_recall_requests_total{cache_hit="false",status="success",step="expansion_pool",surface="home_hot_deals"} 1',
    );
  });

  test('browse_products suppresses exact recent views on page 1 and can allow them on later pages', async () => {
    const candidateProducts = [
      makeProduct({ merchant_id: 'm1', product_id: 'browse_a', title: 'Browse A', category: 'Kitchen' }),
      makeProduct({ merchant_id: 'm1', product_id: 'browse_b', title: 'Browse B', category: 'Kitchen' }),
      makeProduct({ merchant_id: 'm1', product_id: 'recent_exact', title: 'Browse C', category: 'Kitchen' }),
      makeProduct({ merchant_id: 'm1', product_id: 'browse_d', title: 'Browse D', category: 'Kitchen' }),
    ];

    const pageOne = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 2,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [
            {
              merchant_id: 'm1',
              product_id: 'recent_exact',
              title: 'Recently viewed item',
              viewed_at: '2026-04-04T10:00:00Z',
            },
          ],
        },
      },
      { candidateProducts },
    );

    const pageTwo = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 2,
        limit: 2,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [
            {
              merchant_id: 'm1',
              product_id: 'recent_exact',
              title: 'Recently viewed item',
              viewed_at: '2026-04-04T10:00:00Z',
            },
          ],
        },
      },
      { candidateProducts },
    );

    expect(pageOne.products.map((product) => product.product_id)).not.toContain('recent_exact');
    expect(pageTwo.products.map((product) => product.product_id)).toContain('recent_exact');
  });

  test('browse_products reuses a short ttl pool cache to keep pagination stable', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.PIVOTA_API_KEY = 'test-key';

    let callCount = 0;
    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query(true)
      .times(2)
      .reply(() => {
        callCount += 1;
        return [
          200,
          {
            products: Array.from({ length: 6 }, (_, idx) =>
              makeProduct({
                merchant_id: `m${idx + 1}`,
                product_id: `browse_${idx + 1}`,
                title: `Browse ${idx + 1}`,
                category: 'Skincare',
                product_type: 'Serum',
              }),
            ),
          },
        ];
      });

    const basePayload = {
      surface: 'browse_products',
      limit: 2,
      debug: true,
      context: {
        auth_state: 'authenticated',
        locale: 'en-US',
        recent_views: [
          {
            merchant_id: 'm1',
            product_id: 'seed_alpha',
            title: 'Alpha Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
            viewed_at: '2026-04-04T10:00:00Z',
          },
        ],
        recent_queries: ['repair serum'],
      },
    };

    const pageOne = await getDiscoveryFeed(basePayload);
    const pageTwo = await getDiscoveryFeed({
      ...basePayload,
      page: 2,
    });

    expect(callCount).toBe(1);
    expect(pageOne.products).toHaveLength(2);
    expect(pageTwo.products).toHaveLength(2);
    expect(pageTwo.metadata?.rank_debug?.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'browse_pool_cache', cache_hit: true }),
      ]),
    );
  });

  test('browse_products serves warm browse cache even when discovery base URL is missing', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'test-key';

    let callCount = 0;
    nock('http://discovery-catalog.test')
      .get('/agent/v1/products/search')
      .query(true)
      .once()
      .reply(() => {
        callCount += 1;
        return [
          200,
          {
            products: Array.from({ length: 6 }, (_, idx) =>
              makeProduct({
                merchant_id: `m${idx + 1}`,
                product_id: `warm_${idx + 1}`,
                title: `Warm ${idx + 1}`,
                category: 'Skincare',
                product_type: 'Serum',
              }),
            ),
          },
        ];
      });

    const basePayload = {
      surface: 'browse_products',
      limit: 2,
      debug: true,
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    };

    const pageOne = await getDiscoveryFeed(basePayload);
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;
    const pageTwo = await getDiscoveryFeed({
      ...basePayload,
      page: 2,
    });

    expect(callCount).toBe(1);
    expect(pageOne.products).toHaveLength(2);
    expect(pageTwo.products).toHaveLength(2);
    expect(pageTwo.metadata?.rank_debug?.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'browse_pool_cache', cache_hit: true }),
      ]),
    );
    expect(pageTwo.metadata?.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          successful: true,
        }),
      ]),
    );
  });

  test('products_search exposes http_401 provider failure diagnostics', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'bad-key';
    delete process.env.DATABASE_URL;

    nock('http://discovery-catalog.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(401, { error: 'unauthorized' });

    await expect(
      getDiscoveryFeed({
        surface: 'home_hot_deals',
        limit: 6,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      }),
    ).rejects.toMatchObject({
      code: 'DISCOVERY_CATALOG_UNAVAILABLE',
      details: expect.objectContaining({
        providerBreakdown: expect.arrayContaining([
          expect.objectContaining({
            provider: 'products_search',
            successful: false,
            failure_reason: 'http_401',
          }),
        ]),
      }),
    });
  });

  test('working products_search prevents catalog_unavailable even when db-backed providers are missing', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'test-key';
    delete process.env.DATABASE_URL;

    nock('http://discovery-catalog.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        products: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'serum_1',
            title: 'Niacinamide Repair Serum',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'serum_2',
            title: 'Barrier Support Serum',
            category: 'Skincare',
            product_type: 'Serum',
          }),
        ],
      });

    const response = await getDiscoveryFeed({
      surface: 'home_hot_deals',
      limit: 2,
      debug: true,
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });

    expect(response.products).toHaveLength(2);
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          successful: true,
        }),
        expect.objectContaining({
          successful: false,
          failure_reason: 'missing_database',
        }),
      ]),
    );
  });

  test('home_hot_deals backfills with non-viewed skincare results after interest recall returns recent views', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.PIVOTA_API_KEY = 'test-key';

    const capturedParams = [];
    let searchCallIndex = 0;
    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query((params) => {
        capturedParams.push(params);
        return true;
      })
      .times(2)
      .reply(200, () => {
        const products =
          searchCallIndex === 0
            ? [
                makeProduct({
                  merchant_id: 'm1',
                  product_id: 'view_1',
                  title: 'Barrier Repair Serum',
                  brand: 'Alpha',
                  category: 'Skincare',
                  product_type: 'Serum',
                }),
                makeProduct({
                  merchant_id: 'm2',
                  product_id: 'view_2',
                  title: 'Niacinamide Serum',
                  brand: 'Beta',
                  category: 'Skincare',
                  product_type: 'Serum',
                }),
              ]
            : [
                makeProduct({
                  merchant_id: 'm3',
                  product_id: 'fresh_1',
                  title: 'Calming Recovery Serum',
                  brand: 'Gamma',
                  category: 'Skincare',
                  product_type: 'Serum',
                }),
                makeProduct({
                  merchant_id: 'm4',
                  product_id: 'fresh_2',
                  title: 'Hydrating Barrier Toner',
                  brand: 'Delta',
                  category: 'Skincare',
                  product_type: 'Toner',
                }),
                makeProduct({
                  merchant_id: 'm5',
                  product_id: 'tool_1',
                  title: 'Professional Makeup Brush',
                  brand: 'BrushLab',
                  category: 'Beauty Tools',
                  product_type: 'Brush',
                }),
              ];
        searchCallIndex += 1;
        return { products };
      });

    const response = await getDiscoveryFeed({
      surface: 'home_hot_deals',
      limit: 2,
      debug: true,
      context: {
        auth_state: 'authenticated',
        locale: 'en-US',
        recent_views: [
          {
            merchant_id: 'm1',
            product_id: 'view_1',
            title: 'Barrier Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
            viewed_at: '2026-04-04T10:00:00Z',
          },
          {
            merchant_id: 'm2',
            product_id: 'view_2',
            title: 'Niacinamide Serum',
            brand: 'Beta',
            category: 'Skincare',
            product_type: 'Serum',
            viewed_at: '2026-04-03T10:00:00Z',
          },
        ],
        recent_queries: ['niacinamide serum'],
      },
    });

    expect(capturedParams).toHaveLength(2);
    expect(response.products.map((product) => product.product_id)).toEqual(['fresh_1', 'fresh_2']);
    expect(response.metadata.candidate_counts.eligible_pool).toBeGreaterThan(0);
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'interest_pool' }),
        expect.objectContaining({ label: 'expansion_pool' }),
      ]),
    );
  });

  test('home_hot_deals generic serum history recalls descriptor-led skincare queries instead of beauty umbrella queries', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.PIVOTA_API_KEY = 'test-key';

    const capturedQueries = [];
    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query((params) => {
        capturedQueries.push(String(params.query || '').trim());
        return true;
      })
      .times(2)
      .reply(200, () => {
        const currentQuery = capturedQueries[capturedQueries.length - 1] || '';
        if (/beauty skincare/i.test(currentQuery)) {
          return {
            products: [
              makeProduct({
                merchant_id: 'm_tool_1',
                product_id: 'tool_1',
                title: 'Small Eyeshadow Brush',
                brand: 'BrushLab',
                category: 'Beauty Tools',
                product_type: 'Brush',
              }),
              makeProduct({
                merchant_id: 'm_tool_2',
                product_id: 'tool_2',
                title: 'Small Foundation Brush',
                brand: 'BrushLab',
                category: 'Beauty Tools',
                product_type: 'Brush',
              }),
            ],
          };
        }

        return {
          products: [
            makeProduct({
              merchant_id: 'm1',
              product_id: 'serum_1',
              title: 'Calming Repair Serum',
              brand: 'Alpha',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            makeProduct({
              merchant_id: 'm2',
              product_id: 'serum_2',
              title: 'Barrier Repair Serum',
              brand: 'Beta',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            makeProduct({
              merchant_id: 'm3',
              product_id: 'toner_1',
              title: 'Hydrating Recovery Toner',
              brand: 'Gamma',
              category: 'Skincare',
              product_type: 'Toner',
            }),
          ],
        };
      });

    const response = await getDiscoveryFeed({
      surface: 'home_hot_deals',
      limit: 3,
      debug: true,
      context: {
        auth_state: 'authenticated',
        locale: 'en-US',
        recent_views: [
          {
            merchant_id: 'm0',
            product_id: 'seed_1',
            title: 'Winona Soothing Repair Serum',
            brand: 'Winona',
            category: 'Skincare',
            product_type: 'Serum',
            viewed_at: '2026-04-05T10:00:00Z',
          },
        ],
        recent_queries: ['Serum'],
      },
    });

    expect(capturedQueries).toHaveLength(2);
    expect(capturedQueries.some((queryText) => /beauty skincare/i.test(queryText))).toBe(false);
    expect(capturedQueries.some((queryText) => /repair serum|winona serum|niacinamide serum|vitamin c serum/i.test(queryText))).toBe(true);
    expect(response.products.map((product) => product.product_id)).toEqual(['serum_1', 'serum_2', 'toner_1']);
  });

  test('cold start home recalls specific skincare queries before generic beauty umbrella queries', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.PIVOTA_API_KEY = 'test-key';

    const capturedQueries = [];
    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query((params) => {
        capturedQueries.push(String(params.query || '').trim());
        return true;
      })
      .times(2)
      .reply(200, () => ({
        products: [
          makeProduct({
            merchant_id: 'm1',
            product_id: `serum_${capturedQueries.length}_1`,
            title: 'Niacinamide Recovery Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: `serum_${capturedQueries.length}_2`,
            title: 'Vitamin C Brightening Serum',
            brand: 'Beta',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: `cream_${capturedQueries.length}_1`,
            title: 'Barrier Repair Cream',
            brand: 'Gamma',
            category: 'Skincare',
            product_type: 'Cream',
          }),
        ],
      }));

    const response = await getDiscoveryFeed({
      surface: 'home_hot_deals',
      limit: 4,
      debug: true,
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });

    expect(capturedQueries).toHaveLength(1);
    expect(capturedQueries.some((queryText) => /beauty skincare serum/i.test(queryText))).toBe(false);
    expect(capturedQueries).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/niacinamide serum/i),
      ]),
    );
    expect(response.products).toHaveLength(3);
  });

  test('cold start browse recalls specific skincare queries before generic beauty umbrella queries', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.PIVOTA_API_KEY = 'test-key';

    const capturedQueries = [];
    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query((params) => {
        capturedQueries.push(String(params.query || '').trim());
        return true;
      })
      .times(2)
      .reply(200, () => ({
        products: [
          makeProduct({
            merchant_id: 'm1',
            product_id: `serum_${capturedQueries.length}_1`,
            title: 'Niacinamide Recovery Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: `serum_${capturedQueries.length}_2`,
            title: 'Vitamin C Brightening Serum',
            brand: 'Beta',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: `cream_${capturedQueries.length}_1`,
            title: 'Barrier Repair Cream',
            brand: 'Gamma',
            category: 'Skincare',
            product_type: 'Cream',
          }),
        ],
      }));

    const response = await getDiscoveryFeed({
      surface: 'browse_products',
      page: 1,
      limit: 10,
      debug: true,
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });

    expect(capturedQueries).toHaveLength(2);
    expect(capturedQueries.some((queryText) => /beauty skincare serum/i.test(queryText))).toBe(false);
    expect(capturedQueries).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/niacinamide serum/i),
        expect.stringMatching(/vitamin c serum|barrier moisturizer|gentle cleanser sunscreen/i),
      ]),
    );
    expect(response.products).toHaveLength(3);
  });

  test('home_hot_deals still runs browse fill when a large interest pool is mostly filtered out', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.PIVOTA_API_KEY = 'test-key';

    const capturedParams = [];
    let searchCallIndex = 0;
    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query((params) => {
        capturedParams.push(params);
        return true;
      })
      .times(2)
      .reply(200, () => {
        const products =
          searchCallIndex === 0
            ? [
                makeProduct({
                  merchant_id: 'm1',
                  product_id: 'view_1',
                  title: 'Barrier Repair Serum',
                  brand: 'Alpha',
                  category: 'Skincare',
                  product_type: 'Serum',
                }),
                ...Array.from({ length: 23 }, (_, idx) =>
                  makeProduct({
                    merchant_id: `pet_${idx + 1}`,
                    product_id: `pet_${idx + 1}`,
                    title: `Warm Pet Outfit ${idx + 1}`,
                    brand: `Paws ${idx + 1}`,
                    category: 'Pet',
                    product_type: 'Apparel',
                  }),
                ),
              ]
            : [
                makeProduct({
                  merchant_id: 'm3',
                  product_id: 'fresh_1',
                  title: 'Vitamin C Repair Serum',
                  brand: 'Gamma',
                  category: 'Skincare',
                  product_type: 'Serum',
                }),
                makeProduct({
                  merchant_id: 'm4',
                  product_id: 'fresh_2',
                  title: 'Barrier Recovery Cream',
                  brand: 'Delta',
                  category: 'Skincare',
                  product_type: 'Cream',
                }),
                makeProduct({
                  merchant_id: 'm5',
                  product_id: 'fresh_3',
                  title: 'Hydrating Toner',
                  brand: 'Epsilon',
                  category: 'Skincare',
                  product_type: 'Toner',
                }),
              ];
        searchCallIndex += 1;
        return { products };
      });

    const response = await getDiscoveryFeed({
      surface: 'home_hot_deals',
      limit: 3,
      debug: true,
      context: {
        auth_state: 'authenticated',
        locale: 'en-US',
        recent_views: [
          {
            merchant_id: 'm1',
            product_id: 'view_1',
            title: 'Barrier Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
            viewed_at: '2026-04-04T10:00:00Z',
          },
        ],
        recent_queries: ['vitamin c serum'],
      },
    });

    expect(capturedParams).toHaveLength(2);
    expect(response.products.map((product) => product.product_id)).toEqual([
      'fresh_1',
      'fresh_2',
      'fresh_3',
    ]);
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'interest_pool' }),
        expect.objectContaining({ label: 'expansion_pool' }),
      ]),
    );
  });

  test('beauty-dominant discovery includes brand context when recent queries are generic', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.PIVOTA_API_KEY = 'test-key';

    const capturedParams = [];
    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query((params) => {
        capturedParams.push(params);
        return true;
      })
      .times(2)
      .reply(200, {
        products: [
          makeProduct({
            merchant_id: 'm2',
            product_id: 'fresh_1',
            title: 'Alpha Brightening Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'fresh_2',
            title: 'Alpha Barrier Cream',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Cream',
          }),
        ],
      });

    await getDiscoveryFeed({
      surface: 'home_hot_deals',
      limit: 2,
      debug: true,
      context: {
        auth_state: 'authenticated',
        locale: 'en-US',
        recent_views: [
          {
            merchant_id: 'm1',
            product_id: 'seed_alpha',
            title: 'Alpha Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
            viewed_at: '2026-04-04T10:00:00Z',
          },
        ],
        recent_queries: ['serum'],
      },
    });

    expect(capturedParams).toHaveLength(2);
    expect(String(capturedParams[0]?.query || '').toLowerCase()).toContain('repair');
    expect(String(capturedParams[0]?.query || '').toLowerCase()).toContain('serum');
    expect(String(capturedParams[1]?.query || '').toLowerCase()).not.toContain('beauty skincare');
  });

  test('dominant beauty discovery filters pet and sleepwear candidates from top results', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 4,
        debug: true,
        context: {
          auth_state: 'authenticated',
          locale: 'en-US',
          recent_views: [
            {
              merchant_id: 'm1',
              product_id: 'beauty_seed',
              title: 'Alpha Repair Serum',
              brand: 'Alpha',
              category: 'Skincare',
              product_type: 'Serum',
              viewed_at: '2026-04-04T10:00:00Z',
            },
          ],
          recent_queries: ['vitamin c serum'],
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'beauty_1',
            title: 'Vitamin C Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'beauty_2',
            title: 'Barrier Repair Cream',
            brand: 'Beta',
            category: 'Skincare',
            product_type: 'Cream',
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'pet_1',
            title: 'Reflective Dog Leash',
            brand: 'Paws',
            category: 'Pet',
            product_type: 'Leash',
          }),
          makeProduct({
            merchant_id: 'm4',
            product_id: 'sleepwear_1',
            title: 'Satin Sleepwear Set',
            brand: 'Cloud',
            category: 'Sleepwear',
            product_type: 'Pajama',
          }),
        ],
      },
    );

    const ids = response.products.map((product) => product.product_id);
    expect(ids).toEqual(expect.arrayContaining(['beauty_1', 'beauty_2']));
    expect(ids).not.toContain('pet_1');
    expect(ids).not.toContain('sleepwear_1');
    expect(response.metadata.rank_debug?.profile_summary).toEqual(
      expect.objectContaining({
        dominant_domain: 'beauty',
      }),
    );
  });

  test('browse_products suppresses beauty tools when skincare candidates exist for skincare-heavy users', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 3,
        debug: true,
        context: {
          auth_state: 'authenticated',
          locale: 'en-US',
          recent_views: [
            {
              merchant_id: 'm1',
              product_id: 'beauty_seed',
              title: 'Alpha Repair Serum',
              brand: 'Alpha',
              category: 'Skincare',
              product_type: 'Serum',
              viewed_at: '2026-04-04T10:00:00Z',
            },
          ],
          recent_queries: ['niacinamide serum'],
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'serum_1',
            title: 'Niacinamide Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'toner_1',
            title: 'Hydrating Toner',
            brand: 'Beta',
            category: 'Skincare',
            product_type: 'Toner',
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'cream_1',
            title: 'Barrier Recovery Cream',
            brand: 'Gamma',
            category: 'Skincare',
            product_type: 'Cream',
          }),
          makeProduct({
            merchant_id: 'm4',
            product_id: 'tool_1',
            title: 'Precision Makeup Brush Set',
            brand: 'BrushLab',
            category: 'Beauty Tools',
            product_type: 'Brush',
          }),
          makeProduct({
            merchant_id: 'm5',
            product_id: 'pet_1',
            title: 'Dog Rain Jacket',
            brand: 'Paws',
            category: 'Pet',
            product_type: 'Apparel',
          }),
        ],
      },
    );

    const ids = response.products.map((product) => product.product_id);
    expect(ids).toEqual(expect.arrayContaining(['serum_1', 'toner_1', 'cream_1']));
    expect(ids).not.toContain('tool_1');
    expect(ids).not.toContain('pet_1');
    const topCandidates = response.metadata.rank_debug.top_candidates;
    expect(topCandidates.find((candidate) => candidate.product_id === 'tool_1')?.decision).toBe('page_window_excluded');
  });

  test('cold start returns curated metadata with no personalization source', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 3,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        candidateProducts: [
          makeProduct({ merchant_id: 'm1', product_id: 'cold_1', title: 'Cold Start One', category: 'Kitchen' }),
          makeProduct({ merchant_id: 'm1', product_id: 'cold_2', title: 'Cold Start Two', category: 'Electronics' }),
          makeProduct({ merchant_id: 'm1', product_id: 'cold_3', title: 'Cold Start Three', category: 'Beauty' }),
        ],
      },
    );

    expect(response.metadata.discovery_strategy).toBe('cold_start_curated');
    expect(response.metadata.personalization_source).toBe('none');
    expect(response.metadata.history_items_used).toBe(0);
    expect(response.products).toHaveLength(3);
  });

  test('cold start defers pet, sleepwear, apparel, lingerie, and beauty tools when enough non-deferred options exist', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 4,
        debug: true,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'pet_1',
            title: 'Dog Rain Jacket',
            category: 'Pet',
            product_type: 'Apparel',
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'sleep_1',
            title: 'Velvet Sleepwear Set',
            category: 'Sleepwear',
            product_type: 'Pajama',
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'apparel_1',
            title: 'Wool Blend Coat',
            category: 'Apparel',
            product_type: 'Outerwear',
          }),
          makeProduct({
            merchant_id: 'm3b',
            product_id: 'lingerie_1',
            title: 'Backless Lingerie Set',
            category: 'Lingerie',
            product_type: 'Bodysuit',
          }),
          makeProduct({
            merchant_id: 'm4',
            product_id: 'beauty_1',
            title: 'Barrier Repair Serum',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm5',
            product_id: 'beauty_2',
            title: 'Calming Recovery Cream',
            category: 'Skincare',
            product_type: 'Cream',
          }),
          makeProduct({
            merchant_id: 'm5b',
            product_id: 'tool_1',
            title: 'Precision Small Detail Brush',
            category: 'Beauty Tools',
            product_type: 'Brush',
          }),
          makeProduct({
            merchant_id: 'm6',
            product_id: 'unknown_1',
            title: 'Kitchen Counter Organizer',
            category: 'Kitchen',
            product_type: 'Storage',
          }),
          makeProduct({
            merchant_id: 'm7',
            product_id: 'unknown_2',
            title: 'Portable Table Lamp',
            category: 'Electronics',
            product_type: 'Lamp',
          }),
        ],
      },
    );

    expect(response.products.map((product) => product.product_id)).toEqual([
      'beauty_1',
      'beauty_2',
      'unknown_1',
      'unknown_2',
    ]);
    expect(
      response.metadata.rank_debug.top_candidates.find((candidate) => candidate.product_id === 'pet_1')?.decision,
    ).toBe('filtered_cold_start_domain');
    expect(
      response.metadata.rank_debug.top_candidates.find((candidate) => candidate.product_id === 'sleep_1')?.decision,
    ).toBe('filtered_cold_start_domain');
    expect(
      response.metadata.rank_debug.top_candidates.find((candidate) => candidate.product_id === 'lingerie_1')?.decision,
    ).toBe('filtered_cold_start_domain');
    expect(
      response.metadata.rank_debug.top_candidates.find((candidate) => candidate.product_id === 'tool_1')?.decision,
    ).toBe('filtered_cold_start_domain');
  });

  test('cold start does not backfill deferred domains once enough non-deferred home results exist', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 6,
        debug: true,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'beauty_1',
            title: 'Barrier Repair Serum',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'beauty_2',
            title: 'Calming Recovery Cream',
            category: 'Skincare',
            product_type: 'Cream',
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'pet_1',
            title: 'Dog Rain Jacket',
            category: 'Pet',
            product_type: 'Apparel',
          }),
          makeProduct({
            merchant_id: 'm4',
            product_id: 'sleep_1',
            title: 'Velvet Sleepwear Set',
            category: 'Sleepwear',
            product_type: 'Pajama',
          }),
          makeProduct({
            merchant_id: 'm5',
            product_id: 'lingerie_1',
            title: 'Backless Lingerie Set',
            category: 'Lingerie',
            product_type: 'Bodysuit',
          }),
        ],
      },
    );

    expect(response.products.map((product) => product.product_id)).toEqual(['beauty_1', 'beauty_2']);
    const decisions = new Map(
      response.metadata.rank_debug.top_candidates.map((candidate) => [candidate.product_id, candidate.decision]),
    );
    expect(decisions.get('pet_1')).toBe('not_selected_cold_start_deferred');
    expect(decisions.get('sleep_1')).toBe('not_selected_cold_start_deferred');
    expect(decisions.get('lingerie_1')).toBe('not_selected_cold_start_deferred');
  });

  test('cold start home_hot_deals prefers external seed skincare over equally generic internal catalog items', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 4,
        debug: true,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        candidateProducts: [
          {
            ...makeProduct({
              merchant_id: 'merch_internal',
              product_id: 'internal_1',
              title: 'The Ordinary Niacinamide 10% + Zinc 1%',
              brand: 'The Ordinary',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'external_1',
              title: 'Ceramide Barrier Serum',
              brand: 'cocokind',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'external_2',
              title: 'Hydrating Milky Serum',
              brand: 'PIXI BEAUTY',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'external_3',
              title: 'Glow Tonic Serum',
              brand: 'PIXI BEAUTY',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'external_4',
              title: 'Vitamin-C Creme Serum',
              brand: 'PIXI BEAUTY',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
          {
            ...makeProduct({
              merchant_id: 'merch_internal',
              product_id: 'internal_2',
              title: 'Winona Soothing Repair Serum',
              brand: 'Winona',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
        ],
      },
    );

    expect(response.products.map((product) => product.merchant_id)).toEqual([
      'external_seed',
      'external_seed',
      'external_seed',
      'external_seed',
    ]);
    expect(response.products.map((product) => product.product_id)).toEqual([
      'external_1',
      'external_2',
      'external_3',
      'external_4',
    ]);
    expect(
      response.metadata.rank_debug.top_candidates.find((candidate) => candidate.product_id === 'external_1')?.scores
        ?.cold_start_source_score,
    ).toBeGreaterThan(
      response.metadata.rank_debug.top_candidates.find((candidate) => candidate.product_id === 'internal_1')?.scores
        ?.cold_start_source_score,
    );
  });

  test('cold start home_hot_deals keeps external beauty fill ahead of internal products when same-brand seed results remain', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 8,
        debug: true,
        context: {
          auth_state: 'authenticated',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        candidateProducts: [
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'external_1',
              title: 'ceramide barrier serum',
              brand: 'cocokind',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
          ...Array.from({ length: 7 }, (_, idx) => ({
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: `external_pixi_${idx + 1}`,
              title: `PIXI Serum ${idx + 1}`,
              brand: 'PIXI BEAUTY',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          })),
          {
            ...makeProduct({
              merchant_id: 'merch_internal',
              product_id: 'internal_1',
              title: 'The Ordinary Niacinamide 10% + Zinc 1%',
              brand: 'The Ordinary',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
          {
            ...makeProduct({
              merchant_id: 'merch_internal',
              product_id: 'internal_2',
              title: 'Winona Soothing Repair Serum',
              brand: 'Winona',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
        ],
      },
    );

    expect(response.products).toHaveLength(8);
    expect(response.products.every((product) => product.merchant_id === 'external_seed')).toBe(true);
    expect(response.products.map((product) => product.product_id)).not.toEqual(
      expect.arrayContaining(['internal_1', 'internal_2']),
    );
  });

  test('cold start home_hot_deals does not backfill internal beauty when external beauty candidates exist', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 10,
        debug: true,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        candidateProducts: [
          ...Array.from({ length: 9 }, (_, idx) => ({
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: `external_home_${idx + 1}`,
              title: `External Serum ${idx + 1}`,
              brand: idx < 7 ? 'PIXI BEAUTY' : `External Brand ${idx + 1}`,
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          })),
          {
            ...makeProduct({
              merchant_id: 'merch_internal',
              product_id: 'internal_ipsa',
              title: 'IPSA Time Reset Aqua',
              brand: 'IPSA',
              category: 'Skincare',
              product_type: 'Lotion',
            }),
            __discovery_provider: 'products_search',
          },
        ],
      },
    );

    expect(response.products).toHaveLength(9);
    expect(response.products.every((product) => product.merchant_id === 'external_seed')).toBe(true);
    expect(response.products.map((product) => product.product_id)).not.toContain('internal_ipsa');
    expect(response.metadata.filter_counts.not_selected_cold_start_internal_source).toBeGreaterThanOrEqual(1);
  });

  test('cold start home_hot_deals uses external seed fastpath before internal catalog when primary underfills', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://wrong-backend.test';
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'bridge-key';

    const internalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'merch_internal',
        product_id: 'internal_1',
        title: 'Winona Repair Serum',
        brand: 'Winona',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);
    const externalSpy = jest.fn(async ({ limit }) =>
      Array.from({ length: limit }, (_, idx) =>
        makeProduct({
          merchant_id: 'external_seed',
          product_id: `external_fast_${idx + 1}`,
          title: `External Fastpath Serum ${idx + 1}`,
          brand: `Seeded ${idx + 1}`,
          category: 'Skincare',
          product_type: 'Serum',
        }),
      ),
    );

    nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        products: [
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'primary_1',
            title: 'Primary Serum 1',
            brand: 'Primary',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'primary_2',
            title: 'Primary Serum 2',
            brand: 'Primary',
            category: 'Skincare',
            product_type: 'Serum',
          }),
        ],
      });

    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 6,
        debug: true,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(response.products).toHaveLength(6);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(response.products.some((product) => product.product_id === 'internal_1')).toBe(false);
    expect(response.metadata.candidate_source).toBe('external_seed_fastpath');
    expect(response.metadata.primary_path_used).toBe('external_seed_fastpath');
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          skipped: true,
          skip_reason: 'anonymous_cold_start_fastpath_sufficient',
        }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'anonymous_cold_start_internal_disabled',
        }),
        expect.objectContaining({ provider: 'external_seeds', successful: true }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'external_seeds',
          label: 'external_seed_pool_fastpath',
          status: 200,
        }),
      ]),
    );
  });

  test('cold start browse_products defers beauty tools when non-tool beauty candidates exist across providers', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 6,
        debug: true,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        candidateProducts: [
          {
            ...makeProduct({
              merchant_id: 'merch_internal',
              product_id: 'internal_1',
              title: 'Winona Soothing Repair Serum',
              brand: 'Winona',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
          {
            ...makeProduct({
              merchant_id: 'merch_internal',
              product_id: 'internal_2',
              title: 'The Ordinary Niacinamide 10% + Zinc 1%',
              brand: 'The Ordinary',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
          {
            ...makeProduct({
              merchant_id: 'merch_internal',
              product_id: 'tool_1',
              title: 'Small Foundation Brush',
              brand: 'moyu',
              category: 'Beauty Tools',
              product_type: 'Brush',
            }),
            __discovery_provider: 'products_search',
          },
          {
            ...makeProduct({
              merchant_id: 'merch_internal',
              product_id: 'tool_2',
              title: 'Small Eyeshadow Brush',
              brand: 'moyu',
              category: 'Beauty Tools',
              product_type: 'Brush',
            }),
            __discovery_provider: 'products_search',
          },
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'external_1',
              title: 'Ceramide Barrier Serum',
              brand: 'cocokind',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'external_seeds',
          },
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'external_2',
              title: 'Hydrating Milky Serum',
              brand: 'PIXI BEAUTY',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'external_seeds',
          },
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'external_3',
              title: 'Barrier Repair Cream',
              brand: 'Beta',
              category: 'Skincare',
              product_type: 'Cream',
            }),
            __discovery_provider: 'external_seeds',
          },
          {
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: 'external_4',
              title: 'Calming Recovery Toner',
              brand: 'Gamma',
              category: 'Skincare',
              product_type: 'Toner',
            }),
            __discovery_provider: 'external_seeds',
          },
        ],
      },
    );

    const ids = response.products.map((product) => product.product_id);
    expect(ids).toEqual(expect.arrayContaining(['external_1', 'external_2', 'external_3', 'external_4']));
    expect(ids).not.toContain('tool_1');
    expect(ids).not.toContain('tool_2');
    expect(response.products[0].merchant_id).toBe('external_seed');
    expect(response.metadata.rank_debug.top_candidates.find((candidate) => candidate.product_id === 'tool_1')?.decision).toBe(
      'filtered_cold_start_domain',
    );
  });

  test('cold start browse_products keeps products_search internal beauty behind external seed beauty fill', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        context: {
          auth_state: 'authenticated',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        candidateProducts: [
          ...Array.from({ length: 11 }, (_, idx) => ({
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: `external_front_${idx + 1}`,
              title: `PIXI Serum ${idx + 1}`,
              brand: 'PIXI BEAUTY',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          })),
          {
            ...makeProduct({
              merchant_id: 'merch_internal',
              product_id: 'internal_1',
              title: 'The Ordinary Niacinamide 10% + Zinc 1%',
              brand: 'The Ordinary',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
          ...Array.from({ length: 2 }, (_, idx) => ({
            ...makeProduct({
              merchant_id: 'external_seed',
              product_id: `external_tail_${idx + 1}`,
              title: `Vitamin-C Serum ${idx + 1}`,
              brand: `External Brand ${idx + 1}`,
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          })),
          {
            ...makeProduct({
              merchant_id: 'merch_internal',
              product_id: 'internal_2',
              title: 'Winona Soothing Repair Serum',
              brand: 'Winona',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            __discovery_provider: 'products_search',
          },
        ],
      },
    );

    expect(response.products).toHaveLength(12);
    expect(response.products.every((product) => product.merchant_id === 'external_seed')).toBe(true);
    expect(response.products.map((product) => product.product_id)).not.toEqual(
      expect.arrayContaining(['internal_1', 'internal_2']),
    );
    expect(response.metadata.filter_counts.filtered_cold_start_internal_source).toBeGreaterThanOrEqual(1);
  });

  test('browse_products total reports stable corpus count while eligible pool stays page-local', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 4,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [
            {
              merchant_id: 'm1',
              product_id: 'recent_alpha',
              title: 'Alpha Repair Serum',
              brand: 'Alpha',
              category: 'Skincare',
              product_type: 'Serum',
              viewed_at: '2026-04-11T10:00:00Z',
            },
          ],
          recent_queries: [],
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'recent_alpha',
            title: 'Alpha Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'alpha_2',
            title: 'Alpha Barrier Cream',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Cream',
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'beta_1',
            title: 'Beta Repair Serum',
            brand: 'Beta',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm4',
            product_id: 'gamma_1',
            title: 'Gamma Recovery Toner',
            brand: 'Gamma',
            category: 'Skincare',
            product_type: 'Toner',
          }),
          makeProduct({
            merchant_id: 'm5',
            product_id: 'delta_1',
            title: 'Delta Gel Cream',
            brand: 'Delta',
            category: 'Skincare',
            product_type: 'Moisturizer',
          }),
        ],
      },
    );

    expect(response.total).toBe(5);
    expect(response.products).toHaveLength(4);
    expect(response.products.some((product) => product.product_id === 'recent_alpha')).toBe(false);
    expect(response.metadata).toEqual(
      expect.objectContaining({
        corpus_total_count: 5,
        eligible_pool_count: 4,
        has_more: false,
        candidate_counts: expect.objectContaining({
          raw: 5,
          normalized: 5,
          scored: 5,
          eligible_pool: 4,
          returned: 4,
        }),
      }),
    );
  });

  test('generic anonymous browse serves a curated head first, then hands off to exhaustive cursor tail', async () => {
    const candidateProducts = Array.from({ length: 180 }, (_, idx) =>
      ({
        ...makeProduct({
          merchant_id: 'external_seed',
          product_id: `generic_${idx + 1}`,
          title: `Barrier Serum ${idx + 1}`,
          brand: `Brand ${idx + 1}`,
          category: 'Skincare',
          product_type: 'Serum',
        }),
        __discovery_provider: 'products_search',
      }));

    const basePayload = {
      surface: 'browse_products',
      limit: 60,
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    };

    const pageOne = await getDiscoveryFeed(basePayload, { candidateProducts });
    const pageTwo = await getDiscoveryFeed(
      {
        ...basePayload,
        cursor: pageOne.cursor_info.next_cursor,
      },
      { candidateProducts },
    );
    const pageThree = await getDiscoveryFeed(
      {
        ...basePayload,
        cursor: pageTwo.cursor_info.next_cursor,
      },
      { candidateProducts },
    );

    expect(pageOne.metadata).toEqual(
      expect.objectContaining({
        serving_mode: 'curated_head',
        eligible_pool_count: 120,
      }),
    );
    expect(pageTwo.metadata).toEqual(
      expect.objectContaining({
        serving_mode: 'curated_head',
      }),
    );
    expect(pageThree.metadata).toEqual(
      expect.objectContaining({
        serving_mode: 'exhaustive',
      }),
    );
    expect(pageOne.cursor_info).toEqual(
      expect.objectContaining({
        has_next_page: true,
        serving_mode: 'curated_head',
      }),
    );
    expect(pageTwo.cursor_info).toEqual(
      expect.objectContaining({
        has_next_page: true,
        serving_mode: 'exhaustive',
      }),
    );
    expect(pageThree.cursor_info).toEqual(
      expect.objectContaining({
        has_next_page: false,
        serving_mode: 'exhaustive',
      }),
    );

    const ids = [
      ...pageOne.products.map((product) => product.product_id),
      ...pageTwo.products.map((product) => product.product_id),
      ...pageThree.products.map((product) => product.product_id),
    ];
    expect(new Set(ids).size).toBe(180);
    expect(pageOne.products[0].product_id).toBe('generic_1');
    expect(pageTwo.products[0].product_id).toBe('generic_61');
    expect(pageThree.products[0].product_id).toBe('generic_121');
  });

  test('brand or query scoped browse skips curated head and starts in exhaustive mode', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        limit: 2,
        query: {
          text: 'serum',
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'serum_1',
            title: 'Barrier Serum',
            brand: 'KraveBeauty',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'serum_2',
            title: 'Hydrating Serum',
            brand: 'Byoma',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'cream_1',
            title: 'Barrier Cream',
            brand: 'KraveBeauty',
            category: 'Skincare',
            product_type: 'Cream',
          }),
        ],
      },
    );

    expect(response.metadata).toEqual(
      expect.objectContaining({
        serving_mode: 'exhaustive',
        serving_contract_version: 'pivota.discovery.serving.v1',
      }),
    );
    expect(response.cursor_info).toEqual(
      expect.objectContaining({
        has_next_page: false,
        serving_mode: 'exhaustive',
      }),
    );
    expect(response.products.map((product) => product.product_id)).toEqual(['serum_1', 'serum_2']);
  });

  test('explicit query browse cursor expands provider prefetch before ending the catalog', async () => {
    const prevEnv = {
      DISCOVERY_PRODUCTS_SEARCH_BASE_URL: process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL,
      PIVOTA_BACKEND_BASE_URL: process.env.PIVOTA_BACKEND_BASE_URL,
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      DISCOVERY_PRODUCTS_SEARCH_API_KEY: process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY,
      PIVOTA_BACKEND_AGENT_API_KEY: process.env.PIVOTA_BACKEND_AGENT_API_KEY,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      SHOP_GATEWAY_AGENT_API_KEY: process.env.SHOP_GATEWAY_AGENT_API_KEY,
      PIVOTA_AGENT_API_KEY: process.env.PIVOTA_AGENT_API_KEY,
      AGENT_API_KEY: process.env.AGENT_API_KEY,
    };
    for (const key of Object.keys(prevEnv)) {
      delete process.env[key];
    }

    const externalProducts = Array.from({ length: 240 }, (_, idx) =>
      makeProduct({
        merchant_id: 'external_seed',
        product_id: `external_serum_${idx + 1}`,
        title: `Barrier Serum ${idx + 1}`,
        brand: `Seeded ${idx + 1}`,
        category: 'Skincare',
        product_type: 'Serum',
      }),
    );
    const externalSpy = jest.fn(async ({ limit }) => externalProducts.slice(0, limit));
    const basePayload = {
      surface: 'browse_products',
      limit: 24,
      query: {
        text: 'serum',
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    };

    try {
      const pageOne = await getDiscoveryFeed(basePayload, {
        providerOverrides: {
          external_seeds: externalSpy,
        },
      });
      const pageTwo = await getDiscoveryFeed(
        {
          ...basePayload,
          limit: 36,
          cursor: pageOne.cursor_info.next_cursor,
        },
        {
          providerOverrides: {
            external_seeds: externalSpy,
          },
        },
      );
      const pageThree = await getDiscoveryFeed(
        {
          ...basePayload,
          limit: 36,
          cursor: pageTwo.cursor_info.next_cursor,
        },
        {
          providerOverrides: {
            external_seeds: externalSpy,
          },
        },
      );
      const pageFour = await getDiscoveryFeed(
        {
          ...basePayload,
          limit: 36,
          cursor: pageThree.cursor_info.next_cursor,
        },
        {
          providerOverrides: {
            external_seeds: externalSpy,
          },
        },
      );

      expect(externalSpy.mock.calls.map(([arg]) => arg.limit)).toEqual([48, 168, 204, 240]);
      expect(pageOne.products).toHaveLength(24);
      expect(pageTwo.products).toHaveLength(36);
      expect(pageThree.products).toHaveLength(36);
      expect(pageFour.products).toHaveLength(36);
      expect(pageFour.products[0].product_id).toBe('external_serum_97');
      expect(pageFour.cursor_info).toEqual(
        expect.objectContaining({
          has_next_page: true,
          serving_mode: 'exhaustive',
        }),
      );
    } finally {
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('compound query browse cursor uses absolute offset for external seed prefetch', () => {
    const baseRequest = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      limit: 24,
      query: {
        text: 'lip balm',
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });
    const cursor = _internals.buildDiscoveryCursor(baseRequest, 'exhaustive', 96, 96);
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      limit: 36,
      cursor,
      query: {
        text: 'lip balm',
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });

    expect(_internals.resolveExplicitBeautyCompoundIntent(request.query.text)).toBe('lip_balm');
    expect(_internals.resolveDiscoveryCandidateLimit(request)).toBe(240);
    expect(_internals.resolveExternalSeedProviderLimit(request, 240)).toBe(240);
  });

  test('explicit browse seed stage caps are page buffered instead of provider-limit sized', () => {
    const serumPageOne = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      page: 1,
      limit: 12,
      query: {
        text: 'serum',
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });
    const serumPageTwo = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      page: 2,
      limit: 12,
      query: {
        text: 'serum',
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });
    const lipBalmPageOne = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      page: 1,
      limit: 12,
      query: {
        text: 'lip balm',
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });
    const hairOilPageOne = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      page: 1,
      limit: 12,
      query: {
        text: 'hair oil',
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });

    expect(_internals.resolveExplicitBrowseStageQueryCap(serumPageOne, 24)).toBe(36);
    expect(_internals.resolveExplicitBrowseStageQueryCap(serumPageTwo, 36)).toBe(48);
    expect(
      _internals.resolveExplicitBrowseStageQueryCap(lipBalmPageOne, 120, {
        compoundIntent: 'lip_balm',
      }),
    ).toBe(36);
    expect(
      _internals.resolveExplicitBrowseStageQueryCap(hairOilPageOne, 120, {
        compoundIntent: 'hair_oil',
      }),
    ).toBe(120);
  });

  test('query text matcher honors external seed recall text for vitamin c candidates', () => {
    const candidate = _internals.normalizeCandidateProduct(
      {
        merchant_id: 'external_seed',
        product_id: 'seed_c_vit_1',
        title: '+C Vit Priming Oil',
        category: 'Face Oil',
        product_type: 'Oil',
        external_seed_recall: {
          retrieval_title: 'vitamin c priming oil',
          retrieval_summary: 'antioxidant vitamin c face oil for glow',
          category: 'Vitamin C',
          vertical: 'Skincare',
        },
      },
      0,
    );

    expect(_internals.matchesQueryTextCandidate(candidate, 'vitamin c')).toBe(true);
  });

  test('query text matcher treats short acid terms as bounded tokens', () => {
    const ahaPeel = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'aha_peel_1',
        title: 'AHA 30% + BHA 2% Peeling Solution',
        category: 'Exfoliant',
        product_type: 'Peel',
      }),
      0,
    );
    const bhaExfoliant = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'bha_exfoliant_1',
        title: 'Skin Perfecting 2% BHA Liquid Exfoliant',
        category: 'Exfoliant',
        product_type: 'Exfoliant',
      }),
      0,
    );
    const mahamaneOil = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'mahamane_1',
        title: 'MahaMane Smooth & Shine Hair Oil',
        category: 'Hair Oil',
        product_type: 'Hair Oil',
      }),
      0,
    );
    const kalahariLipOil = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'kalahari_1',
        title: 'Kalahari Melon Lip Oil',
        category: 'Lip Oil',
        product_type: 'Lip Oil',
      }),
      0,
    );
    const ingredientOnlyLipCream = _internals.normalizeCandidateProduct(
      {
        merchant_id: 'external_seed',
        product_id: 'lip_cream_lactic_1',
        title: 'Gloss Bomb Cream Color Drip Lip Cream',
        category: 'Lip Cream',
        product_type: 'Lip Cream',
        external_seed_recall: {
          retrieval_title: 'gloss bomb cream color drip lip cream',
          retrieval_summary: 'comfortable color and shine for lips',
          category: 'Lip Cream',
          vertical: 'Makeup',
          ingredient_tokens: 'lactic acid fragrance wax',
        },
      },
      0,
    );
    const ingredientBackedPeel = _internals.normalizeCandidateProduct(
      {
        merchant_id: 'external_seed',
        product_id: 'peel_salicylic_1',
        title: 'Liquid Peelfoliant',
        category: 'Exfoliant',
        product_type: 'Peel',
        external_seed_recall: {
          retrieval_title: 'liquid peelfoliant',
          retrieval_summary: 'daily exfoliating peel for smoother skin',
          category: 'Exfoliant',
          vertical: 'Skincare',
          ingredient_tokens: 'salicylic acid enzymes',
        },
      },
      0,
    );

    expect(_internals.matchesQueryTextCandidate(ahaPeel, 'aha')).toBe(true);
    expect(_internals.matchesQueryTextCandidate(bhaExfoliant, 'bha')).toBe(true);
    expect(_internals.matchesQueryTextCandidate(mahamaneOil, 'aha')).toBe(false);
    expect(_internals.matchesQueryTextCandidate(kalahariLipOil, 'aha')).toBe(false);
    expect(_internals.matchesQueryTextCandidate(ingredientOnlyLipCream, 'lactic acid')).toBe(false);
    expect(_internals.matchesQueryTextCandidate(ingredientBackedPeel, 'bha')).toBe(true);
  });

  test('query text matcher removes broad beauty merch and tool noise unless explicitly requested', () => {
    const makeupBag = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'makeup_bag_1',
        title: 'Puffy Makeup Bag - Mauve',
        category: 'Makeup',
        product_type: 'Bag',
      }),
      0,
    );
    const foundationBrush = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'foundation_brush_1',
        title: 'Liquid Touch Foundation Brush',
        category: 'Makeup Tools',
        product_type: 'Brush',
      }),
      0,
    );
    const giftCard = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'beauty_gift_card_1',
        title: 'Rare Beauty E-Gift Card',
        category: 'Makeup',
        product_type: 'Gift Card',
      }),
      0,
    );
    const beautyMirror = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'beauty_mirror_1',
        title: "Smurfette n' Reflect Handheld Beauty Mirror",
        category: 'Beauty Accessories',
        product_type: 'Mirror',
      }),
      0,
    );
    const sweatpants = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'beauty_sweatpants_1',
        title: 'Comfy Sweatpants',
        category: 'Beauty',
        product_type: 'Apparel',
      }),
      0,
    );
    const sunscreenBundle = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'sunscreen_bundle_1',
        title: 'Build Your Own SPF Moisturizer + Foundation Bundle',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
      }),
      0,
    );

    expect(_internals.matchesQueryTextCandidate(makeupBag, 'makeup')).toBe(false);
    expect(_internals.matchesQueryTextCandidate(makeupBag, 'makeup bag')).toBe(true);
    expect(_internals.matchesQueryTextCandidate(foundationBrush, 'foundation')).toBe(false);
    expect(_internals.matchesQueryTextCandidate(foundationBrush, 'foundation brush')).toBe(true);
    expect(_internals.matchesQueryTextCandidate(giftCard, 'beauty')).toBe(false);
    expect(_internals.matchesQueryTextCandidate(beautyMirror, 'beauty')).toBe(false);
    expect(_internals.matchesQueryTextCandidate(sweatpants, 'beauty')).toBe(false);
    expect(_internals.matchesQueryTextCandidate(sunscreenBundle, 'sunscreen')).toBe(true);
  });

  test('exact hair gel text filtering rejects adjacent shower gel noise', () => {
    const hairGel = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'hair_gel_1',
        title: 'The Controlling Type Hair-Thickening Edge Control Gel',
        category: 'Hair Gel',
        product_type: 'Hair Gel',
      }),
      0,
    );
    const showerGel = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'shower_gel_1',
        title: 'Multi-Use Shower Gel Face, Beard, Body, Hair',
        category: 'Shower Gel',
        product_type: 'Shower Gel',
      }),
      0,
    );

    expect(_internals.matchesQueryTextCandidate(hairGel, 'hair gel')).toBe(true);
    expect(_internals.matchesQueryTextCandidate(showerGel, 'hair gel')).toBe(false);
  });

  test('exact product-type text filtering rejects adjacent tool and treatment noise', () => {
    const makeupSponge = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'makeup_sponge_1',
        title: 'Mushroom Sponge 2-Piece Makeup Blending Sponge',
        category: 'Makeup Sponge',
        product_type: 'Makeup Sponge',
      }),
      0,
    );
    const powderBrush = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'powder_brush_1',
        title: 'Powder Puff Setting Brush 170',
        category: 'Brush',
        product_type: 'Brush',
      }),
      0,
    );
    const hydratingMask = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'hydrating_mask_1',
        title: 'Dew N Plump Hydrating Face Mask',
        category: 'Face Mask',
        product_type: 'Face Mask',
      }),
      0,
    );
    const hydratingPad = _internals.normalizeCandidateProduct(
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'hydrating_pad_1',
        title: 'Hyalu-Cica Jelly-Fit Ampoule Pad',
        category: 'Treatment Pad',
        product_type: 'Treatment Pad',
      }),
      0,
    );

    expect(_internals.matchesQueryTextCandidate(makeupSponge, 'makeup sponge')).toBe(true);
    expect(_internals.matchesQueryTextCandidate(powderBrush, 'makeup sponge')).toBe(false);
    expect(_internals.matchesQueryTextCandidate(hydratingMask, 'hydrating mask')).toBe(true);
    expect(_internals.matchesQueryTextCandidate(hydratingPad, 'hydrating mask')).toBe(false);
  });

  test('exact beauty phrase hints skip broad category and vertical stages for narrow explicit queries', () => {
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      query: {
        text: 'setting spray',
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });
    const profile = buildDiscoveryProfile(request.context);
    const recallTerms = _internals.buildBeautyInterestRecallTerms(request, profile, ['setting spray']);

    expect(recallTerms.categoryTerms).toEqual(
      expect.arrayContaining(['setting spray', 'fixing mist', 'makeup fixing mist']),
    );
    expect(recallTerms.verticalTerms).toEqual(expect.arrayContaining(['makeup']));
    expect(_internals.resolveExplicitIndexedCategoryHeadTerms(request, recallTerms)).toEqual(
      expect.arrayContaining(['setting spray', 'makeup setting spray', 'fixing mist', 'makeup fixing mist']),
    );
    expect(_internals.shouldSkipExplicitCategorySeedStage(request, recallTerms)).toBe(true);
    expect(_internals.shouldSkipExplicitVerticalSeedStage(request, recallTerms)).toBe(true);

    const broadRequest = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      query: {
        text: 'hair care',
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });
    const broadRecallTerms = _internals.buildBeautyInterestRecallTerms(
      broadRequest,
      profile,
      ['hair care'],
    );

    expect(_internals.shouldSkipExplicitCategorySeedStage(broadRequest, broadRecallTerms)).toBe(false);
    expect(_internals.shouldSkipExplicitVerticalSeedStage(broadRequest, broadRecallTerms)).toBe(false);
  });

  test('slow public beauty product-type queries use exact-intent external seed mainline', () => {
    const profile = buildDiscoveryProfile({
      auth_state: 'anonymous',
      locale: 'en-US',
      recent_views: [],
      recent_queries: [],
    });
    const exactQueries = [
      ['makeup remover', ['makeup remover', 'make-up remover']],
      ['makeup sponge', ['makeup sponge', 'blending sponge']],
      ['scalp treatment', ['scalp treatment', 'scalp tonic']],
      ['heat protectant', ['heat protectant', 'hair styling']],
      ['curl cream', ['curl cream', 'curl-defining cream']],
      ['hair spray', ['hair spray', 'hairspray']],
      ['hair gel', ['hair gel', 'edge control gel']],
      ['deodorant', ['deodorant', 'body deodorant']],
      ['exfoliant', ['exfoliant']],
      ['glycolic acid', ['exfoliant']],
      ['lactic acid', ['exfoliant']],
      ['aha', ['exfoliant']],
      ['bha', ['exfoliant']],
      ['hydrating mask', ['hydrating mask', 'hydration mask']],
      ['clay mask', ['clay mask', 'clay stick mask']],
    ];

    for (const [queryText, expectedHeadTerms] of exactQueries) {
      const request = _internals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        limit: 12,
        query: {
          text: queryText,
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });
      const recallTerms = _internals.buildBeautyInterestRecallTerms(request, profile, [queryText]);

      const indexedHeadTerms = _internals.resolveExplicitIndexedCategoryHeadTerms(request, recallTerms);
      if (expectedHeadTerms.length > 0) {
        expect(indexedHeadTerms).toEqual(expect.arrayContaining(expectedHeadTerms));
      } else {
        expect(indexedHeadTerms).toEqual([]);
      }
      if (queryText === 'exfoliant') {
        expect(indexedHeadTerms).not.toContain('treatment');
      }
      expect(_internals.shouldSkipExplicitCategorySeedStage(request, recallTerms)).toBe(true);
      expect(_internals.shouldSkipExplicitVerticalSeedStage(request, recallTerms)).toBe(true);
      expect(_internals.resolveExplicitQueryExternalSeedMainlineAcceptThreshold(request, 60)).toBe(18);
      if (['exfoliant', 'glycolic acid', 'lactic acid', 'aha', 'bha'].includes(queryText)) {
        const exactTextPatterns = _internals.resolveExactPhraseTextUnionPatterns(request, recallTerms);
        expect(exactTextPatterns).not.toContain('%aha%');
        expect(exactTextPatterns).not.toContain('%bha%');
        const fieldLabels = _internals.resolveExactPhraseTextUnionFieldLabels(request, recallTerms);
        expect(fieldLabels).toEqual([
          'title',
          'ingredient_tokens',
          'alias_tokens',
        ]);
        expect(
          _internals
            .buildExactPhraseTextFieldStageDefinitions({
              patterns: exactTextPatterns,
              fieldLabels,
              cap: 72,
            })
            .map((stage) => stage.stage),
        ).toEqual([
          'recall_exact_text_title',
          'recall_exact_text_ingredient_tokens',
          'recall_exact_text_alias_tokens',
        ]);
      }
    }
  });

  test('exact beauty phrase hints cover fragrance and compound conditioner variants', () => {
    const profile = buildDiscoveryProfile({
      auth_state: 'anonymous',
      locale: 'en-US',
      recent_views: [],
      recent_queries: [],
    });

    const perfumeRequest = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      query: {
        text: 'perfume',
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });
    const perfumeRecallTerms = _internals.buildBeautyInterestRecallTerms(
      perfumeRequest,
      profile,
      ['perfume'],
    );
    expect(_internals.resolveExplicitIndexedCategoryHeadTerms(perfumeRequest, perfumeRecallTerms)).toEqual(
      expect.arrayContaining(['perfume', 'eau de parfum', 'fragrance']),
    );

    for (const queryText of ['shampoo', 'conditioner']) {
      const request = _internals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        query: {
          text: queryText,
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });
      const recallTerms = _internals.buildBeautyInterestRecallTerms(
        request,
        profile,
        [queryText],
      );
      const expectedFields = ['title', 'summary'];
      expect(_internals.resolveExplicitIndexedCategoryHeadTerms(request, recallTerms)).toEqual([]);
      expect(_internals.resolveExactPhraseTextUnionFieldLabels(request, recallTerms)).toEqual(expectedFields);
      expect(
        _internals
          .buildExactPhraseTextFieldStageDefinitions({
            patterns: _internals.resolveExactPhraseTextUnionPatterns(request, recallTerms),
            fieldLabels: _internals.resolveExactPhraseTextUnionFieldLabels(request, recallTerms),
            cap: 36,
          })
          .map((stage) => stage.stage),
      ).toEqual(expectedFields.map((field) => `recall_exact_text_${field}`));
    }

    const leaveInRequest = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      query: {
        text: 'leave in conditioner',
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });
    const leaveInRecallTerms = _internals.buildBeautyInterestRecallTerms(
      leaveInRequest,
      profile,
      ['leave in conditioner'],
    );
    expect(leaveInRecallTerms.compoundIntent).toBe('leave_in_conditioner');
    expect(leaveInRecallTerms.primaryCategoryTerms).toEqual(
      expect.arrayContaining(['leave in conditioner', 'hair milk']),
    );
    expect(leaveInRecallTerms.weakCategoryTerms).toEqual(expect.arrayContaining(['conditioner']));
    expect(_internals.resolveExplicitIndexedCategoryHeadTerms(leaveInRequest, leaveInRecallTerms)).toEqual([]);

    const handCreamRequest = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      limit: 12,
      query: {
        text: 'hand cream',
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });
    const handCreamRecallTerms = _internals.buildBeautyInterestRecallTerms(
      handCreamRequest,
      profile,
      ['hand cream'],
    );
    expect(_internals.resolveExplicitIndexedCategoryHeadTerms(handCreamRequest, handCreamRecallTerms)).toEqual(
      expect.arrayContaining(['hand cream', 'hand lotion']),
    );
    expect(_internals.resolveExplicitQueryExternalSeedMainlineAcceptThreshold(handCreamRequest, 24)).toBe(18);
  });

  test('exact phrase indexed head treats fragrance as a safe structured synonym for perfume', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-perfume-indexed-head-structured-test';
    const requiredColumns = [
      { table_name: 'products_cache', column_name: 'id' },
      { table_name: 'products_cache', column_name: 'merchant_id' },
      { table_name: 'products_cache', column_name: 'product_data' },
      { table_name: 'products_cache', column_name: 'expires_at' },
      { table_name: 'products_cache', column_name: 'cached_at' },
      { table_name: 'external_product_seeds', column_name: 'id' },
      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
      { table_name: 'external_product_seeds', column_name: 'destination_url' },
      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
      { table_name: 'external_product_seeds', column_name: 'title' },
      { table_name: 'external_product_seeds', column_name: 'seed_data' },
      { table_name: 'external_product_seeds', column_name: 'market' },
      { table_name: 'external_product_seeds', column_name: 'tool' },
      { table_name: 'external_product_seeds', column_name: 'status' },
      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
      { table_name: 'external_product_seeds', column_name: 'updated_at' },
      { table_name: 'external_product_seeds', column_name: 'created_at' },
    ];
    const requiredIndexes = [
      'idx_external_product_seeds_recall_title_trgm',
      'idx_external_product_seeds_recall_summary_trgm',
      'idx_external_product_seeds_recall_category_vertical_recency',
      'idx_external_product_seeds_recall_vertical_recency',
      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
      'idx_external_product_seeds_recall_alias_tokens_trgm',
    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));
    const headRows = Array.from({ length: 6 }, (_, index) =>
      makeExternalSeedRow({
        id: `perfume_head_${index + 1}`,
        title: `Maison Eau de Parfum ${index + 1}`,
        category: 'Fragrance',
        product_type: 'Fragrance',
        description: 'Fine fragrance composition.',
      }),
    );
	    const dbQueryMock = jest
	      .fn()
	      .mockResolvedValueOnce({ rows: requiredColumns })
	      .mockResolvedValueOnce({ rows: requiredIndexes })
	      .mockResolvedValueOnce({ rows: headRows })
	      .mockResolvedValue({ rows: [] });
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const {
        buildDiscoveryProfile: freshBuildDiscoveryProfile,
        _internals: freshInternals,
      } = require('../src/services/discoveryFeed');
      freshInternals.resetDiscoveryDependencyProbeCache();
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        page: 1,
        limit: 12,
        query: {
          text: 'perfume',
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });

      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile: freshBuildDiscoveryProfile(request.context),
        queries: ['perfume'],
        limit: freshInternals.resolveExternalSeedProviderLimit(request, 60),
        providerName: 'external_seeds',
        productProvider: 'external_seeds',
        stepName: 'external_seed_pool',
        label: 'external_seed_pool',
      });

	      expect(result.products).toHaveLength(6);
	      expect(dbQueryMock).toHaveBeenCalledTimes(6);
	      expect(result.recallSummary[0].external_seed_stage_counts).toEqual([
	        expect.objectContaining({
	          stage: 'recall_indexed_category_head',
	          raw_rows: 6,
	          query_qualified_rows: 6,
	          final_eligible_rows: 6,
	        }),
	        expect.objectContaining({
	          stage: 'recall_indexed_category_head',
	          tool_scope: 'creator_agents',
	          raw_rows: 0,
	          final_eligible_rows: 6,
	        }),
	        expect.objectContaining({
	          stage: 'recall_exact_text_union',
	          tool_scope: '*',
	          raw_rows: 0,
	          final_eligible_rows: 6,
	        }),
	        expect.objectContaining({
	          stage: 'recall_exact_text_union',
	          tool_scope: 'creator_agents',
	          raw_rows: 0,
	          final_eligible_rows: 6,
	        }),
	      ]);
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      jest.dontMock('../src/db');
      jest.resetModules();
    }
  });

  test('exact phrase browse keeps structured parfum head candidates through final selection', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-parfum-final-selection-structured-test';
    const requiredColumns = [
      { table_name: 'products_cache', column_name: 'id' },
      { table_name: 'products_cache', column_name: 'merchant_id' },
      { table_name: 'products_cache', column_name: 'product_data' },
      { table_name: 'products_cache', column_name: 'expires_at' },
      { table_name: 'products_cache', column_name: 'cached_at' },
      { table_name: 'external_product_seeds', column_name: 'id' },
      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
      { table_name: 'external_product_seeds', column_name: 'destination_url' },
      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
      { table_name: 'external_product_seeds', column_name: 'title' },
      { table_name: 'external_product_seeds', column_name: 'seed_data' },
      { table_name: 'external_product_seeds', column_name: 'market' },
      { table_name: 'external_product_seeds', column_name: 'tool' },
      { table_name: 'external_product_seeds', column_name: 'status' },
      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
      { table_name: 'external_product_seeds', column_name: 'updated_at' },
      { table_name: 'external_product_seeds', column_name: 'created_at' },
    ];
    const requiredIndexes = [
      'idx_external_product_seeds_recall_title_trgm',
      'idx_external_product_seeds_recall_summary_trgm',
      'idx_external_product_seeds_recall_category_vertical_recency',
      'idx_external_product_seeds_recall_vertical_recency',
      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
      'idx_external_product_seeds_recall_alias_tokens_trgm',
    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));
    const perfumeRows = Array.from({ length: 6 }, (_, index) =>
      makeExternalSeedRow({
        id: `parfum_final_${index + 1}`,
        title: `Maison Eau de Parfum ${index + 1}`,
        category: 'Fragrance',
        product_type: 'Fragrance',
        description: 'Fine fragrance composition.',
      }),
    );
    const noiseRows = [
      makeExternalSeedRow({
        id: 'parfum_noise_mist',
        title: 'Maison Fragrance Mist',
        category: 'Fragrance',
        product_type: 'Fragrance',
        description: 'Body and hair fragrance mist with eau de parfum discovery notes.',
      }),
      makeExternalSeedRow({
        id: 'parfum_noise_balm',
        title: 'Maison Fragrance Layering Balm',
        category: 'Fragrance',
        product_type: 'Fragrance',
        description: 'Layering balm for fragrance and eau de parfum routines.',
      }),
    ];
    const headRows = perfumeRows.concat(noiseRows);
	    const dbQueryMock = jest
	      .fn()
	      .mockResolvedValueOnce({ rows: requiredColumns })
	      .mockResolvedValueOnce({ rows: requiredIndexes })
	      .mockResolvedValueOnce({ rows: headRows })
	      .mockResolvedValue({ rows: [] });
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const fresh = require('../src/services/discoveryFeed');
      fresh._internals.resetDiscoveryDependencyProbeCache();
      const response = await fresh.getDiscoveryFeed({
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        query: {
          text: 'eau de parfum',
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });

      expect(response.products).toHaveLength(6);
      expect(response.products.every((product) => /Parfum/i.test(product.title))).toBe(true);
      expect(response.metadata.candidate_source).toBe('external_seed_exact_intent');
      expect(response.metadata.candidate_counts).toEqual(
        expect.objectContaining({
          raw: 8,
          eligible_pool: 6,
          returned: 6,
        }),
      );
	      expect(response.metadata.external_seed_stage_counts).toEqual([
	        expect.objectContaining({
	          stage: 'recall_indexed_category_head',
	          raw_rows: 8,
	          query_qualified_rows: 8,
	          final_eligible_rows: 8,
	        }),
	        expect.objectContaining({
	          stage: 'recall_indexed_category_head',
	          tool_scope: 'creator_agents',
	          raw_rows: 0,
	          final_eligible_rows: 8,
	        }),
	        expect.objectContaining({
	          stage: 'recall_exact_text_union',
	          tool_scope: '*',
	          raw_rows: 0,
	          final_eligible_rows: 8,
	        }),
	        expect.objectContaining({
	          stage: 'recall_exact_text_union',
	          tool_scope: 'creator_agents',
	          raw_rows: 0,
	          final_eligible_rows: 8,
	        }),
	      ]);
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      jest.dontMock('../src/db');
      jest.resetModules();
    }
  });

  test('compound leave in conditioner recall does not broaden to generic conditioner rows', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-leave-in-structured-head-guard-test';
    const requiredColumns = [
      { table_name: 'products_cache', column_name: 'id' },
      { table_name: 'products_cache', column_name: 'merchant_id' },
      { table_name: 'products_cache', column_name: 'product_data' },
      { table_name: 'products_cache', column_name: 'expires_at' },
      { table_name: 'products_cache', column_name: 'cached_at' },
      { table_name: 'external_product_seeds', column_name: 'id' },
      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
      { table_name: 'external_product_seeds', column_name: 'destination_url' },
      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
      { table_name: 'external_product_seeds', column_name: 'title' },
      { table_name: 'external_product_seeds', column_name: 'seed_data' },
      { table_name: 'external_product_seeds', column_name: 'market' },
      { table_name: 'external_product_seeds', column_name: 'tool' },
      { table_name: 'external_product_seeds', column_name: 'status' },
      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
      { table_name: 'external_product_seeds', column_name: 'updated_at' },
      { table_name: 'external_product_seeds', column_name: 'created_at' },
    ];
    const requiredIndexes = [
      'idx_external_product_seeds_recall_title_trgm',
      'idx_external_product_seeds_recall_summary_trgm',
      'idx_external_product_seeds_recall_category_vertical_recency',
      'idx_external_product_seeds_recall_vertical_recency',
      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
      'idx_external_product_seeds_recall_alias_tokens_trgm',
    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));
    const headRows = Array.from({ length: 6 }, (_, index) =>
      makeExternalSeedRow({
        id: `generic_conditioner_head_${index + 1}`,
        title: `Smooth Conditioner ${index + 1}`,
        category: 'Conditioner',
        product_type: 'Conditioner',
        description: 'Hydrating conditioner for hair.',
      }),
    );
	    const dbQueryMock = jest
	      .fn()
	      .mockResolvedValueOnce({ rows: requiredColumns })
	      .mockResolvedValueOnce({ rows: requiredIndexes })
	      .mockResolvedValueOnce({ rows: headRows })
	      .mockResolvedValue({ rows: [] });
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const {
        buildDiscoveryProfile: freshBuildDiscoveryProfile,
        _internals: freshInternals,
      } = require('../src/services/discoveryFeed');
      freshInternals.resetDiscoveryDependencyProbeCache();
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        page: 1,
        limit: 12,
        query: {
          text: 'leave in conditioner',
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });

      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile: freshBuildDiscoveryProfile(request.context),
        queries: ['leave in conditioner'],
        limit: freshInternals.resolveExternalSeedProviderLimit(request, 60),
        providerName: 'external_seeds',
        productProvider: 'external_seeds',
        stepName: 'external_seed_pool',
        label: 'external_seed_pool',
      });

	      expect(result.products).toHaveLength(0);
	      expect(dbQueryMock).toHaveBeenCalledTimes(12);
	      expect(result.recallSummary[0].compound_intent).toBe('leave_in_conditioner');
	      expect(result.recallSummary[0].external_seed_stage_counts).toEqual([
	        expect.objectContaining({
	          stage: 'recall_compound_primary_category',
	          raw_rows: 6,
	          query_qualified_rows: 0,
	          final_eligible_rows: 0,
	        }),
	        expect.objectContaining({
	          stage: 'recall_compound_primary_category',
	          tool_scope: 'creator_agents',
	          final_eligible_rows: 0,
	        }),
	        expect.objectContaining({
	          stage: 'recall_compound_exact_title',
	          tool_scope: '*',
	          final_eligible_rows: 0,
	        }),
	        expect.objectContaining({
	          stage: 'recall_compound_exact_title',
	          tool_scope: 'creator_agents',
	          final_eligible_rows: 0,
	        }),
	        expect.objectContaining({
	          stage: 'recall_compound_weak_category',
	          tool_scope: '*',
	          final_eligible_rows: 0,
	        }),
	        expect.objectContaining({
	          stage: 'recall_compound_weak_category',
	          tool_scope: 'creator_agents',
	          final_eligible_rows: 0,
	        }),
	        expect.objectContaining({
	          stage: 'recall_compound_weak_vertical',
	          tool_scope: '*',
	          final_eligible_rows: 0,
	        }),
	        expect.objectContaining({
	          stage: 'recall_compound_weak_vertical',
	          tool_scope: 'creator_agents',
	          final_eligible_rows: 0,
	        }),
	        expect.objectContaining({
	          stage: 'recall_compound_title_conjunction',
	          tool_scope: '*',
	          final_eligible_rows: 0,
	        }),
	        expect.objectContaining({
	          stage: 'recall_compound_title_conjunction',
	          tool_scope: 'creator_agents',
	          final_eligible_rows: 0,
	        }),
	      ]);
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      jest.dontMock('../src/db');
      jest.resetModules();
    }
  });

  test('explicit non-compound browse keeps running seed stages until query-qualified rows fill target', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-noncompound-query-stage-test';
    const requiredColumns = [
      { table_name: 'products_cache', column_name: 'id' },
      { table_name: 'products_cache', column_name: 'merchant_id' },
      { table_name: 'products_cache', column_name: 'product_data' },
      { table_name: 'products_cache', column_name: 'expires_at' },
      { table_name: 'products_cache', column_name: 'cached_at' },
      { table_name: 'external_product_seeds', column_name: 'id' },
      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
      { table_name: 'external_product_seeds', column_name: 'destination_url' },
      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
      { table_name: 'external_product_seeds', column_name: 'title' },
      { table_name: 'external_product_seeds', column_name: 'seed_data' },
      { table_name: 'external_product_seeds', column_name: 'market' },
      { table_name: 'external_product_seeds', column_name: 'tool' },
      { table_name: 'external_product_seeds', column_name: 'status' },
      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
      { table_name: 'external_product_seeds', column_name: 'updated_at' },
      { table_name: 'external_product_seeds', column_name: 'created_at' },
    ];
    const requiredIndexes = [
      'idx_external_product_seeds_recall_title_trgm',
      'idx_external_product_seeds_recall_summary_trgm',
      'idx_external_product_seeds_recall_category_vertical_recency',
      'idx_external_product_seeds_recall_vertical_recency',
      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
      'idx_external_product_seeds_recall_alias_tokens_trgm',
    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));
    const titleRows = Array.from({ length: 10 }, (_, index) =>
      makeExternalSeedRow({
        id: `vitamin_title_${index + 1}`,
        title: `Vitamin C Serum ${index + 1}`,
        category: 'Serum',
        product_type: 'Serum',
        description: 'Vitamin C brightening serum.',
      }),
    );
    const broadTokenRows = Array.from({ length: 20 }, (_, index) =>
      makeExternalSeedRow({
        id: `peptide_noise_${index + 1}`,
        title: `Peptide Serum ${index + 1}`,
        category: 'Serum',
        product_type: 'Serum',
        description: 'Firming peptide treatment.',
      }),
    );
    const categoryRows = Array.from({ length: 12 }, (_, index) =>
      makeExternalSeedRow({
        id: `vitamin_category_${index + 1}`,
        title: `Vitamin C Treatment ${index + 1}`,
        category: 'Treatment',
        product_type: 'Treatment',
        description: 'Vitamin C antioxidant treatment.',
      }),
    );
	    const dbQueryMock = jest
	      .fn()
	      .mockResolvedValueOnce({ rows: requiredColumns })
	      .mockResolvedValueOnce({ rows: requiredIndexes })
	      .mockResolvedValueOnce({ rows: titleRows })
	      .mockResolvedValueOnce({ rows: [] })
	      .mockResolvedValueOnce({ rows: [] })
	      .mockResolvedValueOnce({ rows: [] })
	      .mockResolvedValueOnce({ rows: broadTokenRows })
	      .mockResolvedValueOnce({ rows: [] })
	      .mockResolvedValueOnce({ rows: categoryRows });
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const {
        buildDiscoveryProfile: freshBuildDiscoveryProfile,
        _internals: freshInternals,
      } = require('../src/services/discoveryFeed');
      freshInternals.resetDiscoveryDependencyProbeCache();
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        page: 1,
        limit: 12,
        query: {
          text: 'vitamin c',
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });
      expect(
        freshInternals.resolveExplicitIndexedCategoryHeadTerms(
          request,
          freshInternals.buildBeautyInterestRecallTerms(
            request,
            freshBuildDiscoveryProfile(request.context),
            ['vitamin c'],
          ),
        ),
      ).toEqual([]);

      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile: freshBuildDiscoveryProfile(request.context),
        queries: ['vitamin c'],
        limit: freshInternals.resolveExternalSeedProviderLimit(request, 60),
        providerName: 'external_seeds',
        productProvider: 'external_seeds',
        stepName: 'external_seed_pool',
        label: 'external_seed_pool',
      });

	      expect(result.products).toHaveLength(22);
	      expect(result.products.every((product) => /Vitamin C/.test(product.title))).toBe(true);
	      expect(dbQueryMock).toHaveBeenCalledTimes(9);
      expect(result.recallSummary[0]).toEqual(
        expect.objectContaining({
          external_seed_qualified_count: 22,
          external_seed_filtered_query_text_count: 20,
        }),
      );
      expect(result.recallSummary[0].external_seed_stage_counts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: 'recall_tokens',
            raw_rows: 20,
            query_qualified_rows: 0,
            final_eligible_rows: 10,
          }),
          expect.objectContaining({
            stage: 'recall_category',
            raw_rows: 12,
            query_qualified_rows: 12,
            final_eligible_rows: 22,
          }),
        ]),
      );
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });

  test('explicit hair wash category browse uses exact field stages without category head', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-noncompound-title-stop-test';
    const requiredColumns = [
      { table_name: 'products_cache', column_name: 'id' },
      { table_name: 'products_cache', column_name: 'merchant_id' },
      { table_name: 'products_cache', column_name: 'product_data' },
      { table_name: 'products_cache', column_name: 'expires_at' },
      { table_name: 'products_cache', column_name: 'cached_at' },
      { table_name: 'external_product_seeds', column_name: 'id' },
      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
      { table_name: 'external_product_seeds', column_name: 'destination_url' },
      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
      { table_name: 'external_product_seeds', column_name: 'title' },
      { table_name: 'external_product_seeds', column_name: 'seed_data' },
      { table_name: 'external_product_seeds', column_name: 'market' },
      { table_name: 'external_product_seeds', column_name: 'tool' },
      { table_name: 'external_product_seeds', column_name: 'status' },
      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
      { table_name: 'external_product_seeds', column_name: 'updated_at' },
      { table_name: 'external_product_seeds', column_name: 'created_at' },
    ];
    const requiredIndexes = [
      'idx_external_product_seeds_recall_title_trgm',
      'idx_external_product_seeds_recall_summary_trgm',
      'idx_external_product_seeds_recall_category_vertical_recency',
      'idx_external_product_seeds_recall_vertical_recency',
      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
      'idx_external_product_seeds_recall_alias_tokens_trgm',
    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));
	    const titleRows = Array.from({ length: 8 }, (_, index) =>
	      makeExternalSeedRow({
	        id: `conditioner_title_${index + 1}`,
	        title: `Seed Conditioner ${index + 1}`,
	        category: 'Conditioner',
	        product_type: 'Conditioner',
	        description: 'Smoothing conditioner for hair.',
	      }),
	    );
	    const summaryRows = Array.from({ length: 4 }, (_, index) =>
	      makeExternalSeedRow({
	        id: `conditioner_summary_${index + 1}`,
	        title: `Hair Routine Duo ${index + 1}`,
	        category: 'Hair Set',
	        product_type: 'Hair Set',
	        description: 'Washday routine with smoothing conditioner and detangling care.',
	      }),
	    );
	    const dbQueryMock = jest
	      .fn()
	      .mockResolvedValueOnce({ rows: requiredColumns })
	      .mockResolvedValueOnce({ rows: requiredIndexes })
	      .mockResolvedValueOnce({ rows: titleRows })
	      .mockResolvedValueOnce({ rows: [] })
	      .mockResolvedValueOnce({ rows: summaryRows })
	      .mockResolvedValueOnce({ rows: [] });
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const {
        buildDiscoveryProfile: freshBuildDiscoveryProfile,
        _internals: freshInternals,
      } = require('../src/services/discoveryFeed');
      freshInternals.resetDiscoveryDependencyProbeCache();
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        page: 1,
        limit: 12,
        query: {
          text: 'conditioner',
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });

	      expect(
	        freshInternals.resolveExplicitQueryExternalSeedMainlineAcceptThreshold(request, 60),
	      ).toBe(18);
      expect(
        freshInternals.resolveExplicitIndexedCategoryHeadTerms(
          request,
          freshInternals.buildBeautyInterestRecallTerms(
            request,
            freshBuildDiscoveryProfile(request.context),
            ['conditioner'],
          ),
        ),
      ).toEqual([]);

      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile: freshBuildDiscoveryProfile(request.context),
        queries: ['conditioner'],
        limit: freshInternals.resolveExternalSeedProviderLimit(request, 60),
        providerName: 'external_seeds',
        productProvider: 'external_seeds',
        stepName: 'external_seed_pool',
        label: 'external_seed_pool',
      });

	      expect(result.products).toHaveLength(12);
	      expect(dbQueryMock).toHaveBeenCalledTimes(6);
	      expect(dbQueryMock.mock.calls[2][0]).toContain('AND tool = $2');
	      expect(dbQueryMock.mock.calls[2][0]).not.toContain("(tool = '*' OR tool = $2)");
	      expect(dbQueryMock.mock.calls[2][1][1]).toBe('*');
	      expect(dbQueryMock.mock.calls[3][1][1]).toBe('creator_agents');
	      expect(dbQueryMock.mock.calls[2][0]).toContain("seed_data->'derived'->'recall'->>'retrieval_title'");
	      expect(dbQueryMock.mock.calls[4][0]).toContain("seed_data->'derived'->'recall'->>'retrieval_summary'");
	      expect(dbQueryMock.mock.calls[2][0]).not.toContain("lower(coalesce(seed_data->'derived'->'recall'->>'category', '')");
	      expect(dbQueryMock.mock.calls[4][0]).not.toContain("lower(coalesce(seed_data->'derived'->'recall'->>'category', '')");
	      expect(dbQueryMock.mock.calls[2][0]).not.toContain('UNION ALL');
	      expect(dbQueryMock.mock.calls[4][0]).not.toContain('UNION ALL');
	      expect(dbQueryMock.mock.calls[2][1].at(-1)).toBe(36);
	      expect(result.recallSummary[0].external_seed_tool_scopes).toEqual(['*', 'creator_agents']);
	      expect(result.recallSummary[0].external_seed_stage_counts.map((entry) => entry.stage)).toEqual([
	        'recall_exact_text_title',
	        'recall_exact_text_title',
	        'recall_exact_text_summary',
	        'recall_exact_text_summary',
	      ]);
	      expect(result.recallSummary[0].external_seed_stage_counts[0].tool_scope).toBe('*');
	      expect(result.recallSummary[0].external_seed_stage_counts[1].tool_scope).toBe('creator_agents');
	      expect(result.recallSummary[0].external_seed_stage_counts[2].tool_scope).toBe('*');
	      expect(result.recallSummary[0].external_seed_stage_counts[3].tool_scope).toBe('creator_agents');
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      jest.dontMock('../src/db');
      jest.resetModules();
    }
  });

  test('exact phrase browse page 1 continues past indexed head partial exact-intent pool', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-exact-head-stop-test';
    const requiredColumns = [
      { table_name: 'products_cache', column_name: 'id' },
      { table_name: 'products_cache', column_name: 'merchant_id' },
      { table_name: 'products_cache', column_name: 'product_data' },
      { table_name: 'products_cache', column_name: 'expires_at' },
      { table_name: 'products_cache', column_name: 'cached_at' },
      { table_name: 'external_product_seeds', column_name: 'id' },
      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
      { table_name: 'external_product_seeds', column_name: 'destination_url' },
      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
      { table_name: 'external_product_seeds', column_name: 'title' },
      { table_name: 'external_product_seeds', column_name: 'seed_data' },
      { table_name: 'external_product_seeds', column_name: 'market' },
      { table_name: 'external_product_seeds', column_name: 'tool' },
      { table_name: 'external_product_seeds', column_name: 'status' },
      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
      { table_name: 'external_product_seeds', column_name: 'updated_at' },
      { table_name: 'external_product_seeds', column_name: 'created_at' },
    ];
    const requiredIndexes = [
      'idx_external_product_seeds_recall_title_trgm',
      'idx_external_product_seeds_recall_summary_trgm',
      'idx_external_product_seeds_recall_category_vertical_recency',
      'idx_external_product_seeds_recall_vertical_recency',
      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
      'idx_external_product_seeds_recall_alias_tokens_trgm',
    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));
    const headRows = Array.from({ length: 5 }, (_, index) =>
      makeExternalSeedRow({
        id: `essence_head_${index + 1}`,
        title: `Water Essence ${index + 1}`,
        category: 'Essence',
        product_type: 'Essence',
        description: 'Hydrating water essence for daily use.',
      }),
    );
	    const dbQueryMock = jest
	      .fn()
	      .mockResolvedValueOnce({ rows: requiredColumns })
	      .mockResolvedValueOnce({ rows: requiredIndexes })
	      .mockResolvedValueOnce({ rows: headRows })
	      .mockResolvedValue({ rows: [] });
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const {
        buildDiscoveryProfile: freshBuildDiscoveryProfile,
        _internals: freshInternals,
      } = require('../src/services/discoveryFeed');
      freshInternals.resetDiscoveryDependencyProbeCache();
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        page: 1,
        limit: 12,
        query: {
          text: 'essence',
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });

      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile: freshBuildDiscoveryProfile(request.context),
        queries: ['essence'],
        limit: freshInternals.resolveExternalSeedProviderLimit(request, 60),
        providerName: 'external_seeds',
        productProvider: 'external_seeds',
        stepName: 'external_seed_pool',
        label: 'external_seed_pool',
      });

	      expect(result.products).toHaveLength(5);
	      expect(dbQueryMock).toHaveBeenCalledTimes(6);
	      expect(result.recallSummary[0].external_seed_stage_counts.map((entry) => entry.stage)).toEqual([
	        'recall_indexed_category_head',
	        'recall_indexed_category_head',
	        'recall_exact_text_union',
	        'recall_exact_text_union',
	      ]);
	      expect(result.recallSummary[0].external_seed_stage_counts.map((entry) => entry.tool_scope)).toEqual([
	        '*',
	        'creator_agents',
	        '*',
	        'creator_agents',
	      ]);
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      jest.dontMock('../src/db');
      jest.resetModules();
    }
  });

  test('exact phrase browse later pages still continue past indexed head partials', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-exact-head-no-stop-page-2-test';
    const requiredColumns = [
      { table_name: 'products_cache', column_name: 'id' },
      { table_name: 'products_cache', column_name: 'merchant_id' },
      { table_name: 'products_cache', column_name: 'product_data' },
      { table_name: 'products_cache', column_name: 'expires_at' },
      { table_name: 'products_cache', column_name: 'cached_at' },
      { table_name: 'external_product_seeds', column_name: 'id' },
      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
      { table_name: 'external_product_seeds', column_name: 'destination_url' },
      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
      { table_name: 'external_product_seeds', column_name: 'title' },
      { table_name: 'external_product_seeds', column_name: 'seed_data' },
      { table_name: 'external_product_seeds', column_name: 'market' },
      { table_name: 'external_product_seeds', column_name: 'tool' },
      { table_name: 'external_product_seeds', column_name: 'status' },
      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
      { table_name: 'external_product_seeds', column_name: 'updated_at' },
      { table_name: 'external_product_seeds', column_name: 'created_at' },
    ];
    const requiredIndexes = [
      'idx_external_product_seeds_recall_title_trgm',
      'idx_external_product_seeds_recall_summary_trgm',
      'idx_external_product_seeds_recall_category_vertical_recency',
      'idx_external_product_seeds_recall_vertical_recency',
      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
      'idx_external_product_seeds_recall_alias_tokens_trgm',
    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));
    const headRows = Array.from({ length: 5 }, (_, index) =>
      makeExternalSeedRow({
        id: `essence_page2_head_${index + 1}`,
        title: `Water Essence ${index + 1}`,
        category: 'Essence',
        product_type: 'Essence',
        description: 'Hydrating water essence for daily use.',
      }),
    );
    const unionRows = [
      makeExternalSeedRow({
        id: 'essence_page2_union_1',
        title: 'Activating Essence Lotion',
        category: 'Essence',
        product_type: 'Essence',
        description: 'Hydrating essence lotion.',
      }),
    ];
	    const dbQueryMock = jest
	      .fn()
	      .mockResolvedValueOnce({ rows: requiredColumns })
	      .mockResolvedValueOnce({ rows: requiredIndexes })
	      .mockResolvedValueOnce({ rows: headRows })
	      .mockResolvedValueOnce({ rows: [] })
	      .mockResolvedValueOnce({ rows: unionRows })
	      .mockResolvedValue({ rows: [] });
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const {
        buildDiscoveryProfile: freshBuildDiscoveryProfile,
        _internals: freshInternals,
      } = require('../src/services/discoveryFeed');
      freshInternals.resetDiscoveryDependencyProbeCache();
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        page: 2,
        limit: 12,
        query: {
          text: 'essence',
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });

      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile: freshBuildDiscoveryProfile(request.context),
        queries: ['essence'],
        limit: freshInternals.resolveExternalSeedProviderLimit(request, 60),
        providerName: 'external_seeds',
        productProvider: 'external_seeds',
        stepName: 'external_seed_pool',
        label: 'external_seed_pool',
      });

	      expect(result.products).toHaveLength(6);
	      expect(dbQueryMock).toHaveBeenCalledTimes(6);
	      expect(result.recallSummary[0].external_seed_stage_counts.map((entry) => entry.stage)).toEqual([
	        'recall_indexed_category_head',
	        'recall_indexed_category_head',
	        'recall_exact_text_union',
	        'recall_exact_text_union',
	      ]);
	      expect(result.recallSummary[0].external_seed_stage_counts.map((entry) => entry.tool_scope)).toEqual([
	        '*',
	        'creator_agents',
	        '*',
	        'creator_agents',
	      ]);
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      jest.dontMock('../src/db');
      jest.resetModules();
    }
  });

  test('explicit narrow browse query skips broad category and vertical seed stages', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-narrow-query-stage-test';
    const requiredColumns = [
      { table_name: 'products_cache', column_name: 'id' },
      { table_name: 'products_cache', column_name: 'merchant_id' },
      { table_name: 'products_cache', column_name: 'product_data' },
      { table_name: 'products_cache', column_name: 'expires_at' },
      { table_name: 'products_cache', column_name: 'cached_at' },
      { table_name: 'external_product_seeds', column_name: 'id' },
      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
      { table_name: 'external_product_seeds', column_name: 'destination_url' },
      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
      { table_name: 'external_product_seeds', column_name: 'title' },
      { table_name: 'external_product_seeds', column_name: 'seed_data' },
      { table_name: 'external_product_seeds', column_name: 'market' },
      { table_name: 'external_product_seeds', column_name: 'tool' },
      { table_name: 'external_product_seeds', column_name: 'status' },
      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
      { table_name: 'external_product_seeds', column_name: 'updated_at' },
      { table_name: 'external_product_seeds', column_name: 'created_at' },
    ];
    const requiredIndexes = [
      'idx_external_product_seeds_recall_title_trgm',
      'idx_external_product_seeds_recall_summary_trgm',
      'idx_external_product_seeds_recall_category_vertical_recency',
      'idx_external_product_seeds_recall_vertical_recency',
      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
      'idx_external_product_seeds_recall_alias_tokens_trgm',
    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));
    const titleRows = [
      makeExternalSeedRow({
        id: 'vitamin_c_body_wash_exact',
        title: 'The Brightener Vitamin C Brightening Body Wash',
        category: 'Body Wash',
        product_type: 'Body Wash',
        description: 'Vitamin C brightening body wash.',
      }),
    ];
    const dbQueryMock = jest
      .fn()
      .mockResolvedValueOnce({ rows: requiredColumns })
      .mockResolvedValueOnce({ rows: requiredIndexes })
      .mockResolvedValueOnce({ rows: titleRows })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const {
        buildDiscoveryProfile: freshBuildDiscoveryProfile,
        _internals: freshInternals,
      } = require('../src/services/discoveryFeed');
      freshInternals.resetDiscoveryDependencyProbeCache();
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        page: 1,
        limit: 12,
        query: {
          text: 'vitamin c body wash',
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });

      expect(
        freshInternals.shouldSkipBroadStructuredSeedStagesForExplicitQuery(
          request,
          freshInternals.buildBeautyInterestRecallTerms(
            request,
            freshBuildDiscoveryProfile(request.context),
            ['vitamin c body wash'],
          ),
        ),
      ).toBe(true);

      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile: freshBuildDiscoveryProfile(request.context),
        queries: ['vitamin c body wash'],
        limit: freshInternals.resolveExternalSeedProviderLimit(request, 60),
        providerName: 'external_seeds',
        productProvider: 'external_seeds',
        stepName: 'external_seed_pool',
        label: 'external_seed_pool',
      });

      expect(result.products).toHaveLength(1);
      expect(result.products[0].title).toBe('The Brightener Vitamin C Brightening Body Wash');
      expect(dbQueryMock).toHaveBeenCalledTimes(3);
      expect(result.recallSummary[0]).toEqual(
        expect.objectContaining({
          external_seed_qualified_count: 1,
        }),
      );
      expect(result.recallSummary[0].external_seed_stage_counts.map((entry) => entry.stage)).toEqual([
        'recall_title',
      ]);
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      jest.dontMock('../src/db');
      jest.resetModules();
    }
  });

  test('exact phrase browse query uses indexed head synonyms and merged text union stage', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-exact-phrase-union-stage-test';
    const requiredColumns = [
      { table_name: 'products_cache', column_name: 'id' },
      { table_name: 'products_cache', column_name: 'merchant_id' },
      { table_name: 'products_cache', column_name: 'product_data' },
      { table_name: 'products_cache', column_name: 'expires_at' },
      { table_name: 'products_cache', column_name: 'cached_at' },
      { table_name: 'external_product_seeds', column_name: 'id' },
      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
      { table_name: 'external_product_seeds', column_name: 'destination_url' },
      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
      { table_name: 'external_product_seeds', column_name: 'title' },
      { table_name: 'external_product_seeds', column_name: 'seed_data' },
      { table_name: 'external_product_seeds', column_name: 'market' },
      { table_name: 'external_product_seeds', column_name: 'tool' },
      { table_name: 'external_product_seeds', column_name: 'status' },
      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
      { table_name: 'external_product_seeds', column_name: 'updated_at' },
      { table_name: 'external_product_seeds', column_name: 'created_at' },
    ];
    const requiredIndexes = [
      'idx_external_product_seeds_recall_title_trgm',
      'idx_external_product_seeds_recall_summary_trgm',
      'idx_external_product_seeds_recall_category_vertical_recency',
      'idx_external_product_seeds_recall_vertical_recency',
      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
      'idx_external_product_seeds_recall_alias_tokens_trgm',
    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));
    const unionRows = [
      makeExternalSeedRow({
        id: 'setting_spray_1',
        title: 'You Mist Makeup-Extending Setting Spray',
        category: 'Makeup Setting Spray',
        product_type: 'Setting Spray',
        description: 'Makeup fixing mist for long wear.',
      }),
      makeExternalSeedRow({
        id: 'fixing_mist_1',
        title: 'Makeup Fixing Mist',
        category: null,
        product_type: null,
        description: 'Set your makeup and make your look last longer with rose water and green tea.',
      }),
      makeExternalSeedRow({
        id: 'fixing_mist_bundle_noise',
        title: "Glow N' Blur Bundle",
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        description: 'Fan-favorite set includes a free Mini Makeup Fixing Mist.',
      }),
    ];
	    const dbQueryMock = jest
	      .fn()
	      .mockResolvedValueOnce({ rows: requiredColumns })
	      .mockResolvedValueOnce({ rows: requiredIndexes })
	      .mockResolvedValueOnce({ rows: [] })
	      .mockResolvedValueOnce({ rows: [] })
	      .mockResolvedValueOnce({ rows: unionRows })
	      .mockResolvedValue({ rows: [] });
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const {
        buildDiscoveryProfile: freshBuildDiscoveryProfile,
        _internals: freshInternals,
      } = require('../src/services/discoveryFeed');
      freshInternals.resetDiscoveryDependencyProbeCache();
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        page: 1,
        limit: 12,
        query: {
          text: 'setting spray',
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });
      const recallTerms = freshInternals.buildBeautyInterestRecallTerms(
        request,
        freshBuildDiscoveryProfile(request.context),
        ['setting spray'],
      );

      expect(freshInternals.resolveExplicitIndexedCategoryHeadTerms(request, recallTerms)).toEqual(
        expect.arrayContaining(['setting spray', 'makeup setting spray', 'fixing mist', 'makeup fixing mist']),
      );

      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile: freshBuildDiscoveryProfile(request.context),
        queries: ['setting spray'],
        limit: freshInternals.resolveExternalSeedProviderLimit(request, 60),
        providerName: 'external_seeds',
        productProvider: 'external_seeds',
        stepName: 'external_seed_pool',
        label: 'external_seed_pool',
      });

	      expect(result.products.map((product) => product.title)).toEqual([
	        'You Mist Makeup-Extending Setting Spray',
	        'Makeup Fixing Mist',
	      ]);
	      expect(dbQueryMock).toHaveBeenCalledTimes(6);
	      expect(dbQueryMock.mock.calls[4][0]).toContain('UNION ALL');
	      expect(dbQueryMock.mock.calls[4][1].flat()).toEqual(
	        expect.arrayContaining(['%fixing mist%', '%makeup fixing mist%']),
	      );
	      expect(dbQueryMock.mock.calls[4][0]).toContain("seed_data->'derived'->'recall'->>'retrieval_title'");
	      expect(dbQueryMock.mock.calls[4][0]).toContain("seed_data->'derived'->'recall'->>'retrieval_summary'");
	      expect(dbQueryMock.mock.calls[4][0]).toContain("seed_data#>>'{derived,recall,ingredient_tokens}'");
	      expect(dbQueryMock.mock.calls[4][0]).toContain("seed_data#>>'{derived,recall,alias_tokens}'");
	      expect(result.recallSummary[0].external_seed_stage_counts.map((entry) => entry.stage)).toEqual([
	        'recall_indexed_category_head',
	        'recall_indexed_category_head',
	        'recall_exact_text_union',
	        'recall_exact_text_union',
	      ]);
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      jest.dontMock('../src/db');
      jest.resetModules();
    }
  });

  test('browse_products debug mode records a non-blocking catalog serving shadow summary', async () => {
    jest.resetModules();
    process.env.CATALOG_SERVING_INDEX_BASE_URL = 'https://catalog-shadow.example';
    process.env.CATALOG_SERVING_INDEX_SHADOW_READ_ENABLED = 'true';
    process.env.DISCOVERY_SERVING_SHADOW_TIMEOUT_MS = '450';

    const searchCatalogServingIndexMock = jest.fn(async () => ({
      items: [
        { doc_id: 'source:external_seed:serum_1' },
        { doc_id: 'source:external_seed:serum_2' },
      ],
      cursor_info: {
        next_cursor: 'shadow-next',
        has_next_page: true,
        serving_mode: 'exhaustive',
      },
      source: 'opensearch_compatible',
    }));

    jest.doMock('../src/services/catalogServingIndex', () => {
      const actual = jest.requireActual('../src/services/catalogServingIndex');
      return {
        ...actual,
        getCatalogServingIndexConfig: () => ({
          base_url: 'https://catalog-shadow.example',
          index_name: 'catalog_public_v1',
          api_key: null,
          shadow_read_enabled: true,
          enabled: true,
        }),
        isCatalogServingIndexEnabled: () => true,
        searchCatalogServingIndex: searchCatalogServingIndexMock,
      };
    });

    try {
      const fresh = require('../src/services/discoveryFeed');
      const response = await fresh.getDiscoveryFeed(
        {
          surface: 'browse_products',
          limit: 2,
          debug: true,
          context: {
            auth_state: 'anonymous',
            locale: 'en-US',
            recent_views: [],
            recent_queries: [],
          },
        },
        {
          candidateProducts: [
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'serum_1',
              title: 'Barrier Serum',
              brand: 'KraveBeauty',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'serum_2',
              title: 'Hydrating Serum',
              brand: 'Byoma',
              category: 'Skincare',
              product_type: 'Serum',
            }),
          ],
        },
      );

      expect(searchCatalogServingIndexMock).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 2,
          market: 'US',
          timeout_ms: 450,
        }),
      );
      expect(response.metadata.shadow_serving_summary).toEqual(
        expect.objectContaining({
          mode: 'shadow',
          status: 'ok',
          market: 'US',
          runtime_returned: 2,
          shadow_returned: 2,
          overlap_count: 2,
          overlap_ratio: 1,
          source: 'opensearch_compatible',
        }),
      );
    } finally {
      jest.dontMock('../src/services/catalogServingIndex');
    }
  });

  test('browse_products debug mode does not read local shadow when the external serving index is disabled', async () => {
    jest.resetModules();
    const prevBaseUrl = process.env.CATALOG_SERVING_INDEX_BASE_URL;
    const prevShadowReadEnabled = process.env.CATALOG_SERVING_INDEX_SHADOW_READ_ENABLED;
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.CATALOG_SERVING_INDEX_BASE_URL = '';
    process.env.CATALOG_SERVING_INDEX_SHADOW_READ_ENABLED = 'true';
    process.env.DATABASE_URL = 'postgres://catalog-shadow.test/pivota';

    const searchCatalogServingIndexMock = jest.fn(async () => ({
      items: [{ doc_id: 'source:external_seed:serum_1' }],
      cursor_info: {
        next_cursor: null,
        has_next_page: false,
        serving_mode: 'exhaustive',
      },
      source: 'local_shadow',
    }));

    jest.doMock('../src/services/catalogServingIndex', () => {
      const actual = jest.requireActual('../src/services/catalogServingIndex');
      return {
        ...actual,
        getCatalogServingIndexConfig: () => ({
          base_url: '',
          index_name: 'catalog_public_v1',
          api_key: null,
          shadow_read_enabled: true,
          enabled: false,
        }),
        isCatalogServingIndexEnabled: () => false,
        searchCatalogServingIndex: searchCatalogServingIndexMock,
      };
    });

    try {
      const fresh = require('../src/services/discoveryFeed');
      const response = await fresh.getDiscoveryFeed(
        {
          surface: 'browse_products',
          limit: 2,
          debug: true,
          context: {
            auth_state: 'anonymous',
            locale: 'en-US',
            recent_views: [],
            recent_queries: [],
          },
        },
        {
          candidateProducts: [
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'serum_1',
              title: 'Barrier Serum',
              brand: 'KraveBeauty',
              category: 'Skincare',
              product_type: 'Serum',
            }),
          ],
        },
      );

      expect(searchCatalogServingIndexMock).not.toHaveBeenCalled();
      expect(response.metadata.shadow_serving_summary).toBeUndefined();
    } finally {
      jest.dontMock('../src/services/catalogServingIndex');
      if (prevBaseUrl === undefined) delete process.env.CATALOG_SERVING_INDEX_BASE_URL;
      else process.env.CATALOG_SERVING_INDEX_BASE_URL = prevBaseUrl;
      if (prevShadowReadEnabled === undefined) delete process.env.CATALOG_SERVING_INDEX_SHADOW_READ_ENABLED;
      else process.env.CATALOG_SERVING_INDEX_SHADOW_READ_ENABLED = prevShadowReadEnabled;
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });

  test('browse_products uses stable catalog count from db when available and keeps runtime pool in metadata', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://browse-count-test';

    const dbQueryMock = jest.fn(async (sql) => {
      const text = String(sql || '');
      if (text.includes('COUNT(DISTINCT') && text.includes('FROM filtered')) {
        return { rows: [{ total: 37 }] };
      }
      return { rows: [] };
    });

    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const fresh = require('../src/services/discoveryFeed');
      const response = await fresh.getDiscoveryFeed(
        {
          surface: 'browse_products',
          page: 1,
          limit: 4,
          context: {
            auth_state: 'anonymous',
            locale: 'en-US',
            recent_views: [
              {
                merchant_id: 'm1',
                product_id: 'recent_alpha',
                title: 'Alpha Repair Serum',
                brand: 'Alpha',
                category: 'Skincare',
                product_type: 'Serum',
                viewed_at: '2026-04-11T10:00:00Z',
              },
            ],
            recent_queries: [],
          },
        },
        {
          candidateProducts: [
            makeProduct({
              merchant_id: 'm1',
              product_id: 'recent_alpha',
              title: 'Alpha Repair Serum',
              brand: 'Alpha',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            makeProduct({
              merchant_id: 'm2',
              product_id: 'alpha_2',
              title: 'Alpha Barrier Cream',
              brand: 'Alpha',
              category: 'Skincare',
              product_type: 'Cream',
            }),
            makeProduct({
              merchant_id: 'm3',
              product_id: 'beta_1',
              title: 'Beta Repair Serum',
              brand: 'Beta',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            makeProduct({
              merchant_id: 'm4',
              product_id: 'gamma_1',
              title: 'Gamma Recovery Toner',
              brand: 'Gamma',
              category: 'Skincare',
              product_type: 'Toner',
            }),
            makeProduct({
              merchant_id: 'm5',
              product_id: 'delta_1',
              title: 'Delta Gel Cream',
              brand: 'Delta',
              category: 'Skincare',
              product_type: 'Moisturizer',
            }),
          ],
        },
      );

      expect(response.total).toBe(37);
      expect(response.metadata).toEqual(
        expect.objectContaining({
          corpus_total_count: 37,
          runtime_corpus_count: 5,
          eligible_pool_count: 4,
          count_source: 'stable_catalog_identity_grouped',
        }),
      );
      const countQueries = dbQueryMock.mock.calls
        .map(([sql]) => String(sql || ''))
        .filter((text) => text.includes('COUNT(DISTINCT') && text.includes('FROM filtered'));
      expect(countQueries).toHaveLength(1);
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });

  test('stable browse catalog count falls back to source listing count when identity graph table is missing', async () => {
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://browse-count-fallback-test';
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      page: 1,
      limit: 24,
      query: {
        text: 'Great Barrier',
      },
      scope: {
        brand_names: ['KraveBeauty'],
        categories: ['Serum'],
      },
      context: {
        auth_state: 'anonymous',
        locale: 'en-US',
        recent_views: [],
        recent_queries: [],
      },
    });

    const queryFn = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('relation "pdp_identity_listing" does not exist'), { code: '42P01' }))
      .mockResolvedValueOnce({ rows: [{ total: 29 }] });

    const result = await _internals.countStableBrowseCatalogTotal(request, {
      queryFn,
      useCache: false,
    });

    try {
      expect(result).toEqual({
        total: 29,
        source: 'stable_catalog_source_listing',
      });
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(String(queryFn.mock.calls[0][0])).toContain('LEFT JOIN pdp_identity_listing pil');
      expect(String(queryFn.mock.calls[1][0])).not.toContain('LEFT JOIN pdp_identity_listing pil');
      expect(String(queryFn.mock.calls[1][0])).toContain('FROM external_product_seeds eps');
      expect(String(queryFn.mock.calls[1][0])).toContain('FROM products_cache pc');
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });

  test('browse_products overlaps stable catalog count with candidate loading instead of serializing both waits', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://browse-count-parallel-test';

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const dbQueryMock = jest.fn(async (sql) => {
      const text = String(sql || '');
      if (text.includes('COUNT(DISTINCT') && text.includes('FROM filtered')) {
        await sleep(120);
        return { rows: [{ total: 240 }] };
      }
      return { rows: [] };
    });

    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const fresh = require('../src/services/discoveryFeed');
      const externalProducts = Array.from({ length: 120 }, (_, idx) =>
        makeProduct({
          merchant_id: 'external_seed',
          product_id: `parallel_external_${idx + 1}`,
          title: `Parallel Serum ${idx + 1}`,
          brand: `Seed ${idx + 1}`,
          category: 'Skincare',
          product_type: 'Serum',
        }),
      );
      const externalSpy = jest.fn(async () => {
        await sleep(120);
        return externalProducts;
      });

      const startedAt = Date.now();
      const response = await fresh.getDiscoveryFeed(
        {
          surface: 'browse_products',
          page: 1,
          limit: 24,
          context: {
            auth_state: 'anonymous',
            locale: 'en-US',
            recent_views: [],
            recent_queries: [],
          },
        },
        {
          providerOverrides: {
            external_seeds: externalSpy,
          },
        },
      );
      const elapsedMs = Date.now() - startedAt;

      expect(response.total).toBe(240);
      expect(response.metadata).toEqual(
        expect.objectContaining({
          primary_path_used: 'external_seed_fastpath',
          count_source: 'stable_catalog_identity_grouped',
        }),
      );
      expect(externalSpy).toHaveBeenCalled();
      expect(elapsedMs).toBeLessThan(220);
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });

  test('explicit browse query skips stable catalog count and uses runtime corpus total', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://browse-query-count-skip-test';

    const dbQueryMock = jest.fn(async (sql) => {
      const text = String(sql || '');
      if (text.includes('COUNT(DISTINCT') && text.includes('FROM filtered')) {
        throw new Error('stable count should not run for explicit query browse');
      }
      return { rows: [] };
    });

    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const fresh = require('../src/services/discoveryFeed');
      const response = await fresh.getDiscoveryFeed(
        {
          surface: 'browse_products',
          page: 1,
          limit: 4,
          query: { text: 'lip balm' },
          context: {
            auth_state: 'anonymous',
            locale: 'en-US',
            recent_views: [],
            recent_queries: [],
          },
        },
        {
          candidateProducts: Array.from({ length: 5 }, (_, idx) =>
            makeProduct({
              merchant_id: 'external_seed',
              product_id: `lip_balm_${idx + 1}`,
              title: `Lip Balm ${idx + 1}`,
              brand: `Brand ${idx + 1}`,
              category: 'Lip Care',
              product_type: 'Lip Balm',
            }),
          ),
        },
      );

      expect(response.total).toBe(5);
      expect(response.metadata).toEqual(
        expect.objectContaining({
          corpus_total_count: 5,
          runtime_corpus_count: 5,
          count_source: 'runtime_corpus_query_scoped',
        }),
      );
      const countQueries = dbQueryMock.mock.calls
        .map(([sql]) => String(sql || ''))
        .filter((text) => text.includes('COUNT(DISTINCT') && text.includes('FROM filtered'));
      expect(countQueries).toHaveLength(0);
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });

  test('cold start browse does not backfill deferred domains onto later pages when non-deferred results exist', async () => {
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 2,
        limit: 4,
        debug: true,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        candidateProducts: [
          makeProduct({
            merchant_id: 'm1',
            product_id: 'beauty_1',
            title: 'Barrier Repair Serum',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm2',
            product_id: 'beauty_2',
            title: 'Vitamin C Glow Serum',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm3',
            product_id: 'beauty_3',
            title: 'Ceramide Recovery Cream',
            category: 'Skincare',
            product_type: 'Cream',
          }),
          makeProduct({
            merchant_id: 'm4',
            product_id: 'beauty_4',
            title: 'Niacinamide Refining Treatment',
            category: 'Skincare',
            product_type: 'Treatment',
          }),
          makeProduct({
            merchant_id: 'm5',
            product_id: 'pet_1',
            title: 'Dog Rain Jacket',
            category: 'Pet',
            product_type: 'Apparel',
          }),
          makeProduct({
            merchant_id: 'm6',
            product_id: 'sleep_1',
            title: 'Cloud Sleepwear Set',
            category: 'Sleepwear',
            product_type: 'Pajama',
          }),
          makeProduct({
            merchant_id: 'm7',
            product_id: 'lingerie_1',
            title: 'Lace Bodysuit Set',
            category: 'Lingerie',
            product_type: 'Bodysuit',
          }),
          makeProduct({
            merchant_id: 'm8',
            product_id: 'tool_1',
            title: 'Precision Blending Brush',
            category: 'Beauty Tools',
            product_type: 'Brush',
          }),
          makeProduct({
            merchant_id: 'm9',
            product_id: 'beauty_5',
            title: 'Peptide Firming Serum',
            category: 'Skincare',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'm10',
            product_id: 'beauty_6',
            title: 'Gentle Barrier Cleanser',
            category: 'Skincare',
            product_type: 'Cleanser',
          }),
        ],
      },
    );

    expect(response.products.map((product) => product.product_id)).toEqual(['beauty_5', 'beauty_6']);
    expect(response.total).toBe(6);
    const decisions = new Map(
      response.metadata.rank_debug.top_candidates.map((candidate) => [candidate.product_id, candidate.decision]),
    );
    expect(decisions.get('pet_1')).toBe('filtered_cold_start_domain');
    expect(decisions.get('sleep_1')).toBe('filtered_cold_start_domain');
    expect(decisions.get('lingerie_1')).toBe('filtered_cold_start_domain');
    expect(decisions.get('tool_1')).toBe('filtered_cold_start_domain');
  });

  test('beauty interest mainline can succeed via external seeds even when products/search is unavailable', async () => {
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;

    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 4,
        debug: true,
        context: {
          auth_state: 'authenticated',
          locale: 'en-US',
          recent_views: [
            {
              merchant_id: 'm1',
              product_id: 'recent_alpha',
              title: 'Barrier Repair Serum',
              brand: 'Alpha',
              category: 'Skincare',
              product_type: 'Serum',
              viewed_at: '2026-04-04T10:00:00Z',
            },
          ],
          recent_queries: ['niacinamide serum'],
        },
      },
      {
        providerOverrides: {
          internal_catalog: async () => [],
          external_seeds: async () => [
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'seed_1',
              title: 'Niacinamide Recovery Serum',
              brand: 'Seeded',
              category: 'Skincare',
              product_type: 'Serum',
              canonical_url: 'https://example.com/niacinamide-recovery-serum',
            }),
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'seed_2',
              title: 'Barrier Repair Toner',
              brand: 'Seeded',
              category: 'Skincare',
              product_type: 'Toner',
              canonical_url: 'https://example.com/barrier-repair-toner',
            }),
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'seed_3',
              title: 'Calming Recovery Cream',
              brand: 'Seeded',
              category: 'Skincare',
              product_type: 'Cream',
              canonical_url: 'https://example.com/calming-recovery-cream',
            }),
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'seed_4',
              title: 'Vitamin C Brightening Serum',
              brand: 'Seeded',
              category: 'Skincare',
              product_type: 'Serum',
              canonical_url: 'https://example.com/vitamin-c-brightening-serum',
            }),
          ],
        },
      },
    );

    expect(response.products).toHaveLength(4);
    expect(response.metadata.candidate_source).toBe('beauty_interest_mainline');
    expect(response.metadata.primary_path_used).toBe('beauty_interest_mainline');
    expect(response.metadata.fallback_triggered).toBe(false);
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'beauty_interest_mainline', successful: true, returned: 4 }),
        expect.objectContaining({ provider: 'products_search', skipped: true }),
        expect.objectContaining({ provider: 'external_seeds', skipped: true }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'external_seeds', label: 'beauty_interest_mainline', status: 200 }),
      ]),
    );
  });

  test('beauty interest mainline short-circuits multi-provider expansion when external beauty candidates are sufficient', async () => {
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;

    const internalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'm_internal',
        product_id: 'internal_1',
        title: 'Winona Soothing Repair Serum',
        brand: 'Winona',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);

    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 4,
        debug: true,
        context: {
          auth_state: 'authenticated',
          recent_views: [],
          recent_queries: ['niacinamide serum', 'vitamin c serum'],
        },
      },
      {
        providerOverrides: {
          beauty_interest_mainline: async () => [
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'seed_1',
              title: 'Niacinamide Recovery Serum',
              brand: 'Seeded',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'seed_2',
              title: 'Vitamin C Brightening Serum',
              brand: 'Seeded',
              category: 'Skincare',
              product_type: 'Serum',
            }),
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'seed_3',
              title: 'Barrier Repair Cream',
              brand: 'Seeded',
              category: 'Skincare',
              product_type: 'Cream',
            }),
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'seed_4',
              title: 'Calming Hydration Toner',
              brand: 'Seeded',
              category: 'Skincare',
              product_type: 'Toner',
            }),
          ],
          internal_catalog: internalSpy,
        },
      },
    );

    expect(response.metadata.discovery_strategy).toBe('personalized_interest');
    expect(response.metadata.candidate_source).toBe('beauty_interest_mainline');
    expect(response.metadata.primary_path_used).toBe('beauty_interest_mainline');
    expect(response.metadata.fallback_triggered).toBe(false);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'beauty_interest_mainline', successful: true, returned: 4 }),
        expect.objectContaining({ provider: 'products_search', skipped: true }),
        expect.objectContaining({ provider: 'internal_catalog', skipped: true }),
        expect.objectContaining({ provider: 'external_seeds', skipped: true }),
      ]),
    );
  });

  test('beauty interest mainline covers personalized browse page 2 before falling back', async () => {
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;

    const beautyMainlineSpy = jest.fn(async ({ limit }) =>
      Array.from({ length: limit }, (_, idx) =>
        makeProduct({
          merchant_id: 'external_seed',
          product_id: `seed_page_2_${idx + 1}`,
          title: `Niacinamide Serum ${idx + 1}`,
          brand: `Seeded ${idx + 1}`,
          category: 'Skincare',
          product_type: 'Serum',
          canonical_url: `https://example.com/niacinamide-serum-${idx + 1}`,
        }),
      ),
    );
    const internalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'm_internal',
        product_id: 'internal_1',
        title: 'Winona Soothing Repair Serum',
        brand: 'Winona',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 2,
        limit: 24,
        debug: true,
        context: {
          auth_state: 'authenticated',
          recent_views: [],
          recent_queries: ['niacinamide serum', 'vitamin c serum'],
        },
      },
      {
        providerOverrides: {
          beauty_interest_mainline: beautyMainlineSpy,
          internal_catalog: internalSpy,
        },
      },
    );

    expect(beautyMainlineSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: expect.any(Number) }),
    );
    expect(beautyMainlineSpy.mock.calls[0][0].limit).toBeGreaterThanOrEqual(48);
    expect(response.products).toHaveLength(24);
    expect(response.products.every((product) => product.merchant_id === 'external_seed')).toBe(true);
    expect(response.metadata.candidate_source).toBe('beauty_interest_mainline');
    expect(response.metadata.primary_path_used).toBe('beauty_interest_mainline');
    expect(response.metadata.fallback_triggered).toBe(false);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'beauty_interest_mainline', successful: true }),
        expect.objectContaining({ provider: 'products_search', skipped: true }),
        expect.objectContaining({ provider: 'internal_catalog', skipped: true }),
        expect.objectContaining({ provider: 'external_seeds', skipped: true }),
      ]),
    );
  });

  test('cold start discovery falls back to discovery-specific products/search after cold-start fastpath underfills', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://wrong-backend.test';
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'bridge-key';

    const products = Array.from({ length: 24 }, (_, idx) =>
      makeProduct({
        merchant_id: `m${idx + 1}`,
        product_id: `serum_${idx + 1}`,
        title: `Barrier Repair Serum ${idx + 1}`,
        brand: `Brand ${idx + 1}`,
        category: 'Skincare',
        product_type: 'Serum',
      }),
    );
    const externalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'external_1',
        title: 'External Rescue Serum',
        brand: 'Seeded',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);

    nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query(true)
      .times(2)
      .reply(200, { products });

    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 4,
        debug: true,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        providerOverrides: {
          internal_catalog: async () => [],
          external_seeds: externalSpy,
        },
      },
    );

    expect(response.products).toHaveLength(4);
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(response.metadata.candidate_source).toBe('external_seed_fastpath+products_search');
    expect(response.metadata.primary_path_used).toBe('external_seed_fastpath');
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'products_search', successful: true }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'anonymous_cold_start_internal_disabled',
        }),
        expect.objectContaining({ provider: 'external_seeds', successful: true, returned: 1 }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'external_seeds',
          label: 'external_seed_pool_fastpath',
          status: 200,
        }),
      ]),
    );
  });

  test('query-only personalized browse stops after current page coverage and skips slow supplemental providers', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://wrong-backend.test';
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'bridge-key';

    const primaryProducts = Array.from({ length: 13 }, (_, idx) =>
      makeProduct({
        merchant_id: `m${idx + 1}`,
        product_id: `personalized_serum_${idx + 1}`,
        title: `Niacinamide Serum ${idx + 1}`,
        brand: `Beauty Brand ${idx + 1}`,
        category: 'Skincare',
        product_type: 'Serum',
      }),
    );
    const internalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'merch_internal',
        product_id: 'internal_personalized_1',
        title: 'Winona Soothing Repair Serum',
        brand: 'Winona',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);
    const externalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'external_personalized_1',
        title: 'External Barrier Serum',
        brand: 'Seeded',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);

    nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query((query) => String(query.query || '') === 'niacinamide serum')
      .reply(200, { products: primaryProducts });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        context: {
          auth_state: 'authenticated',
          locale: 'en-US',
          recent_views: [],
          recent_queries: ['niacinamide serum', 'vitamin c serum'],
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(response.products).toHaveLength(12);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(nock.isDone()).toBe(true);
    expect(response.metadata.discovery_strategy).toBe('personalized_interest');
    expect(response.metadata.personalization_source).toBe('account_history');
    expect(response.metadata.candidate_source).toBe('beauty_interest_mainline+multi_provider');
    expect(response.metadata.primary_path_used).toBe('beauty_interest_mainline');
    expect(response.metadata.fallback_triggered).toBe(true);
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'beauty_interest_mainline', successful: true, returned: 1 }),
        expect.objectContaining({ provider: 'products_search', successful: true }),
        expect.objectContaining({ provider: 'internal_catalog', skipped: true }),
        expect.objectContaining({ provider: 'external_seeds', skipped: true }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'external_seeds',
          label: 'beauty_interest_mainline',
          returned: 1,
          status: 200,
        }),
        expect.objectContaining({
          provider: 'products_search',
          label: 'browse_pool',
          query: 'niacinamide serum',
          returned: 13,
        }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'sufficient_personalized_primary_candidates',
        }),
        expect.objectContaining({
          provider: 'external_seeds',
          skipped: true,
          skip_reason: 'sufficient_personalized_primary_candidates',
        }),
      ]),
    );
  });

  test('generic no-signal browse short-circuits provider expansion when primary beauty candidates are already sufficient', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://wrong-backend.test';
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'bridge-key';

    const primaryProducts = Array.from({ length: 12 }, (_, idx) =>
      makeProduct({
        merchant_id: 'external_seed',
        product_id: `external_${idx + 1}`,
        title: `Barrier Repair Serum ${idx + 1}`,
        brand: idx < 4 ? 'PIXI BEAUTY' : `Brand ${idx + 1}`,
        category: 'Skincare',
        product_type: 'Serum',
      }),
    );
    const internalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'merch_internal',
        product_id: 'internal_1',
        title: 'Winona Soothing Repair Serum',
        brand: 'Winona',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);
    const externalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'external_fallback_1',
        title: 'External Fallback Serum',
        brand: 'Seeded',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);

    nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, { products: primaryProducts });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        debug: true,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(response.products).toHaveLength(12);
    expect(response.products.every((product) => product.merchant_id === 'external_seed')).toBe(true);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(response.metadata.candidate_source).toBe('external_seed_fastpath+products_search');
    expect(response.metadata.primary_path_used).toBe('external_seed_fastpath');
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'products_search', successful: true }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'anonymous_cold_start_internal_disabled',
        }),
        expect.objectContaining({ provider: 'external_seeds', successful: true }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'external_seeds',
          label: 'external_seed_pool_fastpath',
          status: 200,
        }),
      ]),
    );
  });

  test('logged-in browse with no recent signal also short-circuits provider expansion', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://wrong-backend.test';
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'bridge-key';

    const primaryProducts = Array.from({ length: 27 }, (_, idx) =>
      makeProduct({
        merchant_id: 'external_seed',
        product_id: `external_auth_${idx + 1}`,
        title: `Glow Serum ${idx + 1}`,
        brand: idx < 6 ? 'PIXI BEAUTY' : `Brand ${idx + 1}`,
        category: 'Skincare',
        product_type: 'Serum',
      }),
    );
    const internalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'merch_internal',
        product_id: 'internal_auth_1',
        title: 'The Ordinary Niacinamide 10% + Zinc 1%',
        brand: 'The Ordinary',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);
    const externalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'external_auth_fallback_1',
        title: 'Fallback Serum',
        brand: 'Seeded',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);

    nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, { products: primaryProducts });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 2,
        limit: 12,
        debug: true,
        context: {
          auth_state: 'authenticated',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(response.products).toHaveLength(12);
    expect(response.products.every((product) => product.merchant_id === 'external_seed')).toBe(true);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(response.metadata.candidate_source).toBe('external_seed_fastpath+products_search');
    expect(response.metadata.primary_path_used).toBe('external_seed_fastpath');
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'products_search', successful: true }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'anonymous_cold_start_internal_disabled',
        }),
        expect.objectContaining({ provider: 'external_seeds', successful: true }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'external_seeds',
          label: 'external_seed_pool_fastpath',
          status: 200,
        }),
      ]),
    );
  });

  test('logged-in browse short-circuits provider expansion when primary pool already covers the requested tail page', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://wrong-backend.test';
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'bridge-key';

    const primaryProducts = Array.from({ length: 19 }, (_, idx) =>
      makeProduct({
        merchant_id: 'external_seed',
        product_id: `external_tail_${idx + 1}`,
        title: `Glow Serum ${idx + 1}`,
        brand: idx < 8 ? 'PIXI BEAUTY' : `Brand ${idx + 1}`,
        category: 'Skincare',
        product_type: 'Serum',
      }),
    );
    const internalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'merch_internal',
        product_id: 'internal_tail_1',
        title: 'The Ordinary Niacinamide 10% + Zinc 1%',
        brand: 'The Ordinary',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);
    const externalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'external_tail_fallback_1',
        title: 'Fallback Serum',
        brand: 'Seeded',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);

    nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, { products: primaryProducts });

    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 2,
        limit: 12,
        debug: true,
        context: {
          auth_state: 'authenticated',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        providerOverrides: {
          internal_catalog: internalSpy,
          external_seeds: externalSpy,
        },
      },
    );

    expect(response.products).toHaveLength(8);
    expect(response.products.every((product) => product.merchant_id === 'external_seed')).toBe(true);
    expect(internalSpy).not.toHaveBeenCalled();
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(response.metadata.candidate_source).toBe('external_seed_fastpath+products_search');
    expect(response.metadata.primary_path_used).toBe('external_seed_fastpath');
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'products_search', successful: true }),
        expect.objectContaining({
          provider: 'internal_catalog',
          skipped: true,
          skip_reason: 'anonymous_cold_start_internal_disabled',
        }),
        expect.objectContaining({ provider: 'external_seeds', successful: true }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'external_seeds',
          label: 'external_seed_pool_fastpath',
          status: 200,
        }),
      ]),
    );
  });

  test('cold start discovery still loads external seeds when primary pools are numerically sufficient but tool-heavy', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://discovery-catalog.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://wrong-backend.test';
    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_API_KEY;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'bridge-key';

    const products = Array.from({ length: 24 }, (_, idx) =>
      makeProduct({
        merchant_id: `m${idx + 1}`,
        product_id: `tool_${idx + 1}`,
        title: `Precision Makeup Brush ${idx + 1}`,
        brand: `BrushLab ${idx + 1}`,
        category: 'Beauty Tools',
        product_type: 'Brush',
      }),
    );
    const externalSpy = jest.fn(async () => [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'external_1',
        title: 'External Rescue Serum',
        brand: 'Seeded',
        category: 'Skincare',
        product_type: 'Serum',
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'external_2',
        title: 'External Barrier Cream',
        brand: 'Seeded',
        category: 'Skincare',
        product_type: 'Cream',
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'external_3',
        title: 'External Recovery Toner',
        brand: 'Seeded',
        category: 'Skincare',
        product_type: 'Toner',
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'external_4',
        title: 'External Vitamin C Serum',
        brand: 'Seeded',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    ]);

    nock('http://discovery-catalog.test')
      .matchHeader('x-agent-api-key', 'bridge-key')
      .matchHeader('x-api-key', 'bridge-key')
      .get('/agent/v1/products/search')
      .query(true)
      .times(2)
      .reply(200, { products });

    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 4,
        debug: true,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        providerOverrides: {
          internal_catalog: async () => [],
          external_seeds: externalSpy,
        },
      },
    );

    expect(externalSpy).toHaveBeenCalled();
    expect(response.metadata.candidate_source).toBe('external_seed_fastpath');
    expect(response.metadata.primary_path_used).toBe('external_seed_fastpath');
    expect(response.products.map((product) => product.product_id)).toEqual(
      expect.arrayContaining(['external_1', 'external_4']),
    );
    expect(response.metadata.provider_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          skipped: true,
          skip_reason: 'anonymous_cold_start_fastpath_sufficient',
        }),
        expect.objectContaining({ provider: 'external_seeds', successful: true, returned: 4 }),
      ]),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'external_seeds', label: 'external_seed_pool_fastpath', status: 200 }),
      ]),
    );
  });

	  test('anonymous cold-start fastpath skips summary-stage DB recall when generic recall terms miss', async () => {
	    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-fastpath-test';
    const dbQueryMock = jest.fn(async () => ({ rows: [] }));
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const { _internals: freshInternals } = require('../src/services/discoveryFeed');
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'home_hot_deals',
        limit: 4,
        page: 1,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });

      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile: {
          hasInterestSignals: false,
        },
        queries: ['niacinamide serum'],
        limit: 4,
        providerName: 'external_seeds',
        productProvider: 'beauty_interest_mainline',
        stepName: 'beauty_interest_mainline',
        label: 'external_seed_pool_fastpath',
      });

      expect(result.products).toEqual([]);
      expect(dbQueryMock).toHaveBeenCalledTimes(2);
      expect(
        dbQueryMock.mock.calls.every(
          (call) => !String(call?.[0] || '').includes("'recall_summary'::text AS match_stage"),
        ),
      ).toBe(true);
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
	    }
	  });

		  test('explicit compound browse continues DB stages until qualified rows fill target', async () => {
		    jest.resetModules();
	    const prevDatabaseUrl = process.env.DATABASE_URL;
	    process.env.DATABASE_URL = 'postgres://discovery-compound-stage-test';
	    const requiredColumns = [
	      { table_name: 'products_cache', column_name: 'id' },
	      { table_name: 'products_cache', column_name: 'merchant_id' },
	      { table_name: 'products_cache', column_name: 'product_data' },
	      { table_name: 'products_cache', column_name: 'expires_at' },
	      { table_name: 'products_cache', column_name: 'cached_at' },
	      { table_name: 'external_product_seeds', column_name: 'id' },
	      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
	      { table_name: 'external_product_seeds', column_name: 'destination_url' },
	      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
	      { table_name: 'external_product_seeds', column_name: 'title' },
	      { table_name: 'external_product_seeds', column_name: 'seed_data' },
	      { table_name: 'external_product_seeds', column_name: 'market' },
	      { table_name: 'external_product_seeds', column_name: 'tool' },
	      { table_name: 'external_product_seeds', column_name: 'status' },
	      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
	      { table_name: 'external_product_seeds', column_name: 'updated_at' },
	      { table_name: 'external_product_seeds', column_name: 'created_at' },
	    ];
	    const requiredIndexes = [
	      'idx_external_product_seeds_recall_title_trgm',
	      'idx_external_product_seeds_recall_summary_trgm',
	      'idx_external_product_seeds_recall_category_vertical_recency',
	      'idx_external_product_seeds_recall_vertical_recency',
	      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
	      'idx_external_product_seeds_recall_alias_tokens_trgm',
	    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));
	    const junkRows = Array.from({ length: 12 }, (_, index) =>
	      makeExternalSeedRow({
	        id: `junk_${index + 1}`,
	        title: `High Shine Shampoo ${index + 1}`,
	        category: 'Shampoo',
	        product_type: 'Shampoo',
	        description: 'Cleanses hair with camellia oil for shine.',
	      }),
	    );
	    const exactRows = Array.from({ length: 24 }, (_, index) =>
	      makeExternalSeedRow({
	        id: `oil_${index + 1}`,
	        title: `Beauty Oil ${index + 1}`,
	        category: 'Haircare',
	        product_type: 'Haircare',
	        description: 'Lightweight hair oil for glossy ends.',
	      }),
	    );
	    const dbQueryMock = jest
	      .fn()
	      .mockResolvedValueOnce({ rows: requiredColumns })
	      .mockResolvedValueOnce({ rows: requiredIndexes })
	      .mockResolvedValueOnce({ rows: [...junkRows, ...exactRows] });
	    jest.doMock('../src/db', () => ({
	      query: dbQueryMock,
	    }));

	    try {
	      const { buildDiscoveryProfile: freshBuildDiscoveryProfile, _internals: freshInternals } = require('../src/services/discoveryFeed');
	      freshInternals.resetDiscoveryDependencyProbeCache();
	      const request = freshInternals.normalizeDiscoveryRequest({
	        surface: 'browse_products',
	        page: 1,
	        limit: 12,
	        query: {
	          text: 'hair oil',
	        },
	        context: {
	          auth_state: 'anonymous',
	          locale: 'en-US',
	          recent_views: [],
	          recent_queries: [],
	        },
	      });

	      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
	        request,
	        profile: freshBuildDiscoveryProfile(request.context),
	        queries: ['hair oil'],
	        limit: freshInternals.resolveExternalSeedProviderLimit(request, 36),
	        providerName: 'external_seeds',
	        productProvider: 'external_seeds',
	        stepName: 'external_seed_pool',
	        label: 'external_seed_pool',
	      });

	      expect(result.products).toHaveLength(24);
	      expect(result.products.every((product) => /Beauty Oil/.test(product.title))).toBe(true);
	      expect(dbQueryMock).toHaveBeenCalledTimes(3);
	      expect(result.recallSummary[0]).toEqual(
	        expect.objectContaining({
	          compound_intent: 'hair_oil',
	          external_seed_qualified_count: 24,
	          external_seed_filtered_compound_count: 12,
	        }),
	      );
	      expect(result.recallSummary[0].external_seed_stage_counts).toEqual(
	        expect.arrayContaining([
	          expect.objectContaining({
	            stage: 'recall_compound_hair_oil_main',
	            raw_rows: 36,
	            compound_qualified_rows: 24,
	          }),
	        ]),
	      );
	    } finally {
	      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
	      else process.env.DATABASE_URL = prevDatabaseUrl;
		    }
		  });

  test('explicit compound browse continues past first-page coverage until qualified target', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-compound-exact-stop-test';
    const requiredColumns = [
      { table_name: 'products_cache', column_name: 'id' },
      { table_name: 'products_cache', column_name: 'merchant_id' },
      { table_name: 'products_cache', column_name: 'product_data' },
      { table_name: 'products_cache', column_name: 'expires_at' },
      { table_name: 'products_cache', column_name: 'cached_at' },
      { table_name: 'external_product_seeds', column_name: 'id' },
      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
      { table_name: 'external_product_seeds', column_name: 'destination_url' },
      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
      { table_name: 'external_product_seeds', column_name: 'title' },
      { table_name: 'external_product_seeds', column_name: 'seed_data' },
      { table_name: 'external_product_seeds', column_name: 'market' },
      { table_name: 'external_product_seeds', column_name: 'tool' },
      { table_name: 'external_product_seeds', column_name: 'status' },
      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
      { table_name: 'external_product_seeds', column_name: 'updated_at' },
      { table_name: 'external_product_seeds', column_name: 'created_at' },
    ];
    const requiredIndexes = [
      'idx_external_product_seeds_recall_title_trgm',
      'idx_external_product_seeds_recall_summary_trgm',
      'idx_external_product_seeds_recall_category_vertical_recency',
      'idx_external_product_seeds_recall_vertical_recency',
      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
      'idx_external_product_seeds_recall_alias_tokens_trgm',
    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));
    const primaryRows = Array.from({ length: 12 }, (_, index) =>
      makeExternalSeedRow({
        id: `lip_oil_primary_${index + 1}`,
        title: `Glow Lip Oil Primary ${index + 1}`,
        category: 'Lip Oil',
        product_type: 'Lip Oil',
        description: 'A glossy lip oil.',
      }),
    );
    const exactRows = Array.from({ length: 12 }, (_, index) =>
      makeExternalSeedRow({
        id: `lip_oil_exact_${index + 1}`,
        title: `Glow Lip Oil Exact ${index + 1}`,
        category: 'Lip Oil',
        product_type: 'Lip Oil',
        description: 'A glossy lip oil.',
      }),
    );
	    const dbQueryMock = jest
	      .fn()
	      .mockResolvedValueOnce({ rows: requiredColumns })
	      .mockResolvedValueOnce({ rows: requiredIndexes })
	      .mockResolvedValueOnce({ rows: primaryRows })
	      .mockResolvedValueOnce({ rows: [] })
	      .mockResolvedValueOnce({ rows: exactRows });
    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const { buildDiscoveryProfile: freshBuildDiscoveryProfile, _internals: freshInternals } = require('../src/services/discoveryFeed');
      freshInternals.resetDiscoveryDependencyProbeCache();
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        page: 1,
        limit: 12,
        query: {
          text: 'lip oil',
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });

      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile: freshBuildDiscoveryProfile(request.context),
        queries: ['lip oil'],
        limit: freshInternals.resolveExternalSeedProviderLimit(request, 36),
        providerName: 'external_seeds',
        productProvider: 'external_seeds',
        stepName: 'external_seed_pool',
        label: 'external_seed_pool',
      });

	      expect(result.products).toHaveLength(24);
	      expect(dbQueryMock).toHaveBeenCalledTimes(5);
	      expect(dbQueryMock.mock.calls[2][1].at(-1)).toBe(36);
	      expect(result.recallSummary[0].external_seed_stage_counts).toEqual(
	        expect.arrayContaining([
	          expect.objectContaining({
	            stage: 'recall_compound_primary_category',
	            raw_rows: 12,
	            compound_qualified_rows: 12,
	          }),
	          expect.objectContaining({
	            stage: 'recall_compound_primary_category',
	            tool_scope: 'creator_agents',
	            raw_rows: 0,
	            final_eligible_rows: 12,
	          }),
	          expect.objectContaining({
	            stage: 'recall_compound_exact_title',
	            raw_rows: 12,
            compound_qualified_rows: 12,
            final_eligible_rows: 24,
          }),
        ]),
      );
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      jest.dontMock('../src/db');
      jest.resetModules();
    }
  });

  test('explicit beauty compound intent recognizes face wash, hair mask, dry shampoo, and scalp serum', () => {
    expect(_internals.resolveExplicitBeautyCompoundIntent('face wash')).toBe('face_wash');
    expect(_internals.resolveExplicitBeautyCompoundIntent('hair mask')).toBe('hair_mask');
    expect(_internals.resolveExplicitBeautyCompoundIntent('dry shampoo')).toBe('dry_shampoo');
    expect(_internals.resolveExplicitBeautyCompoundIntent('scalp serum')).toBe('scalp_serum');

    const request = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      query: {
        text: 'face wash',
      },
      context: {
        auth_state: 'anonymous',
        recent_views: [],
        recent_queries: [],
        locale: 'en-US',
      },
    });
    const profile = buildDiscoveryProfile(request.context);
    const recallTerms = _internals.buildBeautyInterestRecallTerms(request, profile, ['face wash']);

    expect(recallTerms.compoundIntent).toBe('face_wash');
    expect(recallTerms.primaryCategoryTerms).toEqual(expect.arrayContaining(['face wash']));
    expect(recallTerms.weakCategoryTerms).toEqual(expect.arrayContaining(['cleanser']));
    expect(recallTerms.verticalTerms).toEqual(expect.arrayContaining(['skincare']));
  });

  test('new compound beauty matchers keep exact intent and reject broad noise', () => {
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Foaming Face Wash',
            external_seed_recall: {
              retrieval_title: 'foaming face wash',
              category: 'Face Wash',
              vertical: 'Skincare',
            },
          },
          category: 'face wash',
          parentCategory: 'skincare',
        },
        'face_wash',
      ),
    ).toBe(true);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Oud Wood Hand and Body Wash',
            external_seed_recall: {
              retrieval_title: 'oud wood hand and body wash',
              category: 'Body Wash',
              vertical: 'Skincare',
            },
          },
          category: 'body wash',
          parentCategory: 'skincare',
        },
        'face_wash',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Round Foundation Brush',
            external_seed_recall: {
              retrieval_title: 'round foundation brush',
              category: 'Tool',
              vertical: 'Makeup',
            },
          },
          category: 'tool',
          parentCategory: 'makeup',
        },
        'face_wash',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Intensive Repair Hair Mask',
            external_seed_recall: {
              retrieval_title: 'intensive repair hair mask',
              category: 'Hair Mask',
              vertical: 'Haircare',
            },
          },
          category: 'hair mask',
          parentCategory: 'haircare',
        },
        'hair_mask',
      ),
    ).toBe(true);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'The Imposter Invisi-Boost Volumizing Dry Shampoo Powder',
            external_seed_recall: {
              retrieval_title: 'the imposter invisi-boost volumizing dry shampoo powder',
              category: 'Dry Shampoo',
              vertical: 'Haircare',
            },
          },
          category: 'dry shampoo',
          parentCategory: 'haircare',
        },
        'dry_shampoo',
      ),
    ).toBe(true);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Oil Control Duo: Dry Shampoo',
            external_seed_recall: {
              retrieval_title: 'oil control duo dry shampoo',
              category: 'Dry Shampoo',
              vertical: 'Haircare',
            },
          },
          category: 'dry shampoo',
          parentCategory: 'haircare',
        },
        'dry_shampoo',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Rosemary Scalp Serum',
            external_seed_recall: {
              retrieval_title: 'rosemary scalp serum',
              category: 'Scalp Treatment',
              vertical: 'Haircare',
            },
          },
          category: 'scalp treatment',
          parentCategory: 'haircare',
        },
        'scalp_serum',
      ),
    ).toBe(true);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Natural Moisturizing Factors + HA For Scalp',
            external_seed_recall: {
              retrieval_title: 'natural moisturizing factors + ha for scalp',
              category: 'Serum',
              vertical: 'Haircare',
              retrieval_summary: 'A lightweight hydrating serum for the scalp.',
            },
          },
          category: 'serum',
          parentCategory: 'haircare',
        },
        'scalp_serum',
      ),
    ).toBe(true);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Complete Pre-Wash Scalp Oil',
            external_seed_recall: {
              retrieval_title: 'complete pre-wash scalp oil',
              category: 'Hair Oil',
              vertical: 'Haircare',
            },
          },
          category: 'hair oil',
          parentCategory: 'haircare',
        },
        'scalp_serum',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Brow Harmony Flexible Lifting Gel',
            external_seed_recall: {
              retrieval_title: 'brow harmony flexible lifting gel',
              category: null,
              vertical: 'Makeup',
            },
          },
          category: null,
          parentCategory: 'makeup',
        },
        'brow_gel',
      ),
    ).toBe(true);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Brow MVP Ultra Fine Brow Pencil & Styler',
            external_seed_recall: {
              retrieval_title: 'brow mvp ultra fine brow pencil and styler',
              category: null,
              vertical: 'Makeup',
            },
          },
          category: null,
          parentCategory: 'makeup',
        },
        'brow_gel',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Detangling Leave-in Hair Milk',
            external_seed_recall: {
              retrieval_title: 'detangling leave-in hair milk',
              category: 'Hair Milk',
              vertical: 'Haircare',
            },
          },
          category: 'hair milk',
          parentCategory: 'haircare',
        },
        'leave_in_conditioner',
      ),
    ).toBe(true);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'The Rich One Moisture Repair Conditioner',
            external_seed_recall: {
              retrieval_title: 'the rich one moisture repair conditioner',
              category: 'Conditioner',
              vertical: 'Haircare',
            },
          },
          category: 'conditioner',
          parentCategory: 'haircare',
        },
        'leave_in_conditioner',
      ),
    ).toBe(false);
  });

  test('hair oil compound matcher rejects exact-phrase shampoo fragrance and accessory noise', () => {
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Shine Hair Oil Shampoo',
            external_seed_recall: {
              retrieval_title: 'shine hair oil shampoo',
              category: 'Shampoo',
              vertical: 'Hair Care',
            },
          },
          category: 'shampoo',
          parentCategory: 'hair care',
        },
        'hair_oil',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Hair Oil Fragrance Mist',
            external_seed_recall: {
              retrieval_title: 'hair oil fragrance mist',
              category: 'Fragrance Mist',
              vertical: 'Fragrance',
            },
          },
          category: 'fragrance mist',
          parentCategory: 'hair care',
        },
        'hair_oil',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Hair Oil Clip Set',
            external_seed_recall: {
              retrieval_title: 'hair oil clip set',
              category: 'Accessories',
              vertical: 'Hair Care',
            },
          },
          category: 'accessories',
          parentCategory: 'hair care',
        },
        'hair_oil',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Rosemary Hair Oil',
            external_seed_recall: {
              retrieval_title: 'rosemary hair oil',
              category: 'Haircare',
              vertical: 'Haircare',
            },
          },
          category: 'haircare',
          parentCategory: 'haircare',
        },
        'hair_oil',
      ),
	    ).toBe(true);
	  });

  test('compound matcher keeps hair oil summary recall and rejects lip bundle noise', () => {
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Huile Prodigieuse® Florale',
            description: 'Precious botanical oils nourish face, body and hair in a single step.',
            external_seed_recall: {
              retrieval_title: 'Huile Prodigieuse® Florale',
              retrieval_summary: 'Nourish, replenish and beautify the skin of your face, body and your hair with botanical oils.',
              vertical: 'haircare',
            },
          },
          category: 'haircare',
          parentCategory: 'haircare',
        },
        'hair_oil',
      ),
    ).toBe(true);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Intense Nourishing Cream',
            description: 'Nourishes hair with camellia oil.',
            external_seed_recall: {
              retrieval_title: 'Intense Nourishing Cream',
              retrieval_summary: 'Transform your hair with camellia oil.',
              vertical: 'haircare',
            },
          },
          category: 'haircare',
          parentCategory: 'haircare',
        },
        'hair_oil',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Hydrating Recovery Oil',
            description: 'This ultra-lightweight oil nourishes, brightens and balances skin.',
            external_seed_recall: {
              retrieval_title: 'Hydrating Recovery Oil',
              retrieval_summary: 'This ultra-lightweight oil nourishes, brightens and balances skin.',
              retrieval_body: 'Supports the skin barrier with botanical oils including jojoba and rosehip.',
              vertical: 'haircare',
            },
          },
          category: 'external',
          parentCategory: '',
        },
        'hair_oil',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Intensive Repair Hair Mask',
            description: 'A reparative mask with botanical oils for dry hair.',
            external_seed_recall: {
              retrieval_title: 'Intensive Repair Hair Mask',
              retrieval_summary: 'A reparative mask with botanical oils for dry hair.',
              category: 'Treatment',
              vertical: 'haircare',
            },
          },
          category: 'treatment',
          parentCategory: 'haircare',
        },
        'hair_oil',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Detangling Leave-in Hair Milk',
            description: 'Softens hair with nourishing plant oils.',
            external_seed_recall: {
              retrieval_title: 'Detangling Leave-in Hair Milk',
              retrieval_summary: 'Softens hair with nourishing plant oils.',
              category: 'Treatment',
              vertical: 'haircare',
            },
          },
          category: 'treatment',
          parentCategory: 'haircare',
        },
        'hair_oil',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Moisturizing Set',
            description: 'Includes an Ultra-Nourishing Lip Balm and dry oil.',
            external_seed_recall: {
              retrieval_title: 'Moisturizing Set',
              retrieval_summary: 'Includes an Ultra-Nourishing Lip Balm and dry oil.',
              vertical: 'makeup',
            },
          },
          category: 'lip balm',
          parentCategory: 'makeup',
        },
        'lip_balm',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Lip Oil Gift Set',
            external_seed_recall: {
              retrieval_title: 'Lip Oil Gift Set',
              vertical: 'makeup',
            },
          },
          category: 'makeup',
          parentCategory: 'makeup',
        },
        'lip_oil',
      ),
    ).toBe(false);
    expect(
      _internals.matchesBeautyCompoundQueryIntent(
        {
          raw: {
            title: 'Protective & Nourishing Lip Balm',
            external_seed_recall: {
              retrieval_title: 'Protective & Nourishing Lip Balm',
              vertical: 'makeup',
            },
          },
          category: 'lip balm',
          parentCategory: 'makeup',
        },
        'lip_balm',
      ),
    ).toBe(true);
  });

  test('hair oil weak external seed stages can use summary oil signals', () => {
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      query: {
        text: 'hair oil',
      },
      context: {
        auth_state: 'anonymous',
        recent_views: [],
        recent_queries: [],
        locale: 'en-US',
      },
    });
    const profile = buildDiscoveryProfile(request.context);
    const recallTerms = _internals.buildBeautyInterestRecallTerms(request, profile, ['hair oil']);
    const stages = _internals.buildCompoundBeautySeedStageDefinitions(recallTerms, 120);
    const hairOilMainStage = stages.find((stage) => stage.stage === 'recall_compound_hair_oil_main');
    const boundValues = [];
    const sql = hairOilMainStage.buildWhereSql((value) => {
      boundValues.push(value);
      return `$${boundValues.length}`;
    });

    expect(recallTerms.compoundPositiveTitleTokens).toEqual(expect.arrayContaining(['oil', 'huile']));
    expect(sql).toContain("seed_data->'derived'->'recall'->>'retrieval_summary'");
    expect(boundValues.flat()).toEqual(expect.arrayContaining(['%oil%', '%huile%']));
  });

  test('hair oil provider preserves full stored recall body for compound filtering', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-hair-oil-recall-body-test';
    const requiredColumns = [
      { table_name: 'products_cache', column_name: 'id' },
      { table_name: 'products_cache', column_name: 'merchant_id' },
      { table_name: 'products_cache', column_name: 'product_data' },
      { table_name: 'products_cache', column_name: 'expires_at' },
      { table_name: 'products_cache', column_name: 'cached_at' },
      { table_name: 'external_product_seeds', column_name: 'id' },
      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
      { table_name: 'external_product_seeds', column_name: 'destination_url' },
      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
      { table_name: 'external_product_seeds', column_name: 'title' },
      { table_name: 'external_product_seeds', column_name: 'seed_data' },
      { table_name: 'external_product_seeds', column_name: 'market' },
      { table_name: 'external_product_seeds', column_name: 'tool' },
      { table_name: 'external_product_seeds', column_name: 'status' },
      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
      { table_name: 'external_product_seeds', column_name: 'updated_at' },
      { table_name: 'external_product_seeds', column_name: 'created_at' },
    ];
    const requiredIndexes = [
      'idx_external_product_seeds_recall_title_trgm',
      'idx_external_product_seeds_recall_summary_trgm',
      'idx_external_product_seeds_recall_category_vertical_recency',
      'idx_external_product_seeds_recall_vertical_recency',
      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
      'idx_external_product_seeds_recall_alias_tokens_trgm',
    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));
    const hairOilRow = {
      id: 'eps_huile_or_florale',
      external_product_id: 'ext_huile_or_florale',
      destination_url: 'https://us.nuxe.com/products/huile-prodigieuse-or-florale-1',
      canonical_url: 'https://us.nuxe.com/products/huile-prodigieuse-or-florale-1',
      domain: 'us.nuxe.com',
      title: 'Huile Prodigieuse® Or Florale',
      image_url: 'https://cdn.example.com/huile.jpg',
      price_amount: 34,
      price_currency: 'USD',
      availability: 'in_stock',
      updated_at: '2026-04-12T10:00:00Z',
      created_at: '2026-04-12T09:00:00Z',
      seed_brand: 'NUXE',
      seed_category: '',
      seed_product_type: '',
      seed_description:
        'This shimmering dry oil with natural-origin pearly particles infuses all skin types with an iridescent glow.',
      seed_recall: {
        retrieval_title: 'Huile Prodigieuse® Or Florale',
        retrieval_summary:
          'This shimmering dry oil with natural-origin pearly particles infuses all skin types with an iridescent glow.',
        retrieval_body:
          'This shimmering dry oil moisturizes, gives a satin feel and illuminates the face, body and hair in a single step.',
        brand: 'NUXE',
        category: null,
        vertical: 'haircare',
        alias_tokens: ['huile', 'prodigieuse', 'or', 'florale'],
      },
    };
    const dbQueryMock = jest
      .fn()
      .mockResolvedValueOnce({ rows: requiredColumns })
      .mockResolvedValueOnce({ rows: requiredIndexes })
      .mockResolvedValueOnce({ rows: [hairOilRow] })
      .mockResolvedValueOnce({ rows: [] });

    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const {
        buildDiscoveryProfile: freshBuildDiscoveryProfile,
        _internals: freshInternals,
      } = require('../src/services/discoveryFeed');
      freshInternals.resetDiscoveryDependencyProbeCache();
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        page: 1,
        limit: 12,
        query: {
          text: 'hair oil',
        },
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });

      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile: freshBuildDiscoveryProfile(request.context),
        queries: ['hair oil'],
        limit: 24,
        providerName: 'external_seeds',
        productProvider: 'external_seeds',
        stepName: 'external_seed_pool',
        label: 'external_seed_pool',
      });

      expect(result.products).toHaveLength(1);
      expect(result.products[0].title).toBe('Huile Prodigieuse® Or Florale');
      expect(result.recallSummary[0].external_seed_stage_counts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: 'recall_compound_hair_oil_main',
            raw_rows: 1,
            compound_qualified_rows: 1,
            deduped_rows: 1,
          }),
        ]),
      );
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      jest.dontMock('../src/db');
      jest.resetModules();
    }
  });

  test('lip oil external seed stages do not use summary recall', () => {
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      query: {
        text: 'lip oil',
      },
      context: {
        auth_state: 'anonymous',
        recent_views: [],
        recent_queries: [],
        locale: 'en-US',
      },
    });
    const profile = buildDiscoveryProfile(request.context);
    const recallTerms = _internals.buildBeautyInterestRecallTerms(request, profile, ['lip oil']);
    const stages = _internals.buildCompoundBeautySeedStageDefinitions(recallTerms, 120);

    expect(stages.map((stage) => stage.stage)).not.toContain('recall_compound_summary');
  });

			  test('anonymous generic browse fastpath uses indexed curated head instead of lexical DB stages', async () => {
    jest.resetModules();
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://discovery-fastpath-test';
    const requiredColumns = [
      { table_name: 'products_cache', column_name: 'id' },
      { table_name: 'products_cache', column_name: 'merchant_id' },
      { table_name: 'products_cache', column_name: 'product_data' },
      { table_name: 'products_cache', column_name: 'expires_at' },
      { table_name: 'products_cache', column_name: 'cached_at' },
      { table_name: 'external_product_seeds', column_name: 'id' },
      { table_name: 'external_product_seeds', column_name: 'external_product_id' },
      { table_name: 'external_product_seeds', column_name: 'destination_url' },
      { table_name: 'external_product_seeds', column_name: 'canonical_url' },
      { table_name: 'external_product_seeds', column_name: 'title' },
      { table_name: 'external_product_seeds', column_name: 'seed_data' },
      { table_name: 'external_product_seeds', column_name: 'market' },
      { table_name: 'external_product_seeds', column_name: 'tool' },
      { table_name: 'external_product_seeds', column_name: 'status' },
      { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
      { table_name: 'external_product_seeds', column_name: 'updated_at' },
      { table_name: 'external_product_seeds', column_name: 'created_at' },
    ];
    const requiredIndexes = [
      'idx_external_product_seeds_recall_title_trgm',
      'idx_external_product_seeds_recall_summary_trgm',
      'idx_external_product_seeds_recall_category_vertical_recency',
      'idx_external_product_seeds_recall_vertical_recency',
      'idx_external_product_seeds_recall_ingredient_tokens_trgm',
      'idx_external_product_seeds_recall_alias_tokens_trgm',
    ].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));

    const makeSeedRow = (id, vertical = 'skincare', category = 'Skincare') => ({
      id,
      external_product_id: `seed_${id}`,
      destination_url: `https://example.com/products/${id}`,
      canonical_url: `https://example.com/products/${id}`,
      domain: 'beauty',
      title: `${category} Product ${id}`,
      image_url: `https://example.com/images/${id}.jpg`,
      price_amount: 24,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        snapshot: {
          title: `${category} Product ${id}`,
          brand: 'Alpha',
          category,
          product_type: category,
          description: `${category} ${id}`,
          destination_url: `https://example.com/products/${id}`,
          canonical_url: `https://example.com/products/${id}`,
          image_url: `https://example.com/images/${id}.jpg`,
          price_amount: 24,
          price_currency: 'USD',
          availability: 'in_stock',
        },
        derived: {
          recall: {
            retrieval_title: `${category} Product ${id}`,
            retrieval_summary: `${category} ${id}`,
            brand: 'Alpha',
            category,
            vertical,
          },
        },
      },
    });
    const makeSeedRows = (startId, count, vertical, category) =>
      Array.from({ length: count }, (_, index) => makeSeedRow(startId + index, vertical, category));

    const dbQueryMock = jest
      .fn()
      .mockResolvedValueOnce({
        rows: requiredColumns,
      })
      .mockResolvedValueOnce({
        rows: requiredIndexes,
      })
      .mockResolvedValueOnce({
        rows: makeSeedRows(1, 48, 'skincare', 'Skincare'),
      })
      .mockResolvedValueOnce({
        rows: makeSeedRows(49, 30, 'makeup', 'Makeup'),
      })
      .mockResolvedValueOnce({
        rows: makeSeedRows(79, 19, 'haircare', 'Haircare'),
      })
      .mockResolvedValueOnce({
        rows: makeSeedRows(98, 12, 'fragrance', 'Fragrance'),
      })
      .mockResolvedValueOnce({
        rows: makeSeedRows(110, 7, 'bodycare', 'Bodycare'),
      })
      .mockResolvedValueOnce({
        rows: makeSeedRows(117, 4, 'beauty_tools', 'Beauty Tools'),
      });

    jest.doMock('../src/db', () => ({
      query: dbQueryMock,
    }));

    try {
      const { _internals: freshInternals } = require('../src/services/discoveryFeed');
      freshInternals.resetDiscoveryDependencyProbeCache();
      const request = freshInternals.normalizeDiscoveryRequest({
        surface: 'browse_products',
        page: 1,
        limit: 60,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });

      const result = await freshInternals.fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile: {
          hasInterestSignals: false,
        },
        queries: ['niacinamide serum'],
        limit: 120,
        providerName: 'external_seeds',
        productProvider: 'beauty_interest_mainline',
        stepName: 'external_seed_pool_fastpath',
        label: 'external_seed_pool_fastpath',
      });

      expect(result.products).toHaveLength(120);
      expect(dbQueryMock).toHaveBeenCalledTimes(8);
      const curatedSql = String(dbQueryMock.mock.calls[2]?.[0] || '');
      expect(curatedSql).toContain("'generic_browse_curated_head'::text AS match_stage");
      for (const call of dbQueryMock.mock.calls.slice(2)) {
        const sql = String(call?.[0] || '');
        expect(sql).not.toContain('LIKE ANY');
        expect(sql).not.toContain('UNION ALL');
        expect(sql).not.toContain('row_number() OVER');
        expect(sql).not.toContain('tool = ANY');
        expect(sql).not.toContain("'recall_title'::text AS match_stage");
        expect(sql).not.toContain("'recall_tokens'::text AS match_stage");
      }
      expect(result.recallSummary[0].external_seed_stage_counts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: 'generic_browse_curated_head',
            tool_scope: '*',
            match_axis: 'vertical',
            match_value: 'skincare',
            stage_quota: 48,
            raw_rows: 48,
            deduped_rows: 48,
            final_eligible_rows: 48,
          }),
          expect.objectContaining({
            stage: 'generic_browse_curated_head',
            tool_scope: '*',
            match_axis: 'vertical',
            match_value: 'makeup',
            stage_quota: 30,
            raw_rows: 30,
            deduped_rows: 30,
            final_eligible_rows: 78,
          }),
          expect.objectContaining({
            stage: 'generic_browse_curated_head',
            tool_scope: '*',
            match_axis: 'vertical',
            match_value: 'beauty_tools',
            stage_quota: 4,
            raw_rows: 4,
            deduped_rows: 4,
            final_eligible_rows: 120,
          }),
        ]),
      );
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });

  test('anonymous browse first page prefetches beyond a single page for generic runtime browsing', async () => {
    const prevDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    const externalProducts = Array.from({ length: 240 }, (_, idx) =>
      makeProduct({
        merchant_id: 'external_seed',
        product_id: `external_page1_${idx + 1}`,
        title: `Niacinamide Serum ${idx + 1}`,
        brand: `Seeded ${idx + 1}`,
        category: 'Skincare',
        product_type: 'Serum',
      }),
    );
    const externalSpy = jest.fn(async ({ limit }) => externalProducts.slice(0, limit));

    try {
      const response = await getDiscoveryFeed(
        {
          surface: 'browse_products',
          page: 1,
          limit: 60,
          context: {
            auth_state: 'anonymous',
            locale: 'en-US',
            recent_views: [],
            recent_queries: [],
          },
        },
        {
          providerOverrides: {
            external_seeds: externalSpy,
          },
        },
      );

      expect(externalSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 120,
        }),
      );
      expect(response.products).toHaveLength(60);
      expect(response.metadata).toEqual(
        expect.objectContaining({
          primary_path_used: 'external_seed_fastpath',
          eligible_pool_count: 120,
          runtime_corpus_count: 120,
          has_more: true,
          serving_mode: 'curated_head',
        }),
      );
      expect(response.cursor_info).toEqual(
        expect.objectContaining({
          has_next_page: true,
          serving_mode: 'curated_head',
        }),
      );
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });

  test('anonymous browse deep pages expand fastpath beyond the legacy 120 candidate ceiling', async () => {
    const prevDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    const externalProducts = Array.from({ length: 240 }, (_, idx) =>
      makeProduct({
        merchant_id: 'external_seed',
        product_id: `external_${idx + 1}`,
        title: `Niacinamide Serum ${idx + 1}`,
        brand: `Seeded ${idx + 1}`,
        category: 'Skincare',
        product_type: 'Serum',
      }),
    );
    const externalSpy = jest.fn(async ({ limit }) => externalProducts.slice(0, limit));

    try {
      const response = await getDiscoveryFeed(
        {
          surface: 'browse_products',
          page: 3,
          limit: 60,
          context: {
            auth_state: 'anonymous',
            locale: 'en-US',
            recent_views: [],
            recent_queries: [],
          },
        },
        {
          providerOverrides: {
            external_seeds: externalSpy,
          },
        },
      );

      expect(externalSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 240,
        }),
      );
      expect(response.products).toHaveLength(60);
      expect(response.products[0].product_id).toBe('external_121');
      expect(response.metadata).toEqual(
        expect.objectContaining({
          primary_path_used: 'external_seed_fastpath',
          eligible_pool_count: 240,
          runtime_corpus_count: 240,
          has_more: false,
          serving_mode: 'curated_head',
        }),
      );
      expect(response.cursor_info).toEqual(
        expect.objectContaining({
          has_next_page: false,
          serving_mode: 'curated_head',
        }),
      );
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });

  test('generic discovery semantically dedupes duplicate tool titles across providers', async () => {
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;

    const response = await getDiscoveryFeed(
      {
        surface: 'home_hot_deals',
        limit: 4,
        debug: true,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      },
      {
        providerOverrides: {
          external_seeds: async () => [
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'tool_external_1',
              title: 'Makeup Brush Everyday Essential',
              brand: 'BrushLab',
              category: 'Beauty Tools',
              product_type: 'Brush',
            }),
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'serum_external_1',
              title: 'Barrier Repair Serum',
              brand: 'Alpha',
              category: 'Skincare',
              product_type: 'Serum',
              canonical_url: 'https://example.com/barrier-repair-serum',
            }),
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'cream_external_1',
              title: 'Calming Recovery Cream',
              brand: 'Beta',
              category: 'Skincare',
              product_type: 'Cream',
              canonical_url: 'https://example.com/calming-recovery-cream',
            }),
            makeProduct({
              merchant_id: 'external_seed',
              product_id: 'toner_external_1',
              title: 'Hydrating Skin Toner',
              brand: 'Gamma',
              category: 'Skincare',
              product_type: 'Toner',
              canonical_url: 'https://example.com/hydrating-skin-toner',
            }),
          ],
        },
      },
    );

    expect(response.products.map((product) => product.title)).toEqual(
      expect.arrayContaining([
        'Barrier Repair Serum',
        'Calming Recovery Cream',
        'Hydrating Skin Toner',
      ]),
    );
    expect(
      response.products.filter((product) => String(product.title || '').includes('Makeup Brush Everyday Essential')),
    ).toHaveLength(0);
    expect(response.metadata.candidate_counts.raw).toBe(4);
    expect(
      _internals.buildDiscoveryProviderMergeKey(
        makeProduct({
          merchant_id: 'm1',
          product_id: 'tool_internal_1',
          title: 'Makeup Brush Everyday Essential',
          brand: 'BrushLab',
          category: 'Beauty Tools',
          product_type: 'Brush',
        }),
      ),
    ).toBe(
      _internals.buildDiscoveryProviderMergeKey(
        makeProduct({
          merchant_id: 'external_seed',
          product_id: 'tool_external_1',
          title: 'Makeup Brush Everyday Essential',
          brand: 'BrushLab',
          category: 'Beauty Tools',
          product_type: 'Brush',
        }),
      ),
    );
  });

  test('throws when products/search catalog is unavailable and mock mode is not explicitly enabled', async () => {
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.PIVOTA_API_BASE;

    let caught = null;
    try {
      await getDiscoveryFeed({
        surface: 'home_hot_deals',
        limit: 3,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DiscoveryCatalogUnavailableError);
    expect(caught.details).toEqual(
      expect.objectContaining({
        providerBreakdown: expect.any(Array),
        recallSummary: expect.any(Array),
        candidateSource: expect.any(String),
      }),
    );

    const snapshot = getLastDiscoverySnapshot('home_hot_deals');
    expect(snapshot).toEqual(
      expect.objectContaining({
        surface: 'home_hot_deals',
        status: 'catalog_unavailable',
        candidate_source: 'multi_provider',
        error_code: 'DISCOVERY_CATALOG_UNAVAILABLE',
      }),
    );

    const metrics = renderDiscoveryMetricsPrometheus();
    expect(metrics).toContain(
      'discovery_feed_requests_total{candidate_source="multi_provider",personalization_source="none",reason="discovery_catalog_unavailable",status="catalog_unavailable",strategy="cold_start_curated",surface="home_hot_deals"} 1',
    );
  });
});
