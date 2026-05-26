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

function eligibleServingRow(overrides = {}) {
  return {
    content_key: overrides.content_key || 'ck_test_serving',
    product_key: overrides.product_key || 'prod::external_seed::external_seed::ext_test_serving',
    pivota_signature_id: overrides.pivota_signature_id || null,
    sync_status: 'live',
    pdp_lifecycle_stage: 'live',
    serving_eligible: true,
    pipeline_stage: 'serving',
    blocker_code: null,
    blocker_detail: null,
    content_quality_score: 95.2,
    active_external_seed_source_match: true,
    ...overrides,
  };
}

describe('external seed product detail hydration', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('catalog PDP content hydration ref collection includes identity/content refs and skips public sig ids', () => {
    const { debug } = loadServerWithDb();
    const refs = debug.collectCatalogPdpContentSourceProductIds(
      {
        product_id: 'sig_abc123',
        product_key: 'prod::external_seed::external_seed::ext_product_key_ref',
        source_product_id: 'ext_payload_product',
        canonical_content_ref: { product_id: 'ext_content_base' },
        selected_commerce_ref: { product_id: 'ext_commerce_row' },
        canonical_payload_product_ref: { product_id: 'ext_payload_ref' },
        pdp_open: {
          get_pdp_v2_payload: {
            product_ref: { product_id: 'ext_pdp_open_ref' },
          },
        },
      },
      { product_id: 'ext_entry_ref' },
      [
        { product_id: 'ext_identity_canonical' },
        {
          source_product_id: 'ext_catalog_identity',
          source_listing_ref: 'prod::external_seed::external_seed::ext_listing_ref',
          external_product_id: 'ext_external_product_ref',
        },
        { source_listing_ref: 'external_seed:ext_colon_listing_ref' },
        { external_seed_external_product_id: 'ext_route_status_ref' },
        'sig_def456',
        'ext_string_ref',
        'prod::external_seed::external_seed::ext_string_product_key_ref',
        'external_seed:ext_string_colon_ref',
      ],
    );

    expect(refs).toEqual(
      expect.arrayContaining([
        'ext_entry_ref',
        'ext_content_base',
        'ext_commerce_row',
        'ext_payload_ref',
        'ext_pdp_open_ref',
        'ext_identity_canonical',
        'ext_catalog_identity',
        'ext_payload_product',
        'ext_product_key_ref',
        'ext_listing_ref',
        'ext_external_product_ref',
        'ext_colon_listing_ref',
        'ext_route_status_ref',
        'ext_string_ref',
        'ext_string_product_key_ref',
        'ext_string_colon_ref',
      ]),
    );
    expect(refs).not.toEqual(expect.arrayContaining(['sig_abc123', 'sig_def456']));
  });

  test('module health keeps optional coverage gaps out of global degrade', () => {
    const { debug } = loadServerWithDb();

    const optionalHealth = debug.classifyPdpV2ModuleHealth(
      [
        { type: 'active_ingredients', reason: 'unavailable' },
        { type: 'ingredients_inci', reason: 'unavailable' },
        { type: 'how_to_use', reason: 'unavailable' },
        { type: 'supplemental_details', reason: 'unavailable' },
        { type: 'product_intel', reason: 'identity_or_published_intel_missing' },
      ],
      [
        { type: 'active_ingredients', required: false },
        { type: 'ingredients_inci', required: false },
        { type: 'how_to_use', required: false },
        { type: 'supplemental_details', required: false },
        { type: 'product_intel', required: false },
      ],
    );

    expect(optionalHealth.applied).toBe(false);
    expect(optionalHealth.severity).toBe('warning');
    expect(optionalHealth.degraded).toHaveLength(0);
    expect(optionalHealth.warnings.map((item) => item.type)).toEqual([
      'active_ingredients',
      'ingredients_inci',
      'how_to_use',
      'supplemental_details',
      'product_intel',
    ]);

    const requiredHealth = debug.classifyPdpV2ModuleHealth(
      [{ type: 'product_intel', reason: 'published_intel_missing' }],
      [{ type: 'product_intel', required: true }],
    );
    expect(requiredHealth.applied).toBe(true);
    expect(requiredHealth.severity).toBe('degraded');

    const informationalHealth = debug.classifyPdpV2ModuleHealth(
      [{ type: 'similar', reason: 'deferred' }],
      [{ type: 'similar', required: false }],
    );
    expect(informationalHealth.applied).toBe(false);
    expect(informationalHealth.severity).toBe('info');
  });

  test('get_pdp_v2 response keeps optional product_intel gap out of global degrade', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });
    const statusRow = {
      id: 'eps_optional_intel_gap',
      external_product_id: 'ext_optional_intel_gap',
      status: 'active',
    };
    const detailRow = {
      ...statusRow,
      canonical_url: 'https://example.com/products/optional-intel-gap',
      destination_url: 'https://example.com/products/optional-intel-gap',
      title: 'Optional Intel Gap Serum',
      image_url: 'https://cdn.example.com/optional-intel-gap.jpg',
      price_amount: '24.00',
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'Pivota Test',
        pdp_description_raw: 'A lightweight serum used for module-health testing.',
        snapshot: {
          variants: [
            {
              variant_id: 'ext_optional_intel_gap',
              price: '24.00',
              currency: 'USD',
            },
          ],
        },
      },
    };
    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({
          rows: [
            eligibleServingRow({
              content_key: 'ck_optional_intel_gap',
              product_key: 'prod::external_seed::external_seed::ext_optional_intel_gap',
            }),
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

    nock('https://backend.test')
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_optional_intel_gap')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'No product group' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: 'external_seed',
            product_id: 'ext_optional_intel_gap',
          },
          include: ['product_intel'],
          options: { no_cache: true },
        },
      })
      .expect(200);

    expect(res.body.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'product_intel' }),
      ]),
    );
    expect(res.body.metadata.module_health).toEqual(
      expect.objectContaining({
        severity: 'warning',
        applied: false,
        warnings: expect.arrayContaining([
          expect.objectContaining({ type: 'product_intel' }),
        ]),
      }),
    );
    expect(res.body.metadata.module_degrade).toEqual(
      expect.objectContaining({
        severity: 'warning',
        applied: false,
      }),
    );
  });

  test('get_pdp_v2 response marks core offers failure as degraded', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
      PDP_SELF_OFFER_FALLBACK_ENABLED: 'false',
    });
    const statusRow = {
      id: 'eps_core_offers_gap',
      external_product_id: 'ext_core_offers_gap',
      status: 'active',
    };
    const detailRow = {
      ...statusRow,
      canonical_url: 'https://example.com/products/core-offers-gap',
      destination_url: 'https://example.com/products/core-offers-gap',
      title: 'Core Offers Gap Serum',
      image_url: 'https://cdn.example.com/core-offers-gap.jpg',
      price_amount: null,
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'Pivota Test',
        pdp_description_raw: 'A serum used for module-health testing.',
        snapshot: {
          variants: [],
        },
      },
    };
    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({
          rows: [
            eligibleServingRow({
              content_key: 'ck_core_offers_gap',
              product_key: 'prod::external_seed::external_seed::ext_core_offers_gap',
            }),
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

    nock('https://backend.test')
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_core_offers_gap')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'No product group' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: 'external_seed',
            product_id: 'ext_core_offers_gap',
          },
          include: ['offers'],
          options: { no_cache: true },
        },
      })
      .expect(200);

    expect(res.body.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'offers' }),
      ]),
    );
    expect(res.body.metadata.module_health).toEqual(
      expect.objectContaining({
        severity: 'degraded',
        applied: true,
        degraded: expect.arrayContaining([
          expect.objectContaining({ type: 'offers' }),
        ]),
      }),
    );
    expect(res.body.metadata.module_degrade).toEqual(
      expect.objectContaining({
        severity: 'degraded',
        applied: true,
      }),
    );
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
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({
          rows: [
            eligibleServingRow({
              content_key: 'ck_ext_seed_db_1',
              product_key: 'prod::external_seed::external_seed::ext_seed_db_1',
            }),
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
      content_key: 'ck_ext_seed_db_sig_1',
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_product_id: 'ext_seed_db_sig_1',
      product_key: 'prod::external_seed::external_seed::ext_seed_db_sig_1',
      catalog_title: 'Fenty Beauty Gloss Bomb Universal Lip Luminizer',
      catalog_brand: 'Fenty Beauty',
      catalog_image_url: 'https://cdn.example.com/fenty-gloss.jpg',
      catalog_description: 'A high-shine lip luminizer.',
      catalog_canonical_url: 'https://www.fentybeauty.com/products/gloss-bomb',
      catalog_pivota_canonical_url: 'https://agent.pivota.cc/products/sig_fentygloss1',
      catalog_product_payload: {
        seed_data: {
          brand: 'Fenty Beauty',
          description: 'A high-shine lip luminizer.',
          snapshot: {
            canonical_url: 'https://www.fentybeauty.com/products/gloss-bomb',
            product_id: 'ext_seed_db_sig_1',
            image_urls: ['https://cdn.example.com/fenty-gloss.jpg'],
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
      },
      catalog_sync_status: 'live',
      catalog_pdp_lifecycle_stage: 'published',
      signature_serving_eligible: true,
      signature_pipeline_stage: 'serving',
      signature_blocker_code: null,
      signature_blocker_detail: null,
      signature_content_quality_score: 95.2,
      external_seed_id: 'eps_seed_db_sig_1',
      external_seed_external_product_id: 'ext_seed_db_sig_1',
      external_seed_status: 'active',
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
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({
          rows: [
            eligibleServingRow({
              content_key: 'ck_ext_seed_db_sig_1',
              product_key: signatureRow.product_key,
              pivota_signature_id: 'sig_fentygloss1',
            }),
          ],
        });
      }
      if (text.includes('FROM catalog_products') && text.includes('pivota_signature_id = $1')) {
        return Promise.resolve({ rows: [signatureRow] });
      }
      if (text.includes('FROM pdp_identity_listing pil') && text.includes('source_listing_ref = $1')) {
        return Promise.resolve({
          rows: [
            {
              sellable_item_group_id: 'sig_fentygloss_line',
              product_line_id: 'line_fenty_gloss_bomb',
              review_family_id: 'line_fenty_gloss_bomb',
              identity_confidence: 0.98,
              match_basis: ['catalog_signature'],
              identity_status: 'approved',
              live_read_enabled: true,
              review_required: false,
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
    expect(
      db.query.mock.calls.filter(([sql]) => String(sql || '').includes('WITH offer_stats AS')),
    ).toHaveLength(0);
    expect(
      db.query.mock.calls.filter(([sql]) =>
        String(sql || '').includes('FROM catalog_products cp') &&
        String(sql || '').includes('LEFT JOIN pdp_identity_listing'),
      ),
    ).toHaveLength(0);
    expect(
      db.query.mock.calls.filter(([sql]) =>
        String(sql || '').includes('FROM external_product_seeds\n    WHERE') &&
        String(sql || '').includes("CASE WHEN status = 'active'") &&
        !String(sql || '').includes('destination_url'),
      ),
    ).toHaveLength(0);
    expect(
      db.query.mock.calls.filter(([sql]) =>
        String(sql || '').includes('FROM external_product_seeds') &&
        String(sql || '').includes('destination_url'),
      ),
    ).toHaveLength(0);
    expect(
      db.query.mock.calls.filter(([sql]) =>
        String(sql || '').includes('FROM catalog_products cp') &&
        String(sql || '').includes('LEFT JOIN index_pipeline_state ips'),
      ),
    ).toHaveLength(0);
    expect(
      db.query.mock.calls.filter(([sql]) =>
        String(sql || '').includes('WHERE pil.sellable_item_group_id = $1'),
      ),
    ).toHaveLength(0);
    expect(res.body.subject).toEqual(
      expect.objectContaining({
        type: 'product_group',
        id: 'sig_fentygloss_line',
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
        resolution_source: 'catalog_products_signature_exact',
      }),
    );
    expect(res.body.metadata.route_health.phases.catalog_identity_hydration).toBe(0);
    expect(res.body.metadata.route_health.phases.external_seed_status_precheck).toBeLessThanOrEqual(5);
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

  test('get_pdp_v2 allows published live sig_* PDPs blocked only by a missing quality snapshot', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const signatureRow = {
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_product_id: 'ext_live_missing_quality_snapshot',
      product_key: 'prod::external_seed::external_seed::ext_live_missing_quality_snapshot',
      external_seed_id: 'eps_live_missing_quality_snapshot',
      external_seed_external_product_id: 'ext_live_missing_quality_snapshot',
      external_seed_status: 'active',
    };
    const statusRow = {
      id: 'eps_live_missing_quality_snapshot',
      external_product_id: 'ext_live_missing_quality_snapshot',
      status: 'active',
    };
    const detailRow = {
      ...statusRow,
      canonical_url: 'https://example.com/products/live-published-serum',
      destination_url: 'https://example.com/products/live-published-serum',
      title: 'Live Published Serum',
      image_url: 'https://cdn.example.com/live-published-serum.jpg',
      price_amount: '13.99',
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'Example',
        description: 'A live published serum with source-backed product detail.',
        snapshot: {
          canonical_url: 'https://example.com/products/live-published-serum',
          product_id: 'ext_live_missing_quality_snapshot',
          image_urls: ['https://cdn.example.com/live-published-serum.jpg'],
          variants: [
            {
              variant_id: 'live-published-serum-default',
              title: 'Default',
              price: '13.99',
              currency: 'USD',
              stock: 'In Stock',
            },
          ],
        },
      },
    };
    const servingEligibilityRow = eligibleServingRow({
      content_key: 'ck_live_missing_quality_snapshot',
      product_key: signatureRow.product_key,
      pivota_signature_id: 'sig_live_missing_quality_snapshot',
      pdp_lifecycle_stage: 'published',
      serving_eligible: false,
      pipeline_stage: 'extracted',
      blocker_code: 'low_quality',
      blocker_detail: 'no quality snapshot found',
      content_quality_score: 0,
      active_external_seed_source_match: true,
    });

    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({ rows: [servingEligibilityRow] });
      }
      if (text.includes('FROM catalog_products') && text.includes('pivota_signature_id = $1')) {
        return Promise.resolve({ rows: [signatureRow] });
      }
      if (text.includes('FROM pdp_identity_listing pil') && text.includes('source_listing_ref = $1')) {
        return Promise.resolve({ rows: [] });
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
      .query((query) => query && query.product_id === 'ext_live_missing_quality_snapshot')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'No product group' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: 'external_seed',
            product_id: 'sig_live_missing_quality_snapshot',
          },
          include: ['canonical', 'product_overview', 'offers'],
          options: {
            serving_eligible_only: true,
          },
        },
      })
      .expect(200);

    const canonicalModule = res.body.modules?.find((module) => module?.type === 'canonical');
    expect(canonicalModule?.data?.pdp_payload?.product).toEqual(
      expect.objectContaining({
        product_id: 'ext_live_missing_quality_snapshot',
        title: 'Live Published Serum',
      }),
    );
  });

  test('get_pdp_v2 treats reviewed external seed accessories as not-applicable for formula modules', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const statusRow = {
      id: 'eps_boj_bojagi',
      external_product_id: 'ext_boj_bojagi',
      status: 'active',
    };
    const detailRow = {
      ...statusRow,
      canonical_url: 'https://beautyofjoseon.com/products/bojagi',
      destination_url: 'https://beautyofjoseon.com/products/bojagi',
      title: 'Bojagi',
      product_family: 'accessory',
      category: 'Beauty / Accessory',
      product_type: 'Wrapping Cloth',
      image_url: 'https://cdn.example.com/bojagi.jpg',
      price_amount: '9.95',
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'Beauty of Joseon',
        product_family: 'accessory',
        description:
          'A traditional Korean wrapping cloth used as a reusable gift wrap.',
        ingredient_intel: {
          not_applicable: true,
          source_origin: 'manual_component_level_review',
          source_quality_status: 'high',
          not_applicable_reason: 'gift_wrap_cloth_not_a_formula',
        },
        snapshot: {
          product_family: 'accessory',
          canonical_url: 'https://beautyofjoseon.com/products/bojagi',
          product_id: 'ext_boj_bojagi',
          variants: [
            {
              variant_id: 'bojagi-olive',
              title: 'Olive',
              option_name: 'Color',
              option_value: 'Olive',
              price: '9.95',
              currency: 'USD',
              stock: 'In Stock',
            },
          ],
        },
      },
    };
    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({
          rows: [
            eligibleServingRow({
              content_key: 'ck_ext_boj_bojagi',
              product_key: 'prod::external_seed::external_seed::ext_boj_bojagi',
            }),
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

    nock('https://backend.test')
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_boj_bojagi')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'No product group' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: 'external_seed',
            product_id: 'ext_boj_bojagi',
          },
          include: [
            'active_ingredients',
            'ingredients_inci',
            'product_overview',
            'product_facts',
            'supplemental_details',
          ],
          options: { no_cache: true },
        },
      })
      .expect(200);

    const missingTypes = (res.body.missing || []).map((item) => item.type);
    expect(missingTypes).not.toContain('active_ingredients');
    expect(missingTypes).not.toContain('ingredients_inci');
    expect(missingTypes).not.toContain('product_facts');
    expect(missingTypes).not.toContain('supplemental_details');
    const activeIngredientsModule = res.body.modules.find((module) => module.type === 'active_ingredients');
    const ingredientsInciModule = res.body.modules.find((module) => module.type === 'ingredients_inci');
    if (activeIngredientsModule) {
      expect(activeIngredientsModule.reason).toBe('product_family_accessory');
    }
    if (ingredientsInciModule) {
      expect(ingredientsInciModule.reason).toBe('product_family_accessory');
    }
  });

  test('get_pdp_v2 treats reviewed external seed sets as component-level not-applicable', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const statusRow = {
      id: 'eps_boj_hanbang_set',
      external_product_id: 'ext_boj_hanbang_set',
      status: 'active',
    };
    const detailRow = {
      ...statusRow,
      canonical_url: 'https://beautyofjoseon.com/products/perfect-hanbang-palette',
      destination_url: 'https://beautyofjoseon.com/products/perfect-hanbang-palette',
      title: 'Perfect Hanbang Palette',
      product_family: 'set_or_collection',
      category: 'Beauty / Skincare Set',
      product_type: 'Set',
      image_url: 'https://cdn.example.com/hanbang-set.jpg',
      price_amount: '48.00',
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'Beauty of Joseon',
        product_family: 'set_or_collection',
        description:
          'A four-serum discovery set featuring Calming Barrier Serum, Glow Serum, Glow Deep Serum, and Revive Serum.',
        bundle_component_refs: [
          {
            title: 'Calming Barrier Serum',
            size_label: '30 ml',
            review_state: 'reviewed',
            inheritance_scope: ['ingredients_inci', 'how_to_use'],
          },
          {
            title: 'Glow Serum',
            size_label: '30 ml',
            review_state: 'reviewed',
            inheritance_scope: ['ingredients_inci', 'how_to_use'],
          },
        ],
        snapshot: {
          product_family: 'set_or_collection',
          canonical_url: 'https://beautyofjoseon.com/products/perfect-hanbang-palette',
          product_id: 'ext_boj_hanbang_set',
        },
      },
    };
    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({
          rows: [
            eligibleServingRow({
              content_key: 'ck_ext_boj_hanbang_set',
              product_key: 'prod::external_seed::external_seed::ext_boj_hanbang_set',
            }),
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

    nock('https://backend.test')
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_boj_hanbang_set')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'No product group' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: 'external_seed',
            product_id: 'ext_boj_hanbang_set',
          },
          include: [
            'variant_selector',
            'active_ingredients',
            'ingredients_inci',
            'how_to_use',
            'product_overview',
            'product_facts',
            'supplemental_details',
          ],
          options: { no_cache: true },
        },
      })
      .expect(200);

    const missingTypes = (res.body.missing || []).map((item) => item.type);
    expect(missingTypes).not.toContain('variant_selector');
    expect(missingTypes).not.toContain('active_ingredients');
    expect(missingTypes).not.toContain('ingredients_inci');
    expect(missingTypes).not.toContain('how_to_use');
    expect(missingTypes).not.toContain('product_facts');
    expect(missingTypes).not.toContain('supplemental_details');
  });

  test('get_pdp_v2 serving_eligible_only blocks index-ineligible sig_* PDPs before sparse detail render', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const signatureRow = {
      content_key: 'ck_blocked_fenty_concealer',
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_product_id: 'fenty-beauty:aaee8f1fd286214f',
      product_key: 'prod::external_seed::external_seed::fenty-beauty:aaee8f1fd286214f',
      pivota_signature_id: 'sig_cef6200022e629cf83f06e539bdf0644',
      external_seed_id: 'eps_blocked_fenty_concealer',
      external_seed_external_product_id: 'fenty-beauty:aaee8f1fd286214f',
      external_seed_status: 'active',
    };
    const statusRow = {
      id: 'eps_blocked_fenty_concealer',
      external_product_id: 'fenty-beauty:aaee8f1fd286214f',
      status: 'active',
    };
    const sparseDetailRow = {
      ...statusRow,
      canonical_url:
        'https://www.fentybeauty.com/pro-filtr-instant-retouch-concealer/FB30006.html?shade=260',
      destination_url:
        'https://www.fentybeauty.com/pro-filtr-instant-retouch-concealer/FB30006.html?shade=260',
      title: "Pro Filt'r Instant Retouch Concealer",
      image_url: null,
      price_amount: null,
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'Fenty Beauty',
        description: '',
        snapshot: {
          variants: [
            {
              variant_id: 'fenty-beauty:aaee8f1fd286214f',
              price: null,
              currency: 'USD',
            },
          ],
        },
      },
    };
    const servingEligibilityRow = {
      content_key: 'ck_blocked_fenty_concealer',
      product_key: signatureRow.product_key,
      pivota_signature_id: 'sig_cef6200022e629cf83f06e539bdf0644',
      sync_status: 'live',
      pdp_lifecycle_stage: 'draft',
      serving_eligible: false,
      pipeline_stage: 'discovered',
      blocker_code: 'no_seed',
      blocker_detail:
        'no external_product_seeds row and no agent_pdp_view title+description source document',
      content_quality_score: 28.6,
      active_external_seed_source_match: false,
    };

    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({ rows: [servingEligibilityRow] });
      }
      if (text.includes('FROM catalog_products') && text.includes('pivota_signature_id = $1')) {
        return Promise.resolve({ rows: [signatureRow] });
      }
      if (text.includes('FROM pdp_identity_listing pil') && text.includes('source_listing_ref = $1')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('FROM external_product_seeds') && text.includes('destination_url')) {
        return Promise.resolve({ rows: [sparseDetailRow] });
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
            product_id: 'sig_cef6200022e629cf83f06e539bdf0644',
          },
          options: {
            serving_eligible_only: true,
          },
        },
      })
      .expect(404);

    expect(res.body).toMatchObject({
      error: 'PRODUCT_NOT_SERVABLE',
      message: 'Product not found',
      reason_code: 'PRODUCT_NOT_SERVABLE',
      details: {
        reason: 'no_seed',
        serving_eligible: false,
        index_row_found: true,
        content_key: 'ck_blocked_fenty_concealer',
        blocker_code: 'no_seed',
        content_quality_score: 28.6,
      },
    });
    expect(res.body.modules).toBeUndefined();
  });

  test('get_pdp_v2 serving_eligible_only blocks stale no_seed until index state is recomputed eligible', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const signatureRow = {
      content_key: 'ck_fenty_seed_source_match',
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'ext_fenty_seed_source_match',
      product_key: 'prod::external_seed::external_seed::ext_fenty_seed_source_match',
      pivota_signature_id: 'sig_fenty_seed_source_match',
      external_seed_id: 'eps_fenty_seed_source_match',
      external_seed_external_product_id: 'ext_fenty_seed_source_match',
      external_seed_status: 'active',
    };
    const statusRow = {
      id: 'eps_fenty_seed_source_match',
      external_product_id: 'ext_fenty_seed_source_match',
      status: 'active',
    };
    const detailRow = {
      ...statusRow,
      canonical_url: 'https://fentybeauty.com/products/fenty-eau-de-parfum-travel-set',
      destination_url: 'https://fentybeauty.com/products/fenty-eau-de-parfum-travel-set',
      title: 'Fenty Eau De Parfum Travel Set + Refills',
      image_url: 'https://cdn.example.com/fenty-travel-set.jpg',
      price_amount: '42.00',
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'Fenty Beauty',
        pdp_description_raw: 'A travel-ready fragrance set with refillable spray.',
        seed_description_origin: 'pdp_product_description',
        snapshot: {
          variants: [
            {
              variant_id: 'ext_fenty_seed_source_match',
              price: '42.00',
              currency: 'USD',
            },
          ],
        },
      },
    };
    const servingEligibilityRow = {
      content_key: 'ck_fenty_seed_source_match',
      product_key: signatureRow.product_key,
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'ext_fenty_seed_source_match',
      pivota_signature_id: 'sig_fenty_seed_source_match',
      sync_status: 'live',
      pdp_lifecycle_stage: 'candidate',
      serving_eligible: false,
      pipeline_stage: 'discovered',
      blocker_code: 'no_seed',
      blocker_detail: 'no external_product_seeds row attached to this product_key',
      content_quality_score: 71.4,
      active_external_seed_source_match: true,
    };

    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({ rows: [servingEligibilityRow] });
      }
      if (text.includes('FROM catalog_products') && text.includes('pivota_signature_id = $1')) {
        return Promise.resolve({ rows: [signatureRow] });
      }
      if (text.includes('FROM pdp_identity_listing pil') && text.includes('source_listing_ref = $1')) {
        return Promise.resolve({ rows: [] });
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
            product_id: 'sig_fenty_seed_source_match',
          },
          include: ['product_overview', 'offers'],
          options: {
            serving_eligible_only: true,
          },
        },
      })
      .expect(404);

    expect(res.body).toMatchObject({
      error: 'PRODUCT_NOT_SERVABLE',
      details: {
        blocker_code: 'no_seed',
        serving_eligible: false,
        content_key: 'ck_fenty_seed_source_match',
      },
    });
    expect(res.body.modules).toBeUndefined();
  });

  test('get_pdp_v2 serving_eligible_only blocks missing_price until source evidence is repaired', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const signatureRow = {
      content_key: 'ck_fenty_missing_price_sample',
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'ext_fenty_missing_price_sample',
      product_key: 'prod::external_seed::external_seed::ext_fenty_missing_price_sample',
      pivota_signature_id: 'sig_fenty_missing_price_sample',
      external_seed_id: 'eps_fenty_missing_price_sample',
      external_seed_external_product_id: 'ext_fenty_missing_price_sample',
      external_seed_status: 'active',
    };
    const statusRow = {
      id: 'eps_fenty_missing_price_sample',
      external_product_id: 'ext_fenty_missing_price_sample',
      status: 'active',
    };
    const detailRow = {
      ...statusRow,
      canonical_url: 'https://fentybeauty.com/products/fenty-eau-de-parfum-sample-vial-on-card',
      destination_url: 'https://fentybeauty.com/products/fenty-eau-de-parfum-sample-vial-on-card',
      title: 'Fenty Eau de Parfum Sample Vial on Card',
      image_url: 'https://cdn.example.com/fenty-sample.jpg',
      price_amount: null,
      price_currency: null,
      availability: 'out_of_stock',
      seed_data: {
        brand: 'Fenty Beauty',
        pdp_description_raw: 'A sample vial card for Fenty Eau de Parfum.',
        seed_description_origin: 'pdp_product_description',
        image_urls: ['https://cdn.example.com/fenty-sample.jpg'],
        snapshot: {
          image_urls: ['https://cdn.example.com/fenty-sample.jpg'],
          variants: [
            {
              variant_id: 'ext_fenty_missing_price_sample',
              title: 'Sample vial',
              price: null,
              currency: 'USD',
            },
          ],
        },
      },
    };
    const servingEligibilityRow = {
      content_key: 'ck_fenty_missing_price_sample',
      product_key: signatureRow.product_key,
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'ext_fenty_missing_price_sample',
      pivota_signature_id: 'sig_fenty_missing_price_sample',
      catalog_image_url: 'https://cdn.example.com/fenty-sample.jpg',
      catalog_description: 'A sample vial card for Fenty Eau de Parfum.',
      catalog_image_urls_count: 1,
      sync_status: 'live',
      pdp_lifecycle_stage: 'candidate',
      serving_eligible: false,
      pipeline_stage: 'extracted',
      blocker_code: 'missing_price',
      blocker_detail: 'missing_price',
      content_quality_score: 63,
      active_external_seed_source_match: true,
    };

    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({ rows: [servingEligibilityRow] });
      }
      if (text.includes('FROM catalog_products') && text.includes('pivota_signature_id = $1')) {
        return Promise.resolve({ rows: [signatureRow] });
      }
      if (text.includes('FROM pdp_identity_listing pil') && text.includes('source_listing_ref = $1')) {
        return Promise.resolve({ rows: [] });
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
            product_id: 'sig_fenty_missing_price_sample',
          },
          include: ['canonical', 'product_overview', 'offers'],
          options: {
            serving_eligible_only: true,
          },
        },
      })
      .expect(404);

    expect(res.body).toMatchObject({
      error: 'PRODUCT_NOT_SERVABLE',
      details: {
        blocker_code: 'missing_price',
        serving_eligible: false,
        content_key: 'ck_fenty_missing_price_sample',
      },
    });
    expect(res.body.modules).toBeUndefined();
  });

  test('get_pdp_v2 serving_eligible_only blocks active mirror PDPs that have no index row', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const signatureRow = {
      content_key: 'ck_tirtir_stale_mask',
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'ext_tirtir_stale_mask',
      product_key: 'prod::external_seed::external_seed::ext_tirtir_stale_mask',
      pivota_signature_id: 'sig_tirtir_stale_mask',
      external_seed_id: 'eps_tirtir_stale_mask',
      external_seed_external_product_id: 'ext_tirtir_stale_mask',
      external_seed_status: 'active',
    };
    const statusRow = {
      id: 'eps_tirtir_stale_mask',
      external_product_id: 'ext_tirtir_stale_mask',
      status: 'active',
    };
    const detailRow = {
      ...statusRow,
      canonical_url: 'https://tirtir.global/products/ceramide-moisture-gel-mask',
      destination_url: 'https://tirtir.global/products/ceramide-moisture-gel-mask',
      title: 'Ceramide Moisture Gel Mask',
      image_url: 'https://cdn.example.com/tirtir-mask.jpg',
      price_amount: '7.00',
      price_currency: 'USD',
      availability: 'out_of_stock',
      seed_data: {
        brand: 'TIRTIR',
        pdp_description_raw: 'A cooling moisture gel mask designed to replenish and comfort skin.',
        pdp_ingredients_raw: 'Ceramide NP, Panthenol',
        pdp_how_to_use_raw: 'Apply after cleansing and remove after the package wear time.',
        seed_description_origin: 'reviewed_exact_product_source_details_patch',
        image_urls: ['https://cdn.example.com/tirtir-mask.jpg'],
        snapshot: {
          image_urls: ['https://cdn.example.com/tirtir-mask.jpg'],
          variants: [
            {
              variant_id: 'ext_tirtir_stale_mask',
              title: '1 mask',
              price: '7.00',
              currency: 'USD',
            },
          ],
        },
      },
    };
    const servingEligibilityRow = {
      content_key: 'ck_tirtir_stale_mask',
      product_key: signatureRow.product_key,
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'ext_tirtir_stale_mask',
      pivota_signature_id: 'sig_tirtir_stale_mask',
      catalog_title: 'Ceramide Moisture Gel Mask',
      catalog_image_url: 'https://cdn.example.com/tirtir-mask.jpg',
      catalog_description: 'A cooling moisture gel mask designed to replenish and comfort skin.',
      catalog_image_urls_count: 1,
      sync_status: 'stale',
      pdp_lifecycle_stage: 'candidate',
      serving_eligible: null,
      pipeline_stage: null,
      blocker_code: null,
      blocker_detail: null,
      content_quality_score: null,
      active_external_seed_source_match: true,
      external_seed_product_family: 'single_formula',
    };

    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({ rows: [servingEligibilityRow] });
      }
      if (text.includes('FROM catalog_products') && text.includes('pivota_signature_id = $1')) {
        return Promise.resolve({ rows: [signatureRow] });
      }
      if (text.includes('FROM pdp_identity_listing pil') && text.includes('source_listing_ref = $1')) {
        return Promise.resolve({ rows: [] });
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
            product_id: 'sig_tirtir_stale_mask',
          },
          include: ['canonical', 'product_overview', 'offers'],
          options: {
            serving_eligible_only: true,
          },
        },
      })
      .expect(404);

    expect(res.body).toMatchObject({
      error: 'PRODUCT_NOT_SERVABLE',
      details: {
        reason: 'serving_eligibility_missing',
        serving_eligible: false,
        index_row_found: false,
        content_key: 'ck_tirtir_stale_mask',
      },
    });
    expect(res.body.modules).toBeUndefined();
  });

  test('get_pdp_v2 serving_eligible_only still blocks active external seed rows marked non-core', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const signatureRow = {
      content_key: 'ck_tirtir_stickers',
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'ext_tirtir_stickers',
      product_key: 'prod::external_seed::external_seed::ext_tirtir_stickers',
      pivota_signature_id: 'sig_tirtir_stickers',
    };
    const statusRow = {
      id: 'eps_tirtir_stickers',
      external_product_id: 'ext_tirtir_stickers',
      status: 'active',
    };
    const sparseDetailRow = {
      ...statusRow,
      canonical_url: 'https://tirtir.global/products/tirtir-stickers',
      destination_url: 'https://tirtir.global/products/tirtir-stickers',
      title: 'TIRTIR Stickers',
      image_url: 'https://cdn.example.com/tirtir-stickers.jpg',
      price_amount: '100.00',
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'TIRTIR',
        pdp_description_raw: 'Gift with Purchase Only',
        image_urls: ['https://cdn.example.com/tirtir-stickers.jpg'],
      },
    };
    const servingEligibilityRow = {
      content_key: 'ck_tirtir_stickers',
      product_key: signatureRow.product_key,
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: 'ext_tirtir_stickers',
      pivota_signature_id: 'sig_tirtir_stickers',
      catalog_title: 'TIRTIR Stickers',
      catalog_image_url: 'https://cdn.example.com/tirtir-stickers.jpg',
      catalog_description: 'Gift with Purchase Only',
      catalog_image_urls_count: 1,
      sync_status: 'live',
      pdp_lifecycle_stage: 'candidate',
      serving_eligible: false,
      pipeline_stage: 'extracted',
      blocker_code: 'non_core_product',
      blocker_detail: 'sample/gift/protection/GWP row is not eligible for commerce index serving',
      content_quality_score: 65.4,
      active_external_seed_source_match: true,
      external_seed_product_family: 'general_merchandise',
    };

    db.query.mockImplementation((sql) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({ rows: [servingEligibilityRow] });
      }
      if (text.includes('FROM catalog_products') && text.includes('pivota_signature_id = $1')) {
        return Promise.resolve({ rows: [signatureRow] });
      }
      if (text.includes('FROM pdp_identity_listing pil') && text.includes('source_listing_ref = $1')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('FROM external_product_seeds') && text.includes('destination_url')) {
        return Promise.resolve({ rows: [sparseDetailRow] });
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
            product_id: 'sig_tirtir_stickers',
          },
          options: {
            serving_eligible_only: true,
          },
        },
      })
      .expect(404);

    expect(res.body).toMatchObject({
      error: 'PRODUCT_NOT_SERVABLE',
      details: {
        blocker_code: 'non_core_product',
        serving_eligible: false,
      },
    });
    expect(res.body.modules).toBeUndefined();
  });

  test('get_pdp_v2 reuses canonical catalog signature resolution for sig_* external_seed PDPs', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const productKey = 'prod::external_seed::external_seed::ext_seed_db_sig_group_1';
    const competingPrimaryRow = {
      content_key: 'content::fenty::gloss-bomb-heat',
      product_key: 'prod::external_seed::external_seed::fenty:canonical-gloss-bomb-heat',
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_product_id: 'fenty:canonical-gloss-bomb-heat',
      product_title: 'Fenty Beauty Gloss Bomb Heat Universal Lip Luminizer',
      brand: 'Fenty Beauty',
      canonical_url: 'https://www.fentybeauty.com/products/gloss-bomb-heat',
      product_image_url: 'https://cdn.example.com/fenty-heat.jpg',
      pdp_lifecycle_stage: 'published',
      pivota_signature_id: 'sig_otherfentyheat',
      pivota_signature_minted_at: '2026-04-01T00:00:00.000Z',
      merchant_name: 'Fenty Beauty',
      internal_product_group_id: 'pg_fenty_heat',
      is_primary: true,
      offer_count: 1,
    };
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
      is_primary: false,
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
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({
          rows: [
            eligibleServingRow({
              content_key: 'ck_fentyheat1',
              product_key: productKey,
              pivota_signature_id: 'sig_fentyheat1',
            }),
          ],
        });
      }
      if (text.includes('WITH offer_stats AS')) {
        return Promise.resolve({ rows: [competingPrimaryRow, signatureGroupRow] });
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
    expect(res.body.subject).toEqual(
      expect.objectContaining({
        type: 'product_group',
        id: 'sig_fentyheat1',
      }),
    );
  });

  test('get_pdp_v2 lifts exact sig_* catalog routes to identity group offers while preserving the public sig id', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const groupId = 'sig_theordinaryalphaarbutingroup';
    const channelSig = 'sig_theordinaryalphaarbutinulta';
    const officialExt = 'ext_theordinary_alpha_arbutin_official';
    const channelExt = 'ext_theordinary_alpha_arbutin_ulta';
    const exactCatalogRow = {
      merchant_id: 'external_seed',
      platform: 'external_seed',
      source_product_id: channelExt,
      product_key: `prod::external_seed::external_seed::${channelExt}`,
      pivota_signature_id: channelSig,
      content_key: 'content::theordinary::alpha-arbutin',
      category_path: 'beauty/skincare/serum',
      external_seed_id: `eps_${channelExt}`,
      external_seed_external_product_id: channelExt,
      external_seed_status: 'active',
    };
    const identityRows = [
      {
        source_listing_ref: `external_seed:${officialExt}`,
        merchant_id: 'external_seed',
        platform: 'external_seed',
        product_id: officialExt,
        source_kind: 'external_seed',
        source_tier: 'brand',
        sellable_item_group_id: groupId,
        product_line_id: 'pl_theordinary_alpha_arbutin',
        review_family_id: 'rf_theordinary_alpha_arbutin',
        identity_confidence: 0.99,
        match_basis: ['official_url_axes'],
        identity_status: 'approved',
        live_read_enabled: true,
        review_required: false,
        source_payload: {
          title: 'Alpha Arbutin 2% + HA',
          brand: 'The Ordinary',
          merchant_id: 'external_seed',
          product_id: officialExt,
          price: { amount: 8.85, currency: 'USD' },
          currency: 'USD',
          source_url: 'https://theordinary.com/en-us/alpha-arbutin-2-ha-serum.html',
        },
      },
      {
        source_listing_ref: `external_seed:${channelExt}`,
        merchant_id: 'external_seed',
        platform: 'external_seed',
        product_id: channelExt,
        source_kind: 'external_seed',
        source_tier: 'merchant',
        sellable_item_group_id: groupId,
        product_line_id: 'pl_theordinary_alpha_arbutin',
        review_family_id: 'rf_theordinary_alpha_arbutin',
        identity_confidence: 0.98,
        match_basis: ['reviewed_multi_offer_merge'],
        identity_status: 'approved',
        live_read_enabled: true,
        review_required: false,
        source_payload: {
          title: 'Alpha Arbutin 2% + Hyaluronic Acid for Hyperpigmentation',
          brand: 'The Ordinary',
          merchant_id: 'external_seed',
          product_id: channelExt,
          price: { amount: 11.5, currency: 'USD' },
          currency: 'USD',
          source_url: 'https://www.ulta.com/p/alpha-arbutin-2-hyaluronic-acid-hyperpigmentation-pimprod2007108?sku=2551165',
        },
      },
    ];
    const buildSeedDetail = (externalProductId, priceAmount, canonicalUrl) => ({
      id: `eps_${externalProductId}`,
      external_product_id: externalProductId,
      status: 'active',
      canonical_url: canonicalUrl,
      destination_url: canonicalUrl,
      title:
        externalProductId === officialExt
          ? 'Alpha Arbutin 2% + HA'
          : 'Alpha Arbutin 2% + Hyaluronic Acid for Hyperpigmentation',
      image_url: 'https://cdn.example.com/theordinary-alpha.jpg',
      price_amount: String(priceAmount),
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'The Ordinary',
        description: 'A serum for uneven tone.',
        snapshot: {
          canonical_url: canonicalUrl,
          product_id: externalProductId,
          variants: [
            {
              variant_id: `${externalProductId}-30ml`,
              title: '30ml',
              price: String(priceAmount),
              currency: 'USD',
              stock: 'In Stock',
            },
          ],
        },
      },
    });
    const officialDetail = buildSeedDetail(
      officialExt,
      8.85,
      'https://theordinary.com/en-us/alpha-arbutin-2-ha-serum.html',
    );
    const channelDetail = buildSeedDetail(
      channelExt,
      11.5,
      'https://www.ulta.com/p/alpha-arbutin-2-hyaluronic-acid-hyperpigmentation-pimprod2007108?sku=2551165',
    );
    const servingEligibilityRow = {
      content_key: 'content::theordinary::alpha-arbutin',
      product_key: exactCatalogRow.product_key,
      source_system: 'external_product_seeds_mirror_v1',
      source_product_id: channelExt,
      pivota_signature_id: channelSig,
      catalog_title: exactCatalogRow.title,
      catalog_image_url: 'https://cdn.example.com/theordinary-alpha.jpg',
      catalog_description: 'A serum for uneven tone.',
      sync_status: 'live',
      pdp_lifecycle_stage: 'published',
      serving_eligible: true,
      pipeline_stage: 'ready',
      blocker_code: null,
      blocker_detail: null,
      content_quality_score: 92,
      active_external_seed_source_match: true,
    };

    db.query.mockImplementation((sql, params = []) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({ rows: [servingEligibilityRow] });
      }
      if (text.includes('FROM catalog_products cp') && text.includes('WHERE cp.pivota_signature_id = $1')) {
        return Promise.resolve({ rows: [exactCatalogRow] });
      }
      if (text.includes('FROM pdp_identity_listing pil') && text.includes('WHERE pil.source_listing_ref = $1')) {
        return Promise.resolve({ rows: [identityRows[1]] });
      }
      if (text.includes('FROM pdp_identity_listing') && text.includes('sellable_item_group_id = $1')) {
        return Promise.resolve({ rows: identityRows });
      }
      if (text.includes('FROM external_product_seeds') && text.includes('destination_url')) {
        const requested = String(params[0] || params[1] || '');
        if (requested === officialExt) return Promise.resolve({ rows: [officialDetail] });
        if (requested === channelExt) return Promise.resolve({ rows: [channelDetail] });
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('FROM external_product_seeds') && text.includes('status')) {
        const requested = String(params[0] || params[1] || '');
        return Promise.resolve({
          rows: [
            {
              id: `eps_${requested || channelExt}`,
              external_product_id: requested || channelExt,
              status: 'active',
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          include: ['offers'],
          product_ref: {
            merchant_id: 'external_seed',
            product_id: channelSig,
          },
        },
      })
      .expect(200);

    const canonicalModule = res.body.modules?.find((module) => module?.type === 'canonical');
    const offersModule = res.body.modules?.find((module) => module?.type === 'offers');
    expect(canonicalModule?.data?.pdp_payload?.product).toEqual(
      expect.objectContaining({
        product_id: channelSig,
        source_product_id: channelExt,
      }),
    );
    expect(canonicalModule?.data).toEqual(
      expect.objectContaining({
        product_group_id: groupId,
        sellable_item_group_id: groupId,
        offer_source: 'group_fused',
        selected_commerce_ref: {
          merchant_id: 'external_seed',
          product_id: channelExt,
        },
      }),
    );
    expect(offersModule?.data).toEqual(
      expect.objectContaining({
        product_group_id: groupId,
        offer_source: 'group_fused',
        offers_count: 2,
      }),
    );
    expect(offersModule?.data?.offers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          merchant_id: 'external_seed',
          product_id: officialExt,
          price: { amount: 8.85, currency: 'USD' },
        }),
        expect.objectContaining({
          merchant_id: 'external_seed',
          product_id: channelExt,
          price: { amount: 11.5, currency: 'USD' },
        }),
      ]),
    );
    const defaultOffer = offersModule?.data?.offers?.find(
      (offer) => offer?.offer_id === offersModule?.data?.default_offer_id,
    );
    expect(defaultOffer).toEqual(
      expect.objectContaining({
        product_id: channelExt,
      }),
    );
    expect(
      db.query.mock.calls.filter(([sql]) =>
        String(sql || '').includes('WHERE pil.sellable_item_group_id = $1'),
      ),
    ).toHaveLength(1);
    const servingGateCall = db.query.mock.calls.find(([sql]) =>
      String(sql || '').includes('FROM catalog_products cp') &&
      String(sql || '').includes('LEFT JOIN index_pipeline_state ips'),
    );
    expect(servingGateCall?.[1]?.[0]).toBe('content::theordinary::alpha-arbutin');
    expect(servingGateCall?.[1]?.[3]).toBe(channelSig);
  });

  test.each([
    ['approved external siblings', 2, 3],
    ['empty sibling group', 0, 1],
  ])('get_pdp_v2 preserves review-required internal self-offer and hydrates %s', async (
    _label,
    siblingCount,
    expectedOfferCount,
  ) => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
      PDP_IDENTITY_GRAPH_ENABLED: 'false',
    });
    const sigId = 'sig_1c7611cfd2520d64ad08f3c36b2ef016';
    const groupId = sigId;
    const internalProductId = '10064558194985';
    const internalMerchantId = 'merch_efbc46b4619cfbdf';
    const externalProductIds = ['ext_ordinary_niacinamide_official', 'ext_ordinary_niacinamide_ulta'];
    const exactCatalogRow = {
      merchant_id: internalMerchantId,
      platform: 'shopify',
      source_product_id: internalProductId,
      product_key: 'prod::merch_efbc46b4619cfbdf::shopify::10064558194985',
      pivota_signature_id: sigId,
      content_key: 'content::ordinary::niacinamide',
      category_path: 'beauty/skincare/serum',
      source_domain: 'jwx893-fz.myshopify.com',
      source_system: 'shopify_products_sync',
      source_ref: internalProductId,
    };
    const internalIdentityRow = {
      ...exactCatalogRow,
      sellable_item_group_id: groupId,
      product_line_id: 'pl_ordinary_niacinamide',
      review_family_id: 'rf_ordinary_niacinamide',
      identity_status: 'review_required',
      live_read_enabled: false,
      review_required: true,
      identity_confidence: 0.91,
      match_basis: ['needs_operator_review'],
    };
    const siblingRows = externalProductIds.map((productId, index) => ({
      source_listing_ref: `external_seed:${productId}`,
      merchant_id: 'external_seed',
      product_id: productId,
      source_kind: 'external_seed',
      source_tier: index === 0 ? 'brand' : 'merchant',
      sellable_item_group_id: groupId,
      identity_status: 'approved',
      live_read_enabled: true,
      review_required: false,
      identity_confidence: 0.99 - index / 100,
      source_payload: {
        title: index === 0 ? 'Niacinamide 10% + Zinc 1%' : 'The Ordinary Niacinamide 10% + Zinc 1%',
        brand: 'The Ordinary',
        source_url:
          index === 0
            ? 'https://theordinary.com/en-us/niacinamide-10-zinc-1-serum.html'
            : 'https://www.ulta.com/p/niacinamide-10-zinc-1-serum-pimprod2007111',
      },
      catalog_title: index === 0 ? 'Niacinamide 10% + Zinc 1%' : 'Niacinamide 10% + Zinc 1% at Ulta',
      catalog_brand: 'The Ordinary',
      catalog_canonical_url:
        index === 0
          ? 'https://theordinary.com/en-us/niacinamide-10-zinc-1-serum.html'
          : 'https://www.ulta.com/p/niacinamide-10-zinc-1-serum-pimprod2007111',
      catalog_image_url: 'https://cdn.example.com/ordinary-niacinamide.jpg',
      catalog_offer_id: `offer_${productId}`,
      catalog_sku_key: `sku_${productId}`,
      catalog_offer_currency: 'USD',
      catalog_offer_price: index === 0 ? '6.0' : '6.5',
      catalog_offer_source_system: 'catalog_offers',
      catalog_offer_source_ref: `co_${productId}`,
    })).slice(0, siblingCount);
    db.query.mockImplementation((sql) => {
      const text = String(sql || '').replace(/\s+/g, ' ');
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN index_pipeline_state ips')) {
        return Promise.resolve({ rows: [eligibleServingRow({ ...exactCatalogRow, serving_eligible: true })] });
      }
      if (text.includes('FROM catalog_products cp') && text.includes('WHERE cp.pivota_signature_id = $1')) {
        return Promise.resolve({ rows: [exactCatalogRow] });
      }
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN pdp_identity_listing pil')) {
        return Promise.resolve({ rows: [internalIdentityRow] });
      }
      if (text.includes('FROM pdp_identity_listing pil') && text.includes('offer_row.offer_id')) {
        return Promise.resolve({ rows: siblingRows });
      }
      if (text.includes('FROM catalog_merchants')) {
        return Promise.resolve({
          rows: [{ merchant_id: internalMerchantId, merchant_name: 'Chydan' }],
        });
      }
      if (text.includes('FROM products_cache')) {
        return Promise.resolve({
          rows: [{
            product_data: {
              merchant_id: internalMerchantId,
              product_id: internalProductId,
              title: 'The Ordinary Niacinamide 10% + Zinc 1%',
              brand: 'The Ordinary',
              currency: 'USD',
              price: { amount: 5.9, currency: 'USD' },
              in_stock: true,
              platform: 'shopify',
              platform_product_id: internalProductId,
            },
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          include: ['offers'],
          product_ref: { merchant_id: 'external_seed', product_id: sigId },
        },
      })
      .expect(200);

    const offersModule = res.body.modules?.find((module) => module?.type === 'offers');
    expect(offersModule?.data?.offers_count).toBe(expectedOfferCount);
    expect(offersModule?.data?.offers).toHaveLength(expectedOfferCount);
    const internalOffer = offersModule?.data?.offers?.find(
      (offer) => offer?.merchant_id === internalMerchantId && offer?.product_id === internalProductId,
    );
    expect(internalOffer).toEqual(expect.objectContaining({
      merchant_id: internalMerchantId,
      product_id: internalProductId,
      merchant_name: 'Chydan',
      price: { amount: 5.9, currency: 'USD' },
    }));
    for (const productId of externalProductIds.slice(0, siblingCount)) {
      expect(offersModule?.data?.offers).toEqual(expect.arrayContaining([
        expect.objectContaining({ merchant_id: 'external_seed', product_id: productId }),
      ]));
    }
  });

  test('get_pdp_v2 skips live identity graph for rich direct external_seed same-merchant groups', async () => {
    const { app, db } = loadServerWithDb({
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });

    const productKey = 'prod::external_seed::external_seed::ext_tf_concealer_1';
    const groupRows = [
      {
        content_key: 'content::tom-ford::traceless-soft-matte-concealer',
        product_key: productKey,
        merchant_id: 'external_seed',
        platform: 'external_seed',
        source_product_id: 'ext_tf_concealer_1',
        product_title: 'Traceless Soft Matte Concealer',
        brand: 'Tom Ford',
        canonical_url: 'https://www.tomfordbeauty.com/product/traceless-soft-matte-concealer',
        product_image_url: 'https://cdn.example.com/tf-concealer.jpg',
        pdp_lifecycle_stage: 'published',
        pivota_signature_id: 'sig_tfconcealer',
        pivota_signature_minted_at: '2026-05-01T00:00:00.000Z',
        merchant_name: 'Tom Ford Beauty',
        internal_product_group_id: 'pg_tf_concealer',
        is_primary: true,
        offer_count: 1,
      },
      {
        content_key: 'content::tom-ford::traceless-soft-matte-concealer',
        product_key: 'prod::external_seed::external_seed::ext_tf_concealer_2',
        merchant_id: 'external_seed',
        platform: 'external_seed',
        source_product_id: 'ext_tf_concealer_2',
        product_title: 'Traceless Soft Matte Concealer',
        brand: 'Tom Ford',
        canonical_url: 'https://www.tomfordbeauty.com/product/traceless-soft-matte-concealer',
        product_image_url: 'https://cdn.example.com/tf-concealer-2.jpg',
        pdp_lifecycle_stage: 'published',
        pivota_signature_id: 'sig_tfconcealer2',
        pivota_signature_minted_at: '2026-05-02T00:00:00.000Z',
        merchant_name: 'Tom Ford Beauty',
        internal_product_group_id: 'pg_tf_concealer',
        is_primary: false,
        offer_count: 1,
      },
    ];
    const statusRow = {
      id: 'eps_tf_concealer_1',
      external_product_id: 'ext_tf_concealer_1',
      status: 'active',
    };
    const detailRow = {
      ...statusRow,
      canonical_url: 'https://www.tomfordbeauty.com/product/traceless-soft-matte-concealer',
      destination_url: 'https://www.tomfordbeauty.com/product/traceless-soft-matte-concealer',
      title: 'Traceless Soft Matte Concealer',
      image_url: 'https://cdn.example.com/tf-concealer.jpg',
      price_amount: '60.00',
      price_currency: 'USD',
      availability: 'In Stock',
      seed_data: {
        brand: 'Tom Ford',
        pdp_how_to_use_raw: 'Apply to areas that need coverage and blend with fingertips or a brush.',
        pdp_details_sections: [
          { heading: 'Details', body: 'A soft matte liquid concealer with buildable coverage.' },
        ],
        snapshot: {
          canonical_url: 'https://www.tomfordbeauty.com/product/traceless-soft-matte-concealer',
          variants: [
            {
              variant_id: 'tf-concealer-1w0',
              title: '1W0 Porcelain',
              display_label: 'Shade: 1W0 Porcelain',
              price: '60.00',
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
        return Promise.resolve({ rows: groupRows });
      }
      if (text.includes('FROM catalog_products cp') && text.includes('LEFT JOIN pdp_identity_listing')) {
        return Promise.resolve({
          rows: [
            {
              merchant_id: 'external_seed',
              platform: 'external_seed',
              source_product_id: 'ext_tf_concealer_1',
              product_key: productKey,
              pivota_signature_id: 'sig_tfconcealer',
              category_path: 'beauty/makeup/face/concealer',
              sellable_item_group_id: 'sig_tfconcealer',
              product_line_id: 'line_tf_traceless_soft_matte_concealer',
              review_family_id: 'line_tf_traceless_soft_matte_concealer',
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
            product_id: 'ext_tf_concealer_1',
          },
          options: {
            allow_ineligible: true,
          },
        },
      })
      .expect(200);

    expect(res.body.metadata.route_health.product_group_resolve_mode).toBe('not_needed');
    expect(res.body.metadata.route_health.identity_graph_live_mode).toBe(
      'skipped_direct_external_seed_same_merchant_group',
    );
    expect(res.body.metadata.identity_resolution).toEqual(
      expect.objectContaining({
        requested_product_id: 'ext_tf_concealer_1',
        resolved_product_id: 'ext_tf_concealer_1',
        resolved_merchant_id: 'external_seed',
        canonicalization_applied: false,
        resolution_source: 'canonical_catalog_product_group',
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

  test('preserves richer source-backed variant specs over thinner identity synthetic labels', () => {
    const { debug } = loadServerWithDb();
    const richProduct = {
      product_id: 'ext_matcha_pads',
      merchant_id: 'external_seed',
      title: 'Matcha Tea Pads',
      variants: [
        {
          variant_id: 'tirtir_matcha_tea_pads_70pads_160ml',
          sku_id: 'tirtir_matcha_tea_pads_70pads_160ml',
          title: '70 pads / 160 mL',
          options: [{ name: 'Size', value: '70 pads / 160 mL', axis_kind: 'size' }],
          display_label: 'Size: 70 pads / 160 mL',
          source_quality_status: 'high',
        },
      ],
      pdp_how_to_use_raw: 'Swipe across clean skin after cleansing.',
    };
    const syntheticProduct = {
      product_id: 'sig_matcha_pads',
      merchant_id: 'external_seed',
      title: 'Matcha Tea Pads',
      variants: [
        {
          variant_id: 'tirtir_matcha_tea_pads_70pads_160ml',
          sku_id: 'tirtir_matcha_tea_pads_70pads_160ml',
          title: '160 mL',
          options: [{ name: 'Size', value: '160 mL', axis_kind: 'volume' }],
          display_label: 'Size: 160 mL',
          source_quality_status: 'captured',
          availability: { in_stock: true, available_quantity: 999 },
          image_url: 'https://cdn.example.com/matcha-tea-pads.png',
        },
      ],
      selected_commerce_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_matcha_pads',
      },
    };

    const merged = debug.mergeIdentitySyntheticWithRichExternalSeedProduct(syntheticProduct, richProduct);

    expect(merged.variants?.[0]).toEqual(
      expect.objectContaining({
        title: '70 pads / 160 mL',
        display_label: 'Size: 70 pads / 160 mL',
        options: [{ name: 'Size', value: '70 pads / 160 mL', axis_kind: 'size' }],
        availability: { in_stock: true, available_quantity: 999 },
        image_url: 'https://cdn.example.com/matcha-tea-pads.png',
      }),
    );
    expect(merged.selected_commerce_ref).toEqual(syntheticProduct.selected_commerce_ref);
  });

  test('hydrates identity line member payloads when an external seed alias resolves to a different canonical row', () => {
    const { debug } = loadServerWithDb();

    expect(
      debug.isRequestedExternalSeedAliasDifferentFromCanonical({
        entryProductIsExternalSeed: true,
        entryProductId: 'ulta:57b8f92ce86ee6b0',
        productId: 'ulta:57b8f92ce86ee6b0',
        canonicalProductRef: {
          merchant_id: 'external_seed',
          product_id: 'ext_bb310b68bf948987b9f658c2',
        },
      }),
    ).toBe(true);

    expect(
      debug.shouldHydratePdpIdentityLineMemberPayloads({
        entryProductIsExternalSeed: true,
        entryProductId: 'ulta:57b8f92ce86ee6b0',
        productId: 'ulta:57b8f92ce86ee6b0',
        canonicalProductRef: {
          merchant_id: 'external_seed',
          product_id: 'ext_bb310b68bf948987b9f658c2',
        },
        requestedMerchantId: 'external_seed',
      }),
    ).toBe(true);

    expect(
      debug.shouldHydratePdpIdentityLineMemberPayloads({
        entryProductIsExternalSeed: true,
        entryProductId: 'ext_bb310b68bf948987b9f658c2',
        productId: 'ext_bb310b68bf948987b9f658c2',
        canonicalProductRef: {
          merchant_id: 'external_seed',
          product_id: 'ext_bb310b68bf948987b9f658c2',
        },
        requestedMerchantId: 'external_seed',
      }),
    ).toBe(false);
  });

  test('merges rich selected external seed alias PDP content without replacing canonical identity', () => {
    const { debug } = loadServerWithDb();
    const { buildPdpPayload } = require('../src/pdpBuilder');
    const canonicalProduct = {
      merchant_id: 'external_seed',
      product_id: 'ext_bb310b68bf948987b9f658c2',
      id: 'ext_bb310b68bf948987b9f658c2',
      title: 'Find Comfort Body & Hair Fragrance Mist',
      selected_commerce_ref: {
        merchant_id: 'external_seed',
        product_id: 'ulta:57b8f92ce86ee6b0',
      },
      canonical_content_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_bb310b68bf948987b9f658c2',
      },
      pdp_field_quality_summary: {
        details_sections: {
          source_origin: 'unknown',
          source_quality_status: 'low',
        },
      },
    };
    const selectedAliasProduct = {
      merchant_id: 'external_seed',
      product_id: 'ulta:57b8f92ce86ee6b0',
      title: 'Find Comfort Body & Hair Fragrance Mist',
      brand: 'Rare Beauty',
      category: 'Fragrance',
      pdp_description_raw:
        'A super fine, cloud-like mist with warm and cozy notes of soft cashmere and jasmine petals.',
      pdp_how_to_use_raw: 'Spritz onto body or hair any time you want a fresh scent.',
      pdp_details_sections: [
        {
          heading: 'Details',
          body: 'A super fine, cloud-like mist with warm and cozy notes.',
        },
        {
          heading: 'Benefits',
          body: 'Lightweight and non-sticky with a warm, comforting scent.',
        },
        {
          heading: 'Research Results',
          body: '100% said it feels fresh on skin and hair.',
        },
      ],
      pdp_field_quality_summary: {
        description_raw: {
          source_quality_status: 'high',
          source_origin: 'shopify_json',
        },
        details_sections: {
          source_quality_status: 'medium',
          source_origin: 'retail_pdp',
        },
        how_to_use_raw: {
          source_quality_status: 'medium',
          source_origin: 'retail_pdp',
        },
      },
      seed_data: {
        pdp_details_sections: [
          {
            heading: 'Details',
            body: 'A super fine, cloud-like mist with warm and cozy notes.',
          },
          {
            heading: 'Benefits',
            body: 'Lightweight and non-sticky with a warm, comforting scent.',
          },
          {
            heading: 'Research Results',
            body: '100% said it feels fresh on skin and hair.',
          },
        ],
      },
    };

    const merged = debug.mergeExternalSeedAliasPdpContent(canonicalProduct, selectedAliasProduct);

    expect(merged.product_id).toBe('ext_bb310b68bf948987b9f658c2');
    expect(merged.id).toBe('ext_bb310b68bf948987b9f658c2');
    expect(merged.selected_commerce_ref).toEqual(canonicalProduct.selected_commerce_ref);
    expect(merged.canonical_content_ref).toEqual(canonicalProduct.canonical_content_ref);
    expect(merged.pdp_how_to_use_raw).toBe('Spritz onto body or hair any time you want a fresh scent.');
    expect(merged.pdp_details_sections).toEqual(selectedAliasProduct.pdp_details_sections);

    const pdpPayload = buildPdpPayload({ product: merged });
    const factsModule = pdpPayload.modules.find((module) => module.type === 'product_facts');
    const supplementalModule = pdpPayload.modules.find((module) => module.type === 'supplemental_details');
    expect(factsModule?.data?.sections?.map((section) => section.heading)).toContain('Benefits');
    expect(supplementalModule?.data?.sections?.map((section) => section.heading)).toEqual(
      expect.arrayContaining(['Benefits', 'Research Results']),
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
        title: '5.07 fl oz / 150 mL',
        option_name: 'Size',
        option_value: '5.07 fl oz / 150 mL',
        axis_kind: 'volume',
        display_label: 'Size: 5.07 fl oz / 150 mL',
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

  test('surfaces reviewed partial key-ingredient scope without treating it as low quality', async () => {
    const { db, debug } = loadServerWithDb();

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'eps_tirtir_partial_key_ingredients',
          external_product_id: 'ext_tirtir_partial_key_ingredients',
          canonical_url: 'https://tirtir.global/products/dermatir-intensive-lotion-md-1',
          destination_url: 'https://tirtir.global/products/dermatir-intensive-lotion-md-1',
          domain: 'tirtir.global',
          title: 'Dermatir Intensive Lotion MD',
          image_url: 'https://cdn.shopify.com/dermatir.jpg',
          price_amount: '7.00',
          price_currency: 'USD',
          availability: 'In Stock',
          status: 'active',
          seed_data: {
            brand: 'TIRTIR Global',
            pdp_ingredients_raw: 'Ceramides, Panthenol',
            raw_ingredient_text_clean: 'Ceramides, Panthenol',
            inci_list: 'Ceramides, Panthenol',
            ingredient_intel: {
              raw_ingredient_text_clean: 'Ceramides, Panthenol',
              inci_list: 'Ceramides, Panthenol',
            },
            pdp_field_quality_summary: {
              ingredients_raw: {
                source_origin: 'reviewed_exact_product_source_partial_ingredient_scope',
                source_quality_status: 'reviewed_key_ingredients_partial_not_full_inci',
                authority_scope: 'reviewed_key_ingredients_not_full_inci',
              },
              ingredients_inci: {
                source_origin: 'reviewed_exact_product_source_partial_ingredient_scope',
                source_quality_status: 'reviewed_key_ingredients_partial_not_full_inci',
                authority_scope: 'reviewed_key_ingredients_not_full_inci',
              },
            },
            snapshot: {
              canonical_url: 'https://tirtir.global/products/dermatir-intensive-lotion-md-1',
            },
          },
        },
      ],
    });

    const product = await debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: 'ext_tirtir_partial_key_ingredients',
    });

    expect(product).toMatchObject({
      product_id: 'ext_tirtir_partial_key_ingredients',
      pdp_ingredients_raw: 'Ceramides, Panthenol',
      raw_ingredient_text_clean: 'Ceramides, Panthenol',
    });
    expect(product.inci_list).toEqual(['Ceramides', 'Panthenol']);
    expect(product.pdp_field_quality_summary.ingredients_raw).toMatchObject({
      source_quality_status: 'reviewed_key_ingredients_partial_not_full_inci',
      authority_scope: 'reviewed_key_ingredients_not_full_inci',
    });
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

describe('product detail cache per-merchant TTL resolution', () => {
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('ttl resolver: external_seed defaults to 0 (bypass) — preserves regression contract from aa04f68f', () => {
    const { debug } = loadServerWithDb();
    expect(debug.resolveProductDetailCacheTtlMs('external_seed')).toBe(0);
  });

  test('ttl resolver: first-party merchants get the default TTL', () => {
    const { debug } = loadServerWithDb();
    const ttl = debug.resolveProductDetailCacheTtlMs('merch_first_party_1');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBe(10 * 60 * 1000); // default 10 min
  });

  test('ttl resolver: PRODUCT_DETAIL_CACHE_TTL_MS_EXTERNAL_SEED env var enables external_seed cache', () => {
    const { debug } = loadServerWithDb({
      PRODUCT_DETAIL_CACHE_TTL_MS_EXTERNAL_SEED: '60000',
    });
    expect(debug.resolveProductDetailCacheTtlMs('external_seed')).toBe(60000);
  });

  test('ttl resolver: PRODUCT_DETAIL_CACHE_TTL_MS_OVERRIDES JSON map is honored and beats named env var', () => {
    const { debug } = loadServerWithDb({
      PRODUCT_DETAIL_CACHE_TTL_MS_OVERRIDES: JSON.stringify({
        merch_special_x: 120000,
        external_seed: 5000,
      }),
      PRODUCT_DETAIL_CACHE_TTL_MS_EXTERNAL_SEED: '60000', // overridden by JSON map
    });
    expect(debug.resolveProductDetailCacheTtlMs('merch_special_x')).toBe(120000);
    expect(debug.resolveProductDetailCacheTtlMs('external_seed')).toBe(5000);
  });

  test('ttl resolver: empty/invalid merchantId falls back to default TTL', () => {
    const { debug } = loadServerWithDb();
    expect(debug.resolveProductDetailCacheTtlMs('')).toBe(10 * 60 * 1000);
    expect(debug.resolveProductDetailCacheTtlMs(null)).toBe(10 * 60 * 1000);
  });

  test('ttl resolver: invalid JSON in PRODUCT_DETAIL_CACHE_TTL_MS_OVERRIDES is ignored', () => {
    const { debug } = loadServerWithDb({
      PRODUCT_DETAIL_CACHE_TTL_MS_OVERRIDES: 'not-valid-json',
    });
    // Falls through to default behavior; external_seed still defaults to 0.
    expect(debug.resolveProductDetailCacheTtlMs('external_seed')).toBe(0);
    expect(debug.resolveProductDetailCacheTtlMs('merch_x')).toBe(10 * 60 * 1000);
  });

  test('healthz snapshot exposes ttl_ms_by_merchant with default + known merchants', () => {
    const { debug } = loadServerWithDb({
      PRODUCT_DETAIL_CACHE_TTL_MS_EXTERNAL_SEED: '30000',
    });
    const stats = debug.snapshotProductDetailCacheStats();
    expect(stats.ttl_ms_by_merchant).toEqual(
      expect.objectContaining({
        default: 10 * 60 * 1000,
        external_seed: 30000,
      }),
    );
  });

  test('healthz snapshot ttl_ms_by_merchant includes merchants from JSON overrides', () => {
    const { debug } = loadServerWithDb({
      PRODUCT_DETAIL_CACHE_TTL_MS_OVERRIDES: JSON.stringify({
        merch_overridden_a: 45000,
      }),
    });
    const stats = debug.snapshotProductDetailCacheStats();
    expect(stats.ttl_ms_by_merchant.merch_overridden_a).toBe(45000);
    // external_seed still appears (it's known historical special-case)
    expect(stats.ttl_ms_by_merchant.external_seed).toBe(0);
  });
});
