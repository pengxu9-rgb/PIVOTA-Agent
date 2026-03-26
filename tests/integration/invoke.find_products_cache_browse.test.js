const nock = require('nock');
const request = require('supertest');

describe('/agent/shop/v1/invoke find_products cache browse', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => {
      const h = String(host || '');
      return h.includes('127.0.0.1') || h.includes('localhost') || h === '::1';
    });

    prevEnv = {
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      API_MODE: process.env.API_MODE,
      DATABASE_URL: process.env.DATABASE_URL,
      FIND_PRODUCTS_MULTI_ROUTE_DEBUG: process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = '1';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();

    if (!prevEnv) return;
    if (prevEnv.PIVOTA_API_BASE === undefined) delete process.env.PIVOTA_API_BASE;
    else process.env.PIVOTA_API_BASE = prevEnv.PIVOTA_API_BASE;
    if (prevEnv.PIVOTA_API_KEY === undefined) delete process.env.PIVOTA_API_KEY;
    else process.env.PIVOTA_API_KEY = prevEnv.PIVOTA_API_KEY;
    if (prevEnv.API_MODE === undefined) delete process.env.API_MODE;
    else process.env.API_MODE = prevEnv.API_MODE;
    if (prevEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevEnv.DATABASE_URL;
    if (prevEnv.FIND_PRODUCTS_MULTI_ROUTE_DEBUG === undefined) {
      delete process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG;
    } else {
      process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = prevEnv.FIND_PRODUCTS_MULTI_ROUTE_DEBUG;
    }
    if (prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED === undefined) {
      delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    } else {
      process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED =
        prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    }
  });

  test('serves merchant browse from cache without upstream search call', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (
          text.includes('FROM products_cache pc') &&
          text.includes('JOIN merchant_onboarding mo') &&
          text.includes('WHERE pc.merchant_id = $1')
        ) {
          return {
            rows: [
              {
                merchant_id: 'merchant_1',
                merchant_name: 'Merchant One',
                product_data: {
                  id: 'prod_1',
                  product_id: 'prod_1',
                  merchant_id: 'merchant_1',
                  title: 'Cache Browse Product',
                  status: 'published',
                  inventory_quantity: 7,
                  price: 39,
                  currency: 'USD',
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products',
        payload: {
          search: {
            merchant_id: 'merchant_1',
            page: 1,
            page_size: 10,
          },
        },
      })
      .expect(200);

    expect(resp.body.products).toEqual([
      expect.objectContaining({
        product_id: 'prod_1',
        merchant_id: 'merchant_1',
        merchant_name: 'Merchant One',
      }),
    ]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'cache_merchant_browse',
        merchant_id: 'merchant_1',
      }),
    );
    expect(resp.body.metadata.route_debug).toEqual(
      expect.objectContaining({
        merchant_cache: expect.objectContaining({
          attempted: true,
          mode: 'browse',
          merchant_id: 'merchant_1',
          cache_hit: true,
        }),
      }),
    );
  });
});
