const request = require('supertest');
const nock = require('nock');

describe('invoke gateway shadow audit', () => {
  const ORIGINAL_ENV = { ...process.env };
  let app;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => {
      const h = String(host || '');
      return h.includes('127.0.0.1') || h.includes('localhost') || h === '::1';
    });
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      API_MODE: 'REAL',
      INVOKE_AUTH_BYPASS_IN_TEST: '1',
      PIVOTA_GATEWAY_GOVERNANCE_SHADOW_MODE: '1',
      PIVOTA_API_BASE: 'http://pivota.test',
      PIVOTA_API_KEY: 'test-key',
    };
    app = require('../src/server');
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    process.env = { ...ORIGINAL_ENV };
  });

  it('attaches shadow governance provenance for blocked MCP traffic without blocking the invoke response', async () => {
    nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Pivota-Invocation-Surface', 'mcp')
      .send({
        operation: 'find_products',
        payload: {
          search: {
            query: 'serum',
          },
        },
        metadata: {
          source: 'shopping_agent',
          merchant_filters: ['merchant_a', 'merchant_b'],
          repeated_merchant_queries: 2,
        },
      });

    expect(res.status).toBe(200);
    expect(res.headers['x-gateway-invocation-surface']).toBe('mcp');
    expect(res.headers['x-gateway-governance-mode']).toBe('shadow');
    expect(res.headers['x-gateway-governance-observed-action']).toBe('block');
    expect(res.headers['x-gateway-governance-effective-action']).toBe('allow');
    expect(res.headers['x-gateway-governance-would-enforce']).toBe('true');
    expect(res.body.metadata.gateway_invocation.surface).toBe('mcp');
    expect(res.body.metadata.gateway_governance.mode).toBe('shadow');
    expect(res.body.metadata.gateway_governance.observed_action).toBe('block');
    expect(res.body.metadata.gateway_governance.would_enforce).toBe(true);
    expect(res.body.metadata.gateway_governance.query_governance.reason_codes).toContain(
      'layer_not_allowed',
    );
  });
});
