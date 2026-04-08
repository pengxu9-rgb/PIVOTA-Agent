const {
  recommend,
  pickLayeredRecommendations,
  getCacheStats,
  _internals,
} = require('../../src/services/RecommendationEngine');

function makeProduct({
  merchant_id = 'merch_a',
  product_id,
  title,
  vendor,
  brand,
  category_path,
  category,
  product_type,
  price = 20,
  currency = 'USD',
  inventory_quantity = 10,
  status = 'active',
  source,
} = {}) {
  return {
    merchant_id,
    product_id,
    title: title || product_id,
    ...(vendor ? { vendor } : {}),
    ...(brand ? { brand } : {}),
    ...(category_path ? { category_path } : {}),
    ...(category ? { category } : {}),
    ...(product_type ? { product_type } : {}),
    price,
    currency,
    inventory_quantity,
    status,
    ...(source ? { source } : {}),
  };
}

describe('RecommendationEngine (PDP)', () => {
  beforeEach(() => {
    _internals.resetCache();
  });

  test('same-brand same-leaf candidates dominate the ranked set', () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_1',
      title: 'Nike Running Shoes',
      vendor: 'Nike',
      category_path: ['Clothing', 'Shoes'],
      price: 100,
    });

    const internal = [
      makeProduct({
        merchant_id: 'merch_store',
        product_id: 'I1',
        title: 'Nike Shoes 1',
        vendor: 'Nike',
        category_path: ['Clothing', 'Shoes'],
        price: 95,
      }),
      makeProduct({
        merchant_id: 'merch_store',
        product_id: 'I2',
        title: 'Nike Shoes 2',
        vendor: 'Nike',
        category_path: ['Clothing', 'Shoes'],
        price: 110,
      }),
      makeProduct({
        merchant_id: 'merch_store',
        product_id: 'I3',
        title: 'Nike Slides',
        vendor: 'Nike',
        category_path: ['Clothing', 'Sandals'],
        price: 99,
      }),
      makeProduct({
        merchant_id: 'merch_store',
        product_id: 'I4',
        title: 'Adidas Shoes',
        vendor: 'Adidas',
        category_path: ['Clothing', 'Shoes'],
        price: 100,
      }),
    ];
    const external = [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'E1',
        title: 'Nike External Shoe',
        vendor: 'Nike',
        category_path: ['Clothing', 'Shoes'],
        price: 105,
        source: 'external_seed',
      }),
    ];

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: internal,
      externalCandidates: external,
      k: 4,
    });

    expect(out.items).toHaveLength(4);
    const brands = out.items.map((item) => _internals.getBrandName(item));
    expect(brands.every((brandName) => brandName === 'nike')).toBe(true);
    expect(out.metadata.similar_confidence).toBe('high');
  });

  test('cross-brand same-category candidates now resolve to healthy empty', async () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_SWEATER',
      title: 'Warm Knit Sweater',
      vendor: 'Acme',
      category_path: ['Apparel', 'Sweaters'],
      price: 30,
    });

    const internal = [
      makeProduct({
        merchant_id: 'merch_store',
        product_id: 'I1',
        title: 'Wool Sweater',
        vendor: 'Other',
        category_path: ['Apparel', 'Sweaters'],
        price: 28,
      }),
      makeProduct({
        merchant_id: 'merch_store',
        product_id: 'I2',
        title: 'Cotton Sweater',
        vendor: 'Other',
        category_path: ['Apparel', 'Sweaters'],
        price: 31,
      }),
    ];

    const result = await recommend({
      pdp_product: base,
      k: 3,
      locale: 'en-US',
      currency: 'USD',
      options: {
        debug: true,
        internal_candidates: internal,
        external_candidates: [],
      },
    });

    expect(result.items).toHaveLength(0);
    expect(result.metadata.similar_status).toBe('empty');
    expect(result.metadata.empty_reason).toBe('no_same_brand_candidates');
  });

  test('external seed anchor uses same-brand external candidates without balanced mixing', async () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_sigma_lip_balm',
      title: 'Sigma Lip Balm',
      vendor: 'Sigma',
      category_path: ['Beauty', 'Lip'],
      source: 'external_seed',
      price: 21,
    });

    const internal = [
      makeProduct({
        merchant_id: 'merch_store',
        product_id: 'I1',
        title: 'Generic Lip Balm',
        vendor: 'Generic',
        category_path: ['Beauty', 'Lip'],
        price: 19,
      }),
    ];
    const external = [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'E1',
        title: 'Sigma Lip Balm A',
        vendor: 'Sigma',
        category_path: ['Beauty', 'Lip'],
        price: 22,
        source: 'external_seed',
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'E2',
        title: 'Sigma Lip Balm B',
        vendor: 'Sigma',
        category_path: ['Beauty', 'Lip'],
        price: 20,
        source: 'external_seed',
      }),
    ];

    const result = await recommend({
      pdp_product: base,
      k: 2,
      options: {
        debug: true,
        internal_candidates: internal,
        external_candidates: external,
      },
    });

    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => _internals.isExternalProduct(item))).toBe(true);
    expect(result.metadata.similar_status).toBe('ready');
    expect(result.metadata.similar_sources.external.returned).toBe(2);
  });

  test('dedupes repeated candidates and filters out out-of-stock entries', () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_DEDUPE',
      title: 'Base',
      vendor: 'Brand',
      category_path: ['Cat', 'Leaf'],
      price: 10,
    });

    const internal = [
      makeProduct({
        merchant_id: 'm1',
        product_id: 'DUP',
        title: 'Dup 1',
        vendor: 'Brand',
        category_path: ['Cat', 'Leaf'],
        price: 10,
        inventory_quantity: 10,
      }),
      makeProduct({
        merchant_id: 'm1',
        product_id: 'DUP',
        title: 'Dup 1 (copy)',
        vendor: 'Brand',
        category_path: ['Cat', 'Leaf'],
        price: 10,
        inventory_quantity: 10,
      }),
      makeProduct({
        merchant_id: 'm1',
        product_id: 'OOS',
        title: 'Out of stock',
        vendor: 'Brand',
        category_path: ['Cat', 'Leaf'],
        price: 10,
        inventory_quantity: 0,
      }),
    ];

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: internal,
      externalCandidates: [],
      k: 5,
    });
    const ids = out.items.map((item) => `${item.merchant_id}::${item.product_id}`);
    expect(ids).toContain('m1::DUP');
    expect(ids).not.toContain('m1::OOS');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('healthy ready results cache and serve subsequent hits', async () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_CACHE',
      title: 'Cache Base',
      vendor: 'Brand',
      category_path: ['Cat', 'Leaf'],
      price: 10,
    });

    const internalA = [
      makeProduct({
        merchant_id: 'm1',
        product_id: 'A1',
        title: 'A1',
        vendor: 'Brand',
        category_path: ['Cat', 'Leaf'],
        price: 10,
      }),
    ];
    const internalB = [
      makeProduct({
        merchant_id: 'm1',
        product_id: 'B1',
        title: 'B1',
        vendor: 'Brand',
        category_path: ['Cat', 'Leaf'],
        price: 10,
      }),
    ];

    const first = await recommend({
      pdp_product: base,
      k: 1,
      locale: 'en-US',
      currency: 'USD',
      options: { debug: true, internal_candidates: internalA, external_candidates: [] },
    });
    expect(first.cache).toEqual(expect.objectContaining({ hit: false }));
    expect(first.items[0].product_id).toBe('A1');

    const second = await recommend({
      pdp_product: base,
      k: 1,
      locale: 'en-US',
      currency: 'USD',
      options: { debug: true, internal_candidates: internalB, external_candidates: [] },
    });
    expect(second.cache).toEqual(expect.objectContaining({ hit: true }));
    expect(second.items[0].product_id).toBe('A1');

    const stats = getCacheStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
    expect(stats.sets).toBeGreaterThanOrEqual(1);
  });

  test('healthy empty results are cacheable and stay empty across repeated requests', async () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_EMPTY_CACHE',
      title: 'Unknown Sweater',
      vendor: 'Brand',
      category_path: ['Apparel', 'Sweaters'],
      price: 10,
    });

    const internalA = [
      makeProduct({
        merchant_id: 'm1',
        product_id: 'A1',
        title: 'Competitor Sweater',
        vendor: 'Competitor',
        category_path: ['Apparel', 'Sweaters'],
        price: 12,
      }),
    ];
    const internalB = [
      makeProduct({
        merchant_id: 'm1',
        product_id: 'B1',
        title: 'Another Competitor Sweater',
        vendor: 'Other',
        category_path: ['Apparel', 'Sweaters'],
        price: 11,
      }),
    ];

    const first = await recommend({
      pdp_product: base,
      k: 2,
      locale: 'en-US',
      currency: 'USD',
      options: { debug: true, internal_candidates: internalA, external_candidates: [] },
    });
    expect(first.metadata.similar_status).toBe('empty');
    expect(first.cache).toEqual(expect.objectContaining({ hit: false }));

    const second = await recommend({
      pdp_product: base,
      k: 2,
      locale: 'en-US',
      currency: 'USD',
      options: { debug: true, internal_candidates: internalB, external_candidates: [] },
    });
    expect(second.metadata.similar_status).toBe('empty');
    expect(second.cache).toEqual(expect.objectContaining({ hit: true }));
  });

  test('cache key still includes requested limit k', async () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_CACHE_K',
      title: 'Cache K Base',
      vendor: 'Brand',
      category_path: ['Cat', 'Leaf'],
      price: 10,
    });

    const internalA = [
      makeProduct({
        merchant_id: 'm1',
        product_id: 'A1',
        title: 'A1',
        vendor: 'Brand',
        category_path: ['Cat', 'Leaf'],
        price: 10,
      }),
    ];
    const internalB = [
      makeProduct({
        merchant_id: 'm1',
        product_id: 'B1',
        title: 'B1',
        vendor: 'Brand',
        category_path: ['Cat', 'Leaf'],
        price: 10,
      }),
      makeProduct({
        merchant_id: 'm2',
        product_id: 'B2',
        title: 'B2',
        vendor: 'Brand',
        category_path: ['Cat', 'Leaf'],
        price: 11,
      }),
    ];

    const first = await recommend({
      pdp_product: base,
      k: 1,
      locale: 'en-US',
      currency: 'USD',
      options: { debug: true, internal_candidates: internalA, external_candidates: [] },
    });
    expect(first.cache).toEqual(expect.objectContaining({ hit: false }));
    expect(first.items).toHaveLength(1);
    expect(first.items[0].product_id).toBe('A1');

    const second = await recommend({
      pdp_product: base,
      k: 2,
      locale: 'en-US',
      currency: 'USD',
      options: { debug: true, internal_candidates: internalB, external_candidates: [] },
    });
    expect(second.cache).toEqual(expect.objectContaining({ hit: false }));
    expect(second.items).toHaveLength(2);
    expect(second.items.map((item) => item.product_id)).toEqual(
      expect.arrayContaining(['B1', 'B2']),
    );
  });
});
