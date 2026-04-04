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
    expect(deriveRecentQuery(seed)).toBe('Alpha');
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
          candidate_source: 'products_search',
          discovery_strategy: 'personalized_interest',
          personalization_source: 'account_history',
          rank_debug: {
            recall_summary: [
              { label: 'interest_pool', status: 200, returned: 3 },
              { label: 'browse_pool', status: 200, returned: 6 },
            ],
          },
        },
      },
      {
        discoveryStrategy: 'personalized_interest',
        personalizationSource: 'account_history',
        candidateSource: 'products_search',
        requireRankDebug: true,
        requiredRecallLabels: ['interest_pool', 'browse_pool'],
        excludeProductKeys: ['m1::p1'],
      },
    );

    expect(summary).toEqual(
      expect.objectContaining({
        candidateSource: 'products_search',
        strategy: 'personalized_interest',
      }),
    );
  });
});
