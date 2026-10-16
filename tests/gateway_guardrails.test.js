describe('gateway guardrails', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('classifyClient derives stable tier/key from the verified identity', () => {
    const { classifyClient } = require('../src/guardrails/gatewayGuardrails');
    const req = {
      headers: { 'x-agent-api-key': 'test-key' },
      invokeAuth: { auth_mode: 'api_key', agent_id: 'agent_1', key_fingerprint: 'fp1' },
    };
    const client = classifyClient({ req });
    expect(client.tier).toBe('api_key');
    expect(client.agent_id).toBe('agent_1');
    expect(client.key.startsWith('api_key:')).toBe(true);
    expect(classifyClient({ req }).key).toBe(client.key);
  });

  test('applyGatewayGuardrails clamps find_products_multi search params', () => {
    process.env.GATEWAY_RATE_LIMIT_ENABLED = 'false';
    const { applyGatewayGuardrails } = require('../src/guardrails/gatewayGuardrails');
    const payload = { search: { query: 'shoes', limit: 999, offset: 9999 } };
    applyGatewayGuardrails({
      req: { headers: {}, ip: '1.1.1.1' },
      operation: 'find_products_multi',
      payload,
      effectivePayload: payload,
      metadata: { source: 'shopping-agent-ui' },
    });
    expect(payload.search.limit).toBe(200);
    expect(payload.search.offset).toBe(500);
  });

  test('applyGatewayGuardrails clamps resolve_product_candidates limit', () => {
    process.env.GATEWAY_RATE_LIMIT_ENABLED = 'false';
    const { applyGatewayGuardrails } = require('../src/guardrails/gatewayGuardrails');
    const payload = { options: { limit: 999 } };
    applyGatewayGuardrails({
      req: { headers: {}, ip: '1.1.1.1' },
      operation: 'resolve_product_candidates',
      payload,
      effectivePayload: payload,
      metadata: { source: 'look-replicator' },
    });
    expect(payload.options.limit).toBe(30);
  });

  test('applyGatewayGuardrails clamps get_pdp_v2 module limits', () => {
    process.env.GATEWAY_RATE_LIMIT_ENABLED = 'false';
    const { applyGatewayGuardrails } = require('../src/guardrails/gatewayGuardrails');
    const payload = { offers: { limit: 999 }, similar: { limit: 999 } };
    applyGatewayGuardrails({
      req: { headers: {}, ip: '1.1.1.1' },
      operation: 'get_pdp_v2',
      payload,
      effectivePayload: payload,
      metadata: { source: 'look-replicator' },
    });
    expect(payload.offers.limit).toBe(30);
    expect(payload.similar.limit).toBe(24);
  });

  test('pdp_live_read has its own wide bucket (one storefront key carries every shopper), env-tunable', () => {
    delete process.env.GATEWAY_RATE_LIMIT_PDP_LIVE_READ_CAPACITY;
    delete process.env.GATEWAY_RATE_LIMIT_PDP_LIVE_READ_REFILL_PER_SEC;
    const { __test__: { operationRateLimit } } = require('../src/guardrails/gatewayGuardrails');
    expect(operationRateLimit('pdp_live_read', { tier: 'api_key' })).toEqual({ capacity: 1200, refill_per_sec: 20 });
    expect(operationRateLimit('get_pdp_v2', { tier: 'api_key' })).toEqual({ capacity: 180, refill_per_sec: 3 });
    process.env.GATEWAY_RATE_LIMIT_PDP_LIVE_READ_CAPACITY = '3000';
    process.env.GATEWAY_RATE_LIMIT_PDP_LIVE_READ_REFILL_PER_SEC = '50';
    expect(operationRateLimit('pdp_live_read', { tier: 'api_key' })).toEqual({ capacity: 3000, refill_per_sec: 50 });
    process.env.GATEWAY_RATE_LIMIT_PDP_LIVE_READ_CAPACITY = '1';
    process.env.GATEWAY_RATE_LIMIT_PDP_LIVE_READ_REFILL_PER_SEC = 'fast';
    expect(operationRateLimit('pdp_live_read', { tier: 'api_key' })).toEqual({ capacity: 10, refill_per_sec: 20 });
    process.env.GATEWAY_RATE_LIMIT_PDP_LIVE_READ_CAPACITY = '';
    expect(operationRateLimit('pdp_live_read', { tier: 'api_key' }).capacity).toBe(1200);
  });

  test('a burst of pdp_live_read under one storefront key passes 1200 calls, then 429s', () => {
    process.env.GATEWAY_RATE_LIMIT_ENABLED = 'true';
    delete process.env.GATEWAY_RATE_LIMIT_PDP_LIVE_READ_CAPACITY;
    delete process.env.GATEWAY_RATE_LIMIT_PDP_LIVE_READ_REFILL_PER_SEC;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    try {
      const { applyGatewayGuardrails } = require('../src/guardrails/gatewayGuardrails');
      const req = {
        headers: { 'x-agent-api-key': 'k' },
        ip: '1.1.1.1',
        invokeAuth: { auth_mode: 'api_key', agent_id: 'storefront', key_fingerprint: 'fp_storefront' },
      };
      const base = { req, operation: 'pdp_live_read', payload: {}, effectivePayload: {} };
      for (let i = 0; i < 1200; i += 1) expect(applyGatewayGuardrails(base).blocked).toBe(null);
      expect(applyGatewayGuardrails(base).blocked?.status).toBe(429);
      // get_pdp_v2 under the same key is a separate bucket.
      expect(applyGatewayGuardrails({ ...base, operation: 'get_pdp_v2' }).blocked).toBe(null);
    } finally {
      jest.useRealTimers();
    }
  });

  test('applyGatewayGuardrails can block on rate limit', () => {
    process.env.GATEWAY_RATE_LIMIT_ENABLED = 'true';
    process.env.GATEWAY_RATE_LIMIT_CAPACITY = '10';
    process.env.GATEWAY_RATE_LIMIT_REFILL_PER_SEC = '0.1';

    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const { applyGatewayGuardrails } = require('../src/guardrails/gatewayGuardrails');
    const req = {
      headers: { 'x-agent-api-key': 'k' },
      ip: '1.1.1.1',
      invokeAuth: { auth_mode: 'api_key', agent_id: 'agent_1', key_fingerprint: 'fp1' },
    };
    const base = {
      req,
      operation: 'unknown_op',
      payload: {},
      effectivePayload: {},
      metadata: { source: 'partner' },
    };

    for (let i = 0; i < 10; i += 1) {
      const attempt = applyGatewayGuardrails(base);
      expect(attempt.blocked).toBe(null);
    }

    const blocked = applyGatewayGuardrails(base);
    expect(blocked.blocked?.status).toBe(429);
    expect(blocked.blocked?.body?.error).toBe('RATE_LIMITED');

    jest.useRealTimers();
  });
});
