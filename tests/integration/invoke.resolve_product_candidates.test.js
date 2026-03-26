process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'REAL';

const request = require('supertest');
const nock = require('nock');

function getApp() {
  jest.resetModules();
  process.env.PIVOTA_API_BASE = 'http://localhost:8080';
  process.env.PIVOTA_API_KEY = 'test-token';
  process.env.API_MODE = 'REAL';
  // eslint-disable-next-line global-require
  return require('../../src/server');
}

describe('/agent/shop/v1/invoke resolve_product_candidates', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  test('uses resolved product group members and skips agent search', async () => {
    const groupScope = nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query({
        product_id: 'p_resolve_candidates_1',
      })
      .reply(200, {
        product_group_id: 'pg:m1:p_resolve_candidates_1',
        members: [
          {
            merchant_id: 'm1',
            product_id: 'p_resolve_candidates_1',
            platform: 'shopify',
            is_primary: true,
          },
        ],
      });

    const detailScope = nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/m1/p_resolve_candidates_1')
      .reply(200, {
        product: {
          merchant_id: 'm1',
          product_id: 'p_resolve_candidates_1',
          platform: 'shopify',
          platform_product_id: 'gid://shopify/Product/resolve-1',
          price: 18.5,
          currency: 'USD',
          in_stock: true,
        },
      });

    const app = getApp();
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'resolve_product_candidates',
        payload: {
          product_ref: {
            product_id: 'p_resolve_candidates_1',
          },
          options: {
            debug: true,
          },
        },
      })
      .expect(200);

    expect(groupScope.isDone()).toBe(true);
    expect(detailScope.isDone()).toBe(true);
    expect(res.body).toMatchObject({
      status: 'success',
      product_group_id: 'pg:m1:p_resolve_candidates_1',
      canonical_product_ref: {
        merchant_id: 'm1',
        product_id: 'p_resolve_candidates_1',
        platform: 'shopify',
      },
      offers_count: 1,
      cache: {
        hit: false,
      },
    });
    expect(Array.isArray(res.body.offers)).toBe(true);
    expect(res.body.offers[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'm1',
        product_id: 'p_resolve_candidates_1',
      }),
    );
  });
});
