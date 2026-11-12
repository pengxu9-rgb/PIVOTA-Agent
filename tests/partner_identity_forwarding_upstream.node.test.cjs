'use strict';

// PARTNER_IDENTITY_FORWARDING_ENABLED (FIX_PLAN O-04) at the kernel upstream: which ops carry the partner's
// request-bound (v2) assertion, what it binds, and which ops never carry one. Driven through the real
// invokeCommerceKernelRawUpstream inside the real INVOKE_AUTH_CONTEXT store, with only the backend and the
// loopback hop intercepted (as tests/issuing_agent_assertion.node.test.cjs does for offers.resolve).
//
// The v2 vectors are shared with pivota-backend tests/test_bound_issuing_assertion.py: a wire-format change
// must change both.

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
  boundIssuingAgentAssertionHeaders,
  signBoundIssuingAgentAssertion,
  partnerIdentityForwardingEnabled,
} = require('../src/attribution/issuingAgentAssertion');

const FLAG = 'PARTNER_IDENTITY_FORWARDING_ENABLED';
const PARTNER = { auth_mode: 'api_key', agent_id: 'agent_partner_a', introspect_auth_source: 'api_keys' };

function decode(token, secret = 'partner_upstream_secret') {
  const [version, body, mac] = String(token).split('.');
  assert.equal(mac, crypto.createHmac('sha256', secret).update(`${version}.${body}`).digest('base64url'), 'MAC');
  return { version, payload: JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) };
}
const sha256 = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

// The upstream request each op makes, the path it reaches and the resource id it must name.
const OPS = {
  preview_quote: { path: '/agent/v2/quotes/preview', rid: null, payload: { quote: { merchant_id: 'm1', items: [{ product_id: 'p1', quantity: 1 }] } } },
  create_order: { path: '/agent/v2/orders', rid: 'q1', payload: { order: { quote_id: 'q1' } } },
  submit_payment: { path: '/agent/v2/payments/checkout-sessions', rid: 'o1', payload: { payment: { order_id: 'o1' } } },
  create_payment_link: { path: '/agent/v2/payments/checkout-sessions', rid: 'o1', payload: { order_id: 'o1' } },
  request_after_sales: { path: '/agent/v2/orders/o1/refunds', rid: 'o1', payload: { status: { order_id: 'o1', reason: 'damaged' } } },
};

// The kernel's order read (MCP get_order): two GETs on the backend's order routes since FIX_PLAN C-11 (the gateway
// half), no longer the invoke route. Kept apart from OPS, which is the signed set.
const READS = {
  get_order_status: { method: 'get', path: '/agent/v2/orders/o1/tracking', payload: { status: { order_id: 'o1' } } },
};

// Every attempt that left the process: headers and the RAW body bytes (nock hands the parsed JSON body to a
// reply function; re-serialising it reproduces the sent string, since the gateway sent JSON.stringify of
// the same object).
async function upstreamAttempts(op, store = PARTNER, { replies = [[200, { status: 'success', products: [] }]] } = {}) {
  const spec = OPS[op] || READS[op] || { path: '/agent/shop/v1/invoke', payload: { search: { query: 'x' } } };
  const attempts = [];
  const queue = [...replies];
  function reply(_uri, body) {
    attempts.push({ headers: { ...this.req.headers }, raw: typeof body === 'string' ? body : JSON.stringify(body) });
    return queue.length > 1 ? queue.shift() : queue[0];
  }
  nock.cleanAll();
  nock(process.env.PIVOTA_API_BASE).persist()[spec.method || 'post'](spec.path).reply(reply);
  nock(process.env.SELF_INVOKE_BASE).persist().post('/agent/shop/v1/invoke').reply(reply);
  try {
    await app._debug.INVOKE_AUTH_CONTEXT.run(store, () => app._debug.invokeCommerceKernelRawUpstream(op, spec.payload));
  } catch (_) {
    // the response mapping is not under test
  }
  nock.cleanAll();
  assert.ok(attempts.length, `${op} must reach ${spec.path}`);
  return attempts;
}
async function upstreamHeaders(op, store) {
  return (await upstreamAttempts(op, store))[0].headers;
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
    for (const [op, spec] of Object.entries(OPS)) {
      const [{ headers, raw }] = await upstreamAttempts(op);
      assert.equal(headers['x-api-key'], 'backend_test_key', `${op}: the upstream key stays the gateway's`);
      const { version, payload } = decode(headers['x-pivota-issuing-agent']);
      assert.equal(version, 'v2', op);
      assert.deepEqual([payload.v, payload.kind, payload.sub, payload.op], [2, 'agent', 'agent_partner_a', op], op);
      assert.equal(payload.m, 'POST', op);
      assert.equal(payload.p, spec.path, `${op}: the path as sent`);
      assert.equal(payload.rid, spec.rid, `${op}: the resource it acts on`);
      assert.equal(payload.bh, sha256(raw), `${op}: the hash of the exact bytes sent`);
      assert.match(payload.jti, /^[A-Za-z0-9_-]{16,128}$/);
      assert.ok(Math.abs(payload.ts - Math.floor(Date.now() / 1000)) <= 5);
    }
  });
});

test('flag on: each request gets its own nonce, and a retry is re-signed over the body it actually sends', async () => {
  await withFlag('1', async () => {
    const a = decode((await upstreamHeaders('create_order'))['x-pivota-issuing-agent']).payload;
    const b = decode((await upstreamHeaders('create_order'))['x-pivota-issuing-agent']).payload;
    assert.notEqual(a.jti, b.jti, 'two requests, two nonces');
    // The create_order fallback: a 422 naming order_request makes the kernel resend the body wrapped.
    const attempts = await upstreamAttempts('create_order', PARTNER, {
      replies: [[422, { detail: [{ loc: ['body', 'order_request'], msg: 'field required' }] }], [200, { status: 'success' }]],
    });
    assert.equal(attempts.length, 2, 'the wrapped retry was sent');
    const [first, second] = attempts.map((t) => ({ raw: t.raw, p: decode(t.headers['x-pivota-issuing-agent']).payload }));
    assert.ok(JSON.parse(second.raw).order_request, 'the second attempt carries the wrapped body');
    assert.notEqual(first.p.jti, second.p.jti, 'a retry never reuses a nonce');
    assert.equal(first.p.bh, sha256(first.raw));
    assert.equal(second.p.bh, sha256(second.raw), 'the retry is hashed over the body it sends');
    assert.equal(second.p.rid, 'q1');
  });
});

test('flag off: no money op carries an assertion (only offers.resolve, as before)', async () => {
  await withFlag(undefined, async () => {
    for (const op of Object.keys(OPS)) {
      assert.equal((await upstreamHeaders(op))['x-pivota-issuing-agent'], undefined, op);
    }
    const offers = decode((await upstreamHeaders('offers.resolve'))['x-pivota-issuing-agent']);
    assert.equal(offers.version, 'v1');
  });
});

test('flag on: offers.resolve stays v1, and get_order_status is not signed (it is not in PARTNER_IDENTITY_OPS)', async () => {
  await withFlag('1', async () => {
    const offers = decode((await upstreamHeaders('offers.resolve'))['x-pivota-issuing-agent']);
    assert.equal(offers.version, 'v1');
    assert.equal(offers.payload.op, 'offers.resolve');
    const read = await upstreamHeaders('get_order_status', PARTNER);
    assert.equal(read['x-pivota-issuing-agent'], undefined);
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
    'create_order', 'create_payment_link', 'external_seed_links.mint', 'preview_quote',
    'request_after_sales', 'submit_payment',
  ]);
  for (const cached of ['find_products', 'find_products_multi']) {
    assert.equal(PARTNER_IDENTITY_OPS.has(cached), false);
    assert.equal(ISSUING_OPS.has(cached), false);
  }
  const env = { [FLAG]: '1', ISSUING_AGENT_ASSERTION_SECRET: 's' };
  const req = { invokeContext: PARTNER, env, method: 'POST', url: 'http://b.test/agent/shop/v1/attribution/external-seed-links', rawBody: '{}' };
  assert.deepEqual(boundIssuingAgentAssertionHeaders({ ...req, op: 'get_product_detail' }), {},
    'an op outside the set is never signed');
  assert.ok(boundIssuingAgentAssertionHeaders({ ...req, op: 'external_seed_links.mint' })['X-Pivota-Issuing-Agent']);
  assert.deepEqual(boundIssuingAgentAssertionHeaders({ ...req, op: 'external_seed_links.mint', env: { ISSUING_AGENT_ASSERTION_SECRET: 's' } }), {});
  // The v1 builder never signs a partner-identity op, flag on or off: v1 binds no request.
  for (const op of PARTNER_IDENTITY_OPS) {
    assert.deepEqual(issuingAgentAssertionHeaders({ op, invokeContext: PARTNER, env }), {}, op);
  }
});

test('the v2 wire format is pinned by the vectors shared with the backend', () => {
  const agent = signBoundIssuingAgentAssertion({
    subject: { kind: 'agent', sub: 'agent_partner_a' }, op: 'create_order', secret: 'vector_secret', nowSec: 1800000000,
    jti: 'jti_vector_0123456789', method: 'POST', path: '/agent/v2/orders', rid: 'q_1', bodyHash: sha256('{"quote_id":"q_1"}'),
  });
  assert.equal(agent, 'v2.eyJ2IjoyLCJraW5kIjoiYWdlbnQiLCJzdWIiOiJhZ2VudF9wYXJ0bmVyX2EiLCJvcCI6ImNyZWF0ZV9vcmRlciIsInRzIjoxODAwMDAw'
    + 'MDAwLCJqdGkiOiJqdGlfdmVjdG9yXzAxMjM0NTY3ODkiLCJtIjoiUE9TVCIsInAiOiIvYWdlbnQvdjIvb3JkZXJzIiwicmlkIjoicV8xIiwi'
    + 'YmgiOiI5MmIxNjc0OTZkNGQyZmFkOTYxMTg4YjgxMWViZTI3YWRlMThhOGM5YjI5Nzg0NjRkYWVhNzY4ZGM5MDU2MmQ5In0'
    + '.4viLFR436_tGxt1TZP5d4OcDZsHTm9zi7qonmkyJmSc');
  const oauth = signBoundIssuingAgentAssertion({
    subject: { kind: 'oauth', iss: 'https://as.example.com', cid: 'mcpc_partner' }, op: 'external_seed_links.mint',
    secret: 'vector_secret', nowSec: 1800000000, jti: 'jti_vector_abcdefghij', method: 'POST',
    path: '/agent/shop/v1/attribution/external-seed-links', rid: null, bodyHash: sha256(''),
  });
  assert.ok(oauth.endsWith('.T_I4KHFyuAThLFBchG9Q5QjNhtvm6QqVyNE9pKmRak4'));
});
