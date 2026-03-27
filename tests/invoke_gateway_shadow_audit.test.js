const nock = require('nock');
const request = require('supertest');

describe('invoke gateway shadow audit', () => {
  const ORIGINAL_ENV = { ...process.env };
  const INTROSPECT_BASE = 'https://auth.test';
  const INTROSPECT_PATH = '/agent/internal/auth/introspect';
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
    nock.cleanAll();
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

  it('surfaces emergency fallback usage in gateway invocation metadata instead of masking it as normal auth', async () => {
    jest.resetModules();
    nock.cleanAll();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      API_MODE: 'MOCK',
      INVOKE_AUTH_BYPASS_IN_TEST: '0',
      PIVOTA_GATEWAY_GOVERNANCE_SHADOW_MODE: '1',
      AGENT_AUTH_INTROSPECT_URL: `${INTROSPECT_BASE}${INTROSPECT_PATH}`,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'internal_test_key',
      AGENT_AUTH_INTROSPECT_TIMEOUT_MS: '1200',
      AGENT_AUTH_CACHE_POSITIVE_TTL_MS: '60000',
      AGENT_AUTH_CACHE_NEGATIVE_TTL_MS: '3000',
      AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED: 'true',
      AGENT_AUTH_EMERGENCY_API_KEY: `ak_live_${'d'.repeat(64)}`,
      AGENT_AUTH_EMERGENCY_AGENT_ID: 'agent_staging_fallback',
    };
    app = require('../src/server');

    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(503, { error: 'UPSTREAM_DOWN' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'d'.repeat(64)}`)
      .send({
        operation: 'find_products',
        payload: {
          search: {
            query: 'serum',
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(res.status).toBe(200);
    expect(res.headers['x-invoke-auth-degraded']).toBe('true');
    expect(res.body.metadata.gateway_invocation.auth_degraded).toBe(true);
    expect(res.body.metadata.gateway_invocation.auth_degraded_reason).toBe(
      'AUTH_INTROSPECT_UNAVAILABLE',
    );
    expect(res.body.metadata.gateway_invocation.introspect_auth_source).toBe(
      'emergency_fallback',
    );
  });
});
