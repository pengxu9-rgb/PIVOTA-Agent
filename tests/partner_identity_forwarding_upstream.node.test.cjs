'use strict';

// PARTNER_IDENTITY_FORWARDING_ENABLED (FIX_PLAN O-04) at the kernel upstream: which ops carry the partner's
// signed assertion, and which never do. Driven through the real invokeCommerceKernelRawUpstream inside the real
// INVOKE_AUTH_CONTEXT store, with only the backend and the loopback hop intercepted (as
// tests/issuing_agent_assertion.node.test.cjs does for offers.resolve).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.PIVOTA_API_BASE = 'http://backend.partner-upstream.test';
process.env.PIVOTA_API_KEY = 'backend_test_key';
process.env.SELF_INVOKE_BASE = 'http://self.partner-upstream.test';
process.env.ISSUING_AGENT_ASSERTION_SECRET = 'partner_upstream_secret';
delete process.env.PARTNER_IDENTITY_FORWARDING_ENABLED;

const nock = require('nock');
const app = require('../src/server');
const {
  PARTNER_IDENTITY_OPS,
  ISSUING_OPS,
  issuingAgentAssertionHeaders,
  partnerIdentityForwardingEnabled,
} = require('../src/attribution/issuingAgentAssertion');

const FLAG = 'PARTNER_IDENTITY_FORWARDING_ENABLED';
const PARTNER = { auth_mode: 'api_key', agent_id: 'agent_partner_a', introspect_auth_source: 'api_keys' };

function verify(token) {
  const [version, body, mac] = String(token).split('.');
  assert.equal(mac, crypto.createHmac('sha256', 'partner_upstream_secret').update(`${version}.${body}`).digest('base64url'));
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

// The upstream request each op makes, and the headers it carried.
const OPS = {
  preview_quote: { path: '/agent/v2/quotes/preview', payload: { quote: { merchant_id: 'm1', items: [{ product_id: 'p1', quantity: 1 }] } } },
  create_order: { path: '/agent/v2/orders', payload: { order: { quote_id: 'q1' } } },
  submit_payment: { path: '/agent/v2/payments/checkout-sessions', payload: { order_id: 'o1', payment: {} } },
  create_payment_link: { path: '/agent/v2/payments/checkout-sessions', payload: { order_id: 'o1' } },
  request_after_sales: { path: '/agent/v2/orders/o1/refunds', payload: { status: { order_id: 'o1', reason: 'damaged' } } },
  get_order_status: { path: '/agent/shop/v1/invoke', payload: { status: { order_id: 'o1' } } },
};

async function upstreamHeaders(op, store = PARTNER) {
  const { path, payload } = OPS[op] || { path: '/agent/shop/v1/invoke', payload: { search: { query: 'x' } } };
  let headers = null;
  function reply() {
    headers = { ...this.req.headers };
    return [200, { status: 'success', products: [] }];
  }
  nock.cleanAll();
  nock(process.env.PIVOTA_API_BASE).post(path).reply(reply);
  nock(process.env.SELF_INVOKE_BASE).post('/agent/shop/v1/invoke').reply(reply);
  try {
    await app._debug.INVOKE_AUTH_CONTEXT.run(store, () => app._debug.invokeCommerceKernelRawUpstream(op, payload));
  } catch (_) {
    // the response mapping is not under test
  }
  nock.cleanAll();
  assert.ok(headers, `${op} must reach ${path}`);
  return headers;
}

function withFlag(value, fn) {
  const before = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  return Promise.resolve(fn()).finally(() => {
    if (before === undefined) delete process.env[FLAG];
    else process.env[FLAG] = before;
  });
}

test.after(() => nock.cleanAll());

test('the flag is off by default and reads the usual literals', () => {
  assert.equal(partnerIdentityForwardingEnabled({}), false);
  for (const off of ['', '0', 'false', 'off', 'no', 'enabled', 'maybe']) {
    assert.equal(partnerIdentityForwardingEnabled({ [FLAG]: off }), false, off);
  }
  for (const on of ['1', 'true', 'TRUE', ' yes ', 'on']) {
    assert.equal(partnerIdentityForwardingEnabled({ [FLAG]: on }), true, on);
  }
});

test('flag on: every money op leaves the process signed for the partner, bound to that op', async () => {
  await withFlag('1', async () => {
    for (const op of Object.keys(OPS)) {
      const headers = await upstreamHeaders(op);
      assert.equal(headers['x-api-key'], 'backend_test_key', `${op}: the upstream key stays the gateway's`);
      const payload = verify(headers['x-pivota-issuing-agent']);
      assert.deepEqual([payload.kind, payload.sub, payload.op], ['agent', 'agent_partner_a', op], op);
    }
  });
});

test('flag off: no money op carries an assertion (only offers.resolve, as before)', async () => {
  await withFlag(undefined, async () => {
    for (const op of Object.keys(OPS)) {
      assert.equal((await upstreamHeaders(op))['x-pivota-issuing-agent'], undefined, op);
    }
    assert.ok(verify((await upstreamHeaders('offers.resolve'))['x-pivota-issuing-agent']));
  });
});

test('flag on: the cached search lanes still carry no identity; the loopback one is told to defer its mint', async () => {
  await withFlag('1', async () => {
    const multi = await upstreamHeaders('find_products_multi');
    assert.equal(multi['x-pivota-issuing-agent'], undefined);
    assert.equal(multi['x-buyer-ref'], undefined);
    assert.equal(multi['x-pivota-seed-attribution'], 'deferred');
    const scoped = await upstreamHeaders('find_products');
    assert.equal(scoped['x-pivota-issuing-agent'], undefined);
    assert.equal(scoped['x-pivota-seed-attribution'], undefined, 'only the loopback search mints in-process');
  });
  await withFlag(undefined, async () => {
    assert.equal((await upstreamHeaders('find_products_multi'))['x-pivota-seed-attribution'], undefined);
  });
});

test('flag on: a degraded, fallback or service identity is never asserted on a money op', async () => {
  await withFlag('1', async () => {
    for (const store of [
      { ...PARTNER, auth_degraded: true },
      { ...PARTNER, introspect_auth_source: 'emergency_fallback' },
      { auth_mode: 'api_key', agent_id: 'agent_service_fallback' },
      { auth_mode: 'test_bypass' },
      {},
    ]) {
      assert.equal((await upstreamHeaders('create_order', store))['x-pivota-issuing-agent'], undefined, JSON.stringify(store));
    }
  });
});

test('the signed set is the money ops plus the per-response mint, and none of them is a cached read op', () => {
  assert.deepEqual([...PARTNER_IDENTITY_OPS].sort(), [
    'create_order', 'create_payment_link', 'external_seed_links.mint', 'get_order_status', 'preview_quote',
    'request_after_sales', 'submit_payment',
  ]);
  for (const cached of ['find_products', 'find_products_multi']) {
    assert.equal(PARTNER_IDENTITY_OPS.has(cached), false);
    assert.equal(ISSUING_OPS.has(cached), false);
  }
  const env = { [FLAG]: '1', ISSUING_AGENT_ASSERTION_SECRET: 's' };
  assert.deepEqual(issuingAgentAssertionHeaders({ op: 'get_product_detail', invokeContext: PARTNER, env }), {},
    'an op outside both sets is never signed');
  assert.ok(issuingAgentAssertionHeaders({ op: 'external_seed_links.mint', invokeContext: PARTNER, env })['X-Pivota-Issuing-Agent']);
  assert.deepEqual(issuingAgentAssertionHeaders({ op: 'external_seed_links.mint', invokeContext: PARTNER, env: { ISSUING_AGENT_ASSERTION_SECRET: 's' } }), {});
});
