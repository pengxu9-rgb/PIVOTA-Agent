const nock = require('nock');
const request = require('supertest');

describe('find_products_multi merchant scope keeps canonical recall out of the way', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => String(host || '').includes('127.0.0.1') || String(host || '').includes('localhost'));
    prevEnv = { ...process.env };
    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://canonical-merchant-test';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    process.env = prevEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test('merchant-scoped MOYU brush query returns merchant-owned upstream PDPs', async () => {
    const observedSql = [];
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        observedSql.push(String(sql || ''));
        return { rows: [] };
      },
    }));
    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [{
          product_id: 'prod_moyu_brush',
          merchant_id: 'merch_moyu',
          platform: 'shopify',
          title: 'MOYU Makeup Brush',
          brand: 'MOYU',
          product_type: 'Brush',
          pdp_scope: 'merchant_owned',
          image_url: 'https://cdn.example.com/moyu-brush.jpg',
          price: 18,
          currency: 'USD',
        }],
        total: 1,
      });
    nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [{
          product_id: 'prod_moyu_brush',
          merchant_id: 'merch_moyu',
          platform: 'shopify',
          title: 'MOYU Makeup Brush',
          brand: 'MOYU',
          product_type: 'Brush',
          pdp_scope: 'merchant_owned',
          image_url: 'https://cdn.example.com/moyu-brush.jpg',
          price: 18,
          currency: 'USD',
        }],
        total: 1,
      });
    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        product: {},
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'MOYU brush',
            merchant_id: 'merch_moyu',
            page: 1,
            limit: 6,
          },
        },
        metadata: { source: 'shopping_agent' },
      });

    expect(resp.status).toBe(200);
    expect((resp.body.products || []).map((item) => item.product_id)).toContain('prod_moyu_brush');
    expect(resp.body.products[0].pdp_scope).toBe('merchant_owned');
    expect(observedSql.some((sql) => sql.includes('FROM catalog_products p'))).toBe(false);
  });
});
