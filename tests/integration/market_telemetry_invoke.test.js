const nock = require('nock');
const request = require('supertest');

// The telemetry REACHES THE LOG LINE, and says what the door ACTUALLY bound.
//
// Review of #2239 found the first version logging a market the SQL never bound -- for a flat
// payload, a whitespace `search.market`, and `search.market: false`. So these tests do not
// trust the record: they capture the parameters the door handed to the database and require
// the logged `market_bound` to be among them.
//
// They also run the beauty direct lane for real (PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED +
// a DATABASE_URL), because without it the door returns before it binds anything and records
// no lane -- which is how two wiring mutants (products key, stage breakdown) survived review.

const FIELDS = ['market_observed', 'market_requested', 'market_source', 'market_bound', 'market_buyer_currency',
  'served_currencies', 'served_currency_mismatch', 'served_price_sources'];

describe('market telemetry on the invoke completion log line', () => {
  let priorEnv, logged, sqlParams;

  beforeEach(() => {
    priorEnv = { ...process.env };
    jest.resetModules();
    logged = [];
    sqlParams = [];
    Object.assign(process.env, {
      PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
      SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true', SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce',
      GATEWAY_RATE_LIMIT_ENABLED: 'false', AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true', DATABASE_URL: 'postgres://unused.test/db',
    });
    delete process.env.FIND_PRODUCTS_BUYER_MARKET;
    nock.disableNetConnect();
    nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    jest.doMock('../../src/db', () => ({
      query: async (sql, params) => { sqlParams.push(...(Array.isArray(params) ? params : [])); return { rows: [] }; },
    }));
  });
  afterEach(() => {
    process.env = priorEnv; jest.dontMock('../../src/db'); jest.restoreAllMocks();
    jest.resetModules(); nock.cleanAll(); nock.enableNetConnect();
  });

  // SPY on the real logger rather than replacing it: a spread copy of a pino instance loses its
  // internal symbols, `logger.error` throws `this[writeSym] is not a function`, and requests hang.
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

  const invoke = async (payload, metadata = {}) => {
    const res = await request(loadApp()).post('/agent/shop/v1/invoke').send({
      operation: 'find_products_multi', payload, metadata: { source: 'public_api', ...metadata },
    });
    await new Promise((resolve) => setImmediate(resolve));
    return res;
  };

  // What the database was handed, flattened -- markets arrive as a scalar or as a list.
  const boundInSql = () => sqlParams.flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter((p) => typeof p === 'string');

  test('a named market: observed at the bind, and the logged market is the one the SQL received', async () => {
    await invoke({ search: { query: 'lip gloss', domain: 'beauty', limit: 5, market: 'SG' } });
    expect(logged).toHaveLength(1);
    const line = logged[0];
    expect(line.market_observed).toBe(true);
    expect(line.market_requested).toBe('SG');
    expect(line.market_source).toBe('explicit_search');
    expect(line.market_bound).toEqual(['SG']);
    expect(boundInSql()).toContain('SG');
    for (const field of FIELDS) expect(Object.keys(line)).toContain(field);
    // Review of #2239 R13: the lane wiring was unpinned because no test reached a lane.
    expect(line.lane).toBe('early_indexed');
  });

  test('Stage 0a on: the logged binding is the served partitions plus SG, with the SGD scope', async () => {
    process.env.FIND_PRODUCTS_BUYER_MARKET = 'on';
    await invoke({ search: { query: 'lip gloss', domain: 'beauty', limit: 5, market: 'SG' } });
    expect(logged).toHaveLength(1);
    expect(logged[0].market_bound).toEqual(['US', 'SG']);
    expect(logged[0].market_buyer_currency).toBe('SGD');
    expect(boundInSql()).toContain('SGD');
  });

  test('Stage 0a off: no buyer currency is logged or bound', async () => {
    await invoke({ search: { query: 'lip gloss', domain: 'beauty', limit: 5, market: 'SG' } });
    expect(logged[0].market_buyer_currency).toBeNull();
    expect(boundInSql()).not.toContain('SGD');
  });

  // Review of #2239, probes B, D and E, reproduced: each once logged a market the SQL never bound.
  test.each([
    ['B: flat payload, no search object', { query: 'lip gloss', domain: 'beauty', limit: 5, market: 'SG' }, {},
      { requested: 'SG', source: 'explicit_search', bound: ['SG'] }],
    ['D: whitespace search.market beats metadata, and binds the default', { search: { query: 'lip gloss', domain: 'beauty', limit: 5, market: '   ' } }, { market: 'SG' },
      { requested: '   ', source: 'explicit_search', bound: ['US'] }],
    ['E: search.market false yields to metadata', { search: { query: 'lip gloss', domain: 'beauty', limit: 5, market: false } }, { market: 'SG' },
      { requested: 'SG', source: 'explicit_metadata', bound: ['SG'] }],
  ])('%s', async (_label, payload, metadata, want) => {
    await invoke(payload, metadata);
    expect(logged).toHaveLength(1);
    const line = logged[0];
    expect(line.market_observed).toBe(true);
    expect({ requested: line.market_requested, source: line.market_source, bound: line.market_bound }).toEqual(want);
    // Not the record's word for it: the SQL got this market.
    expect(boundInSql()).toContain(want.bound[0]);
  });

  test('silence is `defaulted`, and binds the deployment served list', async () => {
    await invoke({ search: { query: 'lip gloss', domain: 'beauty', limit: 5 } });
    const { marketsForRequest } = require('../../src/services/servedMarkets');
    expect(logged[0].market_source).toBe('defaulted');
    expect(logged[0].market_requested).toBeNull();
    expect(logged[0].market_bound).toEqual(marketsForRequest(null));
  });

  test('a request the door never binds says so -- it does not guess a binding', async () => {
    // "return policy" is not beauty: handleInvokeRequest answers it before the door binds.
    await invoke({ search: { query: 'return policy', market: 'SG' } });
    expect(logged).toHaveLength(1);
    expect(logged[0].market_observed).toBe(false);
    expect(logged[0].market_bound).toBeNull();
    // The request side is still recorded -- that is the Stage 2 question.
    expect(logged[0].market_requested).toBe('SG');
    expect(logged[0].market_source).toBe('explicit_search');
  });

  test('the fields are operational only: they never appear in the response body', async () => {
    const res = await invoke({ search: { query: 'lip gloss', domain: 'beauty', limit: 5, market: 'SG' } });
    const body = JSON.stringify(res.body);
    for (const field of [...FIELDS, 'lane']) expect(body).not.toContain(`"${field}"`);
  });

  test('a telemetry failure never changes the response', async () => {
    // Measured against the SAME request with telemetry working, not an assumed status.
    const payload = { search: { query: 'lip gloss', domain: 'beauty', limit: 5, market: 'SG' } };
    const baseline = await invoke(payload);
    expect(logged).toHaveLength(1);

    logged.length = 0;
    jest.restoreAllMocks();
    jest.resetModules();
    const app = loadApp();
    const telemetry = require('../../src/services/marketTelemetry');
    jest.spyOn(telemetry, 'buildMarketTelemetry').mockImplementation(() => { throw new Error('boom'); });
    const broken = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'find_products_multi', payload, metadata: { source: 'public_api' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(broken.status).toBe(baseline.status);
    expect(broken.body.products).toEqual(baseline.body.products);
    expect(broken.body.error).toEqual(baseline.body.error);
    expect(logged).toHaveLength(1);
    expect(logged[0].market_telemetry_error).toBe('boom');
    expect(logged[0].market_bound).toBeUndefined();
  });

  test('another operation emits no market fields at all', async () => {
    await request(loadApp()).post('/agent/shop/v1/invoke').send({
      operation: 'get_offers', payload: { product_id: 'x' }, metadata: { source: 'public_api' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged).toHaveLength(1);
    for (const field of [...FIELDS, 'lane']) expect(Object.keys(logged[0])).not.toContain(field);
  });
});
