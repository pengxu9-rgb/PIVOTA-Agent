// This is the exact search contract emitted by UI sendMessage (9692375782dc).
// A beauty-surface probe rewrites these queries and falsely hides the canonical
// recall defect. The Agent must forward the caller's words and constraints to
// the canonical backend; backend query-plan tests exercise actual recall SQL.
process.env.PIVOTA_API_BASE = 'http://pivota.test';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'REAL';

const request = require('supertest');
const nock = require('nock');
const axios = require('axios');

describe('canonical UI query transport', () => {
  let app;
  let originalAdapter;
  let emittedRequests;
  beforeAll(() => {
    nock.disableNetConnect();
    nock.enableNetConnect((host) => /127\.0\.0\.1|localhost|::1/.test(host));
    jest.doMock('../../src/db', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
    app = require('../../src/server');
    originalAdapter = axios.defaults.adapter;
    // Capture the real serialized Axios request at the transport boundary.
    // No products are canned here: recall is exercised by the backend's SQL
    // integration suite. This test checks routing and constraint propagation.
    axios.defaults.adapter = async (config) => {
      expect(config.url).toBe('http://pivota.test/agent/shop/v1/invoke');
      emittedRequests.push(JSON.parse(config.data));
      return { status: 200, statusText: 'OK', headers: {}, config,
        data: { products: [], total: 0, page: 1, page_size: 0,
          metadata: { query_source: 'pivot_catalog_sig_multi', catalog_entity_mode: 'canonical_sig', unverified_constraints: ['vegan moisturizer'] } } };
    };
  });
  afterEach(() => nock.cleanAll());
  afterAll(() => { axios.defaults.adapter = originalAdapter; nock.enableNetConnect(); jest.dontMock('../../src/db'); });

  test.each([
    ['moisturizer', {}],
    ['moisturizers', {}],
    ['moisturizers. under USD 30', {}],
    ['Find two ceramide moisturizers. under USD 30', {}],
    ['unknown zzqvyst widgets. under EUR 30', {}],
    ['serums', { price_max: 20, currency: 'EUR' }],
  ])('forwards %s through canonical find_products_multi', async (query, constraints) => {
    emittedRequests = [];
    const res = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'find_products_multi',
      payload: { search: {
        in_stock_only: true, query, limit: 12, page: 1,
        catalog_entity_mode: 'canonical_sig', catalog_surface: 'agent_api', commerce_surface: 'agent_api',
        allow_external_seed: false, allow_stale_cache: false, search_all_merchants: true,
        ...constraints,
      }, user: {} },
      metadata: { source: 'shopping_agent', ui_source: 'shopping-agent-ui', catalog_surface: 'agent_api', commerce_surface: 'agent_api' },
    }).expect(200);
    expect(res.body.metadata.unverified_constraints).toEqual(['vegan moisturizer']);
    expect(emittedRequests).toHaveLength(1);
    const emitted = emittedRequests[0];
    expect(emitted.operation).toBe('find_products_multi');
    expect(emitted.payload.search).toMatchObject({
      query, catalog_entity_mode: 'canonical_sig', catalog_surface: 'agent_api', commerce_surface: 'agent_api',
      page: 1, limit: 12, in_stock_only: true,
    });
    if (constraints.price_max) expect(emitted.payload.search.price_max).toBe(constraints.price_max);
    if (constraints.currency) expect(emitted.payload.search.request_context.currency).toBe(constraints.currency);
  });
});
