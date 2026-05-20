function makeExternalRow({
  id,
  external_product_id,
  title,
  brand = 'KraveBeauty',
  category = 'Serum',
  catalog_category_path = '',
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
    ...(catalog_category_path ? { catalog_category_path } : {}),
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
    delete process.env.PDP_RECS_VISIBLE_FALLBACKS_ENABLED;
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
        String(sql).includes('attached_product_key IS NULL'),
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
          canonical_url: 'https://kravebeauty.com/products/great-barrier-relief',
          destination_url: 'https://kravebeauty.com/products/great-barrier-relief',
          domain: 'kravebeauty.com',
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
        canonical_url: 'https://kravebeauty.com/products/great-barrier-relief',
        destination_url: 'https://kravebeauty.com/products/great-barrier-relief',
        domain: 'kravebeauty.com',
      }),
    );
    expect(out.semantic?.rescue_fields).toEqual(
      expect.arrayContaining(['brand', 'category', 'description', 'canonical_url', 'destination_url', 'domain']),
    );
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
      category_path: ['external'],
      source: 'external_seed',
    });

    expect(out.product).toEqual(
      expect.objectContaining({
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        category_path: ['Sunscreen'],
      }),
    );
    expect(_internals.getLeafCategory(out.product)).toBe('sunscreen');
    expect(out.semantic?.rescue_fields).toEqual(expect.arrayContaining(['category']));
  });

  test('enrichExternalBaseProduct uses stored recall vertical before title/body inference', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async () => ({
      rows: [
        {
          id: 'eps_tirtir_primer',
          external_product_id: 'ext_tirtir_primer',
          title: 'Reflect Glow Prep Primer',
          seed_data: {
            brand: 'TIRTIR',
            recall_category: 'Primer',
            recall_vertical: 'makeup',
            category: 'Primer',
            product_type: 'Primer',
            description: '95% skincare-infused red serum primer for crystal glow, plumping and grip.',
          },
        },
      ],
    }));

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const out = await _internals.enrichExternalBaseProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_tirtir_primer',
      external_product_id: 'ext_tirtir_primer',
      title: 'Reflect Glow Prep Primer',
      brand: 'TIRTIR',
      category: 'Skincare',
      product_type: 'Products',
      description: '95% skincare-infused red serum primer for crystal glow, plumping and grip.',
      source: 'external_seed',
    });

    expect(_internals.getLeafCategory(out.product)).toBe('primer');
    expect(out.product).toEqual(
      expect.objectContaining({
        category: 'Primer',
        product_type: 'Primer',
        semantic_vertical: 'makeup',
      }),
    );
    expect(out.semantic).toEqual(
      expect.objectContaining({
        vertical: 'makeup',
        vertical_inferred: false,
      }),
    );
  });

  test('enrichExternalBaseProduct rescues seed price for cross-brand primer recall scoring', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async () => ({
      rows: [
        {
          id: 'eps_tirtir_primer',
          external_product_id: 'ext_tirtir_reflect',
          title: 'Reflect Glow Prep Primer',
          image_url: 'https://tirtir.example/primer.jpg',
          price_amount: 17.6,
          price_currency: 'USD',
          availability: 'in_stock',
          seed_data: {
            brand: 'TIRTIR',
            recall_category: 'Primer',
            recall_vertical: 'makeup',
            category: 'Primer',
            product_type: 'Primer',
          },
        },
      ],
    }));

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals, pickLayeredRecommendations } = require('../../src/services/RecommendationEngine');
    const out = await _internals.enrichExternalBaseProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_tirtir_reflect',
      external_product_id: 'ext_tirtir_reflect',
      title: 'Reflect Glow Prep Primer',
      source: 'external_seed',
    });

    expect(out.product).toEqual(
      expect.objectContaining({
        category: 'Primer',
        price_amount: 17.6,
        price: 17.6,
        currency: 'USD',
        price_currency: 'USD',
        availability: 'in_stock',
        image_url: 'https://tirtir.example/primer.jpg',
      }),
    );
    expect(out.semantic?.rescue_fields).toEqual(
      expect.arrayContaining(['category', 'price', 'currency', 'availability', 'image']),
    );

    const picked = pickLayeredRecommendations({
      baseProduct: out.product,
      baseSemantic: out.semantic,
      k: 4,
      internalCandidates: [],
      externalCandidates: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_fenty_grip_trip',
          source: 'external_seed',
          platform: 'external',
          title: 'Grip Trip Hydrating + Plumping Primer',
          brand: 'Fenty Beauty',
          category: 'Primer',
          product_type: 'Primer',
          price_amount: 22,
          currency: 'USD',
          availability: 'in_stock',
          in_stock: true,
          semantic_vertical: 'makeup',
        },
      ],
    });

    expect(picked.items).toHaveLength(1);
    expect(picked.items[0]).toEqual(
      expect.objectContaining({
        product_id: 'ext_fenty_grip_trip',
        reason: expect.stringContaining('L3'),
      }),
    );
    expect(picked.debug.filters.by_confidence).toBe(0);
  });

  test('fetchExternalCandidates carries stored recall vertical for primer candidates', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (_sql, params) => {
      const brandAliases = params?.[3];
      if (Array.isArray(brandAliases) && brandAliases.includes('tirtir')) {
        return {
          rows: [
            {
              ...makeExternalRow({
                id: 'eps_tirtir_primer',
                external_product_id: 'ext_tirtir_primer',
                title: 'Reflect Glow Prep Primer',
                brand: 'TIRTIR',
                category: '',
                description: '95% skincare-infused red serum primer.',
              }),
              seed_category: '',
              seed_product_type: '',
              seed_data: {
                brand: 'TIRTIR',
                derived: {
                  recall: {
                    category: 'Primer',
                    vertical: 'makeup',
                  },
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
      brandHint: 'TIRTIR',
      categoryHint: 'Primer',
      limit: 12,
    });

    expect(products).toHaveLength(1);
    expect(products[0]).toEqual(
      expect.objectContaining({
        product_id: 'ext_tirtir_primer',
        category: 'Primer',
        product_type: 'Primer',
        semantic_vertical: 'makeup',
      }),
    );
  });

  test('enrichExternalBaseProduct keeps SPF foundation products in makeup vertical when category is foundation', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async () => ({
      rows: [
        {
          id: 'eps_tf_arch_foundation',
          external_product_id: 'ext_tf_arch_foundation',
          title: 'Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+',
          seed_data: {
            brand: 'Tom Ford Beauty',
            category: 'Foundation',
            product_type: 'Foundation',
            snapshot: {
              brand: 'Tom Ford Beauty',
              description:
                'A hydrating foundation with broad spectrum SPF 50+ protection and a radiant finish.',
              category: 'Foundation',
              product_type: 'Foundation',
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
      product_id: 'ext_tf_arch_foundation',
      external_product_id: 'ext_tf_arch_foundation',
      title: 'Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+',
      brand: 'Tom Ford Beauty',
      category: 'Foundation',
      product_type: 'Foundation',
      source: 'external_seed',
    });

    expect(out.product).toEqual(
      expect.objectContaining({
        category: 'Foundation',
        product_type: 'Foundation',
      }),
    );
    expect(_internals.getLeafCategory(out.product)).toBe('foundation');
    expect(out.semantic?.vertical).toBe('makeup');
  });

  test('excludes attached same-brand seed rows from broad brand fallback matching', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      if (String(sql).includes('attached_product_key IS NULL')) {
        return { rows: [] };
      }
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

    expect(products).toHaveLength(0);
    expect(
      queryMock.mock.calls.every(([sql]) => String(sql).includes('attached_product_key IS NULL')),
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
      if (sqlText.includes("seed_data->'derived'->'recall'->>'category")) {
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
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("seed_data->'derived'->'recall'->>'category"))).toBe(true);
  });

  test('uses title category tokens when structured category rows underfill target', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';
    process.env.PDP_RECS_VISIBLE_FALLBACKS_ENABLED = 'true';

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

  test('keeps category-title and recent fallbacks out of visible external recall by default', async () => {
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
        throw new Error('category-title fallback should not run');
      }
      if (params?.length === 3) {
        throw new Error('external_recent fallback should not run');
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

    expect(products.map((product) => product.product_id)).toEqual(['ext_good_molecules_base_only']);
    expect(
      queryMock.mock.calls.some(([sql]) =>
        String(sql).includes("seed_data->'derived'->'recall'->>'retrieval_title'"),
      ),
    ).toBe(false);
    expect(queryMock.mock.calls.some(([, params]) => params?.length === 3)).toBe(false);
  });

  test('keeps focused candidates when category-token underfill query times out', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';
    process.env.PDP_RECS_EXTERNAL_UNDERFILL_QUERY_TIMEOUT_MS = '50';
    process.env.PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS = '50';
    process.env.PDP_RECS_VISIBLE_FALLBACKS_ENABLED = 'true';

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

  test('deep-domain recall uses same-domain fast path before category expansion', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)')) {
        expect(params?.[3]).toEqual(['tomfordbeauty.com', 'www.tomfordbeauty.com']);
        return {
          rows: Array.from({ length: 6 }).map((_, index) =>
            makeExternalRow({
              id: `eps_tf_deep_${index}`,
              external_product_id: `ext_tf_deep_${index}`,
              title: `Tom Ford Concealer ${index}`,
              brand: 'Tom Ford Beauty',
              category: 'Concealer',
              domain: 'www.tomfordbeauty.com',
            }),
          ),
        };
      }
      if (sqlText.includes("seed_data->'derived'->'recall'->>'category")) {
        expect(params?.[3]).toContain('concealer');
        return {
          rows: Array.from({ length: 6 }).map((_, index) =>
            makeExternalRow({
              id: `eps_category_${index}`,
              external_product_id: `ext_category_${index}`,
              title: `Cross Brand Concealer ${index}`,
              brand: `Concealer Brand ${index}`,
              category: 'Concealer',
              domain: `brand-${index}.example`,
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
      domainHints: ['https://www.tomfordbeauty.com/products/shade-and-illuminate-concealer'],
      limit: 12,
      minFocusedCandidates: 12,
      deepDomainRecall: true,
    });

    expect(products).toHaveLength(12);
    expect(products.slice(0, 6).every((product) => product.domain === 'www.tomfordbeauty.com')).toBe(true);
    expect(products.slice(6).every((product) => product.category === 'Concealer')).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('domain = ANY($4)'))).toBe(true);
    expect(
      queryMock.mock.calls.some(([sql]) =>
        String(sql).includes("seed_data->'derived'->'recall'->>'category"),
      ),
    ).toBe(true);
  });

  test('deep-domain recall prefers same-domain category rows before broad same-domain rows', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)') && Array.isArray(params?.[4])) {
        expect(params[3]).toEqual(['fentybeauty.com', 'www.fentybeauty.com']);
        expect(params[4]).toEqual(expect.arrayContaining(['%brow pencil%', '%brow%pencil%']));
        return {
          rows: Array.from({ length: 12 }).map((_, index) =>
            makeExternalRow({
              id: `eps_brow_${index}`,
              external_product_id: `ext_brow_${index}`,
              title: `Brow MVP Ultra Fine Brow Pencil ${index}`,
              brand: 'Fenty Beauty',
              category: 'Brow Pencil',
              domain: 'fentybeauty.com',
            }),
          ),
        };
      }
      if (sqlText.includes('domain = ANY($4)')) {
        throw new Error('broad same-domain query should not run when same-domain category rows fill the target');
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'Fenty Beauty',
      categoryHint: 'Brow Pencil',
      domainHints: ['https://fentybeauty.com/products/brow-mvp-ultra-fine-brow-pencil-styler-auburn'],
      limit: 12,
      minFocusedCandidates: 12,
      deepDomainRecall: true,
    });

    expect(products).toHaveLength(12);
    expect(products.every((product) => product.category === 'Brow Pencil')).toBe(true);
  });

  test('deep-domain non shade-dense recall stops at focused same-domain category rows', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)') && sqlText.includes('LIKE ANY($5')) {
        return {
          rows: Array.from({ length: 12 }).map((_, index) =>
            makeExternalRow({
              id: `eps_tirtir_toner_title_${index}`,
              external_product_id: `ext_tirtir_toner_title_${index}`,
              title: `TIRTIR Toner Pad ${index}`,
              brand: 'TIRTIR Global',
              category: 'Toner',
              domain: 'tirtir.global',
            }),
          ),
        };
      }
      if (sqlText.includes('domain = ANY($4)') && Array.isArray(params?.[4])) {
        throw new Error('same-domain structured category query should not run after title rows fill the target');
      }
      if (sqlText.includes("seed_data->'derived'->'recall'->>'category")) {
        throw new Error('global category query should not run once same-domain toner rows fill the target');
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'TIRTIR Global',
      categoryHint: 'Toner',
      verticalHint: 'skincare',
      domainHints: ['https://tirtir.global/products/ice-cooling-toner-pack-pads'],
      limit: 36,
      minFocusedCandidates: 12,
      deepDomainRecall: true,
    });

    expect(products).toHaveLength(12);
    expect(products.every((product) => product.domain === 'tirtir.global')).toBe(true);
  });

  test('deep-domain recall uses catalog category path before slow JSON category/domain scans', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('FROM catalog_products cp')) {
        expect(params?.[0]).toBe('beauty/makeup/face/primer');
        return {
          rows: Array.from({ length: 12 }).map((_, index) => ({
            product_key: `cp_primer_${index}`,
            merchant_id: 'external_seed',
            platform: 'external_seed',
            source_product_id: `ext_catalog_primer_${index}`,
            product_title: `Catalog Primer ${index}`,
            brand: index === 0 ? 'TIRTIR Global' : `Primer Brand ${index}`,
            product_type: 'Primer',
            category: 'Primer',
            category_path: 'beauty/makeup/face/primer',
            canonical_url: `https://brand-${index}.example/products/primer`,
            product_image_url: `https://brand-${index}.example/primer.jpg`,
            pivota_signature_id: `sig_catalog_primer_${index}`,
            pivota_canonical_url: `https://agent.pivota.cc/products/sig_catalog_primer_${index}`,
            product_payload: {
              seed_data: {
                brand: index === 0 ? 'TIRTIR Global' : `Primer Brand ${index}`,
                title: `Catalog Primer ${index}`,
                category: 'Primer',
                product_type: 'Primer',
                price_amount: 24 + index,
                price_currency: 'USD',
                availability: 'in_stock',
                image_url: `https://brand-${index}.example/primer.jpg`,
                derived: { recall: { category: 'Primer', vertical: 'makeup' } },
              },
            },
          })),
        };
      }
      if (sqlText.includes('domain = ANY($4)') && sqlText.includes('LIKE ANY($5')) {
        throw new Error('domain title query should not run when catalog category path fills recall');
      }
      if (sqlText.includes('FROM external_product_seeds') && sqlText.includes('LIKE ANY($4::text[])')) {
        return {
          rows: Array.from({ length: 6 }).map((_, index) =>
            makeExternalRow({
              id: `eps_title_primer_${index}`,
              external_product_id: `ext_title_primer_${index}`,
              title: `Cross Brand Primer ${index}`,
              brand: `Primer Brand ${index}`,
              category: 'Primer',
              domain: `primer-brand-${index}.example`,
            }),
          ),
        };
      }
      if (sqlText.includes('external_product_id = ANY($1::text[])')) {
        return {
          rows: Array.from({ length: 12 }).map((_, index) => ({
            external_product_id: `ext_catalog_primer_${index}`,
          })),
        };
      }
      if (
        sqlText.includes("seed_data->'derived'->'recall'->>'category") ||
        (sqlText.includes('domain = ANY($4)') && !sqlText.includes('LIKE ANY($5)'))
      ) {
        throw new Error('slow JSON category/domain scans should not run after catalog category path fills recall');
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'TIRTIR Global',
      categoryHint: 'Primer',
      categoryPathHint: 'beauty/makeup/face/primer',
      verticalHint: 'makeup',
      domainHints: ['https://tirtir.global/products/reflect-glow-prep-primer'],
      limit: 36,
      minFocusedCandidates: 12,
      deepDomainRecall: true,
    });

    expect(products).toHaveLength(18);
    expect(products.map((product) => product.product_id)).toContain('ext_catalog_primer_0');
    expect(products.filter((product) => product.retrieval_source === 'catalog_category_path')).toHaveLength(12);
    expect(
      products
        .filter((product) => product.retrieval_source === 'catalog_category_path')
        .every((product) => product.category_path === 'beauty/makeup/face/primer'),
    ).toBe(true);
    expect(products.__externalFetchStats?.stages.map((stage) => stage.name)).toEqual(
      ['external_title_category', 'catalog_category_path'],
    );
  });

  test('deep-domain recall expands through same-brand rows before cross-brand category recall when same-domain underfills', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)') && sqlText.includes('LIKE ANY($5')) {
        return { rows: [] };
      }
      if (sqlText.includes('domain = ANY($4)') && Array.isArray(params?.[4])) {
        return {
          rows: Array.from({ length: 8 }).map((_, index) =>
            makeExternalRow({
              id: `eps_tirtir_cushion_${index}`,
              external_product_id: `ext_tirtir_cushion_${index}`,
              title: `Mask Fit Cushion ${index}`,
              brand: 'TIRTIR Global',
              category: 'Face Makeup/Cushion Foundation',
              domain: 'tirtir.global',
            }),
          ),
        };
      }
      if (sqlText.includes("seed_data->>'brand'")) {
        expect(params?.[3]).toEqual(expect.arrayContaining(['tirtir global', 'tirtirglobal']));
        return {
          rows: Array.from({ length: 6 }).map((_, index) =>
            makeExternalRow({
              id: `eps_tirtir_brand_${index}`,
              external_product_id: `ext_tirtir_brand_${index}`,
              title: `TIRTIR Brand Face Product ${index}`,
              brand: 'TIRTIR Global',
              category: 'Face Makeup/Concealer',
              domain: 'tirtir.global',
            }),
          ),
        };
      }
      if (sqlText.includes("seed_data->'derived'->'recall'->>'category")) {
        throw new Error('cross-brand category query should wait until same-brand expansion underfills');
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'TIRTIR Global',
      categoryHint: 'Cushion Foundation',
      verticalHint: 'makeup',
      domainHints: ['https://tirtir.global/products/mask-fit-red-cushion-mini'],
      limit: 36,
      minFocusedCandidates: 12,
      deepDomainRecall: true,
    });

    expect(products).toHaveLength(14);
    expect(products.slice(0, 8).every((product) => product.domain === 'tirtir.global')).toBe(true);
    expect(products.slice(8).every((product) => product.brand === 'TIRTIR Global')).toBe(true);
    expect(products.__externalFetchStats?.stages.map((stage) => stage.name)).toEqual(
      expect.arrayContaining(['external_brand_fields_deep']),
    );
  });

  test('deep-domain non-foundation intent uses same-domain expansion before slow global category scans', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)') && sqlText.includes('LIKE ANY($5')) {
        return { rows: [] };
      }
      if (sqlText.includes('domain = ANY($4)') && Array.isArray(params?.[4])) {
        return {
          rows: Array.from({ length: 4 }).map((_, index) =>
            makeExternalRow({
              id: `eps_medicube_domain_category_${index}`,
              external_product_id: `ext_medicube_domain_category_${index}`,
              title: `Medicube Serum Domain Category ${index}`,
              brand: 'Medicube',
              category: 'Serum',
              domain: 'medicube.us',
            }),
          ),
        };
      }
      if (sqlText.includes('domain = ANY($4)') && Array.isArray(params?.[3])) {
        return {
          rows: Array.from({ length: 12 }).map((_, index) =>
            makeExternalRow({
              id: `eps_medicube_domain_${index}`,
              external_product_id: `ext_medicube_domain_${index}`,
              title: `Medicube Booster Serum ${index}`,
              brand: 'Medicube',
              category: 'Serum',
              domain: 'medicube.us',
            }),
          ),
        };
      }
      if (sqlText.includes("seed_data->'derived'->'recall'->>'category")) {
        throw new Error('global category query should not run once same-domain intent rows are ready');
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'Medicube',
      categoryHint: 'Serum',
      verticalHint: 'skincare',
      intentFamilyHint: 'serum',
      domainHints: ['https://medicube.us/products/age-r-booster-gel-serum'],
      limit: 36,
      minFocusedCandidates: 36,
      deepDomainRecall: true,
    });

    expect(products).toHaveLength(16);
    expect(products.every((product) => product.domain === 'medicube.us')).toBe(true);
    expect(products.__externalFetchStats?.stages.map((stage) => stage.name)).toContain(
      'external_domain_pre_category',
    );
  });

  test('deep-domain strict intent returns exact same-domain category rows before slow global scans', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)') && sqlText.includes('LIKE ANY($5')) {
        return { rows: [] };
      }
      if (sqlText.includes('domain = ANY($4)') && Array.isArray(params?.[4])) {
        return {
          rows: Array.from({ length: 12 }).map((_, index) =>
            makeExternalRow({
              id: `eps_tirtir_foundation_${index}`,
              external_product_id: `ext_tirtir_foundation_${index}`,
              title: `Mask Fit Cushion Foundation ${index}`,
              brand: 'TIRTIR Global',
              category: 'Foundation',
              domain: 'tirtir.global',
            }),
          ),
        };
      }
      if (
        String(params?.[3] || '').includes('foundation|cushion|skinveil|concealer') ||
        (Array.isArray(params?.[3]) && params[3].includes('%foundation%'))
      ) {
        throw new Error('global strict intent query should not run once exact same-domain category rows are ready');
      }
      if (sqlText.includes("seed_data->'derived'->'recall'->>'category")) {
        throw new Error('global category query should not run once exact same-domain category rows are ready');
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'TIRTIR Global',
      categoryHint: 'Foundation',
      verticalHint: 'makeup',
      intentFamilyHint: 'foundation',
      domainHints: ['https://tirtir.global/products/mask-fit-red-foundation'],
      limit: 36,
      minFocusedCandidates: 36,
      deepDomainRecall: true,
    });

    expect(products).toHaveLength(12);
    expect(products.every((product) => product.domain === 'tirtir.global')).toBe(true);
    expect(
      queryMock.mock.calls.some(([_sql, params]) =>
        String(params?.[3] || '').includes('foundation|cushion|skinveil|concealer'),
      ),
    ).toBe(false);
  });

  test('deep-domain foundation intent uses same-domain title intent before slow global scans', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)') && sqlText.includes('LIKE ANY($5')) {
        return { rows: [] };
      }
      if (sqlText.includes('domain = ANY($4)') && Array.isArray(params?.[4])) {
        return { rows: [] };
      }
      if (sqlText.includes('domain = ANY($4)') && Array.isArray(params?.[3])) {
        return {
          rows: [
            ['ext_red_cushion', 'Mask Fit Red Cushion'],
            ['ext_aura_cushion', 'Mask Fit Aura Cushion'],
            ['ext_all_cover', 'Mask Fit All Cover Cushion'],
            ['ext_ai_filter', 'Mask Fit AI Filter Cushion'],
            ['ext_concealer', 'Glide & Hide Blurring Concealer'],
            ['ext_skinveil', 'H2O SkinVeil'],
            ['ext_red_foundation', 'Mask Fit Red Foundation'],
            ['ext_mesh_foundation', 'Mask Fit Mesh Foundation'],
            ['ext_cushion_mini', 'Mask Fit Red Cushion Mini'],
            ['ext_skinveil_base', 'H2O SkinVeil Base'],
            ['ext_blur_concealer', 'Glide & Hide Blurring Concealer Mini'],
            ['ext_ai_cushion', 'Mask Fit AI Filter Cushion Mini'],
            ['ext_puff', 'Soft Shell Cushion Puff'],
            ['ext_sachet', 'Sachet - Mask Fit Red Cushion Trial Kits'],
            ['ext_toner', 'Milk Skin Toner'],
          ].map(([external_product_id, title], index) =>
            makeExternalRow({
              id: `eps_tirtir_domain_${index}`,
              external_product_id,
              title,
              brand: 'TIRTIR Global',
              category: 'Makeup',
              domain: 'tirtir.global',
            }),
          ),
        };
      }
      if (
        String(params?.[3] || '').includes('foundation|cushion|skinveil|concealer') ||
        (Array.isArray(params?.[3]) && params[3].includes('%foundation%'))
      ) {
        throw new Error('global foundation intent query should not run when same-domain title intent rows are ready');
      }
      if (sqlText.includes("seed_data->'derived'->'recall'->>'category")) {
        throw new Error('global category query should not run when same-domain title intent rows are ready');
      }
      return { rows: [] };
    });

    jest.doMock('../../src/db', () => ({ query: queryMock }));
    jest.doMock('../../src/logger', () => ({ warn: jest.fn(), info: jest.fn() }));

    const { _internals } = require('../../src/services/RecommendationEngine');
    const products = await _internals.fetchExternalCandidates({
      brandHint: 'TIRTIR Global',
      categoryHint: 'Foundation',
      verticalHint: 'makeup',
      intentFamilyHint: 'foundation',
      domainHints: ['https://tirtir.global/products/mask-fit-red-foundation'],
      limit: 36,
      minFocusedCandidates: 36,
      deepDomainRecall: true,
    });

    expect(products.map((product) => product.product_id)).toEqual([
      'ext_red_cushion',
      'ext_aura_cushion',
      'ext_all_cover',
      'ext_ai_filter',
      'ext_concealer',
      'ext_skinveil',
      'ext_red_foundation',
      'ext_mesh_foundation',
      'ext_cushion_mini',
      'ext_skinveil_base',
      'ext_blur_concealer',
      'ext_ai_cushion',
    ]);
    expect(products.map((product) => product.product_id)).not.toContain('ext_puff');
    expect(products.map((product) => product.product_id)).not.toContain('ext_sachet');
    expect(products.map((product) => product.product_id)).not.toContain('ext_toner');
  });

  test('deep-domain recall adds sparse haircare vertical rows without visible fallback', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (_sql, params) => {
      if (params?.[3] === 'haircare' && String(params?.[4] || '').includes('scalp')) {
        return {
          rows: [
            makeExternalRow({
              id: 'eps_scalp_1',
              external_product_id: 'ext_scalp_1',
              title: 'Complete Pre-Wash Scalp Oil',
              brand: 'JVN',
              category: 'Scalp Treatment',
              domain: 'jvn.com',
            }),
            makeExternalRow({
              id: 'eps_hair_mask_1',
              external_product_id: 'ext_hair_mask_1',
              title: 'Intense Repair Hair Mask',
              brand: 'K18',
              category: 'Hair Mask',
              domain: 'k18hair.com',
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
      brandHint: 'COSRX',
      categoryHint: 'Shampoo',
      verticalHint: 'haircare',
      domainHints: ['https://cosrx.com/products/peptide-132-ultra-perfect-hair-bonding-shampoo'],
      limit: 12,
      minFocusedCandidates: 12,
      deepDomainRecall: true,
    });

    expect(products.map((product) => product.product_id)).toEqual(
      expect.arrayContaining(['ext_scalp_1', 'ext_hair_mask_1']),
    );
    expect(
      queryMock.mock.calls.some(([_sql, params]) => params?.[3] === 'haircare'),
    ).toBe(true);
  });

  test('deep-domain recall adds strict intent-family rows without visible fallback', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (_sql, params) => {
      if (Array.isArray(params?.[3]) && params[3].includes('%spf%')) {
        return {
          rows: [
            makeExternalRow({
              id: 'eps_spf_1',
              external_product_id: 'ext_spf_1',
              title: 'Beet The Sun SPF 40 PA+++',
              brand: 'KraveBeauty',
              category: 'Sunscreen',
              domain: 'kravebeauty.com',
            }),
            makeExternalRow({
              id: 'eps_spf_2',
              external_product_id: 'ext_spf_2',
              title: 'Daily Tinted Fluid Sunscreen MY210',
              brand: 'Beauty of Joseon',
              category: 'Sunscreen',
              domain: 'beautyofjoseon.com',
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
      brandHint: 'Round Lab',
      categoryHint: 'Sunscreen',
      verticalHint: 'skincare',
      intentFamilyHint: 'sunscreen',
      domainHints: ['https://roundlab.com/products/birch-mild-up-sunscreen'],
      limit: 12,
      minFocusedCandidates: 12,
      deepDomainRecall: true,
    });

    expect(products.map((product) => product.product_id)).toEqual(
      expect.arrayContaining(['ext_spf_1', 'ext_spf_2']),
    );
    expect(
      queryMock.mock.calls.some(([_sql, params]) => Array.isArray(params?.[3]) && params[3].includes('%spf%')),
    ).toBe(true);
  });

  test('deep-domain recall does not let domain-only rows short-circuit a strict intent family', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)') && Array.isArray(params?.[3])) {
        return {
          rows: Array.from({ length: 14 }, (_, index) =>
            makeExternalRow({
              id: `eps_domain_${index}`,
              external_product_id: `ext_domain_${index}`,
              title: `Round Lab Domain Product ${index}`,
              brand: 'Round Lab',
              category: 'Skincare',
              domain: 'roundlab.com',
            }),
          ),
        };
      }
      if (Array.isArray(params?.[3]) && params[3].includes('%spf%')) {
        return {
          rows: [
            makeExternalRow({
              id: 'eps_spf_global',
              external_product_id: 'ext_spf_global',
              title: 'Beet The Sun SPF 40 PA+++',
              brand: 'KraveBeauty',
              category: 'Sunscreen',
              domain: 'kravebeauty.com',
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
      brandHint: 'Round Lab',
      categoryHint: '',
      verticalHint: 'skincare',
      intentFamilyHint: 'sunscreen',
      domainHints: ['https://roundlab.com/products/deal-birch-sunscreen'],
      limit: 12,
      minFocusedCandidates: 12,
      deepDomainRecall: true,
    });

    expect(products.map((product) => product.product_id)).toContain('ext_spf_global');
    expect(
      queryMock.mock.calls.some(([_sql, params]) => Array.isArray(params?.[3]) && params[3].includes('%spf%')),
    ).toBe(true);
  });

  test('deep-domain recall does not let same-domain category rows short-circuit a different strict intent family', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)') && sqlText.includes('LIKE ANY($5::text[])')) {
        return {
          rows: Array.from({ length: 12 }).map((_, index) =>
            makeExternalRow({
              id: `eps_tirtir_serum_title_${index}`,
              external_product_id: `ext_tirtir_serum_title_${index}`,
              title: `TIRTIR Glow Serum ${index}`,
              brand: 'TIRTIR Global',
              category: 'Serum',
              domain: 'tirtir.global',
            }),
          ),
        };
      }
      if (
        sqlText.includes('domain = ANY($4)') &&
        sqlText.includes("seed_data->'derived'->'recall'->>'category")
      ) {
        return {
          rows: Array.from({ length: 12 }).map((_, index) =>
            makeExternalRow({
              id: `eps_tirtir_serum_structured_${index}`,
              external_product_id: `ext_tirtir_serum_structured_${index}`,
              title: `TIRTIR Skin Serum ${index}`,
              brand: 'TIRTIR Global',
              category: 'Serum',
              domain: 'tirtir.global',
            }),
          ),
        };
      }
      if (
        sqlText.includes("seed_data->'derived'->'recall'->>'retrieval_title'") &&
        Array.isArray(params?.[3]) &&
        params[3].includes('%highlighter%')
      ) {
        return {
          rows: [
            makeExternalRow({
              id: 'eps_highlighter_1',
              external_product_id: 'ext_highlighter_1',
              title: 'Diamond Bomb All-Over Diamond Veil Highlighter',
              brand: 'Fenty Beauty',
              category: 'Highlighter',
              domain: 'fentybeauty.com',
            }),
            makeExternalRow({
              id: 'eps_highlighter_2',
              external_product_id: 'ext_highlighter_2',
              title: 'Kylighter Illuminating Powder',
              brand: 'Kylie Cosmetics',
              category: 'Highlighter',
              domain: 'kyliecosmetics.com',
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
      brandHint: 'TIRTIR Global',
      categoryHint: 'Serum',
      verticalHint: 'makeup',
      intentFamilyHint: 'highlighter',
      domainHints: ['https://tirtir.global/products/my-glow-ampoule-highlighter'],
      limit: 36,
      minFocusedCandidates: 12,
      deepDomainRecall: true,
    });

    expect(products.map((product) => product.product_id)).toEqual(
      expect.arrayContaining(['ext_highlighter_1', 'ext_highlighter_2']),
    );
    expect(products.map((product) => product.product_id)).not.toEqual(
      expect.arrayContaining(['ext_tirtir_serum_title_0', 'ext_tirtir_serum_structured_0']),
    );
    expect(
      queryMock.mock.calls.some(([sql]) =>
        String(sql).includes("seed_data->'derived'->'recall'->>'retrieval_title'"),
      ),
    ).toBe(true);
  });

  test('new strict external intent families cover fragrance, face oil, body oil, eye cream, and moisturizer text', () => {
    const { _internals } = require('../../src/services/RecommendationEngine');

    expect(_internals.getSimilarIntentFamilyFromText('Cosmic 2.0 Eau de Parfum')).toBe('fragrance');
    expect(_internals.getSimilarIntentFamilyFromText('Rare Rose Face Oil')).toBe('face_oil');
    expect(_internals.getSimilarIntentFamilyFromText('Lavender Body Oil')).toBe('body_oil');
    expect(_internals.getSimilarIntentFamilyFromText('Rose Body Lotion')).toBe('body_oil');
    expect(_internals.getSimilarIntentFamilyFromText('Herbal Recovery Eye Cream')).toBe('eye_cream');
    expect(_internals.getSimilarIntentFamilyFromText('Moisture Replenishing Day Cream')).toBe('moisturizer');
    expect(_internals.getSimilarIntentFamilyFromText('My Glow Black Honey Lip Oil')).toBe('lip_oil');
    expect(_internals.getSimilarIntentFamilyFromText('Skin Tint Blurring Elixir')).toBe('foundation');
    expect(_internals.getSimilarIntentFamilyFromFeatures({
      normalizedTitle: 'herbal recovery cream',
      leafCategory: 'cream',
      parentCategory: 'moisturize',
    })).toBe('moisturizer');
  });

  test('strict sunscreen deep-domain recall does not count incidental category rows as focused coverage', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const pixiShieldRows = [
      makeExternalRow({
        id: 'eps_pixi_shield_duo',
        external_product_id: 'ext_pixi_shield_duo',
        title: 'On-the-Glow SHIELD SPF 50 Sunscreen Duo',
        brand: 'PIXI BEAUTY',
        category: 'Sunscreen',
        domain: 'pixibeauty.com',
      }),
      makeExternalRow({
        id: 'eps_pixi_shield_trio',
        external_product_id: 'ext_pixi_shield_trio',
        title: 'On-the-Glow SHIELD SPF 50 Sunscreen Trio',
        brand: 'PIXI BEAUTY',
        category: 'Sunscreen',
        domain: 'pixibeauty.com',
      }),
    ];
    const incidentalPixiRows = Array.from({ length: 8 }).map((_, index) =>
      makeExternalRow({
        id: `eps_pixi_incidental_${index}`,
        external_product_id: `ext_pixi_incidental_${index}`,
        title: `Double Cleanse ${index}`,
        brand: 'PIXI BEAUTY',
        category: 'Sunscreen',
        domain: 'pixibeauty.com',
        description: 'Removes makeup and sunscreen.',
      }),
    );

    const queryMock = jest.fn(async (sql) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)') && sqlText.includes("lower(coalesce(title, '')) LIKE ANY")) {
        return { rows: pixiShieldRows };
      }
      if (sqlText.includes('domain = ANY($4)') && sqlText.includes("seed_data->'derived'->'recall'->>'category")) {
        return { rows: [...pixiShieldRows, ...incidentalPixiRows] };
      }
      if (
        sqlText.includes("seed_data->'derived'->'recall'->>'retrieval_title'") &&
        !sqlText.includes('domain = ANY($4)')
      ) {
        return {
          rows: Array.from({ length: 6 }).map((_, index) =>
            makeExternalRow({
              id: `eps_cross_brand_sunscreen_${index}`,
              external_product_id: `ext_cross_brand_sunscreen_${index}`,
              title: `Daily SPF 50 Sunscreen ${index}`,
              brand: `SPF Brand ${index}`,
              category: 'Sunscreen',
              domain: `spf-brand-${index}.example`,
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
      brandHint: 'PIXI BEAUTY',
      categoryHint: 'Sunscreen',
      intentFamilyHint: 'sunscreen',
      domainHints: ['https://pixibeauty.com/products/on-the-glow-shield'],
      limit: 48,
      minFocusedCandidates: 8,
      deepDomainRecall: true,
    });

    expect(products.some((product) => product.domain === 'pixibeauty.com')).toBe(true);
    expect(products.some((product) => /^spf-brand-/i.test(product.domain))).toBe(true);
    expect(products.some((product) => /^Double Cleanse/i.test(product.title))).toBe(false);
    expect(
      queryMock.mock.calls.some(
        ([sql]) =>
          String(sql).includes("seed_data->'derived'->'recall'->>'retrieval_title'") &&
          !String(sql).includes('domain = ANY($4)'),
      ),
    ).toBe(true);
  });

  test('deep-domain recall still loads global category rows when same-domain category rows may collapse by identity', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)') && Array.isArray(params?.[4])) {
        return {
          rows: Array.from({ length: 30 }).map((_, index) =>
            makeExternalRow({
              id: `eps_fenty_concealer_shade_${index}`,
              external_product_id: `ext_fenty_concealer_shade_${index}`,
              title: `Pro Filt'r Instant Retouch Concealer ${index}`,
              brand: 'Fenty Beauty',
              category: 'Concealer',
              domain: 'fentybeauty.com',
            }),
          ),
        };
      }
      if (sqlText.includes('domain = ANY($4)')) {
        throw new Error('broad same-domain query should wait until exact category expansion underfills');
      }
      if (sqlText.includes("seed_data->'derived'->'recall'->>'category")) {
        expect(params?.[3]).toContain('concealer');
        return {
          rows: Array.from({ length: 6 }).map((_, index) =>
            makeExternalRow({
              id: `eps_cross_brand_concealer_${index}`,
              external_product_id: `ext_cross_brand_concealer_${index}`,
              title: `Cross Brand Concealer ${index}`,
              brand: `Concealer Brand ${index}`,
              category: 'Concealer',
              domain: `concealer-brand-${index}.example`,
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
      brandHint: 'Fenty Beauty',
      categoryHint: 'Concealer',
      domainHints: ['https://fentybeauty.com/products/pro-filtr-instant-retouch-concealer-120-concealer'],
      limit: 48,
      minFocusedCandidates: 24,
      deepDomainRecall: true,
    });

    expect(products.some((product) => product.domain === 'fentybeauty.com')).toBe(true);
    expect(products.some((product) => /^concealer-brand-/i.test(product.domain))).toBe(true);
    expect(
      queryMock.mock.calls.some(
        ([sql]) =>
          String(sql).includes("seed_data->'derived'->'recall'->>'category") &&
          !String(sql).includes('domain = ANY($4)'),
      ),
    ).toBe(true);
  });

  test('deep-domain recall does not let global category rows starve same-domain sibling rows', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('domain = ANY($4)') && Array.isArray(params?.[4])) {
        return { rows: [] };
      }
      if (
        sqlText.includes("seed_data->'derived'->'recall'->>'category") &&
        !sqlText.includes('domain = ANY($4)')
      ) {
        return {
          rows: Array.from({ length: 6 }).map((_, index) =>
            makeExternalRow({
              id: `eps_global_foundation_${index}`,
              external_product_id: `ext_global_foundation_${index}`,
              title: `Cross Brand Foundation ${index}`,
              brand: `Foundation Brand ${index}`,
              category: 'Foundation',
              domain: `foundation-brand-${index}.example`,
            }),
          ),
        };
      }
      if (sqlText.includes('domain = ANY($4)')) {
        return {
          rows: Array.from({ length: 4 }).map((_, index) =>
            makeExternalRow({
              id: `eps_tirtir_cushion_${index}`,
              external_product_id: `ext_tirtir_cushion_${index}`,
              title: `Mask Fit Cushion ${index}`,
              brand: 'TIRTIR Global',
              category: 'Face Makeup/Cushion Foundation',
              domain: 'tirtir.global',
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
      brandHint: 'TIRTIR Global',
      categoryHint: 'Foundation',
      domainHints: ['https://tirtir.global/products/mask-fit-red-foundation'],
      limit: 24,
      minFocusedCandidates: 6,
      deepDomainRecall: true,
    });

    expect(products.some((product) => product.domain === 'tirtir.global')).toBe(true);
    expect(products.some((product) => /^foundation-brand-/i.test(product.domain))).toBe(true);
    expect(
      queryMock.mock.calls.some(
        ([sql, params]) =>
          String(sql).includes('domain = ANY($4)') &&
          !Array.isArray(params?.[4]),
      ),
    ).toBe(true);
  });

  test('strict external leaf categories do not use same-brand same-vertical padding', () => {
    const { pickLayeredRecommendations } = require('../../src/services/RecommendationEngine');
    const result = pickLayeredRecommendations({
      baseProduct: {
        merchant_id: 'external_seed',
        product_id: 'ext_brow_base',
        title: 'Brow MVP Ultra Fine Brow Pencil & Styler — Auburn',
        brand: 'Fenty Beauty',
        category: 'Brow Pencil',
        product_type: 'Brow Pencil',
        price: 25,
        currency: 'USD',
        source: 'external_seed',
      },
      externalCandidates: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_lip_gloss',
          title: 'Gloss Bomb Heat Universal Lip Luminizer + Plumper — Lavender Savage',
          brand: 'Fenty Beauty',
          category: 'Lip Gloss',
          product_type: 'Lip Gloss',
          price: 17,
          currency: 'USD',
          source: 'external_seed',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_gloss_holder',
          title: 'Fuzzy Gloss Bomb Holder',
          brand: 'Fenty Beauty',
          category: 'Lip Gloss',
          product_type: 'Lip Gloss',
          price: 10,
          currency: 'USD',
          source: 'external_seed',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_foundation',
          title: "Pro Filt'r Soft Matte Foundation",
          brand: 'Fenty Beauty',
          category: 'Foundation',
          product_type: 'Foundation',
          price: 40,
          currency: 'USD',
          source: 'external_seed',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_brow_match',
          title: 'Brow MVP Sculpting Wax Pencil & Styler',
          brand: 'Fenty Beauty',
          category: 'Brow Pencil',
          product_type: 'Brow Pencil',
          price: 24,
          currency: 'USD',
          source: 'external_seed',
        },
      ],
      k: 4,
      baseSemantic: { vertical: 'makeup', signal_strength: 3 },
    });

    expect(result.items.map((item) => item.product_id)).toEqual(['ext_brow_match']);
    expect(result.debug?.filters?.by_confidence).toBeGreaterThanOrEqual(3);
  });

  test('strict complexion singles can use same-brand same-intent bundles without admitting brush-only tools', () => {
    const { pickLayeredRecommendations } = require('../../src/services/RecommendationEngine');
    const result = pickLayeredRecommendations({
      baseProduct: {
        merchant_id: 'external_seed',
        product_id: 'ext_kylie_foundation',
        title: 'Power Plush Longwear Foundation',
        brand: 'Kylie Cosmetics',
        category: 'Foundation',
        product_type: 'Foundation',
        price: 36,
        currency: 'USD',
        source: 'external_seed',
        semantic_vertical: 'makeup',
      },
      externalCandidates: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_kylie_foundation_trio',
          title: 'Power Plush Foundation Trio',
          brand: 'Kylie Cosmetics',
          category: 'Foundation',
          product_type: 'Foundation',
          price: 88.2,
          currency: 'USD',
          source: 'external_seed',
          semantic_vertical: 'makeup',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_kylie_foundation_concealer',
          title: 'Power Plush Foundation & Concealer Duo',
          brand: 'Kylie Cosmetics',
          category: 'Foundation',
          product_type: 'Foundation',
          price: 62,
          currency: 'USD',
          source: 'external_seed',
          semantic_vertical: 'makeup',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_kylie_foundation_brush',
          title: 'Foundation Brush 01',
          brand: 'Kylie Cosmetics',
          category: 'Makeup Brush',
          product_type: 'Makeup Brush',
          price: 22,
          currency: 'USD',
          source: 'external_seed',
          semantic_vertical: 'tools',
        },
      ],
      k: 4,
      baseSemantic: { vertical: 'makeup', signal_strength: 3 },
    });

    expect(result.items.map((item) => item.product_id)).toEqual([
      'ext_kylie_foundation_concealer',
      'ext_kylie_foundation_trio',
    ]);
    expect(result.items.map((item) => item.product_id)).not.toContain('ext_kylie_foundation_brush');
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
      k: 6,
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
    expect(result.metadata.low_confidence_reason_codes || []).not.toEqual(
      expect.arrayContaining(['UNDERFILL_MAINLINE_RECALL']),
    );
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

  test('deep domain recall stops once exact domain/category has display-unique coverage for identity-protected foundation', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn(async (sql) => {
      const sqlText = String(sql);
      if (
        sqlText.includes('domain = ANY($4)') &&
        sqlText.includes('lower(coalesce(title') &&
        sqlText.includes('LIKE ANY($5::text[])')
      ) {
        return { rows: [] };
      }
      if (
        sqlText.includes('domain = ANY($4)') &&
        sqlText.includes("lower(coalesce(") &&
        sqlText.includes("seed_data->'derived'->'recall'->>'category'")
      ) {
        return {
          rows: Array.from({ length: 8 }).map((_, index) =>
            makeExternalRow({
              id: `eps_foundation_${index}`,
              external_product_id: `ext_foundation_${index}`,
              title: `Mask Fit Red Foundation ${index + 1}`,
              brand: 'TIRTIR Global',
              category: 'Foundation',
              domain: 'tirtir.global',
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
      brandHint: 'TIRTIR Global',
      categoryHint: 'Foundation',
      verticalHint: 'makeup',
      intentFamilyHint: 'foundation',
      domainHints: ['tirtir.global'],
      limit: 48,
      minFocusedCandidates: 8,
      deepDomainRecall: true,
    });

    expect(products).toHaveLength(8);
    expect(products.__externalFetchStats?.focused_target_count).toBe(8);
    expect(products.__externalFetchStats?.stages.map((stage) => stage.name)).toEqual([
      'external_domain_title_category',
      'external_domain_category',
    ]);
    expect(
      queryMock.mock.calls.some(([sql]) =>
        String(sql).includes("seed_data->'derived'->'recall'->>'retrieval_title'"),
      ),
    ).toBe(false);
    expect(
      queryMock.mock.calls.some(([sql]) =>
        String(sql).includes("regexp_replace(lower(coalesce(seed_data->>'brand'"),
      ),
    ).toBe(false);
  });

  test('recommend includes explicit seed domain when canonical URL is a regional subdomain', async () => {
    process.env.DATABASE_URL = 'postgres://example.test/pivota';

    const queryMock = jest.fn((sql, params) => {
      const sqlText = String(sql);
      if (sqlText.includes('FROM products_cache')) {
        return Promise.resolve({ rows: [] });
      }
      if (sqlText.includes('domain = ANY($4)')) {
        expect(params?.[3]).toEqual(
          expect.arrayContaining([
            'nl.beautyofjoseon.com',
            'www.nl.beautyofjoseon.com',
            'beautyofjoseon.com',
            'www.beautyofjoseon.com',
          ]),
        );
        return Promise.resolve({
          rows: [
            makeExternalRow({
              id: 'eps_lucky_pouch',
              external_product_id: 'ext_lucky_pouch',
              title: 'Lucky Pouch',
              brand: 'Beauty of Joseon',
              category: 'Accessories/Pouch',
              domain: 'beautyofjoseon.com',
            }),
            makeExternalRow({
              id: 'eps_soap_saver',
              external_product_id: 'ext_soap_saver',
              title: 'Nobang Soap Saver',
              brand: 'Beauty of Joseon',
              category: 'Accessories/Cleansing Tool',
              domain: 'beautyofjoseon.com',
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
        merchant_id: 'external_seed',
        product_id: 'ext_bojagi',
        title: 'Bojagi',
        brand: { name: 'Beauty of Joseon' },
        category_path: ['Accessories', 'Gift Wrap'],
        canonical_url: 'https://nl.beautyofjoseon.com/products/bojagi',
        domain: 'beautyofjoseon.com',
        semantic_vertical: 'tools',
        source: 'external_seed',
        price: { current: { amount: 14, currency: 'USD' } },
        inventory_quantity: 10,
        status: 'active',
      },
      k: 2,
      options: { debug: true, no_cache: true },
    });

    expect(result.items.map((item) => item.product_id)).toEqual(
      expect.arrayContaining(['ext_lucky_pouch', 'ext_soap_saver']),
    );
    expect(result.metadata.similar_status).toBe('ready');
  });

  test('recommend accepts external fragrance leaf matches when catalog category path supplies vertical quality', async () => {
    const { recommend, _internals } = require('../../src/services/RecommendationEngine');
    _internals.resetCache();

    const result = await recommend({
      pdp_product: {
        merchant_id: 'external_seed',
        product_id: 'ext_kylie_cosmic_2',
        title: 'Cosmic 2.0 Eau de Parfum',
        brand: 'Kylie Cosmetics',
        category_path: 'beauty/fragrance/perfume',
        canonical_url: 'https://kyliecosmetics.com/products/cosmic-2-eau-de-parfum',
        price: 78,
        currency: 'USD',
        inventory_quantity: 10,
        status: 'active',
        source: 'external_seed',
      },
      k: 6,
      options: {
        debug: true,
        no_cache: true,
        internal_candidates: [],
        external_candidates: [
          ...[
            'Cosmic Kylie Jenner Eau de Parfum',
            'Cosmic 2.0 Eau de Parfum Pen Spray',
            'Pixi Rose Eau de Parfum',
            'Pixi Jasmine Eau de Parfum',
          ].map((title, index) => ({
            merchant_id: 'external_seed',
            product_id: `ext_fragrance_${index}`,
            title,
            brand: index < 2 ? 'Kylie Cosmetics' : 'Pixi',
            category_path: 'beauty/fragrance/perfume',
            price: 60 + index * 5,
            currency: 'USD',
            inventory_quantity: 10,
            status: 'active',
            source: 'external_seed',
          })),
          {
            merchant_id: 'external_seed',
            product_id: 'ext_fragrance_bundle',
            title: 'Cosmic Kylie Jenner 50ml & Pen Spray Duo',
            brand: 'Kylie Cosmetics',
            category: 'Fragrance',
            product_type: 'Fragrance',
            category_path: 'beauty/sets/gift-set',
            semantic_vertical: 'fragrance',
            price: 66,
            currency: 'USD',
            inventory_quantity: 10,
            status: 'active',
            source: 'external_seed',
          },
          {
            merchant_id: 'external_seed',
            product_id: 'ext_fragrance_bundle_large',
            title: 'Cosmic Kylie Jenner 100ml & Pen Spray Duo',
            brand: 'Kylie Cosmetics',
            category: 'Fragrance',
            product_type: 'Fragrance',
            category_path: 'beauty/sets/gift-set',
            semantic_vertical: 'fragrance',
            price: 101,
            currency: 'USD',
            inventory_quantity: 10,
            status: 'active',
            source: 'external_seed',
          },
          {
            merchant_id: 'external_seed',
            product_id: 'ext_lip_glaze_bundle',
            title: 'Supple Kiss Lip Glaze Bundle',
            brand: 'Kylie Cosmetics',
            category: 'Fragrance',
            product_type: 'Fragrance',
            category_path: 'beauty/makeup/lip/lipstick',
            semantic_vertical: 'makeup',
            price: 113,
            currency: 'USD',
            inventory_quantity: 10,
            status: 'active',
            source: 'external_seed',
          },
        ],
      },
    });

    expect(result.debug?.base?.vertical).toBe('fragrance');
    expect(result.metadata.similar_status).toBe('ready');
    expect(result.items.length).toBeGreaterThanOrEqual(5);
    expect(result.items.map((item) => item.product_id)).toContain('ext_fragrance_bundle');
    expect(result.items.map((item) => item.product_id)).not.toContain('ext_lip_glaze_bundle');
    expect(result.items.every((item) => item.merchant_id === 'external_seed')).toBe(true);
  });

  test('recommend uses raw seed category intent for gift-set PDPs before falling back to generic gift sets', async () => {
    const { recommend, _internals } = require('../../src/services/RecommendationEngine');
    _internals.resetCache();

    const result = await recommend({
      pdp_product: {
        merchant_id: 'external_seed',
        product_id: 'ext_tirtir_my_glow_holiday',
        title: 'My Glow Holiday Edition',
        brand: 'TIRTIR Global',
        category: 'Lip Oil',
        product_type: 'Lip Oil',
        category_path: 'beauty/makeup/sets/gift-set',
        price: 3,
        currency: 'USD',
        inventory_quantity: 10,
        status: 'active',
        source: 'external_seed',
      },
      k: 4,
      options: {
        debug: true,
        no_cache: true,
        internal_candidates: [],
        external_candidates: [
          ...[
            'My Glow Black Honey Lip Oil',
            'My Glow Rosy Lip Oil',
            'Crystal Lip Oil',
            'Glow Lip Glaze',
          ].map((title, index) => ({
            merchant_id: 'external_seed',
            product_id: `ext_lip_oil_${index}`,
            title,
            brand: index < 2 ? 'TIRTIR Global' : `Lip Brand ${index}`,
            category: 'Lip Oil',
            product_type: 'Lip Oil',
            category_path: 'beauty/makeup/lip/lip-oil',
            semantic_vertical: 'makeup',
            price: 12 + index,
            currency: 'USD',
            inventory_quantity: 10,
            status: 'active',
            source: 'external_seed',
          })),
          {
            merchant_id: 'external_seed',
            product_id: 'ext_generic_set_category_only',
            title: 'The Modern Muse Set',
            brand: 'Sigma Beauty',
            category: 'Lip Oil',
            product_type: 'Lip Oil',
            category_path: 'beauty/makeup/sets/gift-set',
            semantic_vertical: 'makeup',
            price: 72,
            currency: 'USD',
            inventory_quantity: 10,
            status: 'active',
            source: 'external_seed',
          },
        ],
      },
    });

    expect(result.debug?.fetch_strategy?.base_intent_family).toBe('lip_oil');
    expect(result.metadata.similar_status).toBe('ready');
    expect(result.items.map((item) => item.product_id)).toEqual(
      expect.arrayContaining(['ext_lip_oil_0', 'ext_lip_oil_1']),
    );
    expect(result.items.map((item) => item.product_id)).not.toContain('ext_generic_set_category_only');
  });

  test('recommend lets catalog category path override stale external seed vertical before picking similar products', async () => {
    const { recommend, _internals } = require('../../src/services/RecommendationEngine');
    _internals.resetCache();

    const result = await recommend({
      pdp_product: {
        merchant_id: 'external_seed',
        product_id: 'ext_jurlique_rare_rose_face_oil',
        title: 'Rare Rose Face Oil',
        brand: 'Jurlique',
        category_path: 'beauty/skincare/moisturize/oil',
        semantic_vertical: 'fragrance',
        recall_vertical: 'fragrance',
        price: 70,
        currency: 'USD',
        inventory_quantity: 10,
        status: 'active',
        source: 'external_seed',
      },
      k: 4,
      options: {
        debug: true,
        no_cache: true,
        internal_candidates: [],
        external_candidates: [
          'Herbal Recovery Face Oil',
          'Antioxidant Face Oil',
          'Nourishing Facial Oil',
          'Glow Replenishing Face Oil',
        ].map((title, index) => ({
          merchant_id: 'external_seed',
          product_id: `ext_face_oil_${index}`,
          title,
          brand: index === 0 ? 'Jurlique' : `Skincare Brand ${index}`,
          category_path: 'beauty/skincare/moisturize/oil',
          price: 60 + index * 4,
          currency: 'USD',
          inventory_quantity: 10,
          status: 'active',
          source: 'external_seed',
        })),
      },
    });

    expect(result.debug?.base?.vertical).toBe('skincare');
    expect(result.metadata.similar_status).toBe('ready');
    expect(result.items.map((item) => item.product_id)).toEqual(
      expect.arrayContaining(['ext_face_oil_0', 'ext_face_oil_1']),
    );
  });

  test('recommend treats skincare moisturize cream siblings as moisturizer intent matches', async () => {
    const { recommend, _internals } = require('../../src/services/RecommendationEngine');
    _internals.resetCache();

    const result = await recommend({
      pdp_product: {
        merchant_id: 'external_seed',
        product_id: 'ext_jurlique_day_cream',
        title: 'Moisture Replenishing Day Cream',
        brand: 'Jurlique',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        category_path: 'beauty/skincare/moisturize/cream',
        price: 100,
        currency: 'USD',
        inventory_quantity: 10,
        status: 'active',
        source: 'external_seed',
      },
      k: 4,
      options: {
        debug: true,
        no_cache: true,
        internal_candidates: [],
        external_candidates: [
          'Herbal Recovery Cream',
          'Rare Rose Cream',
          'Balancing Day Care Cream',
          'Calendula Cream',
        ].map((title, index) => ({
          merchant_id: 'external_seed',
          product_id: `ext_jurlique_cream_${index}`,
          title,
          brand: 'Jurlique',
          category: 'Cream',
          product_type: 'Cream',
          category_path: 'beauty/skincare/moisturize/cream',
          price: 60 + index * 8,
          currency: 'USD',
          inventory_quantity: 10,
          status: 'active',
          source: 'external_seed',
        })),
      },
    });

    expect(result.debug?.fetch_strategy?.base_intent_family).toBe('moisturizer');
    expect(result.metadata.similar_status).toBe('ready');
    expect(result.items.map((item) => item.product_id)).toEqual(
      expect.arrayContaining(['ext_jurlique_cream_0', 'ext_jurlique_cream_1']),
    );
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
