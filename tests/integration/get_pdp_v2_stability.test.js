process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';
delete process.env.DATABASE_URL;

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('get_pdp_v2 stability semantics', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('auto-corrects ext_* merchant mismatches to the external_seed canonical product', async () => {
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
      .reply(200, {
        product: {
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
          platform: 'external',
          platform_product_id: 'ext_seed_1',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
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
  });

  it('keeps canonical not-found responses on 404 after mismatch correction fails', async () => {
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

  it('returns 504 UPSTREAM_TIMEOUT when canonical detail fetch times out', async () => {
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
