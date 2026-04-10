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
      if (
        Array.isArray(brandAliases) &&
        brandAliases.includes('kravebeauty')
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
        String(sql).includes("seed_data->>'vendor'") &&
        String(sql).includes("seed_data->'snapshot'->>'title'") &&
        !String(sql).includes('attached_product_key IS NULL'),
      ),
    ).toBe(true);
  });

  test('builds external candidates from snapshot/product_type-backed category fields', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (_sql, params) => {
      const brandAliases = params?.[3];
      if (
        Array.isArray(brandAliases) &&
        brandAliases.includes('kravebeauty')
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
      if (
        Array.isArray(brandAliases) &&
        brandAliases.includes('kravebeauty')
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

  test('prefers same-domain seed lookup and skips broad brand/category scans when domain yields enough rows', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes("lower(coalesce(domain, '')) = ANY($4)")) {
        expect(params?.[3]).toEqual(['kravebeauty.com']);
        return {
          rows: Array.from({ length: 6 }).map((_, index) =>
            ({
              ...makeExternalRow({
                id: `eps_domain_${index}`,
                external_product_id: `ext_domain_${index}`,
                title: `KraveBeauty Domain Product ${index}`,
              }),
              seed_data: undefined,
            }),
          ),
        };
      }
      throw new Error(`unexpected broad external query: ${sqlText}`);
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'KraveBeauty',
      categoryHint: 'Serum',
      domainHints: ['https://kravebeauty.com/products/great-barrier-relief'],
      limit: 12,
    });

    expect(products).toHaveLength(6);
    expect(
      products.every(
        (product) =>
          product.merchant_id === 'external_seed' &&
          String(product.canonical_url || product.destination_url || '').includes('kravebeauty.com'),
      ),
    ).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
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

  test('recommend uses same-domain external seeds for external PDPs before broad scans and keeps similar non-empty', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn((sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('FROM products_cache')) {
        return Promise.resolve({
          rows: Array.from({ length: 12 }).map((_, index) => ({
            merchant_id: `merch_other_${index}`,
            product_data: {
              merchant_id: `merch_other_${index}`,
              product_id: `internal_other_${index}`,
              title: `Other Brand Serum ${index}`,
              brand: 'OtherBrand',
              category_path: ['Beauty', 'Serum'],
              price: 28 + index,
              inventory_quantity: 10,
              status: 'active',
            },
          })),
        });
      }
      if (sqlText.includes("lower(coalesce(domain, '')) = ANY($4)")) {
        expect(params?.[3]).toEqual(['kravebeauty.com']);
        return Promise.resolve({
          rows: [
            {
              ...makeExternalRow({
                id: 'eps_matcha',
                external_product_id: 'ext_matcha',
                title: 'Matcha Hemp Hydrating Cleanser',
                category: 'Cleanser',
              }),
              seed_data: undefined,
            },
            {
              ...makeExternalRow({
                id: 'eps_oat',
                external_product_id: 'ext_oat',
                title: 'Oat So Simple Water Cream',
                category: 'Moisturizer',
              }),
              seed_data: undefined,
            },
            {
              ...makeExternalRow({
                id: 'eps_oil',
                external_product_id: 'ext_oil',
                title: 'Oil La La',
                category: 'Oil',
              }),
              seed_data: undefined,
            },
            {
              ...makeExternalRow({
                id: 'eps_plum',
                external_product_id: 'ext_plum',
                title: 'Plumptuous Lip Jelly',
                category: 'Lip Care',
              }),
              seed_data: undefined,
            },
            {
              ...makeExternalRow({
                id: 'eps_pore',
                external_product_id: 'ext_pore',
                title: 'Pore Refiner',
                category: 'Serum',
              }),
              seed_data: undefined,
            },
            {
              ...makeExternalRow({
                id: 'eps_clean',
                external_product_id: 'ext_clean',
                title: 'Makeup Re-Wined',
                category: 'Cleanser',
              }),
              seed_data: undefined,
            },
          ],
        });
      }
      throw new Error(`unexpected broad external query: ${sqlText}`);
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { recommend, _internals } = require('../../src/services/RecommendationEngine');
    _internals.resetCache();
    const result = await recommend({
      pdp_product: {
        merchant_id: 'external_seed',
        product_id: 'ext_gbr',
        title: 'Great Barrier Relief',
        brand: { name: 'KraveBeauty' },
        category_path: ['Beauty', 'Serum'],
        canonical_url: 'https://kravebeauty.com/products/great-barrier-relief',
        source: 'external_seed',
        price: { current: { amount: 28, currency: 'USD' } },
        inventory_quantity: 10,
        status: 'active',
      },
      k: 6,
      options: { debug: true, no_cache: true },
    });

    expect(result.metadata.similar_status).toBe('ready');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((item) => item.merchant_id === 'external_seed')).toBe(true);
    expect(result.debug?.fetch_strategy?.external_timed_out).toBe(false);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("lower(coalesce(domain, '')) = ANY($4)"))).toBe(true);
    expect(
      queryMock.mock.calls.every(
        ([sql]) => !String(sql).includes("seed_data->>'brand'") && !String(sql).includes("seed_data->>'category'"),
      ),
    ).toBe(true);
  });
});
