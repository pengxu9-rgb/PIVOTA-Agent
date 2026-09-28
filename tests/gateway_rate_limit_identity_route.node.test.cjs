'use strict';

// The rate-limit identity rule (tests/gateway_rate_limit_identity.node.test.cjs) wired through the real
// server: the unauthenticated GET /agent/v1/products/search keys on the client IP whatever credential-
// looking headers or source it carries, and the authenticated invoke door keys on the agent that
// introspection verified — two agents behind one egress IP do not share a budget.

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const nock = require('nock');

const INTROSPECT_BASE = 'https://auth.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const BACKEND_BASE = 'https://backend.test';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.GATEWAY_RATE_LIMIT_ENABLED = 'true';
process.env.GATEWAY_RATE_LIMIT_CAPACITY = '10';
process.env.GATEWAY_RATE_LIMIT_REFILL_PER_SEC = '0.1';
delete process.env.GATEWAY_RATE_LIMIT_TRUSTED_PROXY_HOPS;
delete process.env.GATEWAY_RATE_LIMIT_BYPASS_AGENT_IDS;
// Introspection configured => the real API-key path runs instead of the test bypass.
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED = 'false';
process.env.PIVOTA_API_BASE = BACKEND_BASE;
process.env.PIVOTA_API_KEY = 'test-token';

const app = require('../src/server');

const LB_IP = '34.8.67.235';
const KEY_A = `ak_live_${'a'.repeat(64)}`;
const KEY_B = `ak_live_${'b'.repeat(64)}`;

test.before(() => {
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  nock(INTROSPECT_BASE)
    .persist()
    .post(INTROSPECT_PATH, (body) => body?.api_key === KEY_A || body?.api_key === KEY_B)
    .reply(200, (_uri, body) => ({
      valid: true,
      is_active: true,
      auth_source: 'api_keys',
      agent_id: body.api_key === KEY_A ? 'agent_a' : 'agent_b',
    }));
  // Whatever an admitted request forwards upstream answers at once; this file is about the 429s.
  nock(BACKEND_BASE).persist().post(/.*/).reply(200, { status: 'success', order: { order_id: 'ord_1', status: 'paid' } });
  nock(BACKEND_BASE).persist().get(/.*/).reply(200, { status: 'success', products: [], total: 0 });
});

test.after(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

// Sends requests until the first 429 or `max`; returns the number admitted before it (null: never limited).
async function admittedBefore429(max, send) {
  for (let i = 0; i < max; i += 1) {
    const res = await send(i);
    if (res.status === 429) {
      assert.equal(res.body?.error, 'RATE_LIMITED');
      return i;
    }
  }
  return null;
}

test('the public search route keys on the client IP, not on credential-looking headers or source', async () => {
  // find_products_multi: capacity 60, refill 1/s — 150 is far past it for one client.
  const admitted = await admittedBefore429(150, (i) =>
    supertest(app)
      .get('/agent/v1/products/search')
      .query({ query: `serum ${i}`, source: `src-${i}` })
      .set('X-Forwarded-For', `10.0.${i % 250}.1, 203.0.113.50, ${LB_IP}`)
      .set('X-Agent-API-Key', `junk-key-${i}`)
      .set('Authorization', `Bearer junk-${i}`)
      .set('X-Checkout-Token', `junk-token-${i}`),
  );
  assert.notEqual(admitted, null, 'one client rotating headers must still be rate limited');
  assert.ok(admitted >= 60, `the first 60 fit the bucket (admitted ${admitted})`);

  // A different client behind the same load balancer is unaffected.
  const other = await supertest(app)
    .get('/agent/v1/products/search')
    .query({ query: 'serum other' })
    .set('X-Forwarded-For', `203.0.113.51, ${LB_IP}`);
  assert.notEqual(other.status, 429);
});

function invokeAs(key, extraHeaders = {}) {
  let r = supertest(app)
    .post('/agent/shop/v1/invoke')
    .set('X-Forwarded-For', `34.96.52.90, ${LB_IP}`)
    .set('Authorization', `Bearer ${key}`);
  for (const [k, v] of Object.entries(extraHeaders)) r = r.set(k, v);
  return r.send({ operation: 'get_order_status', payload: { status: { order_id: 'ord_1' } } });
}

test('the invoke door keys on the verified agent: two agents behind one IP have separate budgets', async () => {
  // get_order_status uses the base limits: capacity 10.
  const a = await admittedBefore429(30, () => invokeAs(KEY_A));
  assert.equal(a, 10);
  const b = await admittedBefore429(30, (i) => invokeAs(KEY_B, { 'X-Checkout-Token': `junk-token-${i}` }));
  // agent_b gets its own full budget — not the remainder of agent_a's, nor of the shared IP's — and a
  // rotating X-Checkout-Token beside its key does not buy it a fresh bucket past that.
  assert.equal(b, 10);
});
