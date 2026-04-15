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
    delete process.env.PDP_RECS_EXTERNAL_UNDERFILL_QUERY_TIMEOUT_MS;
    delete process.env.PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS;
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
        String(sql).includes("regexp_replace(lower(coalesce(seed_data->>'brand'") &&
        String(sql).includes("lower(coalesce(seed_data->'snapshot'->>'brand'") &&
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

  test('enrichExternalBaseProduct upgrades weak synthetic categories from external seed recall category', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async () => ({
      rows: [
        {
          id: 'eps_dn350',
          external_product_id: 'ext_dn350',
          title: 'Daily Tinted Fluid Sunscreen DN350',
          seed_data: {
            brand: 'Beauty of Joseon',
            category: 'Sunscreen',
            product_type: 'Sunscreen',
          },
        },
      ],
    }));

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const out = await _internals.enrichExternalBaseProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_dn350',
      external_product_id: 'ext_dn350',
      title: 'Daily Tinted Fluid Sunscreen DN350',
      brand: 'Beauty of Joseon',
      category: 'Skincare',
      product_type: 'Products',
      source: 'external_seed',
    });

    expect(out.product).toEqual(
      expect.objectContaining({
        category: 'Sunscreen',
        product_type: 'Sunscreen',
      }),
    );
    expect(out.semantic?.rescue_fields).toEqual(expect.arrayContaining(['category']));
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

  test('uses same-domain seed lookup and skips broad scans when domain rows can fill target', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)')) {
        expect(params?.[3]).toEqual(['kravebeauty.com', 'www.kravebeauty.com']);
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
      return { rows: [] };
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
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('domain = ANY($4)'))).toBe(true);
    expect(
      queryMock.mock.calls.some(([sql]) =>
        String(sql).includes("regexp_replace(lower(coalesce(seed_data->>'brand'"),
      ),
    ).toBe(false);
  });

  test('uses brand-focused seeds before broad category scans when brand rows can fill target', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      const brandAliases = params?.[3];
      if (Array.isArray(brandAliases) && brandAliases.includes('winona')) {
        return {
          rows: Array.from({ length: 6 }).map((_, index) =>
            makeExternalRow({
              id: `eps_winona_${index}`,
              external_product_id: `ext_winona_${index}`,
              title: `Winona Repair Product ${index}`,
              brand: 'Winona',
              category: 'Serum',
              domain: 'winona.com',
            }),
          ),
        };
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'Winona',
      categoryHint: 'Serum',
      limit: 12,
      minFocusedCandidates: 6,
    });

    expect(products).toHaveLength(6);
    expect(products.every((product) => product.brand === 'Winona')).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("seed_data->>'brand'"))).toBe(true);
    expect(
      queryMock.mock.calls.some(([sql]) => String(sql).includes("lower(coalesce(seed_data->'derived'->'recall'->>'category',''))")),
    ).toBe(false);
  });

  test('continues to category seeds when brand-focused rows underfill target', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      const brandAliases = params?.[3];
      if (Array.isArray(brandAliases) && brandAliases.includes('goodmolecules')) {
        return {
          rows: Array.from({ length: 1 }).map((_, index) =>
            makeExternalRow({
              id: `eps_good_molecules_partial_${index}`,
              external_product_id: `ext_good_molecules_partial_${index}`,
              title: `Good Molecules Partial Product ${index}`,
              brand: 'Good Molecules',
              category: 'Serum',
              domain: 'goodmolecules.com',
            }),
          ),
        };
      }
      if (sqlText.includes("lower(coalesce(seed_data->'derived'->'recall'->>'category',''))")) {
        return {
          rows: [
            makeExternalRow({
              id: 'eps_niacinamide_serum_1',
              external_product_id: 'ext_niacinamide_serum_1',
              title: 'Niacinamide Serum Alternative',
              brand: 'Beauty of Joseon',
              category: 'Serum',
              domain: 'beautyofjoseon.com',
            }),
            makeExternalRow({
              id: 'eps_niacinamide_serum_2',
              external_product_id: 'ext_niacinamide_serum_2',
              title: '10% Niacinamide Booster',
              brand: "Paula's Choice",
              category: 'Serum',
              domain: 'paulaschoice.com',
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
      brandHint: 'Good Molecules',
      categoryHint: 'Serum',
      limit: 12,
      minFocusedCandidates: 6,
    });

    expect(products.map((product) => product.product_id)).toEqual([
      'ext_good_molecules_partial_0',
      'ext_niacinamide_serum_1',
      'ext_niacinamide_serum_2',
    ]);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("lower(coalesce(seed_data->'derived'->'recall'->>'category',''))"))).toBe(true);
  });

  test('uses title category tokens when structured category rows underfill target', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      const brandAliases = params?.[3];
      if (Array.isArray(brandAliases) && brandAliases.includes('goodmolecules')) {
        return {
          rows: [
            makeExternalRow({
              id: 'eps_good_molecules_base_only',
              external_product_id: 'ext_good_molecules_base_only',
              title: 'Good Molecules Niacinamide Serum',
              brand: 'Good Molecules',
              category: 'Serum',
              domain: 'goodmolecules.com',
            }),
          ],
        };
      }
      if (sqlText.includes("lower(coalesce(seed_data->'derived'->'recall'->>'category',''))")) {
        return { rows: [] };
      }
      if (sqlText.includes("seed_data->'derived'->'recall'->>'retrieval_title'")) {
        expect(params?.[3]).toEqual(expect.arrayContaining(['%serum%']));
        expect(sqlText).toContain('attached_product_key IS NULL');
        expect(sqlText).not.toContain("lower(coalesce(title, '')) LIKE");
        expect(sqlText).not.toContain("retrieval_summary");
        return {
          rows: [
            makeExternalRow({
              id: 'eps_title_serum_1',
              external_product_id: 'ext_title_serum_1',
              title: 'Glow Serum : Propolis + Niacinamide',
              brand: 'Beauty of Joseon',
              category: '',
              domain: 'beautyofjoseon.com',
            }),
            makeExternalRow({
              id: 'eps_title_serum_2',
              external_product_id: 'ext_title_serum_2',
              title: '10% Niacinamide Serum',
              brand: 'The Inkey List',
              category: '',
              domain: 'theinkeylist.com',
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
      brandHint: 'Good Molecules',
      categoryHint: 'Serum',
      limit: 12,
      minFocusedCandidates: 6,
    });

    expect(products.map((product) => product.product_id)).toEqual(
      expect.arrayContaining([
        'ext_good_molecules_base_only',
        'ext_title_serum_1',
        'ext_title_serum_2',
      ]),
    );
    expect(
      queryMock.mock.calls.some(([sql]) =>
        String(sql).includes("seed_data->'derived'->'recall'->>'retrieval_title'"),
      ),
    ).toBe(true);
  });

  test('keeps focused candidates when category-token underfill query times out', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';
    process.env.PDP_RECS_EXTERNAL_UNDERFILL_QUERY_TIMEOUT_MS = '50';
    process.env.PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS = '50';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      const brandAliases = params?.[3];
      if (Array.isArray(brandAliases) && brandAliases.includes('goodmolecules')) {
        return {
          rows: [
            makeExternalRow({
              id: 'eps_good_molecules_base_only',
              external_product_id: 'ext_good_molecules_base_only',
              title: 'Good Molecules Niacinamide Serum',
              brand: 'Good Molecules',
              category: 'Serum',
              domain: 'goodmolecules.com',
            }),
          ],
        };
      }
      if (sqlText.includes("lower(coalesce(seed_data->'derived'->'recall'->>'category',''))")) {
        return { rows: [] };
      }
      if (sqlText.includes("seed_data->'derived'->'recall'->>'retrieval_title'")) {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              rows: [
                makeExternalRow({
                  id: 'eps_slow_title_serum',
                  external_product_id: 'ext_slow_title_serum',
                  title: 'Slow Serum Candidate',
                  brand: 'Slow Brand',
                  category: '',
                  domain: 'slow.example',
                }),
              ],
            });
          }, 120);
        });
      }
      return { rows: [] };
    });

    const warn = jest.fn();
    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn, info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'Good Molecules',
      categoryHint: 'Serum',
      limit: 12,
      minFocusedCandidates: 6,
    });

    expect(products.map((product) => product.product_id)).toContain('ext_good_molecules_base_only');
    expect(products.map((product) => product.product_id)).not.toContain('ext_slow_title_serum');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeout_ms: 50, query: 'external_category_title', category: 'serum' }),
      'recommendations external query timed out',
    );
  });

  test('falls back to broad scans when same-domain rows underfill target', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)')) {
        expect(params?.[3]).toEqual(['kravebeauty.com', 'www.kravebeauty.com']);
        return {
          rows: Array.from({ length: 2 }).map((_, index) =>
            ({
              ...makeExternalRow({
                id: `eps_domain_underfill_${index}`,
                external_product_id: `ext_domain_underfill_${index}`,
                title: `KraveBeauty Domain Underfill Product ${index}`,
              }),
              seed_data: undefined,
            }),
          ),
        };
      }
      const brandAliases = params?.[3];
      if (Array.isArray(brandAliases) && brandAliases.includes('kravebeauty')) {
        return {
          rows: [
            makeExternalRow({
              id: 'eps_brand_fill',
              external_product_id: 'ext_brand_fill',
              title: 'KraveBeauty Brand Fill Product',
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
      brandHint: 'KraveBeauty',
      categoryHint: 'Serum',
      domainHints: ['https://kravebeauty.com/products/great-barrier-relief'],
      limit: 12,
      minFocusedCandidates: 6,
    });

    expect(products).toHaveLength(3);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('domain = ANY($4)'))).toBe(true);
    expect(
      queryMock.mock.calls.some(([sql]) => String(sql).includes("seed_data->>'brand'")),
    ).toBe(true);
  });

  test('same-domain seed lookup includes www and bare host aliases before broad scans', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)')) {
        expect(params?.[3]).toEqual(['tomfordbeauty.com', 'www.tomfordbeauty.com']);
        return {
          rows: Array.from({ length: 6 }).map((_, index) =>
            makeExternalRow({
              id: `eps_tf_${index}`,
              external_product_id: `ext_tf_${index}`,
              title: `Tom Ford Beauty Product ${index}`,
              brand: 'Tom Ford Beauty',
              category: 'Makeup',
              domain: 'www.tomfordbeauty.com',
            }),
          ),
        };
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'Tom Ford Beauty',
      categoryHint: 'Concealer',
      domainHints: ['https://www.tomfordbeauty.com/products/traceless-soft-matte-concealer'],
      limit: 12,
    });

    expect(products).toHaveLength(6);
    expect(products.every((product) => product.domain === 'www.tomfordbeauty.com')).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('domain = ANY($4)'))).toBe(true);
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
          rows: Array.from({ length: 4 }).map((_, index) =>
            makeExternalRow({
              id: `eps_ext_${index}`,
              external_product_id: `ext_${index}`,
              title: `Brand Serum External ${index}`,
              brand: 'Brand',
              category: 'Serum',
              domain: 'brand.com',
            }),
          ),
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
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    expect(elapsedMs).toBeLessThan(520);
  });

  test('does not skip external seeds when raw internal pool is large but low quality', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn((sql) => {
      const sqlText = String(sql);
      if (sqlText.includes('FROM products_cache')) {
        return Promise.resolve({
          rows: Array.from({ length: 40 }).map((_, index) => ({
            merchant_id: `merch_other_${index}`,
            product_data: {
              merchant_id: `merch_other_${index}`,
              product_id: `internal_other_${index}`,
              title: `Other Brand Tool ${index}`,
              brand: 'OtherBrand',
              category_path: ['Accessories', 'Tools'],
              price: 80 + index,
              inventory_quantity: 10,
              status: 'active',
            },
          })),
        });
      }
      if (sqlText.includes('FROM external_product_seeds')) {
        return Promise.resolve({
          rows: [
            makeExternalRow({
              id: 'eps_winona_1',
              external_product_id: 'ext_winona_1',
              title: 'Winona Soothing Repair Cream',
              brand: 'Winona',
              category: 'Serum',
              domain: 'winona.com',
            }),
            makeExternalRow({
              id: 'eps_winona_2',
              external_product_id: 'ext_winona_2',
              title: 'Winona Barrier Repair Serum',
              brand: 'Winona',
              category: 'Serum',
              domain: 'winona.com',
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
    const result = await recommend({
      pdp_product: {
        merchant_id: 'merch_winona',
        product_id: 'winona_serum',
        title: 'Winona Soothing Repair Serum',
        brand: 'Winona',
        category_path: ['Beauty', 'Serum'],
        price: 29,
        inventory_quantity: 10,
        status: 'active',
      },
      k: 4,
      options: {
        debug: true,
        no_cache: true,
      },
    });

    expect(result.debug?.fetch_strategy?.external_skipped).toBe(false);
    expect(result.debug?.fetch_strategy?.external_skip_internal_quality_count).toBe(0);
    expect(result.items.map((item) => item.product_id)).toEqual(
      expect.arrayContaining(['ext_winona_1', 'ext_winona_2']),
    );
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
      if (sqlText.includes('domain = ANY($4)')) {
        expect(params?.[3]).toEqual(['kravebeauty.com', 'www.kravebeauty.com']);
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
      return Promise.resolve({ rows: [] });
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
    expect(result.debug?.fetch_strategy?.internal_count).toBe(0);
    expect(queryMock.mock.calls.every(([sql]) => !String(sql).includes('FROM products_cache'))).toBe(true);
    expect(
      queryMock.mock.calls.some(
        ([sql]) => String(sql).includes('domain = ANY($4)'),
      ),
    ).toBe(true);
    expect(
      queryMock.mock.calls.some(
        ([sql]) => String(sql).includes("regexp_replace(lower(coalesce(seed_data->>'brand'"),
      ),
    ).toBe(false);
  });

  test('uses internal category-focused candidates before recent merchant rows', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      if (
        String(sql).includes('FROM products_cache') &&
        String(sql).includes("product_data->>'product_type'") &&
        Array.isArray(params?.[2]) &&
        params[2].includes('serum')
      ) {
        return {
          rows: [
            {
              product_data: {
                merchant_id: 'merch_marketplace',
                product_id: 'internal_serum_match',
                title: 'The Ordinary Niacinamide 10% + Zinc 1%',
                vendor: 'The Ordinary',
                product_type: 'Serum',
                price: 12,
                currency: 'USD',
                inventory_quantity: 10,
                status: 'active',
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
    const products = await _internals.fetchInternalCandidates({
      merchantId: 'merch_marketplace',
      categoryHint: 'Serum',
      limit: 6,
    });

    expect(products.map((item) => item.product_id)).toEqual(['internal_serum_match']);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
