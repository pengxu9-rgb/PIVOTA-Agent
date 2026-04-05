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
    status: 'active',
  };
}

describe('discovery feed service', () => {
  let previousEnv;

  beforeEach(() => {
    previousEnv = {
      PIVOTA_BACKEND_BASE_URL: process.env.PIVOTA_BACKEND_BASE_URL,
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
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
        expect.objectContaining({ label: 'browse_pool' }),
      ]),
    );
    expect(String(homePlan[1].query || '').trim()).not.toBe('');
    expect(String(browsePlan[0].query || '').trim()).not.toBe('');
    expect(browsePlan[0].query).toMatch(/skincare|serum/i);
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

  test('brand-scoped discovery falls back to source-product recommendations when brand pool is empty', async () => {
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
        brandFallbackRecommendFn: async () => ({
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
        }),
      },
    );

    expect(response.products.map((product) => product.product_id)).toEqual([
      'rose_prick',
      'electric_cherry',
    ]);
    expect(response.metadata.candidate_source).toBe('products_search+brand_recommendation_fallback');
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
        candidate_counts: {
          raw: 6,
          normalized: 6,
          scored: 6,
          eligible_pool: 5,
          returned: 4,
        },
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
        candidate_source: 'products_search',
        rank_debug: expect.any(Object),
      }),
    );
    expect(response.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'interest_pool', status: 200, latency_ms: expect.any(Number) }),
        expect.objectContaining({ label: 'browse_pool', status: 200, latency_ms: expect.any(Number) }),
      ]),
    );
    expect(capturedParams.some((params) => String(params.query || '').trim().length > 0)).toBe(true);
    expect(capturedParams).toHaveLength(2);
    const metrics = renderDiscoveryMetricsPrometheus();
    expect(metrics).toContain(
      'discovery_feed_recall_requests_total{cache_hit="false",status="success",step="interest_pool",surface="home_hot_deals"} 1',
    );
    expect(metrics).toContain(
      'discovery_feed_recall_requests_total{cache_hit="false",status="success",step="browse_pool",surface="home_hot_deals"} 1',
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

    expect(callCount).toBe(2);
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
        expect.objectContaining({ label: 'browse_pool' }),
      ]),
    );
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
        expect.objectContaining({ label: 'browse_pool' }),
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
    expect(String(capturedParams[0]?.query || '').toLowerCase()).toContain('alpha');
    expect(String(capturedParams[1]?.query || '').toLowerCase()).toContain('alpha');
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
    expect(topCandidates.find((candidate) => candidate.product_id === 'tool_1')?.decision).toBe('filtered_beauty_bucket');
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
        candidate_source: 'products_search',
        error_code: 'DISCOVERY_CATALOG_UNAVAILABLE',
      }),
    );

    const metrics = renderDiscoveryMetricsPrometheus();
    expect(metrics).toContain(
      'discovery_feed_requests_total{candidate_source="products_search",personalization_source="none",reason="discovery_catalog_unavailable",status="catalog_unavailable",strategy="cold_start_curated",surface="home_hot_deals"} 1',
    );
  });
});
