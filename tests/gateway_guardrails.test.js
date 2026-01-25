describe('gateway guardrails', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('classifyClient derives stable tier/key', () => {
    const { classifyClient } = require('../src/guardrails/gatewayGuardrails');
    const client = classifyClient({
      headers: { 'x-agent-api-key': 'test-key' },
      metadata: { source: 'look-replicator' },
      ip: '127.0.0.1',
    });
    expect(client.source).toBe('look-replicator');
    expect(client.tier).toBe('api_key');
    expect(client.key.startsWith('api_key:')).toBe(true);
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
    expect(payload.search.limit).toBe(50);
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

  test('applyGatewayGuardrails can block on rate limit', () => {
    process.env.GATEWAY_RATE_LIMIT_ENABLED = 'true';
    process.env.GATEWAY_RATE_LIMIT_CAPACITY = '10';
    process.env.GATEWAY_RATE_LIMIT_REFILL_PER_SEC = '0.1';

    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const { applyGatewayGuardrails } = require('../src/guardrails/gatewayGuardrails');
    const req = { headers: { 'x-agent-api-key': 'k' }, ip: '1.1.1.1' };
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
