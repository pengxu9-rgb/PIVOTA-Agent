process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.PDP_EXTERNAL_SEED_UNSCOPED_GROUP_BUDGET_MS = '100';
delete process.env.DATABASE_URL;

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

function mockProductDetailInvoke(merchantId, productId, status, body, times = 1) {
  return nock(process.env.PIVOTA_API_BASE)
    .post('/agent/shop/v1/invoke', (payload) => {
      const product = payload?.payload?.product || {};
      return (
        payload?.operation === 'get_product_detail' &&
        product.merchant_id === merchantId &&
        product.product_id === productId
      );
    })
    .times(times)
    .reply(status, body);
}

describe('get_pdp_v2 stability semantics', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('auto-corrects ext_* merchant mismatches to the external_seed canonical product', async () => {
    const merchantUrl = 'https://merchant.example/products/ext-seed-1';
    const externalSeedProduct = {
      merchant_id: 'external_seed',
      product_id: 'ext_seed_1',
      source: 'external_seed',
      title: 'Tom Ford Noir',
      description: 'External seed PDP',
      brand: 'Tom Ford',
      category: 'Fragrance',
      currency: 'USD',
      price: {
        amount: 180,
        currency: 'USD',
      },
      image_url: 'https://example.com/ext_seed_1.jpg',
      destination_url: merchantUrl,
      canonical_url: merchantUrl,
      platform: 'external',
      platform_product_id: 'ext_seed_1',
    };

    mockProductDetailInvoke('merch_wrong', 'ext_seed_1', 404, {
      error: 'PRODUCT_NOT_FOUND',
      message: 'Product not found',
    });
    mockProductDetailInvoke('external_seed', 'ext_seed_1', 200, {
      product: externalSeedProduct,
    }, 3);

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/merch_wrong/ext_seed_1')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'Product not found' });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_seed_1')
      .reply(200, {
        status: 'success',
        product_group_id: 'pg_ext_seed_1',
        members: [
          {
            merchant_id: 'external_seed',
            product_id: 'ext_seed_1',
            platform: 'external',
            is_primary: true,
          },
        ],
      });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/external_seed/ext_seed_1')
      .twice()
      .reply(200, {
        product: externalSeedProduct,
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          include: ['offers'],
          product_ref: {
            merchant_id: 'merch_wrong',
            product_id: 'ext_seed_1',
          },
        },
      })
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.metadata.identity_resolution).toEqual(
      expect.objectContaining({
        requested_product_id: 'ext_seed_1',
        requested_merchant_id: 'merch_wrong',
        resolved_product_id: 'ext_seed_1',
        resolved_merchant_id: 'external_seed',
        canonicalization_applied: true,
        canonicalization_reason_code: 'PRODUCT_ROUTE_MERCHANT_MISMATCH',
      }),
    );
    expect(res.body.metadata.route_health).toEqual(
      expect.objectContaining({
        requested_product_id: 'ext_seed_1',
        requested_merchant_id: 'merch_wrong',
        resolved_product_id: 'ext_seed_1',
        resolved_merchant_id: 'external_seed',
        canonicalization_applied: true,
      }),
    );

    const canonicalModule = res.body.modules.find((module) => module.type === 'canonical');
    const offersModule = res.body.modules.find((module) => module.type === 'offers');
    expect(canonicalModule?.data?.pdp_payload?.product).toEqual(
      expect.objectContaining({
        source: 'external_seed',
        external_redirect_url: merchantUrl,
        destination_url: merchantUrl,
        canonical_url: merchantUrl,
      }),
    );
    expect(offersModule?.data?.offers?.[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_seed_1',
        purchase_route: 'affiliate_outbound',
        commerce_mode: 'links_out',
        checkout_handoff: 'redirect',
        external_redirect_url: merchantUrl,
        merchant_checkout_url: merchantUrl,
        url: merchantUrl,
        action: {
          type: 'redirect_url',
          url: merchantUrl,
        },
      }),
    );
  });

  it('does not synthesize a self offer when product identity has no group members', async () => {
    const product = {
      merchant_id: 'merch_solo',
      product_id: 'solo_1',
      title: 'Solo Merchant Product',
      brand: 'Solo',
      currency: 'USD',
      price: {
        amount: 42,
        currency: 'USD',
      },
      in_stock: true,
      variants: [
        {
          variant_id: 'solo_variant_1',
          title: 'Default Title',
          price: 42,
          currency: 'USD',
        },
      ],
      store_discount_evidence: {
        pricing_confidence: 'display_estimate',
        offers: [{ title: 'SHOULD_NOT_LEAK_AS_SELF_OFFER' }],
      },
    };

    const productDetailScope = mockProductDetailInvoke('merch_solo', 'solo_1', 200, {
      product,
    });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          include: ['offers'],
          product_ref: {
            merchant_id: 'merch_solo',
            product_id: 'solo_1',
          },
        },
      })
      .expect(200);

    expect(productDetailScope.isDone()).toBe(true);
    expect(res.body.metadata.route_health).toEqual(
      expect.objectContaining({
        product_group_resolve_mode: 'skipped_prechecked_entry',
      }),
    );
    const offersModule = res.body.modules.find((module) => module.type === 'offers');
    expect(offersModule).toEqual(
      expect.objectContaining({
        data: null,
        reason: 'no_product_group_members',
      }),
    );
    expect(res.body.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'offers',
          reason: 'no_product_group_members',
        }),
      ]),
    );
  });

  it('does not synchronously refetch product detail only to hydrate savings presentation', async () => {
    const product = {
      merchant_id: 'merch_fast',
      product_id: 'prod_fast_1',
      title: 'Fast PDP Product',
      brand: 'Fast Brand',
      description: 'Fast canonical content should not wait on optional savings hydration.',
      currency: 'USD',
      price: {
        amount: 24,
        currency: 'USD',
      },
      in_stock: true,
    };

    const productDetailScope = mockProductDetailInvoke('merch_fast', 'prod_fast_1', 200, {
      product,
    });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          include: ['product_overview'],
          product_ref: {
            merchant_id: 'merch_fast',
            product_id: 'prod_fast_1',
          },
        },
      })
      .expect(200);

    expect(productDetailScope.isDone()).toBe(true);
    expect(res.body.metadata.route_health).toEqual(
      expect.objectContaining({
        savings_presentation_hydration_mode: 'prefetched_only',
        product_group_resolve_mode: 'skipped_prechecked_entry',
      }),
    );
    const canonicalModule = res.body.modules.find((module) => module.type === 'canonical');
    expect(canonicalModule?.data?.pdp_payload?.product?.store_discount_evidence).toBeUndefined();
    expect(canonicalModule?.data?.pdp_payload?.product?.payment_offer_evidence).toBeUndefined();
  });

  it('keeps canonical not-found responses on 404 after mismatch correction fails', async () => {
    mockProductDetailInvoke('merch_wrong', 'ext_missing_1', 404, {
      error: 'PRODUCT_NOT_FOUND',
      message: 'Product not found',
    });
    mockProductDetailInvoke('external_seed', 'ext_missing_1', 404, {
      error: 'PRODUCT_NOT_FOUND',
      message: 'Product not found',
    });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/merch_wrong/ext_missing_1')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'Product not found' });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_missing_1')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'No product group' });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/external_seed/ext_missing_1')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'Product not found' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: 'merch_wrong',
            product_id: 'ext_missing_1',
          },
        },
      })
      .expect(404);

    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'PRODUCT_NOT_FOUND',
        reason_code: 'PRODUCT_NOT_FOUND',
      }),
    );
    expect(res.body.metadata.identity_resolution).toEqual(
      expect.objectContaining({
        requested_product_id: 'ext_missing_1',
        requested_merchant_id: 'merch_wrong',
        resolved_merchant_id: 'external_seed',
        canonicalization_applied: true,
      }),
    );
    expect(typeof res.body.gateway_request_id).toBe('string');
  });

  it('attempts unscoped canonical resolution for external_seed ext_* routes after entry misses', async () => {
    mockProductDetailInvoke('external_seed', 'ext_seed_2', 404, {
      error: 'PRODUCT_NOT_FOUND',
      message: 'Product not found',
    });
    mockProductDetailInvoke('merch_canonical', 'prod_canonical_2', 200, {
      product: {
        merchant_id: 'merch_canonical',
        product_id: 'prod_canonical_2',
        title: 'Canonical rescued PDP',
        brand: 'Tom Ford',
        currency: 'USD',
      },
    }, 2);

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/external_seed/ext_seed_2')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'Product not found' });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_seed_2')
      .reply(200, {
        status: 'success',
        product_group_id: 'pg_ext_seed_2',
        members: [
          {
            merchant_id: 'merch_canonical',
            product_id: 'prod_canonical_2',
            platform: 'shopify',
            is_primary: true,
          },
          {
            merchant_id: 'external_seed',
            product_id: 'ext_seed_2',
            platform: 'external',
            is_primary: false,
          },
        ],
        canonical_product_ref: {
          merchant_id: 'merch_canonical',
          product_id: 'prod_canonical_2',
          platform: 'shopify',
        },
      });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/merch_canonical/prod_canonical_2')
      .reply(200, {
        product: {
          merchant_id: 'merch_canonical',
          product_id: 'prod_canonical_2',
          title: 'Canonical rescued PDP',
          brand: 'Tom Ford',
          currency: 'USD',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: 'external_seed',
            product_id: 'ext_seed_2',
          },
        },
      })
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.metadata.identity_resolution).toEqual(
      expect.objectContaining({
        requested_product_id: 'ext_seed_2',
        requested_merchant_id: 'external_seed',
        resolved_product_id: 'prod_canonical_2',
        resolved_merchant_id: 'merch_canonical',
        canonicalization_applied: true,
        canonicalization_reason_code: 'PRODUCT_ROUTE_MERCHANT_MISMATCH',
        resolution_source: 'product_group_unscoped',
      }),
    );
  });

  it('does not block external_seed PDP rendering on slow unscoped group resolution', async () => {
    mockProductDetailInvoke('external_seed', 'ext_seed_slow_group', 200, {
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_seed_slow_group',
        source: 'external_seed',
        title: 'External seed direct PDP',
        brand: 'Beauty Brand',
        currency: 'USD',
      },
    });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_seed_slow_group')
      .delay(250)
      .reply(200, {
        status: 'success',
        product_group_id: 'pg_late',
        canonical_product_ref: {
          merchant_id: 'merchant_late',
          product_id: 'prod_late',
        },
      });

    const startedAt = Date.now();
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: 'external_seed',
            product_id: 'ext_seed_slow_group',
          },
        },
      })
      .expect(200);

    expect(Date.now() - startedAt).toBeLessThan(220);
    expect(res.body.metadata.identity_resolution).toEqual(
      expect.objectContaining({
        requested_product_id: 'ext_seed_slow_group',
        requested_merchant_id: 'external_seed',
        resolved_product_id: 'ext_seed_slow_group',
        resolved_merchant_id: 'external_seed',
        resolution_source: 'external_seed_product_id',
      }),
    );
    expect(res.body.metadata.route_health.product_group_resolve_mode).toBe('timeout_unscoped_external_seed');
  });

  it('returns 504 UPSTREAM_TIMEOUT when canonical detail fetch times out', async () => {
    mockProductDetailInvoke('merchant_slow', 'prod_timeout_1', 504, {
      error: 'UPSTREAM_TIMEOUT',
      message: 'timeout of 5000ms exceeded',
    }, 2);

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/merchant_slow/prod_timeout_1')
      .times(2)
      .reply(504, { error: 'UPSTREAM_TIMEOUT', message: 'timeout of 5000ms exceeded' });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/product-groups/resolve')
      .query((query) => query && query.merchant_id === 'merchant_slow' && query.product_id === 'prod_timeout_1')
      .reply(404, { error: 'PRODUCT_NOT_FOUND', message: 'No product group' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: 'merchant_slow',
            product_id: 'prod_timeout_1',
          },
        },
      })
      .expect(504);

    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'UPSTREAM_TIMEOUT',
        reason_code: 'UPSTREAM_TIMEOUT',
      }),
    );
    expect(res.body.metadata.route_health).toEqual(
      expect.objectContaining({
        requested_product_id: 'prod_timeout_1',
        requested_merchant_id: 'merchant_slow',
      }),
    );
  });
});
