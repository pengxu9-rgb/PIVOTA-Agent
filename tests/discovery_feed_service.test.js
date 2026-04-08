const nock = require('nock');
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
      DISCOVERY_RECALL_BUDGET_MS: process.env.DISCOVERY_RECALL_BUDGET_MS,
      DISCOVERY_POOL_CACHE_TTL_MS: process.env.DISCOVERY_POOL_CACHE_TTL_MS,
    };
    resetDiscoveryMetricsForTest();
    _internals.resetBrowsePoolCache();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
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

  test('brand-scoped discovery falls back to source-product recommendations when brand pool is empty', async () => {
    let recommendCalls = 0;
    const response = await getDiscoveryFeed(
      {
        surface: 'browse_products',
        page: 1,
        limit: 12,
        sort: 'popular',
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

    expect(response.products.map((product) => product.product_id)).toEqual([
      'rose_prick',
      'electric_cherry',
    ]);
    expect(response.metadata.candidate_source).toBe('override+brand_recommendation_fallback');
    expect(recommendCalls).toBe(1);
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
      }),
    );
    expect(response.products[0]).not.toHaveProperty('variants');
    expect(response.products[0]).not.toHaveProperty('image_urls');
    expect(response.products[0]).not.toHaveProperty('raw_detail');
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
      expect(dbQueryMock).toHaveBeenCalledTimes(4);
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

    await expect(
      getDiscoveryFeed({
        surface: 'home_hot_deals',
        limit: 3,
        context: {
          auth_state: 'anonymous',
          locale: 'en-US',
          recent_views: [],
          recent_queries: [],
        },
      }),
    ).rejects.toBeInstanceOf(DiscoveryCatalogUnavailableError);

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
