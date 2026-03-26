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

describe('/agent/shop/v1/invoke mock commerce operations', () => {
  test('returns mock create_order through extracted helper path', async () => {
    const app = getAppWithEnv({
      API_MODE: 'MOCK',
      PIVOTA_API_KEY: undefined,
      DATABASE_URL: undefined,
    });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'create_order',
        payload: {
          order: {
            items: [
              {
                merchant_id: 'merch_208139f7600dbf42',
                product_id: 'BOTTLE_001',
                unit_price: 20,
                quantity: 2,
              },
            ],
          },
        },
      })
      .expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        status: 'success',
        order_status: 'pending',
        total: 40,
      }),
    );
    expect(Array.isArray(res.body.order_lines)).toBe(true);
    expect(res.body.order_lines.length).toBeGreaterThan(0);
  });
});
