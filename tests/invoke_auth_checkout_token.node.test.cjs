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

// ---- 7. after-sales runs on the caller's own agent key, never on the token beside it ----------------------
//
// pivota-backend (be#2760) lets a checkout token reach only the seven routes the hosted checkout page calls.
// /agent/v1/orders/{id}/cancel and /agent/v2/orders/{id}/refunds are not among them, so forwarding the token
// there (it used to win over the caller's key) is a 403 for every caller that sends both. The caller's key
// goes instead, and the backend's agent-ownership check on that key decides. The gateway's own service key
// never stands in: it would make every order this gateway created cancellable by any key holder.

function introspectApiKey(agentId = 'agent_ui') {
  nock(INTROSPECT_BASE)
    .post(INTROSPECT_PATH, (body) => body?.api_key === API_KEY && body?.checkout_token === undefined)
    .reply(200, { valid: true, agent_id: agentId, is_active: true, auth_source: 'api_keys' });
}

const AFTER_SALES = [
  { action: 'cancel', path: '/agent/v1/orders/ord_1/cancel' },
  { action: 'refund', path: '/agent/v2/orders/ord_1/refunds' },
];

for (const { action, path } of AFTER_SALES) {
  test(`API key + token: request_after_sales ${action} goes upstream on the caller's key, without the token`, async () => {
    delete process.env.AGENT_CHECKOUT_STRICT;
    introspectApiKey();
    const seen = [];
    const upstream = nock(BACKEND_BASE)
      .post(path)
      .reply(function reply() {
        seen.push({ ...this.req.headers });
        return [200, { status: 'success', order_id: 'ord_1' }];
      });

    const res = await send(
      {
        method: 'post',
        path: '/agent/shop/v1/invoke',
        body: { operation: 'request_after_sales', payload: { status: { order_id: 'ord_1', requested_action: action } } },
      },
      { 'X-Checkout-Token': REAL_TOKEN, Authorization: `Bearer ${API_KEY}` },
    );

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(upstream.isDone(), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]['x-checkout-token'], undefined);
    assert.equal(seen[0]['x-api-key'], API_KEY);
    assert.equal(seen[0].authorization, `Bearer ${API_KEY}`);
  });
}

test('the token stays forwarded on the checkout ops beside a key (only after-sales drops it)', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  introspectApiKey();
  const seen = [];
  nock(BACKEND_BASE)
    .post('/agent/v1/orders/ord_1/confirm-payment')
    .reply(function reply() {
      seen.push({ ...this.req.headers });
      return [200, { order_id: 'ord_1', status: 'paid' }];
    });
  const res = await send(
    { method: 'post', path: '/agent/shop/v1/invoke', body: { operation: 'confirm_payment', payload: { order_id: 'ord_1' } } },
    { 'X-Checkout-Token': REAL_TOKEN, Authorization: `Bearer ${API_KEY}` },
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(seen[0]['x-checkout-token'], REAL_TOKEN);
});

test('a checkout token alone cannot request a cancel: 401 at the door, no introspect, no backend call', async () => {
  delete process.env.AGENT_CHECKOUT_STRICT;
  const { dials } = introspectCheckoutToken(REAL_TOKEN, validVerdict());
  const upstream = nock(BACKEND_BASE).post(/.*/).reply(200, {});
  const res = await send(
    {
      method: 'post',
      path: '/agent/shop/v1/invoke',
      body: { operation: 'request_after_sales', payload: { status: { order_id: 'ord_1', requested_action: 'cancel' } } },
    },
    { 'X-Checkout-Token': REAL_TOKEN },
  );
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'UNAUTHORIZED');
  assert.equal(dials.length, 0);
  assert.equal(upstream.isDone(), false);
});

// ---- 8. which credential reaches which backend route, for every token-carrying operation -------------------
//
// The tests above mock the backend, so they could not see that a token forwarded to /agent/v2/... was going
// to be a 403 there. This section pins the contract on both sides: pivota-backend's checkout-token allowlist
// (routes/agent_auth.py CHECKOUT_TOKEN_ROUTES, be#2760) is mirrored below, every backend call a token-lane
// operation makes with a token must land on one of those routes, and every other operation from a caller with
// its own key goes upstream on that key with no token at all.

const BACKEND_CHECKOUT_TOKEN_ROUTES = [
  ['POST', /^\/agent\/v1\/quotes\/preview$/],
  ['POST', /^\/agent\/v1\/orders\/create$/],
  ['POST', /^\/agent\/v1\/orders\/payment-offer-evidence$/],
  ['POST', /^\/agent\/v1\/payments$/],
  ['POST', /^\/agent\/v1\/orders\/[^/]+\/confirm-payment$/],
  ['GET', /^\/agent\/v1\/orders\/[^/]+\/track$/],
  ['GET', /^\/agent\/v1\/checkout\/prefill$/],
  ['POST', /^\/agent\/v2\/quotes\/preview$/],
  ['POST', /^\/agent\/v2\/orders$/],
  ['POST', /^\/agent\/v2\/payments\/checkout-sessions$/],
  ['GET', /^\/agent\/v2\/orders\/[^/]+\/tracking$/],
];
const tokenMayCall = (method, path) =>
  BACKEND_CHECKOUT_TOKEN_ROUTES.some(([m, re]) => m === method && re.test(path.split('?')[0]));

// Records every call to the backend (not the introspect host) with the credential it carried.
function recordBackendCalls() {
  const calls = [];
  const reply = function reply(uri, body) {
    calls.push({ method: this.req.method, path: uri, headers: { ...this.req.headers } });
    return [200, upstreamReplyFor(this.req.method, uri, body)];
  };
  const scope = nock(BACKEND_BASE).persist();
  scope.get(/.*/).reply(reply);
  scope.post(/.*/).reply(reply);
  return calls;
}

function upstreamReplyFor(method, uri) {
  if (/quotes\/preview/.test(uri)) {
    return { status: 'success', quote: { quote_id: 'q_1', merchant_id: 'merch_a', currency: 'USD', price_breakdown: { total: '10.00', currency: 'USD' } }, quote_id: 'q_1', pricing: { total: 10 } };
  }
  if (/\/orders$/.test(uri) || /orders\/create/.test(uri)) return { status: 'success', order: { order_id: 'ord_1' }, order_id: 'ord_1' };
  if (/checkout-sessions/.test(uri)) return { status: 'success', checkout_session: { checkout_session_id: 'ci_1', hosted_url: 'https://pay.test/x' } };
  if (/tracking|track/.test(uri)) return { status: 'success', tracking: {}, order_id: 'ord_1' };
  if (/confirm-payment/.test(uri)) return { status: 'success', order_id: 'ord_1', payment_status: 'paid' };
  return { status: 'success', products: [], order_id: 'ord_1' };
}

const TOKEN_LANE_REQUESTS = {
  preview_quote: { quote: { merchant_id: 'merch_a', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }] } },
  create_order: {
    order: {
      merchant_id: 'merch_a',
      quote_id: 'q_1',
      customer_email: 'buyer@example.com',
      items: [{ merchant_id: 'merch_a', product_id: 'p1', variant_id: 'v1', quantity: 1, unit_price: 10, subtotal: 10 }],
      shipping_address: { name: 'B', address_line1: '1 Main', city: 'SF', country: 'US', postal_code: '94105' },
    },
  },
  submit_payment: { payment: { order_id: 'ord_1', quote_id: 'q_1', expected_amount: 10, currency: 'USD' } },
  confirm_payment: { order_id: 'ord_1' },
  get_order_status: { status: { order_id: 'ord_1' } },
};

test('the token lane in this file is exactly the gateway token lane', () => {
  assert.deepEqual(Object.keys(TOKEN_LANE_REQUESTS).sort(), [...app._debug.CHECKOUT_TOKEN_INVOKE_OPERATIONS].sort());
});

// submit_payment has two upstream shapes: the existing-order PSP surface (/agent/v1/payments, above) and,
// with a payment handler, a hosted checkout session (/agent/v2/payments/checkout-sessions).
const TOKEN_LANE_CASES = [
  ...Object.entries(TOKEN_LANE_REQUESTS),
  ['submit_payment', { payment: { order_id: 'ord_1', quote_id: 'q_1', expected_amount: 10, currency: 'USD', payment_handler_id: 'ph_hosted' } }],
];

for (const [operation, payload] of TOKEN_LANE_CASES) {
  for (const withKey of [false, true]) {
    test(`${operation}${payload?.payment?.payment_handler_id ? ' via a payment handler' : ''} (${withKey ? 'key + token' : 'token only'}): the token goes upstream, only to a route the backend lets a token call`, async () => {
      delete process.env.AGENT_CHECKOUT_STRICT;
      if (withKey) introspectApiKey();
      else introspectCheckoutToken(REAL_TOKEN, validVerdict());
      const calls = recordBackendCalls();

      const res = await send(
        { method: 'post', path: '/agent/shop/v1/invoke', body: { operation, payload } },
        withKey ? { 'X-Checkout-Token': REAL_TOKEN, Authorization: `Bearer ${API_KEY}` } : { 'X-Checkout-Token': REAL_TOKEN },
      );

      assert.equal(isAuthRefusal(res), false, `${res.status} ${JSON.stringify(res.body)}`);
      assert.ok(calls.length > 0, `${operation}: no backend call (${res.status} ${JSON.stringify(res.body)})`);
      for (const call of calls) {
        assert.equal(call.headers['x-checkout-token'], REAL_TOKEN, `${call.method} ${call.path}`);
        assert.ok(tokenMayCall(call.method, call.path), `token sent to ${call.method} ${call.path}, which the backend refuses`);
        // The token is the credential: no key beside it, the gateway's own least of all.
        assert.equal(call.headers['x-api-key'], undefined, `${call.method} ${call.path}`);
      }
    });
  }
}

const KEY_LANE_REQUESTS = {
  find_products_multi: { search: { query: 'hiking boots' } },
  find_products: { search: { query: 'serum', merchant_id: 'merch_a' } },
  get_product_detail: { product: { merchant_id: 'merch_a', product_id: 'p1' } },
  request_after_sales: { status: { order_id: 'ord_1', requested_action: 'cancel' } },
};

for (const [operation, payload] of Object.entries(KEY_LANE_REQUESTS)) {
  test(`${operation} (key + token): every backend call carries the caller's key and no token`, async () => {
    delete process.env.AGENT_CHECKOUT_STRICT;
    introspectApiKey();
    const calls = recordBackendCalls();

    const res = await send(
      { method: 'post', path: '/agent/shop/v1/invoke', body: { operation, payload } },
      { 'X-Checkout-Token': REAL_TOKEN, Authorization: `Bearer ${API_KEY}` },
    );

    assert.equal(isAuthRefusal(res), false, `${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(calls.length > 0, `${operation}: no backend call (${res.status} ${JSON.stringify(res.body)})`);
    for (const call of calls) {
      assert.equal(call.headers['x-checkout-token'], undefined, `token sent to ${call.method} ${call.path}`);
      assert.equal(call.headers['x-api-key'], API_KEY, `${call.method} ${call.path}`);
    }
  });
}

// The rule itself, on the one builder every backend hop shares: which credential for each caller shape.
test('buildInvokeUpstreamAuthHeaders: the token goes up only on the token lane or when it is the only credential', () => {
  const { buildInvokeUpstreamAuthHeaders, INVOKE_AUTH_CONTEXT } = app._debug;
  const withCaller = (store, fn) => INVOKE_AUTH_CONTEXT.run(store, fn);
  const keyCaller = { api_key: API_KEY, auth_mode: 'api_key' };
  const tokenCaller = { api_key: null, auth_mode: 'checkout_token' };

  for (const operation of app._debug.CHECKOUT_TOKEN_INVOKE_OPERATIONS) {
    for (const caller of [keyCaller, tokenCaller]) {
      const h = withCaller(caller, () => buildInvokeUpstreamAuthHeaders({ checkoutToken: REAL_TOKEN, operation }));
      assert.equal(h['X-Checkout-Token'], REAL_TOKEN, `${operation} ${caller.auth_mode}`);
      assert.equal(h['X-API-Key'], undefined, `${operation} ${caller.auth_mode}`);
    }
  }
  for (const operation of ['find_products_multi', 'get_product_detail', 'request_after_sales', null]) {
    const keyed = withCaller(keyCaller, () => buildInvokeUpstreamAuthHeaders({ checkoutToken: REAL_TOKEN, operation }));
    assert.equal(keyed['X-Checkout-Token'], undefined, `${operation} with a key`);
    assert.equal(keyed['X-API-Key'], API_KEY, `${operation} with a key`);
    assert.equal(keyed.Authorization, `Bearer ${API_KEY}`, `${operation} with a key`);
    // A token-only caller has nothing else: it keeps sending the token (today's behaviour).
    const tokenOnly = withCaller(tokenCaller, () => buildInvokeUpstreamAuthHeaders({ checkoutToken: REAL_TOKEN, operation }));
    assert.equal(tokenOnly['X-Checkout-Token'], REAL_TOKEN, `${operation} token only`);
    assert.equal(tokenOnly['X-API-Key'], undefined, `${operation} token only`);
  }
  // No token: unchanged, the caller's key.
  const plain = withCaller(keyCaller, () => buildInvokeUpstreamAuthHeaders({ operation: 'preview_quote' }));
  assert.equal(plain['X-API-Key'], API_KEY);
  assert.equal(plain['X-Checkout-Token'], undefined);
});

// create_order re-quotes once on QUOTE_EXPIRED; that hop is part of the token lane and keeps the token.
for (const withKey of [false, true]) {
  test(`create_order re-quote (${withKey ? 'key + token' : 'token only'}) carries the token to /agent/v2/quotes/preview`, async () => {
    delete process.env.AGENT_CHECKOUT_STRICT;
    if (withKey) introspectApiKey();
    else introspectCheckoutToken(REAL_TOKEN, validVerdict());
    const calls = [];
    const record = function record(uri) {
      calls.push({ method: this.req.method, path: uri, headers: { ...this.req.headers } });
    };
    nock(BACKEND_BASE)
      .post('/agent/v2/orders')
      .reply(function reply(uri) {
        record.call(this, uri);
        return [409, { status: 'error', error: { code: 'QUOTE_EXPIRED', message: 'expired' } }];
      })
      .post('/agent/v2/quotes/preview')
      .reply(function reply(uri, body) {
        record.call(this, uri);
        return [200, upstreamReplyFor('POST', uri, body)];
      })
      .post('/agent/v2/orders')
      .reply(function reply(uri, body) {
        record.call(this, uri);
        return [200, upstreamReplyFor('POST', uri, body)];
      });

    await send(
      { method: 'post', path: '/agent/shop/v1/invoke', body: { operation: 'create_order', payload: TOKEN_LANE_REQUESTS.create_order } },
      withKey ? { 'X-Checkout-Token': REAL_TOKEN, Authorization: `Bearer ${API_KEY}` } : { 'X-Checkout-Token': REAL_TOKEN },
    );

    const requote = calls.find((c) => c.path === '/agent/v2/quotes/preview');
    assert.ok(requote, `no re-quote; calls: ${calls.map((c) => c.path).join(', ')}`);
    assert.equal(requote.headers['x-checkout-token'], REAL_TOKEN);
    assert.equal(requote.headers['x-api-key'], undefined);
  });
}
