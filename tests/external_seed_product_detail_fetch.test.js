jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

const ORIGINAL_ENV = process.env;

function loadServerWithDb() {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
  };
  const db = require('../src/db');
  db.query.mockReset();
  const app = require('../src/server');
  return { db, debug: app._debug };
}

describe('external seed product detail hydration', () => {
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('fetchProductDetailForOffers returns enriched external seed detail for external_seed merchant', async () => {
    const { db, debug } = loadServerWithDb();

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'eps_rare_1',
          external_product_id: 'ext_rare_1',
          canonical_url:
            'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
          destination_url:
            'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
          title: 'Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen',
          image_url: 'https://cdn.example.com/rare.jpg',
          price_amount: '30.00',
          price_currency: 'USD',
          availability: 'In Stock',
          seed_data: {
            brand: 'Rare Beauty',
            pdp_description_raw: 'A flexible tinted moisturizer.',
            pdp_ingredients_raw: 'Water, Niacinamide, Ceramide NP',
            pdp_active_ingredients_raw: 'Niacinamide',
            pdp_how_to_use_raw: 'Blend with fingers or brush.',
            seed_description_origin: 'pdp_product_description',
            pdp_field_capture_status: {
              description_raw: 'present',
              details_sections: 'present',
              ingredients_raw: 'present',
              active_ingredients_raw: 'present',
              how_to_use_raw: 'present',
            },
            active_ingredients: ['Niacinamide'],
            key_ingredients: ['Ceramide NP'],
            ingredient_intel: {
              raw_ingredient_text_clean: 'Water, Niacinamide, Ceramide NP',
              inci_list: ['Water', 'Niacinamide', 'Ceramide NP'],
            },
            pdp_details_sections: [
              { heading: 'How to use', body: 'Blend with fingers or brush.' },
              { heading: 'Details', body: 'Light to medium coverage.' },
            ],
            snapshot: {
              canonical_url:
                'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
              variants: [
                {
                  variant_id: '39775686983815',
                  price: '30.00',
                  currency: 'USD',
                  stock: 'In Stock',
                },
              ],
            },
          },
        },
      ],
    });

    const product = await debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: 'ext_rare_1',
    });

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0][0] || '')).toContain('external_product_id = $1');
    expect(String(db.query.mock.calls[0][0] || '')).not.toContain("seed_data->>'external_product_id'");
    expect(product).toMatchObject({
      merchant_id: 'external_seed',
      product_id: 'ext_rare_1',
      pdp_description_raw: 'A flexible tinted moisturizer.',
      pdp_ingredients_raw: 'Water, Niacinamide, Ceramide NP',
      pdp_active_ingredients_raw: 'Niacinamide',
      pdp_how_to_use_raw: 'Blend with fingers or brush.',
      raw_ingredient_text_clean: 'Water, Niacinamide, Ceramide NP',
      seed_description_origin: 'pdp_product_description',
    });
    expect(product.inci_list).toEqual(['Water', 'Niacinamide', 'Ceramide NP']);
    expect(product.active_ingredients).toEqual(['Niacinamide']);
    expect(product.pdp_details_sections).toHaveLength(2);
  });

  test('fetchProductDetailForOffers falls back to JSON product-id matches only after exact keys miss', async () => {
    const { db, debug } = loadServerWithDb();

    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'eps_json_1',
            external_product_id: null,
            canonical_url: 'https://example.com/products/json-fallback',
            destination_url: 'https://example.com/products/json-fallback',
            title: 'JSON Fallback Product',
            image_url: 'https://cdn.example.com/json.jpg',
            price_amount: '18.00',
            price_currency: 'USD',
            availability: 'In Stock',
            seed_data: {
              brand: 'Fallback Beauty',
              snapshot: {
                product_id: 'legacy_snapshot_id',
              },
            },
          },
        ],
      });

    const product = await debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: 'legacy_snapshot_id',
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(String(db.query.mock.calls[0][0] || '')).not.toContain("seed_data->>'external_product_id'");
    expect(String(db.query.mock.calls[1][0] || '')).toContain("seed_data->>'external_product_id'");
    expect(product).toMatchObject({
      merchant_id: 'external_seed',
      product_id: 'legacy_snapshot_id',
      title: 'JSON Fallback Product',
    });
  });

  test('fetchProductDetailForOffers bypassCache refreshes external seed detail instead of reusing in-memory cache', async () => {
    const { db, debug } = loadServerWithDb();

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'eps_tf_1',
          external_product_id: 'ext_tf_1',
          canonical_url: 'https://www.tomfordbeauty.com/products/traceless-soft-matte-concealer',
          destination_url: 'https://www.tomfordbeauty.com/products/traceless-soft-matte-concealer',
          title: 'Traceless Soft Matte Concealer',
          image_url:
            'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_74c2dfd9-3f5f-4832-af13-85e0ec7891c9.png?v=1774387551',
          price_amount: '60.00',
          price_currency: 'USD',
          availability: 'In Stock',
          seed_data: {
            brand: 'Tom Ford Beauty',
            snapshot: {
              canonical_url: 'https://www.tomfordbeauty.com/products/traceless-soft-matte-concealer',
              image_url:
                'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_74c2dfd9-3f5f-4832-af13-85e0ec7891c9.png?v=1774387551',
              image_urls: [
                'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_74c2dfd9-3f5f-4832-af13-85e0ec7891c9.png?v=1774387551',
              ],
              variants: [
                {
                  variant_id: '53031544815829',
                  sku: 'TC7Y09',
                  image_url:
                    'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_74c2dfd9-3f5f-4832-af13-85e0ec7891c9.png?v=1774387551',
                  image_urls: [
                    'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_74c2dfd9-3f5f-4832-af13-85e0ec7891c9.png?v=1774387551',
                  ],
                },
              ],
            },
          },
        },
      ],
    });

    const cachedProduct = await debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: 'ext_tf_1',
    });

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'eps_tf_1',
          external_product_id: 'ext_tf_1',
          canonical_url: 'https://www.tomfordbeauty.com/products/traceless-soft-matte-concealer',
          destination_url: 'https://www.tomfordbeauty.com/products/traceless-soft-matte-concealer',
          title: 'Traceless Soft Matte Concealer',
          image_url:
            'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_1583bea5-c4b7-4f21-bfba-996dfcd7c686.png?v=1774596837',
          price_amount: '60.00',
          price_currency: 'USD',
          availability: 'In Stock',
          seed_data: {
            brand: 'Tom Ford Beauty',
            snapshot: {
              canonical_url: 'https://www.tomfordbeauty.com/products/traceless-soft-matte-concealer',
              image_url:
                'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_1583bea5-c4b7-4f21-bfba-996dfcd7c686.png?v=1774596837',
              image_urls: [
                'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_1583bea5-c4b7-4f21-bfba-996dfcd7c686.png?v=1774596837',
              ],
              variants: [
                {
                  variant_id: '53031544815829',
                  sku: 'TC7Y09',
                  image_url:
                    'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_1583bea5-c4b7-4f21-bfba-996dfcd7c686.png?v=1774596837',
                  image_urls: [
                    'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_1583bea5-c4b7-4f21-bfba-996dfcd7c686.png?v=1774596837',
                  ],
                },
              ],
            },
          },
        },
      ],
    });

    const refreshedProduct = await debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: 'ext_tf_1',
      bypassCache: true,
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(cachedProduct.image_url).toContain('74c2dfd9');
    expect(refreshedProduct.image_url).toContain('1583bea5');
  });
});
