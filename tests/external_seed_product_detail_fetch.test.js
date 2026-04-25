const nock = require('nock');
const request = require('supertest');

jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

const ORIGINAL_ENV = process.env;

function loadServerWithDb(envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    ...envOverrides,
  };
  const db = require('../src/db');
  db.query.mockReset();
  const app = require('../src/server');
  return { app, db, debug: app._debug };
}

describe('external seed product detail hydration', () => {
  afterEach(() => {
    nock.cleanAll();
  });

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

  test('fetchProductDetailForOffers does not reuse in-memory cache for external_seed detail reads', async () => {
    const { db, debug } = loadServerWithDb();

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'eps_tf_live_1',
          external_product_id: 'ext_tf_live_1',
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
            },
          },
        },
      ],
    });

    const firstProduct = await debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: 'ext_tf_live_1',
    });

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'eps_tf_live_1',
          external_product_id: 'ext_tf_live_1',
          canonical_url: 'https://www.tomfordbeauty.com/products/traceless-soft-matte-concealer',
          destination_url: 'https://www.tomfordbeauty.com/products/traceless-soft-matte-concealer',
          title: 'Traceless Soft Matte Concealer',
          image_url:
            'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_ca69ecf4-7cbf-47cc-b6ce-1662f55ad6ec.png?v=1775807537',
          price_amount: '60.00',
          price_currency: 'USD',
          availability: 'In Stock',
          seed_data: {
            brand: 'Tom Ford Beauty',
            snapshot: {
              canonical_url: 'https://www.tomfordbeauty.com/products/traceless-soft-matte-concealer',
              image_url:
                'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_ca69ecf4-7cbf-47cc-b6ce-1662f55ad6ec.png?v=1775807537',
              image_urls: [
                'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tfb_sku_TC7Y09_2000x2000_0_ca69ecf4-7cbf-47cc-b6ce-1662f55ad6ec.png?v=1775807537',
              ],
            },
          },
        },
      ],
    });

    const secondProduct = await debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: 'ext_tf_live_1',
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(firstProduct.image_url).toContain('74c2dfd9');
    expect(secondProduct.image_url).toContain('ca69ecf4');
  });

  test('get_pdp_v2 rescues unscoped ext_* routes from external seed DB instead of defaulting to the legacy merchant', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'eps_seed_db_1',
          external_product_id: 'ext_seed_db_1',
          canonical_url: 'https://www.tomfordbeauty.com/products/noir-ext-seed-db-1',
          destination_url: 'https://www.tomfordbeauty.com/products/noir-ext-seed-db-1',
          title: 'Tom Ford Noir Extreme Parfum',
          image_url: 'https://cdn.example.com/tom-ford-noir.jpg',
          price_amount: '240.00',
          price_currency: 'USD',
          availability: 'In Stock',
          seed_data: {
            brand: 'Tom Ford Beauty',
            description: 'Warm amber fragrance.',
            snapshot: {
              canonical_url: 'https://www.tomfordbeauty.com/products/noir-ext-seed-db-1',
              product_id: 'ext_seed_db_1',
              variants: [
                {
                  variant_id: 'tf-noir-default',
                  price: '240.00',
                  currency: 'USD',
                  stock: 'In Stock',
                },
              ],
            },
          },
        },
      ],
    });

    nock('https://backend.test')
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_seed_db_1')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'No product group' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            product_id: 'ext_seed_db_1',
          },
        },
      })
      .expect(200);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(res.body.metadata.identity_resolution).toEqual(
      expect.objectContaining({
        requested_product_id: 'ext_seed_db_1',
        requested_merchant_id: null,
        resolved_product_id: 'ext_seed_db_1',
        resolved_merchant_id: 'external_seed',
        canonicalization_applied: false,
        resolution_source: 'external_seed_product_id',
      }),
    );
    expect(res.body.metadata.route_health).toEqual(
      expect.objectContaining({
        requested_product_id: 'ext_seed_db_1',
        requested_merchant_id: null,
        resolved_product_id: 'ext_seed_db_1',
        resolved_merchant_id: 'external_seed',
      }),
    );
    expect(res.body.metadata.detail_source).toBe('external_seed_db');
    expect(
      res.body.modules?.find((module) => module?.type === 'canonical')?.data?.pdp_payload?.product,
    ).toEqual(
      expect.objectContaining({
        product_id: 'ext_seed_db_1',
        merchant_id: 'external_seed',
        title: 'Tom Ford Noir Extreme Parfum',
      }),
    );
  });

  test('get_pdp_v2 does not block external seed PDP on slow unscoped product group resolve', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
      PDP_EXTERNAL_SEED_GROUP_RESOLVE_BUDGET_MS: '50',
    });

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'eps_seed_db_slow_group',
          external_product_id: 'ext_seed_db_slow_group',
          canonical_url: 'https://www.rarebeauty.com/products/soft-pinch-liquid-blush',
          destination_url: 'https://www.rarebeauty.com/products/soft-pinch-liquid-blush',
          title: 'Soft Pinch Liquid Blush',
          image_url: 'https://cdn.example.com/rare-blush.jpg',
          price_amount: '25.00',
          price_currency: 'USD',
          availability: 'In Stock',
          seed_data: {
            brand: 'Rare Beauty',
            description: 'A weightless liquid blush.',
            snapshot: {
              canonical_url: 'https://www.rarebeauty.com/products/soft-pinch-liquid-blush',
              product_id: 'ext_seed_db_slow_group',
            },
          },
        },
      ],
    });

    nock('https://backend.test')
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_seed_db_slow_group')
      .delay(250)
      .reply(200, {
        product_group_id: 'pg_should_not_block',
        members: [
          {
            merchant_id: 'external_seed',
            product_id: 'ext_seed_db_slow_group',
            is_primary: true,
          },
        ],
      });

    const startedAt = Date.now();
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            product_id: 'ext_seed_db_slow_group',
          },
        },
      })
      .expect(200);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(220);
    expect(res.body.metadata.route_health).toEqual(
      expect.objectContaining({
        product_group_resolve_mode: 'budget_exceeded_unscoped',
        product_group_resolve_budget_exceeded: true,
        product_group_resolve_budget_ms: 50,
        resolved_product_id: 'ext_seed_db_slow_group',
        resolved_merchant_id: 'external_seed',
      }),
    );
    expect(res.body.metadata.identity_resolution).toEqual(
      expect.objectContaining({
        resolution_source: 'external_seed_product_id',
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 275));
  });
});
