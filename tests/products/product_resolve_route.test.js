const nock = require('nock');
const request = require('supertest');

describe('POST /agent/v1/products/resolve', () => {
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
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
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
  });

  test('returns grounded product_ref (prefers prefer_merchants)', async () => {
    const preferMerchant = 'merch_efbc46b4619cfbdf';
    const otherMerchant = 'merch_other';
    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';

    nock('http://pivota.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        products: [
          {
            merchant_id: otherMerchant,
            product_id: 'prod_other_1',
            title: queryText,
            vendor: 'The Ordinary',
          },
          {
            merchant_id: preferMerchant,
            product_id: 'prod_pref_1',
            title: queryText,
            vendor: 'The Ordinary',
          },
        ],
      });

    const app = require('../../src/server');

    const resp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: queryText,
        lang: 'en',
        options: {
          prefer_merchants: [preferMerchant],
          search_all_merchants: true,
          timeout_ms: 1500,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual(
      expect.objectContaining({
        resolved: true,
        product_ref: { product_id: 'prod_pref_1', merchant_id: preferMerchant },
      }),
    );
    expect(Array.isArray(resp.body.candidates)).toBe(true);
    expect(resp.body.candidates.length).toBeGreaterThan(0);
  });

  test('filters external_seed by default', async () => {
    const queryText = 'Winona Soothing Repair Serum';

    nock('http://pivota.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        products: [
          {
            merchant_id: 'external_seed',
            product_id: 'ext_123',
            title: queryText,
            source_type: 'external_seed',
          },
        ],
      });

    const app = require('../../src/server');

    const resp = await request(app)
      .post('/agent/v1/products/resolve')
      .send({
        query: queryText,
        lang: 'en',
        options: {
          search_all_merchants: true,
          timeout_ms: 800,
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.resolved).toBe(false);
    expect(resp.body.product_ref).toBeNull();
    expect(resp.body.reason).toBe('no_candidates');
    expect(resp.body.candidates).toEqual([]);
  });

  test('rejects missing query', async () => {
    const app = require('../../src/server');
    const resp = await request(app).post('/agent/v1/products/resolve').send({ lang: 'en' });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe('MISSING_PARAMETERS');
  });
});
