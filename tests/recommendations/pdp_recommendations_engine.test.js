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
});

