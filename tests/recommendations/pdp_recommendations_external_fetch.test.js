function makeExternalRow({
  id,
  external_product_id,
  title,
  brand = 'KraveBeauty',
  category = 'Serum',
  domain = 'kravebeauty.com',
  description = 'Focused same-brand serum candidate',
} = {}) {
  return {
    id: id || 'eps_1',
    external_product_id: external_product_id || 'ext_1',
    canonical_url: `https://${domain}/products/${external_product_id || 'ext_1'}`,
    destination_url: `https://${domain}/products/${external_product_id || 'ext_1'}`,
    domain,
    title: title || 'KraveBeauty Serum',
    image_url: `https://${domain}/image.jpg`,
    price_amount: 28,
    price_currency: 'USD',
    availability: 'in_stock',
    seed_brand: brand,
    seed_category: category,
    seed_product_type: category,
    seed_description: description,
    seed_data: {
      snapshot: {
        brand,
        product_type: category,
      },
    },
  };
}

describe('RecommendationEngine external candidate fetch', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.DATABASE_URL;
    delete process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET;
  });

  test('matches normalized brand fastpath and dedupes overlapping brand/category rows', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';
    process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET = 'US';

    const queryMock = jest.fn(async (sql, params) => {
      const brandAliases = params?.[3];
      const brandCompacts = params?.[4];
      const categoryKey = params?.[5];
      if (
        Array.isArray(brandAliases) &&
        brandAliases.includes('kravebeauty') &&
        Array.isArray(brandCompacts) &&
        brandCompacts.includes('kravebeauty') &&
        categoryKey === 'serum'
      ) {
        return {
          rows: [
            makeExternalRow({
              id: 'eps_krave_1',
              external_product_id: 'ext_krave_1',
              title: 'Great Barrier Relief',
              brand: 'KraveBeauty',
              category: 'Serum',
            }),
          ],
        };
      }
      if (
        Array.isArray(brandAliases) &&
        brandAliases.includes('kravebeauty') &&
        Array.isArray(brandCompacts) &&
        brandCompacts.includes('kravebeauty')
      ) {
        return {
          rows: [
            makeExternalRow({
              id: 'eps_krave_1',
              external_product_id: 'ext_krave_1',
              title: 'Great Barrier Relief',
              brand: 'KraveBeauty',
              category: 'Serum',
            }),
          ],
        };
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'Krave Beauty',
      categoryHint: 'Serum',
      limit: 12,
    });

    expect(products).toHaveLength(1);
    expect(products[0]).toEqual(
      expect.objectContaining({
        product_id: 'ext_krave_1',
        brand: 'KraveBeauty',
        category: 'Serum',
      }),
    );
    expect(
      queryMock.mock.calls.some(([sql]) =>
        String(sql).includes("regexp_replace(") &&
        String(sql).includes("split_part(domain, '.', 1)") &&
        String(sql).includes("seed_data->>'vendor'") &&
        !String(sql).includes('attached_product_key IS NULL'),
      ),
    ).toBe(true);
    expect(
      queryMock.mock.calls.some(([sql]) =>
        String(sql).includes("seed_data->'derived'->'recall'->>'category'"),
      ),
    ).toBe(true);
  });

  test('builds external candidates from snapshot/product_type-backed category fields', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (_sql, params) => {
      const brandAliases = params?.[3];
      const brandCompacts = params?.[4];
      const categoryKey = params?.[5];
      if (
        Array.isArray(brandAliases) &&
        brandAliases.includes('kravebeauty') &&
        Array.isArray(brandCompacts) &&
        brandCompacts.includes('kravebeauty') &&
        categoryKey === 'treatment'
      ) {
        return {
          rows: [
            {
              ...makeExternalRow({
                id: 'eps_oil_1',
                external_product_id: 'ext_oil_1',
                title: 'Oil La La',
                brand: 'KraveBeauty',
                category: '',
              }),
              seed_category: '',
              seed_product_type: '',
              seed_data: {
                snapshot: {
                  brand: 'KraveBeauty',
                  product_type: 'Treatment',
                },
              },
            },
          ],
        };
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'KraveBeauty',
      categoryHint: 'Treatment',
      limit: 12,
    });

    expect(products).toHaveLength(1);
    expect(products[0]).toEqual(
      expect.objectContaining({
        product_id: 'ext_oil_1',
        brand: 'KraveBeauty',
        category: 'Treatment',
        product_type: 'Treatment',
      }),
    );
  });

  test('enrichExternalBaseProduct rescues brand/category/description from seed snapshot', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async () => ({
      rows: [
        {
          id: 'eps_gbr',
          external_product_id: 'ext_gbr',
          title: 'Great Barrier Relief',
          seed_data: {
            snapshot: {
              brand: 'KraveBeauty',
              description: 'A calming repairing serum.',
              product_type: 'Serum',
            },
          },
        },
      ],
    }));

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const out = await _internals.enrichExternalBaseProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_gbr',
      source: 'external_seed',
    });

    expect(out.product).toEqual(
      expect.objectContaining({
        brand: 'KraveBeauty',
        category: 'Serum',
        description: 'A calming repairing serum.',
        external_product_id: 'ext_gbr',
      }),
    );
    expect(out.semantic?.rescue_fields).toEqual(expect.arrayContaining(['brand', 'category', 'description']));
  });

  test('includes attached same-brand seeds through broad brand fallback matching', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const brandAliases = params?.[3];
      const brandCompacts = params?.[4];
      if (
        Array.isArray(brandAliases) &&
        brandAliases.includes('kravebeauty') &&
        Array.isArray(brandCompacts) &&
        brandCompacts.includes('kravebeauty')
      ) {
        return {
          rows: [
            {
              ...makeExternalRow({
                id: 'eps_matcha',
                external_product_id: 'ext_matcha',
                title: 'Matcha Hemp Hydrating Cleanser',
                brand: '',
                category: '',
              }),
              attached_product_key: 'native::sku_123',
              seed_data: {
                vendor: 'KraveBeauty',
                snapshot: {
                  title: 'KraveBeauty Matcha Hemp Hydrating Cleanser',
                },
              },
            },
          ],
        };
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'KraveBeauty',
      categoryHint: '',
      limit: 12,
    });

    expect(products).toHaveLength(1);
    expect(products[0]).toEqual(
      expect.objectContaining({
        product_id: 'ext_matcha',
        brand: 'KraveBeauty',
        title: 'KraveBeauty Matcha Hemp Hydrating Cleanser',
      }),
    );
    expect(
      queryMock.mock.calls.every(([sql]) => !String(sql).includes('attached_product_key IS NULL')),
    ).toBe(true);
  });

  test('recommend fetches internal and external pools in parallel instead of serially stacking source latency', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const delay = (ms, value) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(value), ms);
      });

    const queryMock = jest.fn((sql) => {
      const sqlText = String(sql);
      if (sqlText.includes('FROM products_cache') && sqlText.includes('WHERE merchant_id = $1')) {
        return delay(260, {
          rows: [
            {
              product_data: {
                merchant_id: 'merch_store',
                product_id: 'int_1',
                title: 'Brand Serum Internal',
                brand: 'Brand',
                category_path: ['Beauty', 'Serum'],
                price: 29,
                inventory_quantity: 10,
                status: 'active',
              },
            },
          ],
        });
      }
      if (sqlText.includes('FROM products_cache')) {
        return Promise.resolve({ rows: [] });
      }
      if (sqlText.includes('FROM external_product_seeds')) {
        return delay(260, {
          rows: [
            makeExternalRow({
              id: 'eps_ext_1',
              external_product_id: 'ext_1',
              title: 'Brand Serum External',
              brand: 'Brand',
              category: 'Serum',
              domain: 'brand.com',
            }),
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { recommend, _internals } = require('../../src/services/RecommendationEngine');
    _internals.resetCache();
    const startedAt = Date.now();
    const result = await recommend({
      pdp_product: {
        merchant_id: 'merch_store',
        product_id: 'base_1',
        title: 'Brand Serum',
        brand: 'Brand',
        category_path: ['Beauty', 'Serum'],
        price: 30,
        inventory_quantity: 10,
        status: 'active',
      },
      k: 4,
      options: {
        debug: true,
        no_cache: true,
      },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.metadata.similar_status).toBe('ready');
    expect(result.items).toHaveLength(2);
    expect(elapsedMs).toBeLessThan(520);
  });
});
