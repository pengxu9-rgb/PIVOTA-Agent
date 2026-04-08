const {
  buildAuthHeaders,
  buildRecentView,
  deriveRecentQuery,
  normalizeBaseUrl,
  normalizeEndpoint,
  pickSeedProduct,
  validateDiscoveryResponse,
} = require('../scripts/run_discovery_feed_smoke.cjs');

describe('run_discovery_feed_smoke helpers', () => {
  test('normalizes base URL and endpoint values', () => {
    expect(normalizeBaseUrl('https://example.com///')).toBe('https://example.com');
    expect(normalizeEndpoint('agent/shop/v1/invoke')).toBe('/agent/shop/v1/invoke');
  });

  test('builds auth headers only when a key is present', () => {
    expect(buildAuthHeaders('')).toEqual({});
    expect(buildAuthHeaders('test-key')).toEqual({
      'X-Agent-API-Key': 'test-key',
      Authorization: 'Bearer test-key',
    });
    expect(buildAuthHeaders({ authToken: 'bearer-only-token' })).toEqual({
      Authorization: 'Bearer bearer-only-token',
    });
  });

  test('picks seed product and builds recent view payload', () => {
    const seed = pickSeedProduct({
      products: [
        {
          merchant_id: 'm1',
          product_id: 'p1',
          title: 'Alpha Repair Serum',
          brand: 'Alpha',
          category: 'Skincare',
          product_type: 'Serum',
        },
      ],
    });
    const recentView = buildRecentView(seed);

    expect(seed.product_id).toBe('p1');
    expect(recentView).toEqual(
      expect.objectContaining({
        merchant_id: 'm1',
        product_id: 'p1',
        title: 'Alpha Repair Serum',
        brand: 'Alpha',
        category: 'Skincare',
        product_type: 'Serum',
      }),
    );
    expect(typeof deriveRecentQuery(seed)).toBe('string');
    expect(deriveRecentQuery(seed)).toBe('Serum');
  });

  test('validates discovery response contract and suppression checks', () => {
    const summary = validateDiscoveryResponse(
      {
        products: [
          {
            merchant_id: 'm2',
            product_id: 'p2',
            title: 'Beta Repair Toner',
          },
        ],
        metadata: {
          candidate_source: 'multi_provider',
          provider_breakdown: [
            { provider: 'products_search', successful: true },
            { provider: 'internal_catalog', successful: false },
            { provider: 'external_seeds', successful: true },
          ],
          discovery_strategy: 'personalized_interest',
          personalization_source: 'account_history',
          rank_debug: {
            recall_summary: [
              { label: 'interest_pool', status: 200, returned: 3 },
              { label: 'expansion_pool', status: 200, returned: 6 },
            ],
          },
        },
      },
      {
        discoveryStrategy: 'personalized_interest',
        personalizationSource: 'account_history',
        candidateSource: 'multi_provider',
        requireRankDebug: true,
        requiredRecallLabels: ['interest_pool', 'expansion_pool'],
        requiredProviders: ['products_search', 'external_seeds'],
        excludeProductKeys: ['m1::p1'],
      },
    );

    expect(summary).toEqual(
      expect.objectContaining({
        candidateSource: 'multi_provider',
        strategy: 'personalized_interest',
      }),
    );
  });

  test('accepts cold-start recall labels across curated and browse fallback variants', () => {
    const summary = validateDiscoveryResponse(
      {
        products: [
          {
            merchant_id: 'm2',
            product_id: 'p2',
            title: 'Beta Repair Toner',
          },
        ],
        metadata: {
          candidate_source: 'multi_provider',
          provider_breakdown: [
            { provider: 'products_search', successful: true },
            { provider: 'internal_catalog', successful: true },
            { provider: 'external_seeds', successful: false },
          ],
          discovery_strategy: 'cold_start_curated',
          personalization_source: 'none',
          rank_debug: {
            recall_summary: [
              { label: 'cold_start_curated', status: 200, returned: 6 },
              { label: 'cold_start_fill', status: 200, returned: 4 },
            ],
          },
        },
      },
      {
        discoveryStrategy: 'cold_start_curated',
        personalizationSource: 'none',
        candidateSource: 'multi_provider',
        requireRankDebug: true,
        requiredRecallLabels: [['cold_start_curated', 'cold_start_fill', 'external_seed_pool_fastpath']],
        requiredProviders: ['products_search', 'internal_catalog'],
      },
    );

    expect(summary.strategy).toBe('cold_start_curated');
  });

  test('accepts browse recall when browse_pool satisfies page one without an expansion step', () => {
    const summary = validateDiscoveryResponse(
      {
        products: [
          {
            merchant_id: 'm2',
            product_id: 'p2',
            title: 'Beta Repair Toner',
          },
          {
            merchant_id: 'm3',
            product_id: 'p3',
            title: 'Gamma Repair Serum',
          },
        ],
        metadata: {
          candidate_source: 'multi_provider',
          provider_breakdown: [
            { provider: 'products_search', successful: true },
            { provider: 'internal_catalog', successful: true },
            { provider: 'external_seeds', successful: true },
          ],
          discovery_strategy: 'personalized_interest',
          personalization_source: 'account_history',
          rank_debug: {
            recall_summary: [
              { label: 'browse_pool', status: 200, returned: 24 },
              { label: 'internal_catalog_pool', status: 200, returned: 18 },
              { label: 'external_seed_pool', status: 200, returned: 18 },
            ],
          },
        },
      },
      {
        discoveryStrategy: 'personalized_interest',
        personalizationSource: 'account_history',
        candidateSource: 'multi_provider',
        requireRankDebug: true,
        requiredRecallLabels: [['browse_pool', 'expansion_pool']],
        requiredProviders: ['products_search', 'internal_catalog', 'external_seeds'],
        minProducts: 2,
      },
    );

    expect(summary.productCount).toBe(2);
  });

  test('rejects disallowed cold-start titles in the top rows', () => {
    expect(() =>
      validateDiscoveryResponse(
        {
          products: [
            {
              merchant_id: 'm2',
              product_id: 'p2',
              title: 'Velvet Lingerie Set',
            },
          ],
          metadata: {
            candidate_source: 'multi_provider',
            discovery_strategy: 'cold_start_curated',
            personalization_source: 'none',
            provider_breakdown: [{ provider: 'products_search', successful: true, returned: 6 }],
            rank_debug: {
              recall_summary: [{ label: 'cold_start_curated', status: 200, returned: 6 }],
            },
          },
        },
        {
          discoveryStrategy: 'cold_start_curated',
          personalizationSource: 'none',
          candidateSource: 'multi_provider',
          requireRankDebug: true,
          requiredRecallLabels: [['cold_start_curated', 'cold_start_fill', 'external_seed_pool_fastpath']],
          disallowTopN: 3,
          disallowTitlePatterns: ['\\blingerie\\b'],
        },
      ),
    ).toThrow(/disallowed cold-start titles/i);
  });

  test('reports product counts and provider breakdown when the response underfills', () => {
    expect(() =>
      validateDiscoveryResponse(
        {
          products: [
            {
              merchant_id: 'm1',
              product_id: 'p1',
              title: 'Barrier Repair Serum',
            },
          ],
          metadata: {
            candidate_source: 'multi_provider',
            discovery_strategy: 'cold_start_curated',
            personalization_source: 'none',
            candidate_counts: { returned: 1, eligible_pool: 2 },
            provider_breakdown: [
              { provider: 'products_search', successful: true, returned: 24 },
              { provider: 'external_seeds', successful: false, returned: 0 },
            ],
          },
        },
        {
          discoveryStrategy: 'cold_start_curated',
          personalizationSource: 'none',
          candidateSource: 'multi_provider',
          minProducts: 3,
        },
      ),
    ).toThrow(/returned.*1.*required.*3/i);
  });

  test('rejects unavailable catalog responses', () => {
    expect(() =>
      validateDiscoveryResponse(
        {
          products: [],
          metadata: {
            catalog_status: 'unavailable',
            provider_breakdown: [
              { provider: 'products_search', successful: false, failure_reason: 'missing_base_url' },
            ],
          },
        },
        { minProducts: 0, candidateSource: 'multi_provider' },
      ),
    ).toThrow(/unavailable discovery catalog/i);
  });

  test('rejects responses with no successful providers', () => {
    expect(() =>
      validateDiscoveryResponse(
        {
          products: [
            {
              merchant_id: 'm1',
              product_id: 'p1',
              title: 'Fallback Product',
            },
          ],
          metadata: {
            candidate_source: 'multi_provider',
            provider_breakdown: [
              { provider: 'products_search', successful: false, failure_reason: 'timeout' },
              { provider: 'internal_catalog', successful: false, failure_reason: 'missing_database' },
            ],
          },
        },
        { minProducts: 1, candidateSource: 'multi_provider' },
      ),
    ).toThrow(/no successful discovery providers/i);
  });

  test('rejects responses with disallowed products_search provider failures', () => {
    expect(() =>
      validateDiscoveryResponse(
        {
          products: [
            {
              merchant_id: 'm1',
              product_id: 'p1',
              title: 'Fallback Product',
            },
          ],
          metadata: {
            candidate_source: 'multi_provider',
            provider_breakdown: [
              { provider: 'products_search', successful: false, failure_reason: 'missing_base_url' },
              { provider: 'external_seeds', successful: true, returned: 1 },
            ],
          },
        },
        { minProducts: 1, candidateSource: 'multi_provider' },
      ),
    ).toThrow(/products_search provider degraded unexpectedly/i);
  });
});
