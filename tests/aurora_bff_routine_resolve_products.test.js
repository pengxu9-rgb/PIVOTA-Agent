const request = require('supertest');
const nock = require('nock');

const loadApp = () => {
  jest.resetModules();
  return require('../src/server');
};

describe('/v1/routine/resolve-products route', () => {
  jest.setTimeout(30000);

  beforeEach(() => {
    jest.resetModules();
    process.env.AURORA_BFF_USE_MOCK = 'false';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL = 'false';
    process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS = 'false';
    process.env.AURORA_PRODUCT_STRICT_SKINCARE_FILTER = 'true';
    delete process.env.PIVOTA_BACKEND_BASE_URL;
  });

  afterEach(() => {
    delete process.env.AURORA_BFF_USE_MOCK;
    delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    delete process.env.AURORA_BFF_PRODUCT_INTEL_CATALOG_FALLBACK;
    delete process.env.AURORA_BFF_PRODUCT_URL_REALTIME_INTEL;
    delete process.env.AURORA_BFF_PRODUCT_URL_INGREDIENT_ANALYSIS;
    delete process.env.AURORA_PRODUCT_STRICT_SKINCARE_FILTER;
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    nock.cleanAll();
  });

  test('returns empty_input when products[] is empty', async () => {
    const app = loadApp();
    const res = await request(app)
      .post('/v1/routine/resolve-products')
      .set('X-Aurora-UID', 'uid_routine_empty_1')
      .send({ products: [] })
      .expect(200);

    expect(res.body).toEqual({
      resolved: [],
      reason: 'empty_input',
    });
  });

  test('returns high match_quality for strong name match', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-routine.test';
    nock('http://catalog-routine.test')
      .post('/agent/v1/products/resolve')
      .reply(200, {
        resolved: true,
        product_ref: { merchant_id: 'm_1', product_id: 'prod_cerave_001' },
        candidates: [
          {
            product_id: 'prod_cerave_001',
            sku_id: 'sku_cerave_001',
            brand: 'CeraVe',
            name: 'Moisturizing Cream',
            display_name: 'CeraVe Moisturizing Cream',
            category: 'moisturizer',
            image_url: 'https://img.example/cerave.jpg',
          },
        ],
      });

    const app = loadApp();
    const res = await request(app)
      .post('/v1/routine/resolve-products')
      .set('X-Aurora-UID', 'uid_routine_high_1')
      .send({
        lang: 'EN',
        products: [{ slot: 'am', step: 'moisturizer', text: 'CeraVe Moisturizing Cream' }],
      })
      .expect(200);

    expect(Array.isArray(res.body.resolved)).toBe(true);
    expect(res.body.resolved[0]).toEqual(
      expect.objectContaining({
        slot: 'am',
        step: 'moisturizer',
        match_quality: 'high',
      }),
    );
    expect(res.body.resolved[0].product).toEqual(
      expect.objectContaining({
        product_id: 'prod_cerave_001',
      }),
    );
  });

  test('downgrades to low match_quality on single-token weak match', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog-routine.test';
    nock('http://catalog-routine.test')
      .post('/agent/v1/products/resolve')
      .reply(200, {
        resolved: true,
        product_ref: { merchant_id: 'm_2', product_id: 'prod_unrelated_001' },
        candidates: [
          {
            product_id: 'prod_unrelated_001',
            sku_id: 'sku_unrelated_001',
            brand: 'UnrelatedBrand',
            name: 'Barrier Lotion',
            display_name: 'UnrelatedBrand Barrier Lotion',
            category: 'moisturizer',
          },
        ],
      });

    const app = loadApp();
    const res = await request(app)
      .post('/v1/routine/resolve-products')
      .set('X-Aurora-UID', 'uid_routine_low_1')
      .send({
        lang: 'EN',
        products: [{ slot: 'pm', step: 'moisturizer', text: 'cream' }],
      })
      .expect(200);

    expect(res.body.resolved[0]).toEqual(
      expect.objectContaining({
        slot: 'pm',
        step: 'moisturizer',
        match_quality: 'low',
      }),
    );
    expect(res.body.resolved[0].product).toBeTruthy();
  });

  test('maps rejected settled result to promise_rejected item', async () => {
    const originalAllSettled = Promise.allSettled;
    Promise.allSettled = jest.fn().mockResolvedValue([
      {
        status: 'rejected',
        reason: new Error('forced reject'),
      },
    ]);

    try {
      const app = loadApp();
      const res = await request(app)
        .post('/v1/routine/resolve-products')
        .set('X-Aurora-UID', 'uid_routine_reject_1')
        .send({
          products: [{ slot: 'am', step: 'cleanser', text: '' }],
        })
        .expect(200);

      expect(res.body.resolved).toHaveLength(1);
      expect(res.body.resolved[0]).toEqual(
        expect.objectContaining({
          match_quality: 'none',
          reason: 'promise_rejected',
        }),
      );
    } finally {
      Promise.allSettled = originalAllSettled;
    }
  });
});
