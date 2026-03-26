process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('/agent/shop/v1/invoke get_pdp and resolve_product_group', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  test('routes get_pdp through extracted helper and returns pdp payload', async () => {
    const scope = nock(process.env.PIVOTA_API_BASE)
      .post('/agent/shop/v1/invoke', (body) => {
        return (
          body?.operation === 'get_product_detail' &&
          body?.payload?.product?.merchant_id === 'm1' &&
          body?.payload?.product?.product_id === 'p1'
        );
      })
      .reply(200, {
        status: 'success',
        product: {
          merchant_id: 'm1',
          product_id: 'p1',
          title: 'Product 1',
          currency: 'USD',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp',
        payload: {
          product: {
            merchant_id: 'm1',
            product_id: 'p1',
          },
        },
      })
      .expect(200);

    expect(scope.isDone()).toBe(true);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: 'success',
        product: expect.objectContaining({
          merchant_id: 'm1',
          product_id: 'p1',
        }),
        pdp_payload: expect.any(Object),
      }),
    );
  });

  test('routes resolve_product_group through extracted helper and preserves debug cache envelope', async () => {
    const scope = nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/product-groups/resolve')
      .query({
        merchant_id: 'm1',
        product_id: 'p1',
        platform: 'shopify',
      })
      .reply(200, {
        product_group_id: 'pg:m1:p1',
        members: [
          {
            merchant_id: 'm1',
            product_id: 'p1',
            platform: 'shopify',
            is_primary: true,
          },
        ],
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'resolve_product_group',
        payload: {
          product_ref: {
            merchant_id: 'm1',
            product_id: 'p1',
            platform: 'shopify',
          },
          options: {
            debug: true,
          },
        },
      })
      .expect(200);

    expect(scope.isDone()).toBe(true);
    expect(res.body).toMatchObject({
      status: 'success',
      product_group_id: 'pg:m1:p1',
      canonical_product_ref: {
        merchant_id: 'm1',
        product_id: 'p1',
        platform: 'shopify',
      },
      cache: {
        hit: false,
      },
    });
  });
});
