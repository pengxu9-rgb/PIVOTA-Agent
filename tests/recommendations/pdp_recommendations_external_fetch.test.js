describe('RecommendationEngine external candidate fetch', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.DATABASE_URL;
    delete process.env.PDP_RECS_EXTERNAL_QUERY_TIMEOUT_MS;
  });

  test('uses focused brand/category candidates without dropping into recent fallback when pool is already sufficient', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const predicate = params?.[3];
      if (String(predicate || '') === 'tom ford beauty') {
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
      if (Array.isArray(predicate) && sql.includes('LIKE ANY($4::text[])')) {
        return { rows: [] };
      }
      if (Array.isArray(predicate) && predicate.includes('serum')) {
        return { rows: [] };
      }
      return { rows: [] };
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

  test('semantic category lane can add other-brand same-category candidates without reviving recent fallback', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const predicate = params?.[3];
      if (predicate === 'tom ford beauty') {
        return {
          rows: [
            {
              id: 'eps_brand_1',
              external_product_id: 'ext_brand_1',
              canonical_url: 'https://example.com/products/cleanser-1',
              destination_url: 'https://example.com/products/cleanser-1',
              domain: 'example.com',
              title: 'Tom Ford Cleansing Concentrate',
              image_url: 'https://example.com/cleanser-1.jpg',
              price_amount: 100,
              price_currency: 'USD',
              availability: 'in_stock',
              seed_brand: 'Tom Ford Beauty',
              seed_category: '',
              seed_product_type: '',
              seed_description: 'Focused cleanser candidate',
            },
          ],
        };
      }
      if (Array.isArray(predicate) && sql.includes('LIKE ANY($4::text[])')) {
        return {
          rows: [
            {
              id: 'eps_other_brand_cleanser',
              external_product_id: 'ext_other_brand_cleanser',
              canonical_url: 'https://example.com/products/gentle-face-wash',
              destination_url: 'https://example.com/products/gentle-face-wash',
              domain: 'example.com',
              title: 'Other Brand Gentle Face Wash',
              image_url: 'https://example.com/gentle-face-wash.jpg',
              price_amount: 38,
              price_currency: 'USD',
              availability: 'in_stock',
              seed_brand: 'Other Brand',
              seed_category: '',
              seed_product_type: '',
              seed_description: 'A gentle cleansing gel for daily use',
            },
          ],
        };
      }
      if (Array.isArray(predicate) && predicate.includes('cleanser')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'Tom Ford Beauty',
      categoryHint: 'Cleanser',
      limit: 120,
      baseProduct: {
        merchant_id: 'external_seed',
        product_id: 'ext_base_cleanser',
        title: 'Tom Ford Cleansing Concentrate',
        brand: 'Tom Ford Beauty',
        category: 'Cleanser',
        source: 'external_seed',
      },
    });

    expect(products.map((product) => product.product_id)).toEqual(
      expect.arrayContaining(['ext_brand_1', 'ext_other_brand_cleanser']),
    );
    expect(queryMock.mock.calls.filter(([, params]) => Array.isArray(params) && params.length === 3)).toHaveLength(0);
  });

  test('external base semantic rescue can infer missing category from the seed snapshot itself', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async () => ({
      rows: [
        {
          id: 'eps_tf_cleanser',
          external_product_id: 'ext_tf_cleanser',
          title: 'TOM FORD RESEARCH Cleansing Concentrate',
          canonical_url: 'https://example.com/products/cleansing-concentrate',
          destination_url: 'https://example.com/products/cleansing-concentrate',
          domain: 'example.com',
          seed_data: {
            brand: 'Tom Ford Beauty',
            description: 'A luxurious daily cleanser.',
          },
        },
      ],
    }));

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const out = await _internals.enrichExternalBaseProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_tf_cleanser',
      source: 'external_seed',
    });

    expect(out.product.brand).toBe('Tom Ford Beauty');
    expect(out.product.category).toBe('Cleanser');
    expect(out.semantic?.rescue_fields).toEqual(expect.arrayContaining(['brand', 'category', 'description']));
  });

  test('does not fall back to global recent candidates when focused pool underfills', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const predicate = params?.[3];
      if (predicate === 'tom ford beauty') {
        return {
          rows: [
            {
              id: 'eps_brand_1',
              external_product_id: 'ext_brand_1',
              canonical_url: 'https://example.com/products/cleanser-1',
              destination_url: 'https://example.com/products/cleanser-1',
              domain: 'example.com',
              title: 'Tom Ford Cleansing Concentrate',
              image_url: 'https://example.com/cleanser-1.jpg',
              price_amount: 100,
              price_currency: 'USD',
              availability: 'in_stock',
              seed_brand: 'Tom Ford Beauty',
              seed_category: '',
              seed_product_type: '',
              seed_description: 'Focused cleanser candidate',
            },
          ],
        };
      }
      if (Array.isArray(predicate) && sql.includes('LIKE ANY($4::text[])')) {
        return { rows: [] };
      }
      if (Array.isArray(predicate) && predicate.includes('cleanser')) {
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
      categoryHint: 'Cleanser',
      limit: 120,
    });

    expect(products).toHaveLength(1);
    expect(products[0]?.brand).toBe('Tom Ford Beauty');
    expect(products[0]?.title).toBe('Tom Ford Cleansing Concentrate');
    expect(queryMock.mock.calls.filter(([, params]) => Array.isArray(params) && params.length === 3)).toHaveLength(0);
  });

  test('returns fast same-brand rows even when semantic surface query times out', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';
    process.env.PDP_RECS_EXTERNAL_QUERY_TIMEOUT_MS = '25ms';

    const queryMock = jest.fn((sql, params) => {
      const predicate = params?.[3];
      if (String(sql).includes('LIKE ANY')) {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ rows: [] }), 100);
        });
      }
      if (String(predicate || '') === 'fenty beauty') {
        return Promise.resolve({
          rows: [
            {
              id: 'eps_fenty_cleanser',
              external_product_id: 'ext_fenty_cleanser',
              title: "Total Cleans'r Remove-It-All Cleanser",
              canonical_url: 'https://fentybeauty.com/products/total-cleansr',
              destination_url: 'https://fentybeauty.com/products/total-cleansr',
              domain: 'fentybeauty.com',
              price_amount: 29,
              price_currency: 'USD',
              availability: 'in_stock',
              seed_brand: 'Fenty Beauty',
              seed_category: 'Cleanser',
              seed_product_type: 'Cleanser',
              seed_description: 'A daily gel cleanser for fresh skin.',
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'Fenty Beauty',
      categoryHint: 'Treatment',
      baseProduct: {
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_bha',
        title: "Blemish Defeat'r BHA Spot-Targeting Gel",
        brand: 'Fenty Beauty',
        category: 'Treatment',
        source: 'external_seed',
      },
      limit: 12,
    });

    expect(products.map((product) => product.product_id)).toContain('ext_fenty_cleanser');
  });
});
