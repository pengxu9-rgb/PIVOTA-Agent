describe('RecommendationEngine external candidate fetch', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.DATABASE_URL;
  });

  test('uses focused brand/category candidates without dropping into recent fallback when pool is already sufficient', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (_sql, params) => {
      const predicate = String(params?.[3] || '');
      if (predicate === 'tom ford beauty') {
        return {
          rows: Array.from({ length: 18 }).map((_, index) => ({
            id: `eps_brand_${index + 1}`,
            external_product_id: `ext_brand_${index + 1}`,
            canonical_url: `https://example.com/products/serum-${index + 1}`,
            destination_url: `https://example.com/products/serum-${index + 1}`,
            domain: 'example.com',
            title: `Tom Ford Serum ${index + 1}`,
            image_url: `https://example.com/serum-${index + 1}.jpg`,
            price_amount: 100 + index,
            price_currency: 'USD',
            availability: 'in_stock',
            seed_brand: 'Tom Ford Beauty',
            seed_category: '',
            seed_product_type: '',
            seed_description: 'Focused serum candidate',
          })),
        };
      }
      if (predicate === 'serum') {
        return { rows: [] };
      }
      return {
        rows: [
          {
            id: 'eps_recent_1',
            external_product_id: 'ext_recent_1',
            canonical_url: 'https://example.com/products/recent-1',
            destination_url: 'https://example.com/products/recent-1',
            domain: 'example.com',
            title: 'Recent Pool Candidate',
            image_url: 'https://example.com/recent-1.jpg',
            price_amount: 42,
            price_currency: 'USD',
            availability: 'in_stock',
            seed_brand: 'Other Brand',
            seed_category: 'Serum',
            seed_product_type: 'Serum',
            seed_description: 'Should not be fetched',
          },
        ],
      };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'Tom Ford Beauty',
      categoryHint: 'Serum',
      limit: 120,
    });

    expect(products).toHaveLength(18);
    expect(products.every((product) => product.brand === 'Tom Ford Beauty')).toBe(true);
    expect(products.every((product) => product.category === 'Serum')).toBe(true);
    expect(queryMock.mock.calls.filter(([, params]) => Array.isArray(params) && params.length === 3)).toHaveLength(0);
  });
});
