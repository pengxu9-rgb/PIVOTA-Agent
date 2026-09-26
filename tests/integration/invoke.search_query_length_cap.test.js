const nock = require('nock');
const request = require('supertest');

// The invoke route rejects an over-long search query with 400 QUERY_TOO_LONG before any search
// code reads it. Measured 2026-09-26: 30k characters of "1 1 1 ..." held the event loop for 7.8 s
// in buildFindProductsMultiContext alone, and nothing upstream bounded the query. Which text is
// rejected (the query) and which is truncated (history) is pinned in
// tests/search_query_length_cap.node.test.cjs.

describe('search query length cap on the invoke route', () => {
  let priorEnv, dbCalls;

  beforeEach(() => {
    priorEnv = { ...process.env };
    jest.resetModules();
    dbCalls = 0;
    Object.assign(process.env, {
      PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
      GATEWAY_RATE_LIMIT_ENABLED: 'false', AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true', DATABASE_URL: 'postgres://unused.test/db',
    });
    delete process.env.SEARCH_QUERY_MAX_CHARS;
    nock.disableNetConnect();
    nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    jest.doMock('../../src/db', () => ({
      query: async () => {
        dbCalls += 1;
        return { rows: [] };
      },
    }));
  });
  afterEach(() => {
    process.env = priorEnv; jest.dontMock('../../src/db'); jest.restoreAllMocks();
    jest.resetModules(); nock.cleanAll(); nock.enableNetConnect();
  });

  const invoke = (payload) => request(require('../../src/server'))
    .post('/agent/shop/v1/invoke')
    .send({ operation: 'find_products_multi', payload, metadata: { source: 'public_api' } });

  test('a 501-character query is rejected before any search runs', async () => {
    const res = await invoke({ search: { query: 'a'.repeat(501), limit: 5 } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'QUERY_TOO_LONG',
      message: 'The search query is 501 characters; the limit is 500.',
      field: 'search.query',
      max_chars: 500,
      length: 501,
    });
    expect(dbCalls).toBe(0);
  });

  test('a 500-character query is served', async () => {
    const res = await invoke({ search: { query: `lip gloss ${'a'.repeat(490)}`, limit: 5 } });
    expect(res.body.error).not.toBe('QUERY_TOO_LONG');
    expect(res.status).toBe(200);
  });

  test('the 7.8 s shape is rejected in milliseconds, including through messages', async () => {
    require('../../src/server');
    const shape = '1 '.repeat(15000);
    for (const payload of [{ search: { query: shape } }, { messages: [{ role: 'user', content: shape }] }]) {
      const started = Date.now();
      const res = await invoke(payload);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('QUERY_TOO_LONG');
      expect(Date.now() - started).toBeLessThan(1000);
    }
    expect(dbCalls).toBe(0);
  });

  test('one long earlier message does not stop a conversation from searching', async () => {
    // Chat clients re-send their last messages: a pasted ingredient list must not 400 every later search.
    const res = await invoke({
      search: { query: 'moisturizer', limit: 5 },
      messages: [
        { role: 'user', content: `my routine: ${'niacinamide, ceramide, '.repeat(230)}` },
        { role: 'assistant', content: 'Thanks!' },
        { role: 'user', content: 'moisturizer' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });

  test('a long recent query beside a continuation is cut, not searched in full', async () => {
    // understandShoppingQuery promotes a session recent query to the effective query on "previous search";
    // uncut, this request took 9.3 s. Cut to 500 characters it is served promptly.
    const started = Date.now();
    const res = await invoke({
      search: { query: 'previous search' },
      user: { session_recent_queries: ['1 '.repeat(15000)] },
    });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('the GET search route reaches the same check', async () => {
    const res = await request(require('../../src/server'))
      .get('/agent/v1/products/search')
      .query({ query: 'a'.repeat(501) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('QUERY_TOO_LONG');
  });
});
