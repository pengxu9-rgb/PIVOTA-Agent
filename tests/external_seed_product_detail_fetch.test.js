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

  test('hydrates sparse attached external seed details from the canonical catalog product', async () => {
    const { db, debug } = loadServerWithDb();

    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'eps_sony_wh1000xm5_amazon',
            external_product_id: 'amazon:321de14a50113cdb',
            canonical_url: 'https://amzn.to/3QKz2zA',
            destination_url: 'https://amzn.to/3QKz2zA',
            domain: 'amzn.to',
            title: 'WH-1000XM5',
            image_url: null,
            price_amount: '249.00',
            price_currency: 'USD',
            availability: 'In Stock',
            attached_product_key: 'ext:sony-wh-1000xm5::9485151e',
            status: 'active',
            seed_data: {
              brand: 'Sony',
              variants: [{ id: 'amazon:321de14a50113cdb', price: '249.00', currency: 'USD' }],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            product_key: 'ext:sony-wh-1000xm5::9485151e',
            source_product_id: 'sony-wh-1000xm5',
            product_title: 'WH-1000XM5',
            product_description: null,
            brand: 'Sony',
            category: 'headphones_noise_cancelling',
            product_type: 'headphones_noise_cancelling',
            category_path: 'electronics/audio/headphones_noise_cancelling',
            product_image_url: 'https://www.sony.com/wh-1000xm5.jpg',
            product_payload: {
              enrichment_meta: {
                candidate_attribute_summary:
                  'Over-ear wireless noise cancelling headphones with a 30-hour battery.',
              },
            },
          },
        ],
      });

    const detail = await debug.fetchExternalSeedProductDetailFromDb({
      productId: 'amazon:321de14a50113cdb',
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(String(db.query.mock.calls[0][0] || '')).toContain('attached_product_key');
    expect(String(db.query.mock.calls[1][0] || '')).toContain('FROM catalog_products');
    expect(detail?.product).toMatchObject({
      product_id: 'amazon:321de14a50113cdb',
      description: 'Over-ear wireless noise cancelling headphones with a 30-hour battery.',
      image_url: 'https://www.sony.com/wh-1000xm5.jpg',
    });
    expect(detail?.product?.seed_data?.attached_catalog_content_source).toMatchObject({
      source: 'catalog_products',
      product_key: 'ext:sony-wh-1000xm5::9485151e',
      source_product_id: 'sony-wh-1000xm5',
      inherited_fields: expect.arrayContaining(['description', 'image_url', 'category_path']),
    });

    const { buildPdpPayload } = require('../src/pdpBuilder');
    const pdpPayload = buildPdpPayload({ product: detail.product });
    expect(pdpPayload.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'product_overview',
          data: expect.objectContaining({
            sections: expect.arrayContaining([
              expect.objectContaining({
                heading: 'Description',
                content: 'Over-ear wireless noise cancelling headphones with a 30-hour battery.',
              }),
            ]),
          }),
        }),
      ]),
    );
  });

  test('fetchProductDetailForOffers falls back to JSON product-id matches only after exact keys miss', async () => {
    const { db, debug } = loadServerWithDb();

    db.query
      .mockResolvedValueOnce({ rows: [] })
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

    expect(db.query).toHaveBeenCalledTimes(3);
    expect(String(db.query.mock.calls[0][0] || '')).not.toContain("seed_data->>'external_product_id'");
    expect(String(db.query.mock.calls[1][0] || '')).not.toContain("seed_data->>'external_product_id'");
    expect(String(db.query.mock.calls[2][0] || '')).toContain("seed_data->>'external_product_id'");
    expect(product).toMatchObject({
      merchant_id: 'external_seed',
      product_id: 'legacy_snapshot_id',
      title: 'JSON Fallback Product',
    });
  });

  test('fetchProductDetailForOffers does not use stale products cache or upstream fallback for missing external seeds', async () => {
    const { db, debug } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    db.query.mockResolvedValue({ rows: [] });

    const product = await debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: 'ext_missing_external_seed',
    });

    expect(product).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(String(db.query.mock.calls[0][0] || '')).toContain('FROM external_product_seeds');
    expect(String(db.query.mock.calls[1][0] || '')).toContain('FROM external_product_seeds');
    expect(String(db.query.mock.calls[2][0] || '')).toContain('FROM external_product_seeds');
    expect(db.query.mock.calls.some((call) => String(call[0] || '').includes('products_cache'))).toBe(false);
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

    const statusRow = {
      id: 'eps_seed_db_1',
      external_product_id: 'ext_seed_db_1',
      status: 'active',
    };
    const detailRow = {
      ...statusRow,
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
    };
    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('FROM external_product_seeds') && text.includes('destination_url')) {
        return Promise.resolve({ rows: [detailRow] });
      }
      if (text.includes('FROM external_product_seeds') && text.includes('status')) {
        return Promise.resolve({ rows: [statusRow] });
      }
      return Promise.resolve({ rows: [] });
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

    expect(db.query.mock.calls.length).toBeGreaterThanOrEqual(2);
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

  test('get_pdp_v2 resolves sig_* external_seed routes through the rich PDP path while preserving the public sig id', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const signatureRow = {
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_product_id: 'ext_seed_db_sig_1',
      product_key: 'prod::external_seed::external_seed::ext_seed_db_sig_1',
    };
    const statusRow = {
      id: 'eps_seed_db_sig_1',
      external_product_id: 'ext_seed_db_sig_1',
      status: 'active',
    };
    const detailRow = {
      ...statusRow,
      canonical_url: 'https://www.fentybeauty.com/products/gloss-bomb',
      destination_url: 'https://www.fentybeauty.com/products/gloss-bomb',
      title: 'Fenty Beauty Gloss Bomb Universal Lip Luminizer',
      image_url: 'https://cdn.example.com/fenty-gloss.jpg',
      price_amount: '22.00',
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'Fenty Beauty',
        description: 'A high-shine lip luminizer.',
        snapshot: {
          canonical_url: 'https://www.fentybeauty.com/products/gloss-bomb',
          product_id: 'ext_seed_db_sig_1',
          variants: [
            {
              variant_id: 'fenty-gloss-default',
              title: 'Full Size',
              price: '22.00',
              currency: 'USD',
              stock: 'In Stock',
            },
          ],
        },
      },
    };
    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products') && text.includes('pivota_signature_id = $1')) {
        return Promise.resolve({ rows: [signatureRow] });
      }
      if (text.includes('FROM external_product_seeds') && text.includes('destination_url')) {
        return Promise.resolve({ rows: [detailRow] });
      }
      if (text.includes('FROM external_product_seeds') && text.includes('status')) {
        return Promise.resolve({ rows: [statusRow] });
      }
      return Promise.resolve({ rows: [] });
    });

    nock('https://backend.test')
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_seed_db_sig_1')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'No product group' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: 'external_seed',
            product_id: 'sig_fentygloss1',
          },
        },
      })
      .expect(200);

    expect(db.query.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(res.body.subject).toEqual(
      expect.objectContaining({
        type: 'product',
        id: 'sig_fentygloss1',
      }),
    );
    expect(res.body.metadata.identity_resolution).toEqual(
      expect.objectContaining({
        requested_product_id: 'sig_fentygloss1',
        requested_merchant_id: 'external_seed',
        resolved_product_id: 'ext_seed_db_sig_1',
        resolved_merchant_id: 'external_seed',
        canonicalization_applied: true,
        canonicalization_reason_code: 'PIVOTA_SIGNATURE_ID',
        resolution_source: 'external_seed_product_id',
      }),
    );
    const canonicalModule = res.body.modules?.find((module) => module?.type === 'canonical');
    expect(canonicalModule?.data?.canonical_product_ref).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_seed_db_sig_1',
      }),
    );
    expect(canonicalModule?.data?.pdp_payload?.product).toEqual(
      expect.objectContaining({
        product_id: 'sig_fentygloss1',
        canonical_url: 'https://agent.pivota.cc/products/sig_fentygloss1',
        source_url: 'https://www.fentybeauty.com/products/gloss-bomb',
        title: 'Fenty Beauty Gloss Bomb Universal Lip Luminizer',
      }),
    );
  });

  test('get_pdp_v2 reuses canonical catalog signature resolution for sig_* external_seed PDPs', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const productKey = 'prod::external_seed::external_seed::ext_seed_db_sig_group_1';
    const signatureGroupRow = {
      content_key: 'content::fenty::gloss-bomb-heat',
      product_key: productKey,
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_product_id: 'ext_seed_db_sig_group_1',
      product_title: 'Fenty Beauty Gloss Bomb Heat Universal Lip Luminizer',
      brand: 'Fenty Beauty',
      canonical_url: 'https://www.fentybeauty.com/products/gloss-bomb-heat',
      product_image_url: 'https://cdn.example.com/fenty-heat.jpg',
      pdp_lifecycle_stage: 'published',
      pivota_signature_id: 'sig_fentyheat1',
      pivota_signature_minted_at: '2026-05-01T00:00:00.000Z',
      merchant_name: 'Fenty Beauty',
      internal_product_group_id: 'pg_fenty_heat',
      is_primary: true,
      offer_count: 1,
    };
    const statusRow = {
      id: 'eps_seed_db_sig_group_1',
      external_product_id: 'ext_seed_db_sig_group_1',
      status: 'active',
    };
    const detailRow = {
      ...statusRow,
      canonical_url: 'https://www.fentybeauty.com/products/gloss-bomb-heat',
      destination_url: 'https://www.fentybeauty.com/products/gloss-bomb-heat',
      title: 'Fenty Beauty Gloss Bomb Heat Universal Lip Luminizer',
      image_url: 'https://cdn.example.com/fenty-heat.jpg',
      price_amount: '26.00',
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'Fenty Beauty',
        description: 'A high-shine lip luminizer with a warming sensation.',
        snapshot: {
          canonical_url: 'https://www.fentybeauty.com/products/gloss-bomb-heat',
          product_id: 'ext_seed_db_sig_group_1',
          variants: [
            {
              variant_id: 'fenty-heat-full-size',
              title: 'Full Size',
              price: '26.00',
              currency: 'USD',
              stock: 'In Stock',
            },
          ],
        },
      },
    };

    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('WITH offer_stats AS')) {
        return Promise.resolve({ rows: [signatureGroupRow] });
      }
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN pdp_identity_listing')) {
        return Promise.resolve({
          rows: [
            {
              merchant_id: 'external_seed',
              platform: 'external_seed',
              source_product_id: 'ext_seed_db_sig_group_1',
              product_key: productKey,
              pivota_signature_id: 'sig_fentyheat1',
              category_path: 'beauty/makeup/lip/lip_gloss',
              sellable_item_group_id: 'sig_fentyheat1',
              product_line_id: 'line_fenty_gloss_bomb_heat',
              review_family_id: 'line_fenty_gloss_bomb_heat',
              identity_confidence: 0.98,
              match_basis: ['catalog_signature'],
              identity_status: 'reviewed',
            },
          ],
        });
      }
      if (text.includes('FROM external_product_seeds') && text.includes('destination_url')) {
        return Promise.resolve({ rows: [detailRow] });
      }
      if (text.includes('FROM external_product_seeds') && text.includes('status')) {
        return Promise.resolve({ rows: [statusRow] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: 'external_seed',
            product_id: 'sig_fentyheat1',
          },
        },
      })
      .expect(200);

    const canonicalGroupCalls = db.query.mock.calls.filter(([sql]) =>
      String(sql || '').includes('WITH offer_stats AS'),
    );
    expect(canonicalGroupCalls).toHaveLength(1);
    expect(res.body.metadata.identity_resolution).toEqual(
      expect.objectContaining({
        requested_product_id: 'sig_fentyheat1',
        resolved_product_id: 'ext_seed_db_sig_group_1',
        resolved_merchant_id: 'external_seed',
        canonicalization_applied: true,
        canonicalization_reason_code: 'PIVOTA_SIGNATURE_ID',
        resolution_source: 'canonical_catalog_signature',
      }),
    );
    expect(res.body.metadata.route_health.product_group_resolve_mode).toBe('not_needed');
    expect(res.body.metadata.route_health.identity_graph_live_mode).toBe(
      'skipped_sig_external_seed_catalog_identity',
    );
    expect(res.body.modules?.find((module) => module?.type === 'canonical')?.data).toEqual(
      expect.objectContaining({
        product_group_id: 'sig_fentyheat1',
        product_line_id: 'line_fenty_gloss_bomb_heat',
      }),
    );
  });

  test('preserves rich external seed PDP content when identity graph synthetic product is thinner', () => {
    const { debug } = loadServerWithDb();
    const richProduct = {
      product_id: 'ext_seed_db_sig_1',
      merchant_id: 'external_seed',
      title: 'Spicule Shot Boosting Mask',
      variants: [{ variant_id: 'default', title: '4 ct', display_label: 'Size: 4 ct' }],
      pdp_how_to_use_raw: 'Apply after cleansing and remove after the suggested wear time.',
      ingredient_intel: {
        force_fill_contract: {
          contract_version: 'pivota.pdp.force_fill.v1',
          display_note: 'Ingredient details are pending approved source capture.',
        },
      },
    };
    const syntheticProduct = {
      product_id: 'sig_thin_identity',
      merchant_id: 'external_seed',
      title: 'Spicule Shot Boosting Mask',
      selected_commerce_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_seed_db_sig_1',
      },
      product_line_id: 'line_spicule_mask',
    };

    const merged = debug.mergeIdentitySyntheticWithRichExternalSeedProduct(syntheticProduct, richProduct);

    expect(debug.hasExternalSeedRichPdpContent(richProduct)).toBe(true);
    expect(merged).toEqual(
      expect.objectContaining({
        product_id: 'ext_seed_db_sig_1',
        variants: [{ variant_id: 'default', title: '4 ct', display_label: 'Size: 4 ct' }],
        pdp_how_to_use_raw: 'Apply after cleansing and remove after the suggested wear time.',
        ingredient_intel: richProduct.ingredient_intel,
        selected_commerce_ref: syntheticProduct.selected_commerce_ref,
        product_line_id: 'line_spicule_mask',
      }),
    );
  });

  test('promotes reviewed external seed snapshot variants when synthetic product has none', () => {
    const { debug } = loadServerWithDb();
    const richProduct = {
      product_id: 'ext_lucky_pouch',
      merchant_id: 'external_seed',
      title: 'Lucky Pouch',
      seed_data: {
        snapshot: {
          variants: [
            {
              variant_id: '40739135750309',
              title: 'Maehwa Pink',
              option_name: 'Shade',
              option_value: 'Maehwa Pink',
              options: [{ name: 'Shade', value: 'Maehwa Pink', axis_kind: 'shade' }],
              image_url: 'https://cdn.shopify.com/lucky-pouch-maehwa.jpg',
              display_label: 'Shade: Maehwa Pink',
              source_quality_status: 'captured',
            },
          ],
        },
      },
    };
    const syntheticProduct = {
      product_id: 'ext_lucky_pouch',
      merchant_id: 'external_seed',
      title: 'Lucky Pouch',
      variants: [],
      selected_commerce_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_lucky_pouch',
      },
    };

    const merged = debug.mergeIdentitySyntheticWithRichExternalSeedProduct(syntheticProduct, richProduct);

    expect(merged.variants).toEqual([
      expect.objectContaining({
        variant_id: '40739135750309',
        option_name: 'Shade',
        option_value: 'Maehwa Pink',
      }),
    ]);
    expect(merged.selected_commerce_ref).toEqual(syntheticProduct.selected_commerce_ref);
  });

  test('preserves reviewed accessory shade variants through external seed DB hydration', async () => {
    const { db, debug } = loadServerWithDb();

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'eps_lucky_pouch',
          external_product_id: 'ext_lucky_pouch',
          canonical_url: 'https://beautyofjoseon.com/products/lucky-pouch',
          destination_url: 'https://beautyofjoseon.com/products/lucky-pouch',
          domain: 'beautyofjoseon.com',
          title: 'Lucky Pouch',
          image_url: 'https://cdn.shopify.com/lucky-pouch.jpg',
          price_amount: '12.00',
          price_currency: 'USD',
          availability: 'In Stock',
          status: 'active',
          seed_data: {
            brand: 'Beauty of Joseon',
            snapshot: {
              canonical_url: 'https://beautyofjoseon.com/products/lucky-pouch',
              variants: [
                {
                  variant_id: '40739135750309',
                  sku_id: '82BL003',
                  title: 'Maehwa Pink',
                  option_name: 'Shade',
                  option_value: 'Maehwa Pink',
                  options: [{ name: 'Shade', value: 'Maehwa Pink', axis_kind: 'shade' }],
                  display_label: 'Shade: Maehwa Pink',
                  axis_kind: 'shade',
                  source_quality_status: 'captured',
                  image_url: 'https://cdn.shopify.com/lucky-pouch-maehwa.jpg',
                },
                {
                  variant_id: '40739135783077',
                  sku_id: '82BL004',
                  title: 'Olive',
                  option_name: 'Shade',
                  option_value: 'Olive',
                  options: [{ name: 'Shade', value: 'Olive', axis_kind: 'shade' }],
                  display_label: 'Shade: Olive',
                  axis_kind: 'shade',
                  source_quality_status: 'captured',
                  image_url: 'https://cdn.shopify.com/lucky-pouch-olive.jpg',
                },
              ],
            },
          },
        },
      ],
    });

    const detail = await debug.fetchExternalSeedProductDetailFromDb({ productId: 'ext_lucky_pouch' });
    const sql = String(db.query.mock.calls[0][0] || '');

    expect(sql).toContain("'display_label'");
    expect(sql).toContain("'axis_kind'");
    expect(sql).toContain("'source_quality_status'");
    expect(detail?.product?.variants).toEqual([
      expect.objectContaining({
        variant_id: '40739135750309',
        title: 'Maehwa Pink',
        option_name: 'Shade',
        option_value: 'Maehwa Pink',
        axis_kind: 'shade',
        display_label: 'Shade: Maehwa Pink',
        source_quality_status: 'captured',
      }),
      expect.objectContaining({
        variant_id: '40739135783077',
        title: 'Olive',
        option_name: 'Shade',
        option_value: 'Olive',
        axis_kind: 'shade',
        display_label: 'Shade: Olive',
        source_quality_status: 'captured',
      }),
    ]);
  });

  test('normalizes mixed product-size option names into displayable size variants', async () => {
    const { db, debug } = loadServerWithDb();

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'eps_brightening_boost',
          external_product_id: 'ext_brightening_boost',
          canonical_url: 'https://www.cosrx.com/products/brightening-boost',
          destination_url: 'https://www.cosrx.com/products/brightening-boost',
          domain: 'cosrx.com',
          title: 'Brightening Boost',
          image_url: 'https://www.cosrx.com/cdn/shop/files/brightening-boost.jpg',
          price_amount: '42.50',
          price_currency: 'USD',
          availability: 'In Stock',
          status: 'active',
          seed_data: {
            brand: 'COSRX',
            snapshot: {
              canonical_url: 'https://www.cosrx.com/products/brightening-boost',
              variants: [
                {
                  variant_id: '51191889887448',
                  sku: 'WGRPK31115',
                  title: 'Brightening Boost / 150mL (5.07 fl.oz)',
                  option_name: 'Skin Booster / Size',
                  option_value: 'Brightening Boost / 150mL (5.07 fl.oz)',
                  options: [
                    {
                      name: 'Skin Booster / Size',
                      value: 'Brightening Boost / 150mL (5.07 fl.oz)',
                    },
                  ],
                  price: '42.50',
                  currency: 'USD',
                  stock: 'In Stock',
                  image_url: 'https://www.cosrx.com/cdn/shop/files/brightening-boost.jpg',
                },
              ],
            },
          },
        },
      ],
    });

    const detail = await debug.fetchExternalSeedProductDetailFromDb({ productId: 'ext_brightening_boost' });

    expect(detail?.product?.variants).toEqual([
      expect.objectContaining({
        variant_id: '51191889887448',
        title: '150 mL',
        option_name: 'Size',
        option_value: '150 mL',
        axis_kind: 'volume',
        display_label: 'Size: 150 mL',
        source_quality_status: 'captured',
      }),
    ]);
  });

  test('hydrates canonical catalog products from serialized external seed mirror payloads', () => {
    const { debug } = loadServerWithDb();

    const product = debug.buildCanonicalChainMainlineProduct({
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_product_id: 'ext_mac_russian_red_ulta',
      product_key: 'external_seed:ext_mac_russian_red_ulta',
      pivota_signature_id: 'sig_mac_russian_red_ulta',
      pivota_canonical_url: 'https://agent.pivota.cc/products/sig_mac_russian_red_ulta',
      product_payload: JSON.stringify({
        seed_data: JSON.stringify({
          title: 'MAC MACximal Silky Matte Lipstick',
          brand: 'MAC',
          pdp_description_raw: 'A silky matte lipstick in the Russian Red shade.',
          image_urls: ['https://images.ulta.com/mac-russian-red.jpg'],
          destination_url: 'https://www.ulta.com/p/macximal-silky-matte-lipstick-pimprod2044115',
          product_type: 'lipstick',
          price_amount: '25.00',
          price_currency: 'USD',
          in_stock: true,
          snapshot: JSON.stringify({
            canonical_url: 'https://www.ulta.com/p/macximal-silky-matte-lipstick-pimprod2044115',
          }),
        }),
        external_seed: JSON.stringify({
          external_product_id: 'ext_mac_russian_red_ulta',
          merchant_name: 'Ulta Beauty',
        }),
      }),
    });

    // Phase O-5b sanity: a row WITHOUT new fashion columns produces no
    // fashion_meta key on the product (additive change must not break
    // existing behavior).
    expect(product.fashion_meta).toBeUndefined();
    expect(product).toEqual(
      expect.objectContaining({
        product_id: 'sig_mac_russian_red_ulta',
        external_seed_id: 'ext_mac_russian_red_ulta',
        title: 'MAC MACximal Silky Matte Lipstick',
        brand: 'MAC',
        description: 'A silky matte lipstick in the Russian Red shade.',
        image_url: 'https://images.ulta.com/mac-russian-red.jpg',
        destination_url: 'https://www.ulta.com/p/macximal-silky-matte-lipstick-pimprod2044115',
        product_type: 'lipstick',
        price: 25,
        in_stock: true,
      }),
    );
    expect(product.seed_data).toEqual(
      expect.objectContaining({
        title: 'MAC MACximal Silky Matte Lipstick',
        snapshot: expect.objectContaining({
          canonical_url: 'https://www.ulta.com/p/macximal-silky-matte-lipstick-pimprod2044115',
        }),
      }),
    );
  });

  test('Phase O-5b: catalog_products.material/care columns flow into product.fashion_meta with provenance', () => {
    const { debug } = loadServerWithDb();
    const product = debug.buildCanonicalChainMainlineProduct({
      merchant_id: 'merch_apparel',
      platform: 'shopify',
      source_product_id: '12345',
      product_key: 'prod::merch_apparel::shopify::12345',
      pivota_signature_id: 'sig_apparel_demo',
      product_title: 'Linen Summer Dress',
      product_description: 'A breezy linen dress for warm days.',
      brand: 'Atlas',
      // Phase O-5b columns surfaced by canonicalCatalogSearch + entity resolution.
      material: '100% organic cotton',
      material_source: 'regex_extraction_v1',
      material_confidence: 0.75,
      care: 'Machine wash cold; hang dry.',
      care_source: 'regex_extraction_v1',
      care_confidence: 0.7,
      // size_guide intentionally null — UI mapping ships in a follow-up.
    });
    expect(product).not.toBeNull();
    expect(product.fashion_meta).toBeDefined();
    expect(product.fashion_meta.material).toEqual({
      value: '100% organic cotton',
      source: 'regex_extraction_v1',
      confidence: 0.75,
    });
    expect(product.fashion_meta.care).toEqual({
      value: 'Machine wash cold; hang dry.',
      source: 'regex_extraction_v1',
      confidence: 0.7,
    });
    // size_guide is intentionally not assembled yet.
    expect(product.fashion_meta.size_guide).toBeUndefined();
  });

  test('Phase O-5b: empty string columns produce no fashion_meta key', () => {
    const { debug } = loadServerWithDb();
    const product = debug.buildCanonicalChainMainlineProduct({
      merchant_id: 'm',
      platform: 'shopify',
      source_product_id: 'x',
      product_key: 'prod::m::shopify::x',
      pivota_signature_id: 'sig_x',
      product_title: 'Plain item',
      material: '   ', // whitespace-only
      care: null,
    });
    expect(product).not.toBeNull();
    expect(product.fashion_meta).toBeUndefined();
  });

  test('get_pdp_v2 fails fast for inactive external seed routes before legacy detail fallback', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const inactiveSeedRow = {
      id: 'eps_old_1',
      external_product_id: 'ext_deadbeefdeadbeefdeadbeef',
      status: 'inactive',
    };
    db.query.mockResolvedValueOnce({ rows: [inactiveSeedRow] });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            product_id: 'ext_deadbeefdeadbeefdeadbeef',
          },
        },
      })
      .expect(404);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({
      error: 'PRODUCT_NOT_FOUND',
      reason_code: 'PRODUCT_NOT_FOUND',
      details: {
        reason: 'external_seed_not_active',
        external_seed_status: 'inactive',
        external_seed_id: 'eps_old_1',
      },
      metadata: {
        identity_resolution: {
          requested_product_id: 'ext_deadbeefdeadbeefdeadbeef',
          resolved_product_id: null,
          resolution_source: 'external_seed_status_precheck',
        },
      },
    });
    expect(nock.isDone()).toBe(true);
  });
});
