const request = require('supertest');

describe('invoke gateway shadow audit', () => {
  const ORIGINAL_ENV = { ...process.env };
  let app;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      API_MODE: 'MOCK',
      INVOKE_AUTH_BYPASS_IN_TEST: '1',
      PIVOTA_GATEWAY_GOVERNANCE_SHADOW_MODE: '1',
    };
    app = require('../src/server');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('attaches shadow governance provenance for merchant-sweep MCP traffic without blocking the invoke response', async () => {
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
      'merchant_sweep_blocked',
    );
  });
});
