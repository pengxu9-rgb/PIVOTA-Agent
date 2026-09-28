'use strict';

// X-Checkout-Token is verified before it authenticates anything.
//
// WHY THIS FILE EXISTS. Until 2026-09-27 requireExternalInvokeAuth accepted ANY non-empty
// X-Checkout-Token header as authentication, with no check of any kind: `curl -H 'X-Checkout-Token: x'`
// reached every operation behind it — the shop and creator invoke doors, the commerce MCP doors, the
// strict money route, the confirmation action and the photo proxy. Checkout tokens are minted and
// HMAC-signed by pivota-backend; the gateway does not hold that secret, so it now asks the backend's
// internal introspect endpoint (`{checkout_token}`), and a token-only request passes only when:
//   - it asks for a checkout operation on the legacy invoke door — the one place the token itself is
//     forwarded upstream, so the backend enforces it again. Everywhere else (search and catalog reads,
//     the strict/kernel money route, /mcp, /ucp/mcp, /checkout/confirm, photos) a token alone is no
//     credential at all, and is refused without a backend round trip;
//   - the token is well-formed (garbage never costs a backend round trip either),
//   - the backend says it is valid AND that the verdict is about a checkout token,
//   - it has not expired, its agent is active, and it was minted with the "checkout" scope,
// and every failure to get that answer refuses (503), never admits.
// An API key, when sent, stays THE credential and the token beside it is only forwarded context —
// which is exactly how agent.pivota.cc's shop lane sends it (pivota-agent-ui #294).
//
// Every guard above has a test here that fails when the guard is removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };

const INTROSPECT_BASE = 'https://auth.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const BACKEND_BASE = 'https://backend.test';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
// Introspection config present => shouldBypassInvokeAuthForTest() is OFF and the real auth path runs.
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.AGENT_AUTH_INTROSPECT_TIMEOUT_MS = '800';
process.env.AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED = 'false';
process.env.PIVOTA_API_BASE = BACKEND_BASE;
// Set (not deleted — dotenv refills deleted vars) to a value no test key equals.
process.env.PIVOTA_API_KEY = 'test-token';

const app = require('../src/server');
const {
  checkoutTokenVerdictCache,
  putCachedCheckoutTokenVerdict,
  getCachedCheckoutTokenVerdict,
  invokeAuthCache,
  clearInvokeAuthIntrospectCooldown,
} = app._debug;

// Shaped like mint_checkout_token's output: `v1.<payload>.<43-char signature>`. The content is opaque to
// the gateway — only the backend can say whether it is real — so any well-formed string stands in.
const REAL_TOKEN = `v1.${Buffer.from(JSON.stringify({ agent_id: 'agent_ct', exp: 9999999999 })).toString('base64url')}.${'s'.repeat(43)}`;
const FORGED_TOKEN = `v1.${Buffer.from(JSON.stringify({ agent_id: 'agent_ct', exp: 9999999999 })).toString('base64url')}.${'f'.repeat(43)}`;
const GARBAGE_TOKENS = ['x', 'bogus-token', 'v1.abc.def', `v1.abc.${'s'.repeat(42)}`, `v2.abc.${'s'.repeat(43)}`];
const API_KEY = `ak_live_${'a'.repeat(64)}`;

const futureExp = () => Math.floor(Date.now() / 1000) + 600;
const ORDER_STATUS = { method: 'post', path: '/agent/shop/v1/invoke', body: { operation: 'get_order_status', payload: { status: { order_id: 'ord_1' } } } };

// Every route that runs requireExternalInvokeAuth. `body` is what a caller would send; `strict`
// marks doors that only exist while AGENT_CHECKOUT_STRICT=1 (prod runs with it on). `tokenDoor` marks
// the only requests a checkout token can authenticate at all.
const AFFECTED_ROUTES = [
  { method: 'post', path: '/agent/shop/v1/invoke', body: { operation: 'find_products_multi', payload: { search: { query: 'serum' } } } },
  { method: 'post', path: '/agent/shop/v1/invoke', body: { operation: 'get_pdp_v2', payload: { product_ref: { product_id: 'p1' } } } },
  { method: 'post', path: '/agent/shop/v1/invoke', tokenDoor: true, body: { operation: 'get_order_status', payload: { status: { order_id: 'ord_1' } } } },
  { method: 'post', path: '/agent/shop/v1/invoke', tokenDoor: true, body: { operation: 'preview_quote', payload: { quote: { merchant_id: 'm1', items: [{ product_id: 'p1', quantity: 1 }] } } } },
  { method: 'post', path: '/agent/creator/v1/invoke', body: { operation: 'find_products_multi', payload: { search: { query: 'serum' } } } },
  { method: 'post', path: '/agent/creator/v1/invoke', tokenDoor: true, body: { operation: 'create_order', payload: {} } },
  { method: 'post', path: '/agent/shop/v1/invoke', strict: true, body: { operation: 'create_order', payload: {} } },
  { method: 'post', path: '/agent/shop/v1/invoke', strict: true, submitPayment: true, body: { operation: 'submit_payment', payload: {} } },
  { method: 'post', path: '/agent/shop/v1/invoke', strict: true, body: { operation: 'request_after_sales', payload: {} } },
  { method: 'post', path: '/mcp', strict: true, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
  { method: 'post', path: '/ucp/mcp', strict: true, ucp: true, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
  { method: 'post', path: '/checkout/confirm', strict: true, body: { confirmation_token: 'x' } },
  { method: 'post', path: '/photos/presign', body: { content_type: 'image/jpeg' } },
  { method: 'post', path: '/photos/confirm', body: { upload_id: 'u1' } },
  { method: 'get', path: '/photos/qc?upload_id=u1' },
  { method: 'get', path: '/photos/download-url?upload_id=u1' },
  { method: 'post', path: '/photos/download-url', body: { upload_id: 'u1' } },
  { method: 'delete', path: '/photos?upload_id=u1' },
];

function withDoorFlags(route) {
  if (route.strict) process.env.AGENT_CHECKOUT_STRICT = '1';
  else delete process.env.AGENT_CHECKOUT_STRICT;
  if (route.ucp) process.env.AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED = '1';
  else delete process.env.AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED;
  // Prod runs with the charge kill-switch open; closed, submit_payment 405s before auth is even asked.
  if (route.submitPayment) process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED = '1';
  else delete process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED;
}

function send(route, headers = {}) {
  let r = supertest(app)[route.method](route.path);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return route.body ? r.send(route.body) : r;
}

const label = (route) => `${route.method.toUpperCase()} ${route.path}${route.body?.operation ? ` ${route.body.operation}` : ''}`;

// Records every checkout-token dial so a test can assert how many happened (0 for garbage, 1 for a cache miss).
function introspectCheckoutToken(token, reply, { status = 200, times = 1 } = {}) {
  const dials = [];
  const scope = nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => {
      if (body?.checkout_token !== token) return false;
      dials.push(body);
      return true;
    })
    .matchHeader('X-Internal-Key', 'internal_test_key')
    .times(times)
    .reply(status, reply);
  return { scope, dials };
}

const validVerdict = (overrides = {}) => ({
  valid: true,
  agent_id: 'agent_ct',
  is_active: true,
  auth_source: 'checkout_token',
  scopes: ['checkout'],
  merchant_ids: ['merch_a'],
  expires_at: futureExp(),
  ...overrides,
});

const isAuthRefusal = (res) =>
  (res.status === 401 && res.body?.error === 'UNAUTHORIZED') ||
  (res.status === 403 && res.body?.error === 'FORBIDDEN') ||
  (res.status === 503 && res.body?.error === 'AUTH_INTROSPECT_UNAVAILABLE');

test.beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  checkoutTokenVerdictCache.clear();
  invokeAuthCache.clear();
  clearInvokeAuthIntrospectCooldown();
});

test.after(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  process.env = { ...ORIGINAL_ENV };
});

// ---- 1. a bogus token is refused on every affected route --------------------------------------------

for (const route of AFFECTED_ROUTES) {
  test(`garbage X-Checkout-Token is 401 without a backend dial: ${label(route)}`, async () => {
    withDoorFlags(route);
    for (const token of GARBAGE_TOKENS) {
      const res = await send(route, { 'X-Checkout-Token': token });
      assert.equal(res.status, 401, `${token}: ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, 'UNAUTHORIZED');
    }
    // Nothing is mocked and net connect is off: a dial would have been a 503, not a 401.
  });

  test(`a well-formed token the backend rejects is 401: ${label(route)}`, async () => {
    withDoorFlags(route);
    const { dials } = introspectCheckoutToken(FORGED_TOKEN, {
      valid: false,
      auth_source: 'checkout_token_invalid',
    });
    const res = await send(route, { 'X-Checkout-Token': FORGED_TOKEN });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal(res.body.error, 'UNAUTHORIZED');
    // Only a door that accepts checkout tokens even asks; the rest refuse it as no credential.
    assert.equal(dials.length, route.tokenDoor ? 1 : 0);
  });
}

// ---- 2. a real token still works where its scope reaches --------------------------------------------

test('a real checkout token runs get_order_status and is forwarded upstream as the credential', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  const { dials } = introspectCheckoutToken(REAL_TOKEN, validVerdict());
  const seen = [];
  const upstream = nock(BACKEND_BASE)
    .get(/\/agent\/v2\/orders\/ord_1/)
    .reply(function reply() {
      seen.push({ ...this.req.headers });
      return [200, { order_id: 'ord_1', status: 'paid' }];
    });

  const res = await send(
    { method: 'post', path: '/agent/shop/v1/invoke', body: { operation: 'get_order_status', payload: { status: { order_id: 'ord_1' } } } },
    { 'X-Checkout-Token': REAL_TOKEN },
  );

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(dials.length, 1);
  assert.equal(upstream.isDone(), true);
  assert.equal(seen[0]['x-checkout-token'], REAL_TOKEN);
  // The gateway's own service key never stands in for a checkout-token caller on this op.
  assert.notEqual(seen[0]['x-api-key'], 'test-token');
  assert.notEqual(seen[0].authorization, 'Bearer test-token');
});

test('a real token passes the auth door for a checkout op on the creator door', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  const { dials } = introspectCheckoutToken(REAL_TOKEN, validVerdict());
  nock(BACKEND_BASE).post(/.*/).reply(200, { order_id: 'ord_2' });
  const res = await send(
    { method: 'post', path: '/agent/creator/v1/invoke', body: { operation: 'create_order', payload: {} } },
    { 'X-Checkout-Token': REAL_TOKEN },
  );
  assert.equal(isAuthRefusal(res), false, `${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(dials.length, 1);
});

test('a real token is verified once and then served from the verdict cache', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  const { dials } = introspectCheckoutToken(REAL_TOKEN, validVerdict(), { times: 2 });
  nock(BACKEND_BASE).get(/\/agent\/v2\/orders\/ord_1/).times(2).reply(200, { order_id: 'ord_1' });
  const route = { method: 'post', path: '/agent/shop/v1/invoke', body: { operation: 'get_order_status', payload: { status: { order_id: 'ord_1' } } } };

  assert.equal((await send(route, { 'X-Checkout-Token': REAL_TOKEN })).status, 200);
  assert.equal((await send(route, { 'X-Checkout-Token': REAL_TOKEN })).status, 200);
  assert.equal(dials.length, 1);
});

// ---- 3. a real token is still no credential anywhere else ---------------------------------------------

for (const route of AFFECTED_ROUTES.filter((r) => !r.tokenDoor)) {
  test(`a real token alone is 401 and never introspected: ${label(route)}`, async () => {
    withDoorFlags(route);
    const { dials } = introspectCheckoutToken(REAL_TOKEN, validVerdict({ scopes: ['checkout', 'agent_api', 'full'] }));
    const res = await send(route, { 'X-Checkout-Token': REAL_TOKEN });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal(res.body.message, 'Missing or invalid API key');
    assert.equal(dials.length, 0);
  });
}

test('the strict money route never takes a checkout token (its upstream runs on the service key)', async () => {
  process.env.AGENT_CHECKOUT_STRICT = '1';
  const { dials } = introspectCheckoutToken(REAL_TOKEN, validVerdict());
  const res = await send(
    { method: 'post', path: '/agent/shop/v1/invoke', body: { operation: 'preview_quote', payload: {} } },
    { 'X-Checkout-Token': REAL_TOKEN, 'X-Agent-User-JWT': 'eyJ.static.issuer' },
  );
  assert.equal(res.status, 401, JSON.stringify(res.body));
  assert.equal(dials.length, 0);
});

for (const scopes of [null, [], ['agent_api']]) {
  test(`a token not minted for checkout is 403 (scopes=${JSON.stringify(scopes)})`, async () => {
    delete process.env.AGENT_CHECKOUT_STRICT;
    introspectCheckoutToken(REAL_TOKEN, validVerdict({ scopes }));
    const res = await send(ORDER_STATUS, { 'X-Checkout-Token': REAL_TOKEN });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, 'Checkout token not authorized for this operation');
  });
}

// ---- 4. every other way the verdict can say no ------------------------------------------------------------

test('a deactivated agent is 403', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  introspectCheckoutToken(REAL_TOKEN, validVerdict({ is_active: false }));
  const res = await send(ORDER_STATUS, { 'X-Checkout-Token': REAL_TOKEN });
  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'Agent is deactivated');
});

test('an expired token is 401 even when the verdict says valid', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  introspectCheckoutToken(REAL_TOKEN, validVerdict({ expires_at: Math.floor(Date.now() / 1000) - 5 }));
  const res = await send(ORDER_STATUS, { 'X-Checkout-Token': REAL_TOKEN });
  assert.equal(res.status, 401);
});

test('valid:true about something other than a checkout token is not a verdict on this token', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  introspectCheckoutToken(REAL_TOKEN, validVerdict({ auth_source: 'api_keys' }));
  const res = await send(ORDER_STATUS, { 'X-Checkout-Token': REAL_TOKEN });
  assert.equal(res.status, 401);
});

test('valid:true with no agent_id is refused', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  introspectCheckoutToken(REAL_TOKEN, validVerdict({ agent_id: null }));
  const res = await send(ORDER_STATUS, { 'X-Checkout-Token': REAL_TOKEN });
  assert.equal(res.status, 401);
});

// ---- 5. fail closed ---------------------------------------------------------------------------------------

for (const [name, status, reply] of [
  ['a backend 5xx', 503, { detail: 'busy' }],
  ['a backend too old to know checkout_token (422)', 422, { detail: [{ loc: ['body', 'api_key'] }] }],
  ['a backend that refuses our internal key (403)', 403, { detail: { error: 'FORBIDDEN' } }],
  ['a soft error result', 200, { valid: false, auth_source: 'error' }],
]) {
  test(`${name} refuses the request (503), it never admits it`, async () => {
    delete process.env.AGENT_CHECKOUT_STRICT;
    introspectCheckoutToken(REAL_TOKEN, reply, { status });
    const res = await send(ORDER_STATUS, { 'X-Checkout-Token': REAL_TOKEN });
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.error, 'AUTH_INTROSPECT_UNAVAILABLE');
  });
}

test('an introspection timeout refuses the request', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  nock(INTROSPECT_BASE).post(INTROSPECT_PATH).delay(2_000).reply(200, validVerdict());
  const res = await send(ORDER_STATUS, { 'X-Checkout-Token': REAL_TOKEN });
  assert.equal(res.status, 503);
});

test('a negative verdict is cached briefly so a replayed forgery does not re-dial', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  const { dials } = introspectCheckoutToken(FORGED_TOKEN, { valid: false, auth_source: 'checkout_token_invalid' }, { times: 2 });
  assert.equal((await send(ORDER_STATUS, { 'X-Checkout-Token': FORGED_TOKEN })).status, 401);
  assert.equal((await send(ORDER_STATUS, { 'X-Checkout-Token': FORGED_TOKEN })).status, 401);
  assert.equal(dials.length, 1);
});

test('a positive verdict is never cached past the token expiry', () => {
  const now = 1_000_000;
  putCachedCheckoutTokenVerdict('k', { valid: true, expires_at_ms: now + 5_000 }, now);
  assert.ok(getCachedCheckoutTokenVerdict('k', now + 4_999));
  assert.equal(getCachedCheckoutTokenVerdict('k', now + 5_000), null);
  putCachedCheckoutTokenVerdict('dead', { valid: true, expires_at_ms: now - 1 }, now);
  assert.equal(getCachedCheckoutTokenVerdict('dead', now), null);
});

// ---- 6. an API key stays the credential; the token beside it is context -----------------------------------

test('API key + a bogus token authenticates by the key and never asks about the token', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  const keyDials = [];
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => {
      keyDials.push(body);
      return body?.api_key === API_KEY && body?.checkout_token === undefined;
    })
    .reply(200, { valid: true, agent_id: 'agent_ui', is_active: true, auth_source: 'api_keys' });
  nock(BACKEND_BASE).get(/\/agent\/v2\/orders\/ord_1/).reply(200, { order_id: 'ord_1' });

  const res = await send(ORDER_STATUS, { 'X-Checkout-Token': 'bogus-token', Authorization: `Bearer ${API_KEY}` });

  assert.equal(isAuthRefusal(res), false, `${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(keyDials.length, 1);
  assert.equal(keyDials[0].api_key, API_KEY);
});

test('API key + token still refuses an invalid key (the token cannot rescue it)', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => body?.api_key === API_KEY)
    .reply(200, { valid: false, auth_source: 'not_found' });
  const res = await send(AFFECTED_ROUTES[0], { 'X-Checkout-Token': REAL_TOKEN, 'X-Agent-API-Key': API_KEY });
  assert.equal(res.status, 401);
  assert.equal(res.body.message, 'Missing or invalid API key');
});
