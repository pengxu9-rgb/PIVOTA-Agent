const nock = require('nock');
const request = require('supertest');

// The serving-currency guard on the REAL invoke route (src/services/servingCurrencyGuard.js), driven
// through a lane that never binds a market: the upstream proxy. Peng 2026-09-26: a result priced in
// another currency than the buyer's must never reach the agent frontend, whichever lane built it.
// The beauty direct lane is off and there is no database, so every row here comes from upstream.

const UPSTREAM = 'http://upstream.test';

const row = (id, currency) => ({
  product_id: id,
  id,
  merchant_id: 'merch_guard_test',
  merchant_name: 'Guard Test Store',
  title: `Guard Test Running Shoes ${id}`,
  description: 'Running shoes',
  price: 20,
  ...(currency === undefined ? {} : { currency }),
  image_url: `https://cdn.example/${id}.jpg`,
  inventory_quantity: 5,
  in_stock: true,
  platform: 'shopify',
});

describe('serving-currency guard on the invoke route', () => {
  let priorEnv, logged;

  beforeEach(() => {
    priorEnv = { ...process.env };
    jest.resetModules();
    logged = [];
    Object.assign(process.env, {
      PIVOTA_API_BASE: UPSTREAM, PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
      GATEWAY_RATE_LIMIT_ENABLED: 'false', AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'false',
    });
    delete process.env.DATABASE_URL;
    delete process.env.FIND_PRODUCTS_BUYER_MARKET;
    nock.disableNetConnect();
    nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    nock(UPSTREAM).persist()
      .get(/.*/).reply(200, { status: 'success', products: [row('usd', 'USD'), row('sgd', 'SGD'), row('jpy', 'JPY'), row('none')], total: 4 })
      .post(/.*/).reply(200, { status: 'success', products: [row('usd', 'USD'), row('sgd', 'SGD'), row('jpy', 'JPY'), row('none')], total: 4 });
  });
  afterEach(() => {
    process.env = priorEnv; jest.restoreAllMocks(); jest.resetModules(); nock.cleanAll(); nock.enableNetConnect();
  });

  const invoke = async (search) => {
    const app = require('../../src/server');
    const logger = require('../../src/logger');
    const realInfo = logger.info.bind(logger);
    jest.spyOn(logger, 'info').mockImplementation((obj, msg, ...rest) => {
      if (msg === 'invoke request complete') { logged.push(obj); return undefined; }
      return realInfo(obj, msg, ...rest);
    });
    const res = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'find_products_multi', payload: { search: { query: 'running shoes', limit: 10, ...search } }, metadata: { source: 'public_api' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    return res;
  };
  const currencies = (res) => [...new Set((res.body.products || []).map((p) => p.currency))].sort();

  test('control: upstream really does hand the door mixed currencies', async () => {
    // Without this, "only USD" below could pass because upstream sent only USD.
    const res = await invoke({});
    expect(res.status).toBe(200);
    expect(res.body.metadata.serving_currency_guard).toEqual(
      expect.objectContaining({ serving_currency: 'USD', dropped_currencies: expect.arrayContaining(['SGD', 'JPY']) }));
  });

  test('a silent request is served USD only; the dropped rows are counted on the log line', async () => {
    const res = await invoke({});
    expect(res.status).toBe(200);
    expect(currencies(res)).toEqual(['USD']);
    expect(logged).toHaveLength(1);
    expect(logged[0].served_currencies).toEqual(['USD']);
    expect(logged[0].serving_currency_dropped).toBeGreaterThanOrEqual(2);
  });

  test('an SG buyer is served SGD only', async () => {
    const res = await invoke({ market: 'SG' });
    expect(currencies(res)).toEqual(['SGD']);
    expect(logged[0].served_currencies).toEqual(['SGD']);
  });

  test('a market with no known currency is served nothing', async () => {
    const res = await invoke({ market: 'ZZ' });
    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });
});
