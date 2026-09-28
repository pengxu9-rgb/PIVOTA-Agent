const nock = require('nock');
const request = require('supertest');

// After context build there is ONE beauty direct call (lane creator_direct). A second one
// (mainline_direct) used to sit before the creator lanes; it answered 2 of 3,791 requests in the
// 30 days to 2026-09-25, and every request it took now reaches the remaining call.
//
// The case that proves it: a pivot beauty contract request that the early lane cannot see (its
// query arrives only in `messages`, so search.query is empty before context build) and that
// asks for product_only. The remaining call used to refuse product_only; only the removed one
// took it. So this request must still be answered by the beauty direct recall.

describe('one beauty direct call after context build', () => {
  let priorEnv, logged;

  beforeEach(() => {
    priorEnv = { ...process.env };
    jest.resetModules();
    logged = [];
    Object.assign(process.env, {
      PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
      GATEWAY_RATE_LIMIT_ENABLED: 'false', AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true', DATABASE_URL: 'postgres://unused.test/db',
    });
    nock.disableNetConnect();
    nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    jest.doMock('../../src/db', () => ({ query: async () => ({ rows: [] }) }));
  });
  afterEach(() => {
    process.env = priorEnv; jest.dontMock('../../src/db'); jest.restoreAllMocks();
    jest.resetModules(); nock.cleanAll(); nock.enableNetConnect();
  });

  const invoke = async (payload) => {
    const app = require('../../src/server');
    const logger = require('../../src/logger');
    const realInfo = logger.info.bind(logger);
    jest.spyOn(logger, 'info').mockImplementation((obj, msg, ...rest) => {
      if (msg === 'invoke request complete') { logged.push(obj); return undefined; }
      return realInfo(obj, msg, ...rest);
    });
    const res = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'find_products_multi', payload, metadata: { source: 'public_api' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    return res;
  };

  const beautyDirectLanes = () => (logged[0]?.fpm_stage_breakdown || [])
    .filter((stage) => stage.stage === 'beauty_direct_recall')
    .map((stage) => stage.lane);

  test('a product_only pivot beauty request the early lane skips is still answered by beauty direct', async () => {
    await invoke({
      search: { domain: 'beauty', product_only: true, limit: 5 },
      messages: [{ role: 'user', content: 'lip gloss' }],
    });
    expect(logged).toHaveLength(1);
    expect(beautyDirectLanes()).toEqual(['creator_direct']);
  });

  test('the same request with its query in search is answered by the early lane, once', async () => {
    await invoke({ search: { query: 'lip gloss', domain: 'beauty', product_only: true, limit: 5 } });
    expect(beautyDirectLanes()).toEqual(['early_indexed']);
  });
});
