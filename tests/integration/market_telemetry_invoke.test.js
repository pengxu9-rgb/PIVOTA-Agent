const nock = require('nock');
const request = require('supertest');

// The telemetry REACHES THE LOG LINE. The unit tests pin what the record contains; this pins
// that a real request emits it, which is the part a mutation to the wiring would otherwise
// survive (the helper keeps passing while nothing calls it).
//
// It asserts on the logger, not on the response: these fields are deliberately NOT in the
// response body -- they are operational, and adding them to a public contract is a different
// decision from measuring.

const FIELDS = ['market_requested', 'market_source', 'market_bound', 'served_currencies',
  'served_currency_mismatch', 'served_price_sources'];

describe('market telemetry on the invoke completion log line', () => {
  let priorEnv, logged;

  beforeEach(() => {
    priorEnv = { ...process.env };
    jest.resetModules();
    logged = [];
    Object.assign(process.env, {
      PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
      SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true', SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce',
      GATEWAY_RATE_LIMIT_ENABLED: 'false', AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
    });
    nock.disableNetConnect();
    nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    jest.doMock('../../src/db', () => ({ query: async () => ({ rows: [] }) }));
  });
  afterEach(() => {
    process.env = priorEnv; jest.dontMock('../../src/db'); jest.restoreAllMocks();
    jest.resetModules(); nock.cleanAll(); nock.enableNetConnect();
  });

  // SPY on the real logger rather than replacing it. The logger is a pino instance, and a copy
  // made by spreading it loses pino's internal symbols -- `logger.error` then throws
  // `this[writeSym] is not a function`, the request never answers, and every test times out.
  // The logger module is a singleton, so spying on the instance the server just required is
  // spying on the one it logs through.
  const loadApp = () => {
    const app = require('../../src/server');
    const logger = require('../../src/logger');
    const realInfo = logger.info.bind(logger);
    jest.spyOn(logger, 'info').mockImplementation((obj, msg, ...rest) => {
      if (msg === 'invoke request complete') { logged.push(obj); return undefined; }
      return realInfo(obj, msg, ...rest);
    });
    return app;
  };

  const invoke = async (payloadSearch, metadata) => {
    const app = loadApp();
    const res = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'find_products_multi',
      payload: { search: { query: 'lip gloss', domain: 'beauty', limit: 5, ...payloadSearch } },
      metadata: { source: 'public_api', ...metadata },
    });
    // Give the 'finish' handler its turn.
    await new Promise((resolve) => setImmediate(resolve));
    return res;
  };

  test('a named market is recorded with where it was named and what was bound', async () => {
    await invoke({ market: 'SG' }, {});
    expect(logged).toHaveLength(1);
    const line = logged[0];
    expect(line.market_requested).toBe('SG');
    expect(line.market_source).toBe('explicit_search');
    expect(line.market_bound).toEqual(['SG']);
    for (const field of FIELDS) expect(Object.keys(line)).toContain(field);
  });

  test('metadata.market is recorded as such, and silence as defaulted', async () => {
    await invoke({}, { market: 'SG' });
    expect(logged[0].market_source).toBe('explicit_metadata');
    expect(logged[0].market_requested).toBe('SG');

    logged.length = 0;
    jest.resetModules();
    await invoke({}, {});
    expect(logged[0].market_source).toBe('defaulted');
    expect(logged[0].market_requested).toBeNull();
    // The deployment's served list, not a guess.
    const { marketsForRequest } = require('../../src/services/servedMarkets');
    expect(logged[0].market_bound).toEqual(marketsForRequest(null));
  });

  test('the fields are operational only: they never appear in the response body', async () => {
    const res = await invoke({ market: 'SG' }, {});
    const body = JSON.stringify(res.body);
    for (const field of FIELDS) expect(body).not.toContain(field);
  });

  test('a telemetry failure never changes the response', async () => {
    // The guard around the capture is unreachable with today's helper -- it is tested never to
    // throw -- so without this test it is protection nobody has seen work. Force the throw.
    //
    // The property is "telemetry cannot change what the caller gets", so it is measured against
    // the SAME request with telemetry working, not against an assumed status: in this test
    // environment (no recall rows) the request answers 503 either way, and asserting 200 would
    // test the environment instead of the guard.
    const send = (app) => request(app).post('/agent/shop/v1/invoke').send({
      operation: 'find_products_multi',
      payload: { search: { query: 'lip gloss', domain: 'beauty', limit: 5, market: 'SG' } },
      metadata: { source: 'public_api' },
    });
    const baseline = await send(loadApp());
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged).toHaveLength(1);
    expect(logged[0].market_requested).toBe('SG');

    logged.length = 0;
    jest.restoreAllMocks();
    jest.resetModules();
    const app = loadApp();
    const telemetry = require('../../src/services/marketTelemetry');
    jest.spyOn(telemetry, 'buildMarketTelemetry').mockImplementation(() => { throw new Error('boom'); });
    const broken = await send(app);
    await new Promise((resolve) => setImmediate(resolve));

    expect(broken.status).toBe(baseline.status);
    expect(broken.body.products).toEqual(baseline.body.products);
    expect(broken.body.error).toEqual(baseline.body.error);
    // Still logged -- the failure is visible on the line instead of silently absent.
    expect(logged).toHaveLength(1);
    expect(logged[0].market_telemetry_error).toBe('boom');
    expect(logged[0].market_requested).toBeUndefined();
  });

  test('another operation emits no market fields at all', async () => {
    const app = loadApp();
    await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'get_offers', payload: { product_id: 'x' }, metadata: { source: 'public_api' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged).toHaveLength(1);
    for (const field of FIELDS) expect(Object.keys(logged[0])).not.toContain(field);
  });
});
