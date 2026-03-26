const request = require('supertest');

function getAppWithEnv(env) {
  jest.useRealTimers();
  jest.dontMock('../../src/auroraBff/routes');
  jest.dontMock('../../src/lookReplicator');
  jest.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  // eslint-disable-next-line global-require
  return require('../../src/server');
}

describe('/agent/shop/v1/invoke get_product_detail in mock mode', () => {
  test('returns mock product detail bundle through extracted helper path', async () => {
    const app = getAppWithEnv({
      API_MODE: 'MOCK',
      PIVOTA_API_KEY: undefined,
      DATABASE_URL: undefined,
    });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_product_detail',
        payload: {
          product: {
            merchant_id: 'merch_208139f7600dbf42',
            product_id: 'BOTTLE_001',
          },
        },
      })
      .expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        status: 'success',
        product_group_id: 'pg:mock:BOTTLE_001',
        offers_count: 3,
      }),
    );
    expect(Array.isArray(res.body.offers)).toBe(true);
    expect(res.body.default_offer_id).toContain('fast_premium');
    expect(res.body.best_price_offer_id).toContain('cheap_slow');
  });

  test('returns mock resolve_product_candidates bundle through extracted helper path', async () => {
    const app = getAppWithEnv({
      API_MODE: 'MOCK',
      PIVOTA_API_KEY: undefined,
      DATABASE_URL: undefined,
    });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'resolve_product_candidates',
        payload: {
          product_ref: {
            merchant_id: 'merch_208139f7600dbf42',
            product_id: 'BOTTLE_001',
          },
          options: {
            debug: true,
          },
        },
      })
      .expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        status: 'success',
        success: true,
        product_group_id: 'pg:mock:BOTTLE_001',
        offers_count: 3,
        cache: expect.objectContaining({
          hit: false,
        }),
      }),
    );
    expect(Array.isArray(res.body.offers)).toBe(true);
    expect(res.body.default_offer_id).toContain('fast_premium');
    expect(res.body.best_price_offer_id).toContain('cheap_slow');
  });
});
