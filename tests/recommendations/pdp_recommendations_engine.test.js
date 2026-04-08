const nock = require('nock');
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
  canonical_url,
  destination_url,
  domain,
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
    ...(canonical_url ? { canonical_url } : {}),
    ...(destination_url ? { destination_url } : {}),
    ...(domain ? { domain } : {}),
  };
}

describe('RecommendationEngine (PDP)', () => {
  let previousEnv;

  beforeEach(() => {
    previousEnv = {
      DATABASE_URL: process.env.DATABASE_URL,
      PIVOTA_BACKEND_BASE_URL: process.env.PIVOTA_BACKEND_BASE_URL,
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
    };
    _internals.resetCache();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
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

  test('b2) external same-domain fallback can rescue branded seeds even when candidate categories stay generic', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_fenty_base',
      title: 'Bright Fix Eye Brightener',
      brand: 'Fenty Beauty',
      category_path: ['Beauty', 'Concealer'],
      category: 'Concealer',
      price: 28,
      currency: 'USD',
      source: 'external_seed',
      canonical_url: 'https://fentybeauty.com/products/bright-fix-eye-brightener-crepe',
      destination_url: 'https://fentybeauty.com/products/bright-fix-eye-brightener-crepe',
      domain: 'fentybeauty.com',
    });

    const external = [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_match_1',
        title: 'Cheeks Suede Powder Blush',
        brand: 'Fenty Beauty',
        category: 'Beauty',
        product_type: 'Beauty',
        price: 26,
        source: 'external_seed',
        canonical_url: 'https://fentybeauty.com/products/cheeks-suede-powder-blush',
        destination_url: 'https://fentybeauty.com/products/cheeks-suede-powder-blush',
        domain: 'fentybeauty.com',
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_match_2',
        title: 'Gloss Bomb Universal Lip Luminizer',
        brand: 'Fenty Beauty',
        category: 'Beauty',
        product_type: 'Beauty',
        price: 22,
        source: 'external_seed',
        canonical_url: 'https://fentybeauty.com/products/gloss-bomb-universal-lip-luminizer',
        destination_url: 'https://fentybeauty.com/products/gloss-bomb-universal-lip-luminizer',
        domain: 'fentybeauty.com',
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_match_3',
        title: 'Soft Lit Naturally Luminous Longwear Foundation',
        brand: 'Fenty Beauty',
        category: 'Beauty',
        product_type: 'Beauty',
        price: 39,
        source: 'external_seed',
        canonical_url: 'https://fentybeauty.com/products/soft-lit-foundation',
        destination_url: 'https://fentybeauty.com/products/soft-lit-foundation',
        domain: 'fentybeauty.com',
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_other_domain',
        title: 'Generic Brightener',
        brand: 'Other Brand',
        category: 'Beauty',
        product_type: 'Beauty',
        price: 20,
        source: 'external_seed',
        canonical_url: 'https://other.example/products/generic-brightener',
        destination_url: 'https://other.example/products/generic-brightener',
        domain: 'other.example',
      }),
    ];

    const out = pickLayeredRecommendations({ baseProduct: base, internalCandidates: [], externalCandidates: external, k: 4 });

    expect(out.items.map((item) => item.product_id)).toEqual(
      expect.arrayContaining(['ext_fenty_match_1', 'ext_fenty_match_2', 'ext_fenty_match_3']),
    );
    expect(out.metadata.retrieval_mix.external).toBeGreaterThanOrEqual(3);
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

  test('j0) haircare external base keeps same-brand repair products in the mainline mix', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_fenty_hair_bundle',
      title: 'Deep Moisture Repair The Maintenance Crew Full-Size Bundle',
      brand: 'Fenty Beauty',
      vendor: 'Fenty Beauty',
      category: 'Hair Care',
      product_type: 'Hair Care',
      source: 'external_seed',
      price: 121,
    });

    const external = [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_shampoo',
        title: 'The Rich One Moisture Repair Shampoo',
        brand: 'Fenty Beauty',
        category: 'Shampoo',
        product_type: 'Shampoo',
        source: 'external_seed',
        price: 16,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_conditioner',
        title: 'The Rich One Moisture Repair Conditioner',
        brand: 'Fenty Beauty',
        category: 'Conditioner',
        product_type: 'Conditioner',
        source: 'external_seed',
        price: 16,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_deep',
        title: 'The Richer One Moisture Repair Deep Conditioner',
        brand: 'Fenty Beauty',
        category: 'Conditioner',
        product_type: 'Conditioner',
        source: 'external_seed',
        price: 32,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_spray',
        title: 'The Water Boi Reparative Leave-In Detangling Conditioner Spray',
        brand: 'Fenty Beauty',
        category: 'Hair Care',
        product_type: 'Hair Care',
        source: 'external_seed',
        price: 18,
      }),
    ];

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: [],
      externalCandidates: external,
      k: 6,
    });

    expect(out.items.map((item) => item.product_id)).toEqual(
      expect.arrayContaining([
        'ext_fenty_shampoo',
        'ext_fenty_conditioner',
        'ext_fenty_deep',
      ]),
    );
    expect(out.metadata?.base_semantic?.vertical).toBe('haircare');
  });

  test('j0b) skincare acne-treatment base keeps same-brand skincare products in the mainline mix', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_fenty_bha_treatment',
      title: "Blemish Defeat'r BHA Spot-Targeting Gel",
      brand: 'Fenty Beauty',
      vendor: 'Fenty Beauty',
      category: 'Treatment',
      product_type: 'Treatment',
      source: 'external_seed',
      price: 25,
    });

    const external = [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_cleanser',
        title: "Total Cleans'r Remove-It-All Cleanser",
        brand: 'Fenty Beauty',
        vendor: 'Fenty Beauty',
        category: 'Cleanser',
        product_type: 'Cleanser',
        source: 'external_seed',
        price: 29,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_moisturizer',
        title: 'Hydra Vizor Invisible Moisturizer Broad Spectrum SPF 30 Sunscreen',
        brand: 'Fenty Beauty',
        vendor: 'Fenty Beauty',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        source: 'external_seed',
        price: 38,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_mask',
        title: "Cookies N Clean Whipped Clay Detox Face Mask",
        brand: 'Fenty Beauty',
        vendor: 'Fenty Beauty',
        category: 'Treatment',
        product_type: 'Treatment',
        source: 'external_seed',
        price: 34,
      }),
    ];

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: [],
      externalCandidates: external,
      k: 6,
    });

    expect(out.items.map((item) => item.product_id)).toEqual(
      expect.arrayContaining([
        'ext_fenty_cleanser',
        'ext_fenty_moisturizer',
        'ext_fenty_mask',
      ]),
    );
    expect(out.metadata?.base_semantic?.vertical).toBe('skincare');
  });

  test('j0c) skincare acne-treatment base filters unrelated same-brand makeup, body, and hair fallbacks', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_fenty_bha_treatment',
      title: "Blemish Defeat'r BHA Spot-Targeting Gel",
      brand: 'Fenty Beauty',
      vendor: 'Fenty Beauty',
      category: 'Treatment',
      product_type: 'Treatment',
      source: 'external_seed',
      price: 25,
    });

    const external = [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_cleanser',
        title: "Total Cleans'r Remove-It-All Cleanser",
        brand: 'Fenty Beauty',
        vendor: 'Fenty Beauty',
        category: 'Cleanser',
        product_type: 'Cleanser',
        source: 'external_seed',
        price: 29,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_moisturizer',
        title: 'Hydra Vizor Invisible Moisturizer Broad Spectrum SPF 30 Sunscreen',
        brand: 'Fenty Beauty',
        vendor: 'Fenty Beauty',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        source: 'external_seed',
        price: 38,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_mask',
        title: "Cookies N Clean Whipped Clay Detox Face Mask",
        brand: 'Fenty Beauty',
        vendor: 'Fenty Beauty',
        category: 'Treatment',
        product_type: 'Treatment',
        source: 'external_seed',
        price: 34,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_body',
        title: 'Butta Drop Whipped Oil Body Cream',
        brand: 'Fenty Beauty',
        vendor: 'Fenty Beauty',
        category: 'Body Cream',
        product_type: 'Body Cream',
        source: 'external_seed',
        price: 45,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_blush',
        title: 'Fenty Cheeks Suede Powder Blush',
        brand: 'Fenty Beauty',
        vendor: 'Fenty Beauty',
        category: 'Blush',
        product_type: 'Blush',
        source: 'external_seed',
        price: 28,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fenty_hair_mist',
        title: 'Fenty Parfum Hair + Body Mist',
        brand: 'Fenty Beauty',
        vendor: 'Fenty Beauty',
        category: 'Hair Mist',
        product_type: 'Hair Mist',
        source: 'external_seed',
        price: 35,
      }),
    ];

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: [],
      externalCandidates: external,
      k: 6,
    });

    expect(out.items.map((item) => item.product_id)).toEqual(
      expect.arrayContaining([
        'ext_fenty_cleanser',
        'ext_fenty_moisturizer',
        'ext_fenty_mask',
      ]),
    );
    expect(out.items.map((item) => item.product_id)).not.toEqual(
      expect.arrayContaining([
        'ext_fenty_body',
        'ext_fenty_blush',
        'ext_fenty_hair_mist',
      ]),
    );
  });

  test('j1) same-brand tokens alone must not lift unrelated category items into similar results', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_tom_ford_cleanser',
      title: 'TOM FORD RESEARCH Cleansing Concentrate',
      brand: 'Tom Ford Beauty',
      category: 'Cleanser',
      source: 'external_seed',
      price: 100,
    });

    const external = [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_research_serum',
        title: 'TOM FORD RESEARCH Serum Concentrate',
        brand: 'Tom Ford Beauty',
        category: 'Serum',
        source: 'external_seed',
        price: 96,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_lip_color',
        title: 'Lip Color Matte',
        brand: 'Tom Ford Beauty',
        category: 'external',
        source: 'external_seed',
        price: 62,
      }),
    ];

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: [],
      externalCandidates: external,
      k: 6,
    });

    expect(out.items.map((item) => item.product_id)).toContain('ext_research_serum');
    expect(out.items.map((item) => item.product_id)).not.toContain('ext_lip_color');
  });

  test('j2) recommendations dedupe repeated semantic titles across different product ids', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_rose_prick_base',
      title: 'Tom Ford Ombre Leather Eau de Parfum',
      brand: 'Tom Ford',
      category: 'Fragrance',
      source: 'external_seed',
      price: 180,
    });

    const external = [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_rose_prick_30',
        title: 'Rose Prick Eau de Parfum',
        brand: 'Tom Ford',
        category: 'Fragrance',
        source: 'external_seed',
        price: 180,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_rose_prick_50',
        title: 'Rose Prick Eau de Parfum',
        brand: 'Tom Ford',
        category: 'Fragrance',
        source: 'external_seed',
        price: 182,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_electric_cherry_30',
        title: 'Electric Cherry Eau de Parfum',
        brand: 'Tom Ford',
        category: 'Fragrance',
        source: 'external_seed',
        price: 175,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_electric_cherry_50',
        title: 'Electric Cherry Eau de Parfum',
        brand: 'Tom Ford',
        category: 'Fragrance',
        source: 'external_seed',
        price: 178,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_lost_cherry',
        title: 'Lost Cherry Eau de Parfum',
        brand: 'Tom Ford',
        category: 'Fragrance',
        source: 'external_seed',
        price: 190,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_fucking_fabulous',
        title: 'Fucking Fabulous Eau de Parfum',
        brand: 'Tom Ford',
        category: 'Fragrance',
        source: 'external_seed',
        price: 195,
      }),
    ];

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: [],
      externalCandidates: external,
      k: 6,
    });

    const titles = out.items.map((item) => item.title);
    expect(titles.filter((title) => title === 'Rose Prick Eau de Parfum')).toHaveLength(1);
    expect(titles.filter((title) => title === 'Electric Cherry Eau de Parfum')).toHaveLength(1);
    expect(new Set(titles).size).toBe(titles.length);
  });

  test('j3) exclude_items returns the next unique recommendation page and exposes has_more', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_page_base',
      title: 'Base Fragrance Eau de Parfum',
      brand: 'Tom Ford',
      category: 'Fragrance',
      source: 'external_seed',
      price: 180,
    });

    const external = Array.from({ length: 12 }).map((_, index) =>
      makeProduct({
        merchant_id: 'external_seed',
        product_id: `ext_page_${index + 1}`,
        title: `Page Candidate ${index + 1} Eau de Parfum`,
        brand: 'Tom Ford',
        category: 'Fragrance',
        source: 'external_seed',
        price: 170 + index,
      }),
    );

    const firstPage = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: [],
      externalCandidates: external,
      k: 6,
    });
    const secondPage = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: [],
      externalCandidates: external,
      k: 6,
      excludeItems: firstPage.items,
    });

    const firstKeys = new Set(firstPage.items.map((item) => `${item.merchant_id}::${item.product_id}`));
    const firstTitles = new Set(firstPage.items.map((item) => item.title));

    expect(firstPage.items).toHaveLength(6);
    expect(firstPage.metadata?.has_more).toBe(true);
    expect(secondPage.items).toHaveLength(6);
    expect(secondPage.items.every((item) => !firstKeys.has(`${item.merchant_id}::${item.product_id}`))).toBe(true);
    expect(secondPage.items.every((item) => !firstTitles.has(item.title))).toBe(true);
    expect(secondPage.metadata?.has_more).toBe(false);
  });

  test('k) strong semantic external base still fetches external candidates', async () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_strong_semantic_base',
      title: 'Noir Extreme Eau de Parfum',
      category: 'Fragrance',
      vendor: 'Tom Ford',
      source: 'external_seed',
      price: 180,
    });

    const internal = Array.from({ length: 20 }).map((_, index) =>
      makeProduct({
        merchant_id: `m_${index}`,
        product_id: `int_strong_${index}`,
        title: `Internal Fragrance ${index}`,
        category: 'Fragrance',
        price: 100 + index,
      }),
    );

    const external = [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_candidate_1',
        title: 'External Noir Eau de Parfum',
        category: 'Fragrance',
        source: 'external_seed',
        price: 175,
      }),
    ];

    const result = await recommend({
      pdp_product: base,
      k: 6,
      options: {
        debug: true,
        internal_candidates: internal,
        external_candidates: external,
      },
    });

    expect(result?.debug?.fetch_strategy?.base_product_is_external).toBe(true);
    expect(result?.debug?.fetch_strategy?.external_skipped).toBe(false);
  });

  test('k2) external base can surface same-brand external fallbacks even when confidence is weak', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_followup_base',
      title: 'Blemish Gel',
      brand: 'Fenty Beauty',
      category: 'Treatment',
      source: 'external_seed',
      price: 25,
    });

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: [],
      externalCandidates: [
        makeProduct({
          merchant_id: 'external_seed',
          product_id: 'ext_followup_1',
          title: 'Fenty Beauty Clarifying Gel',
          brand: 'Fenty Beauty',
          category: 'Treatment',
          source: 'external_seed',
          price: 41,
          inventory_quantity: 2,
        }),
        makeProduct({
          merchant_id: 'external_seed',
          product_id: 'ext_followup_2',
          title: 'Fenty Beauty Fast-Acting Spot Care',
          brand: 'Fenty Beauty',
          category: 'Treatment',
          source: 'external_seed',
          price: 44,
          inventory_quantity: 2,
        }),
      ],
      k: 4,
    });

    expect(out.items.length).toBeGreaterThanOrEqual(2);
    expect(out.items.every((item) => _internals.isExternalProduct(item))).toBe(true);
  });

  test('l) internal fallback uses products/search when DB is unavailable', async () => {
    delete process.env.DATABASE_URL;
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.PIVOTA_API_KEY = 'test-key';

    const capturedParams = [];
    nock('http://catalog.test')
      .persist()
      .matchHeader('x-api-key', 'test-key')
      .get('/agent/v1/products/search')
      .query((params) => {
        capturedParams.push(params);
        return true;
      })
      .reply(200, {
        products: [
          makeProduct({
            merchant_id: 'merch_store',
            product_id: 'same_store_1',
            title: 'GlowLab Repair Serum',
            brand: 'GlowLab',
            category: 'Beauty',
            product_type: 'Serum',
          }),
          makeProduct({
            merchant_id: 'merch_other',
            product_id: 'other_1',
            title: 'GlowLab Barrier Cream',
            brand: 'GlowLab',
            category: 'Beauty',
            product_type: 'Cream',
          }),
          makeProduct({
            merchant_id: 'external_seed',
            product_id: 'ext_1',
            title: 'External Seed Product',
            brand: 'GlowLab',
            category: 'Beauty',
            product_type: 'Serum',
          }),
        ],
      });

    const candidates = await _internals.fetchInternalCandidates({
      merchantId: 'merch_store',
      excludeMerchantId: 'merch_store',
      limit: 8,
      baseProduct: makeProduct({
        merchant_id: 'merch_store',
        product_id: 'base_serum',
        title: 'GlowLab Repair Serum',
        brand: 'GlowLab',
        category: 'Beauty',
        product_type: 'Serum',
      }),
    });

    expect(candidates.map((item) => item.product_id)).toContain('same_store_1');
    expect(candidates.map((item) => item.product_id)).toContain('other_1');
    expect(candidates.map((item) => item.product_id)).not.toContain('ext_1');
    expect(
      capturedParams.some((params) => String(params.merchant_id || '').trim() === 'merch_store'),
    ).toBe(true);
    expect(
      capturedParams.some((params) => !Object.prototype.hasOwnProperty.call(params, 'merchant_id')),
    ).toBe(true);
  });

  test('m) timeout-underfilled recommendation results are not cacheable', () => {
    expect(
      _internals.shouldCacheRecommendationResult({
        bypassCache: false,
        internalTimedOut: true,
        externalTimedOut: false,
        requestedCount: 6,
        returnedCount: 0,
      }),
    ).toBe(false);

    expect(
      _internals.shouldCacheRecommendationResult({
        bypassCache: false,
        internalTimedOut: true,
        externalTimedOut: false,
        requestedCount: 6,
        returnedCount: 6,
      }),
    ).toBe(true);

    expect(
      _internals.shouldCacheRecommendationResult({
        bypassCache: true,
        internalTimedOut: false,
        externalTimedOut: false,
        requestedCount: 6,
        returnedCount: 6,
      }),
    ).toBe(false);
  });

  test('n) strong semantic internal bases must not skip external when qualified internal recs underfill', () => {
    expect(
      _internals.shouldSkipExternalFetch({
        hasProvidedExternal: false,
        baseProductIsExternal: false,
        baseSemanticStrong: true,
        internalCount: 100,
        internalQualifiedCount: 0,
        skipExternalMin: 15,
        requestedCount: 6,
      }),
    ).toBe(false);

    expect(
      _internals.shouldSkipExternalFetch({
        hasProvidedExternal: false,
        baseProductIsExternal: false,
        baseSemanticStrong: true,
        internalCount: 100,
        internalQualifiedCount: 6,
        skipExternalMin: 15,
        requestedCount: 6,
      }),
    ).toBe(true);
  });

  test('o) diversified similar keeps same-brand adjacent items and other-brand same-category items in the mainline mix', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_tom_ford_cleanser',
      title: 'TOM FORD RESEARCH Cleansing Concentrate',
      brand: 'Tom Ford Beauty',
      category: 'Cleanser',
      source: 'external_seed',
      price: 100,
    });

    const external = [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_same_brand_cleanser',
        title: 'TOM FORD RESEARCH Purifying Cleanser',
        brand: 'Tom Ford Beauty',
        category: 'Cleanser',
        source: 'external_seed',
        price: 98,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_same_brand_serum',
        title: 'TOM FORD RESEARCH Serum Concentrate',
        brand: 'Tom Ford Beauty',
        category: 'Serum',
        source: 'external_seed',
        price: 96,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_same_brand_emulsion',
        title: 'TOM FORD RESEARCH Intensive Treatment Emulsion',
        brand: 'Tom Ford Beauty',
        category: 'Moisturizer',
        source: 'external_seed',
        price: 102,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_other_brand_cleanser',
        title: 'Other Brand Gentle Face Wash',
        brand: 'Other Brand',
        category: 'Cleanser',
        source: 'external_seed',
        price: 38,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_other_brand_cleansing_gel',
        title: 'Another Brand Cleansing Gel',
        brand: 'Another Brand',
        category: 'Cleanser',
        source: 'external_seed',
        price: 42,
      }),
    ];

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: [],
      externalCandidates: external,
      k: 5,
    });

    const productIds = out.items.map((item) => item.product_id);
    expect(productIds).toEqual(expect.arrayContaining(['ext_same_brand_cleanser', 'ext_same_brand_serum']));
    expect(
      productIds.some((productId) =>
        ['ext_other_brand_cleanser', 'ext_other_brand_cleansing_gel'].includes(productId),
      ),
    ).toBe(true);
    expect(out.metadata?.selection_mix).toEqual(
      expect.objectContaining({
        same_brand_same_category: expect.any(Number),
        same_brand_other_category: expect.any(Number),
        other_brand_same_category: expect.any(Number),
      }),
    );
  });

  test('o) placeholder external product_type must not count as same-category', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_base_concealer',
      title: 'Traceless Soft Matte Concealer',
      brand: 'Tom Ford Beauty',
      category: 'Concealer',
      source: 'external_seed',
      price: 64,
    });

    const external = [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_same_category_concealer',
        title: 'Shade and Illuminate Concealer',
        brand: 'Tom Ford Beauty',
        category: 'Concealer',
        source: 'external_seed',
        price: 62,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_placeholder_lip',
        title: 'Soft Matte Lip Color',
        brand: 'Tom Ford Beauty',
        product_type: 'external',
        source: 'external_seed',
        price: 62,
      }),
    ];

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: [],
      externalCandidates: external,
      k: 2,
    });

    expect(out.items.map((item) => item.product_id)).toEqual([
      'ext_same_category_concealer',
      'ext_placeholder_lip',
    ]);
    expect(out.metadata?.selection_mix).toEqual(
      expect.objectContaining({
        same_brand_same_category: 1,
        same_brand_other_category: 0,
        other_brand_same_category: 0,
        semantic_peer: 1,
      }),
    );
  });

  test('p) external lip seeds with placeholder categories use lip vertical fallback', () => {
    const base = makeProduct({
      merchant_id: 'external_seed',
      product_id: 'ext_base_poutsicle',
      title: 'Poutsicle Hydrating Lip Stain — Strawberry Sangria',
      brand: 'Fenty Beauty',
      category: 'external',
      description: 'A glossy lip stain and lip tint with all-day hydration.',
      source: 'external_seed',
      price: 28,
    });

    const external = [
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_lip_stain_mai_type',
        title: 'Poutsicle Hydrating Lip Stain — Mai Type',
        brand: 'Fenty Beauty',
        category: 'external',
        source: 'external_seed',
        price: 28,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_lip_gloss_fenty_glow',
        title: 'Gloss Bomb Universal Lip Luminizer — Fenty Glow',
        brand: 'Fenty Beauty',
        category: 'external',
        source: 'external_seed',
        price: 22,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_lip_oil_coconut',
        title: 'Fenty Treatz Hydrating Strengthening Lip Oil — Coconut',
        brand: 'Fenty Beauty',
        category: 'external',
        source: 'external_seed',
        price: 24,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_lip_luminizer_set',
        title: 'Glossy Posse 3-Piece Lip Luminizer Set',
        brand: 'Fenty Beauty',
        category: 'external',
        source: 'external_seed',
        price: 42,
      }),
      makeProduct({
        merchant_id: 'external_seed',
        product_id: 'ext_foundation_480',
        title: "Soft'lit Naturally Luminous Longwear Foundation — 480",
        brand: 'Fenty Beauty',
        category: 'external',
        source: 'external_seed',
        price: 40,
      }),
    ];

    const out = pickLayeredRecommendations({
      baseProduct: base,
      internalCandidates: [],
      externalCandidates: external,
      k: 4,
    });

    expect(out.items.map((item) => item.product_id)).toEqual(
      expect.arrayContaining(['ext_lip_stain_mai_type', 'ext_lip_gloss_fenty_glow', 'ext_lip_oil_coconut']),
    );
    expect(out.items.map((item) => item.product_id)).not.toContain('ext_foundation_480');
    expect(out.metadata?.base_semantic?.vertical).toBe('makeup');
    expect(out.metadata?.underfill).toBe(0);
  });
});
