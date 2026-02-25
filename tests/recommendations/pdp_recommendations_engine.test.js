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

  test('a) internal has same-brand + same-leaf + near price => topK mostly same brand', () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_1',
      title: 'Nike Running Shoes',
      vendor: 'Nike',
      category_path: ['Clothing', 'Shoes'],
      price: 100,
    });

    const internal = [
      makeProduct({ merchant_id: 'merch_store', product_id: 'I1', title: 'Nike Shoes 1', vendor: 'Nike', category_path: ['Clothing', 'Shoes'], price: 95 }),
      makeProduct({ merchant_id: 'merch_store', product_id: 'I2', title: 'Nike Shoes 2', vendor: 'Nike', category_path: ['Clothing', 'Shoes'], price: 110 }),
      makeProduct({ merchant_id: 'merch_store', product_id: 'I3', title: 'Nike Shoes 3', vendor: 'Nike', category_path: ['Clothing', 'Shoes'], price: 99 }),
      makeProduct({ merchant_id: 'merch_store', product_id: 'I4', title: 'Adidas Shoes', vendor: 'Adidas', category_path: ['Clothing', 'Shoes'], price: 100 }),
    ];
    const external = [
      makeProduct({ merchant_id: 'external_seed', product_id: 'E1', title: 'Nike External Shoe', vendor: 'Nike', category_path: ['Clothing', 'Shoes'], price: 105, source: 'external_seed' }),
    ];

    const out = pickLayeredRecommendations({ baseProduct: base, internalCandidates: internal, externalCandidates: external, k: 4 });
    const brands = out.items.map((p) => _internals.getBrandName(p));
    expect(brands.filter((b) => b === 'nike').length).toBeGreaterThanOrEqual(3);
  });

  test('b) internal lacks same-brand but external has => Top5 includes >=2 external same-brand (if available)', () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_SIGMA',
      title: 'Sigma Lip Balm',
      vendor: 'Sigma',
      category_path: ['Beauty', 'Lip'],
      price: 21,
    });

    const internal = [
      makeProduct({ merchant_id: 'merch_store', product_id: 'I1', title: 'Generic Lip Balm', vendor: 'GenericBrand', category_path: ['Beauty', 'Lip'], price: 19 }),
      makeProduct({ merchant_id: 'merch_store', product_id: 'I2', title: 'Other Lip Stick', vendor: 'Other', category_path: ['Beauty', 'Lip'], price: 25 }),
    ];

    const external = [
      makeProduct({ merchant_id: 'external_seed', product_id: 'E1', title: 'Sigma Lip Balm A', vendor: 'Sigma', category_path: ['Beauty', 'Lip'], price: 22, source: 'external_seed' }),
      makeProduct({ merchant_id: 'external_seed', product_id: 'E2', title: 'Sigma Lip Balm B', vendor: 'Sigma', category_path: ['Beauty', 'Lip'], price: 20, source: 'external_seed' }),
      makeProduct({ merchant_id: 'external_seed', product_id: 'E3', title: 'Sigma Lip Balm C', vendor: 'Sigma', category_path: ['Beauty', 'Lip'], price: 24, source: 'external_seed' }),
    ];

    const out = pickLayeredRecommendations({ baseProduct: base, internalCandidates: internal, externalCandidates: external, k: 6 });
    const top5 = out.items.slice(0, 5);
    const top5SigmaExternal = top5.filter((p) => _internals.getBrandName(p) === 'sigma' && _internals.isExternalProduct(p)).length;
    expect(top5SigmaExternal).toBeGreaterThanOrEqual(2);
  });

  test('c) no brand matches but same category + near price fills', () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_SWEATER',
      title: 'Warm Knit Sweater',
      vendor: 'Acme',
      category_path: ['Apparel', 'Sweaters'],
      price: 30,
    });

    const internal = [
      makeProduct({ merchant_id: 'merch_store', product_id: 'I1', title: 'Wool Sweater', vendor: 'Other', category_path: ['Apparel', 'Sweaters'], price: 28 }),
      makeProduct({ merchant_id: 'merch_store', product_id: 'I2', title: 'Cotton Sweater', vendor: 'Other', category_path: ['Apparel', 'Sweaters'], price: 31 }),
      makeProduct({ merchant_id: 'merch_store', product_id: 'I3', title: 'Jacket', vendor: 'Other', category_path: ['Apparel', 'Jackets'], price: 35 }),
    ];

    const out = pickLayeredRecommendations({ baseProduct: base, internalCandidates: internal, externalCandidates: [], k: 2 });
    expect(out.items.length).toBe(2);
    expect(out.items.every((p) => (_internals.getLeafCategory(p) || '').includes('sweater'))).toBe(true);
  });

  test('d) cold product still returns non-empty via fallback when candidates exist', () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_COLD',
      title: 'Unknown Item',
      vendor: '',
      category_path: [],
      price: 0,
    });

    const internal = [
      makeProduct({ merchant_id: 'm1', product_id: 'I1', title: 'Item A', vendor: 'BrandA', category: 'Misc', price: 10 }),
      makeProduct({ merchant_id: 'm2', product_id: 'I2', title: 'Item B', vendor: 'BrandB', category: 'Misc', price: 12 }),
    ];
    const out = pickLayeredRecommendations({ baseProduct: base, internalCandidates: internal, externalCandidates: [], k: 2 });
    expect(out.items.length).toBe(2);
  });

  test('e) dedupe + filter out-of-stock', () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_DEDUPE',
      title: 'Base',
      vendor: 'Brand',
      category_path: ['Cat', 'Leaf'],
      price: 10,
    });

    const internal = [
      makeProduct({ merchant_id: 'm1', product_id: 'DUP', title: 'Dup 1', vendor: 'Brand', category_path: ['Cat', 'Leaf'], price: 10, inventory_quantity: 10 }),
      makeProduct({ merchant_id: 'm1', product_id: 'DUP', title: 'Dup 1 (copy)', vendor: 'Brand', category_path: ['Cat', 'Leaf'], price: 10, inventory_quantity: 10 }),
      makeProduct({ merchant_id: 'm1', product_id: 'OOS', title: 'Out of stock', vendor: 'Brand', category_path: ['Cat', 'Leaf'], price: 10, inventory_quantity: 0 }),
    ];

    const out = pickLayeredRecommendations({ baseProduct: base, internalCandidates: internal, externalCandidates: [], k: 5 });
    const ids = out.items.map((p) => `${p.merchant_id}::${p.product_id}`);
    expect(ids).toContain('m1::DUP');
    expect(ids).not.toContain('m1::OOS');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('f) cache hit returns same result and exposes hit=true in debug', async () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_CACHE',
      title: 'Cache Base',
      vendor: 'Brand',
      category_path: ['Cat', 'Leaf'],
      price: 10,
    });

    const internalA = [
      makeProduct({ merchant_id: 'm1', product_id: 'A1', title: 'A1', vendor: 'Brand', category_path: ['Cat', 'Leaf'], price: 10 }),
    ];
    const internalB = [
      makeProduct({ merchant_id: 'm1', product_id: 'B1', title: 'B1', vendor: 'Brand', category_path: ['Cat', 'Leaf'], price: 10 }),
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

  test('g) cache key includes requested limit k', async () => {
    const base = makeProduct({
      merchant_id: 'merch_store',
      product_id: 'BASE_CACHE_K',
      title: 'Cache K Base',
      vendor: 'Brand',
      category_path: ['Cat', 'Leaf'],
      price: 10,
    });

    const internalA = [
      makeProduct({ merchant_id: 'm1', product_id: 'A1', title: 'A1', vendor: 'Brand', category_path: ['Cat', 'Leaf'], price: 10 }),
    ];
    const internalB = [
      makeProduct({ merchant_id: 'm1', product_id: 'B1', title: 'B1', vendor: 'Brand', category_path: ['Cat', 'Leaf'], price: 10 }),
      makeProduct({ merchant_id: 'm2', product_id: 'B2', title: 'B2', vendor: 'Brand', category_path: ['Cat', 'Leaf'], price: 11 }),
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
    expect(second.items.map((item) => item.product_id)).toEqual(expect.arrayContaining(['B1', 'B2']));
  });

  test('h) fragrance base blocks obvious tools drift', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_tom_ford_noir',
      title: 'Tom Ford Noir Extreme Eau de Parfum',
      category: 'Fragrance',
      price: 180,
      source: 'external_seed',
    });

    const internal = [
      makeProduct({ merchant_id: 'm1', product_id: 'F1', title: 'Noir Fragrance', category: 'Fragrance', price: 170 }),
      makeProduct({ merchant_id: 'm1', product_id: 'F2', title: 'Amber Eau de Parfum', category: 'Fragrance', price: 175 }),
      makeProduct({ merchant_id: 'm2', product_id: 'F3', title: 'Spice Cologne', category: 'Fragrance', price: 188 }),
      makeProduct({ merchant_id: 'm2', product_id: 'F4', title: 'Woody Perfume', category: 'Fragrance', price: 182 }),
      makeProduct({ merchant_id: 'm3', product_id: 'T1', title: 'Makeup Brush Set', category: 'Tools', price: 25 }),
      makeProduct({ merchant_id: 'm3', product_id: 'T2', title: 'Foundation Brush', category: 'Tools', price: 22 }),
    ];

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: internal,
      externalCandidates: [],
      k: 12,
    });

    expect(out.items).toHaveLength(4);
    expect(out.metadata?.low_confidence).toBe(true);
    expect(out.items.every((item) => !/brush/i.test(item.title))).toBe(true);
  });

  test('i) weak base semantics must not skip external retrieval', async () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_weak_semantic_base',
      title: 'Item 123',
      source: 'external_seed',
      price: 80,
    });

    const internal = Array.from({ length: 20 }).map((_, index) =>
      makeProduct({
        merchant_id: `m_${index}`,
        product_id: `int_${index}`,
        title: `Internal Candidate ${index}`,
        category: 'Misc',
        price: 50 + index,
      }),
    );

    const result = await recommend({
      pdp_product: base,
      k: 6,
      options: { debug: true, internal_candidates: internal },
    });

    expect(result?.debug?.fetch_strategy?.external_skipped).toBe(false);
  });

  test('j) external base uses balanced internal/external mix', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_balance_base',
      title: 'Date Night Perfume',
      category: 'Fragrance',
      source: 'external_seed',
      price: 120,
    });

    const internal = Array.from({ length: 6 }).map((_, index) =>
      makeProduct({
        merchant_id: `mi_${index}`,
        product_id: `internal_${index}`,
        title: `Internal Perfume ${index}`,
        category: 'Fragrance',
        price: 110 + index,
      }),
    );
    const external = Array.from({ length: 6 }).map((_, index) =>
      makeProduct({
        merchant_id: 'external_seed',
        product_id: `external_${index}`,
        title: `External Perfume ${index}`,
        category: 'Fragrance',
        price: 112 + index,
        source: 'external_seed',
      }),
    );

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: internal,
      externalCandidates: external,
      k: 6,
    });

    const internalCount = out.items.filter((item) => !_internals.isExternalProduct(item)).length;
    const externalCount = out.items.filter((item) => _internals.isExternalProduct(item)).length;
    expect(Math.abs(internalCount - externalCount)).toBeLessThanOrEqual(1);
    expect(internalCount + externalCount).toBe(out.items.length);
  });
});
