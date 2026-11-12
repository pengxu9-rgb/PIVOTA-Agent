'use strict';

// PARTNER IDENTITY FOR AN OAUTH CALLER ON THE MCP MONEY OPS (FIX_PLAN O-04; O-04 status review P1-7), end to
// end over the real /mcp door.
//
// With PARTNER_IDENTITY_FORWARDING_ENABLED on, the gateway signs a request-bound (v2) assertion for every
// verified caller it can name: `{kind: 'agent', sub}` for an api-key agent, `{kind: 'oauth', iss, cid}` for an
// MCP OAuth connector. It cannot tell a provisioned confidential client from a public one (that registry lives
// in the backend), so it signs both alike, and the backend decides: a provisioned client is adopted as its
// partner, any other client stays the gateway's, as before O-04 (pivota-backend routes/agent_forwarded_owner.py,
// `absent_oauth_unregistered`). These tests pin the gateway's half:
//   - an OAuth caller's quote, order and hosted link reach the backend signed `{kind: 'oauth', iss, cid}`, each
//     bound to its own path, body and nonce, for a public and a provisioned client alike;
//   - when the backend answers as it does for an unregistered client (the call is the gateway's: a normal 200),
//     the agent gets exactly the answer it gets with the flag off: today's behaviour;
//   - an api-key partner is signed `{kind: 'agent', sub}`, which is what the backend stamps partner_agent_id from;
//   - a 409 PARTNER_ASSERTION_REJECTED is a NON-retriable PARTNER_ASSERTION_REJECTED tool error, sent once, with
//     one warn line naming the backend's reason; never the retriable MERCHANT_UNAVAILABLE.
//
// Real producers from the bearer token to the wire: resolveMcpOAuthIdentity -> req.invokeAuth
// (oauthClientFromClaims) -> INVOKE_AUTH_CONTEXT -> the commerce surface -> the canonical executor and kernel ->
// invokeCommerceKernelRawUpstream -> withBoundIssuingAssertion. Stubbed are only the network edges: the
// authorization server's keys (a local JWKS), api-key introspection and the Python backend (nock).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const ISS = 'https://as.partner-identity-oauth.test';
const RESOURCE = 'https://agent.test.example/mcp';
const BACKEND = 'http://backend.partner-identity-oauth.test';
const INTROSPECT_BASE = 'https://auth.partner-identity-oauth.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const SECRET = 'partner_identity_oauth_test_secret';
const FLAG = 'PARTNER_IDENTITY_FORWARDING_ENABLED';
const PUBLIC_CLIENT = 'mcpc_public_connector';
const PROVISIONED_CLIENT = 'mcpc_partner_a';
const KEY_A = `ak_live_${'c'.repeat(64)}`;
const PARTNER_A = 'agent_partner_a';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.AGENT_CHECKOUT_HOSTED_LINK_ENABLED = '1';
process.env.PIVOTA_API_BASE = BACKEND;
process.env.PIVOTA_API_KEY = 'gateway-service-key';
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.MCP_OAUTH_ENABLED = '1';
process.env.MCP_OAUTH_RESOURCE = RESOURCE;
process.env.MCP_OAUTH_AUTHORIZATION_SERVERS = ISS;
process.env.AGENT_AUTH_INTROSPECT_URL = `${INTROSPECT_BASE}${INTROSPECT_PATH}`;
process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = 'internal_test_key';
process.env.AGENT_AUTH_INTROSPECT_TIMEOUT_MS = '1200';
process.env.INVOKE_AUTH_BYPASS_IN_TEST = '0';
process.env.ISSUING_AGENT_ASSERTION_SECRET = SECRET;
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env.MCP_OAUTH_ISSUERS_JSON;
delete process.env[FLAG];
for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`${prefix}_HEARTBEAT_${suffix}`];
}

const app = require('../src/server');
const logger = require('../src/logger');

test.after(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  process.env = { ...ORIGINAL_ENV };
});

function setFlag(on) {
  if (on) process.env[FLAG] = '1';
  else delete process.env[FLAG];
}

let signingKey = null;
async function tokenFor(clientId, sub) {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  if (!signingKey) {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const pub = await exportJWK(publicKey);
    pub.kid = 'as-1';
    pub.alg = 'RS256';
    process.env.MCP_OAUTH_ISSUERS_JSON = JSON.stringify([{ iss: ISS, jwks: { keys: [pub] }, algs: ['RS256'] }]);
    require('../src/commerceMcpOAuth.js').__resetVerifierCache();
    signingKey = privateKey;
  }
  return new SignJWT({ scope: 'pivota.checkout', token_type: 'access', client_id: clientId })
    .setProtectedHeader({ alg: 'RS256', kid: 'as-1' })
    .setIssuer(ISS).setAudience(RESOURCE).setSubject(sub).setIssuedAt().setExpirationTime('10m')
    .sign(signingKey);
}

function introspect() {
  nock(INTROSPECT_BASE)
    .persist()
    .post(INTROSPECT_PATH, (body) => body && body.api_key === KEY_A)
    .reply(200, { valid: true, agent_id: PARTNER_A, is_active: true, auth_source: 'api_keys' });
}

// The v2 assertion on one captured request, verified against THAT request (path and exact body bytes).
function assertionOf(headers, { path, body }) {
  const token = headers['x-pivota-issuing-agent'];
  if (!token) return null;
  const [version, encoded, mac] = String(token).split('.');
  assert.equal(version, 'v2');
  assert.equal(mac, crypto.createHmac('sha256', SECRET).update(`${version}.${encoded}`).digest('base64url'));
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(payload.p, path, 'bound to the path it was sent to');
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  assert.equal(payload.bh, crypto.createHash('sha256').update(raw, 'utf8').digest('hex'), 'bound to the exact body');
  return payload;
}

const rpc = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

async function call(auth, body) {
  let req = supertest(app).post('/mcp').set('Accept', 'application/json, text/event-stream');
  if (auth.bearer) req = req.set('Authorization', `Bearer ${auth.bearer}`).set('Mcp-Session-Id', auth.session);
  if (auth.key) {
    req = req.set('X-Agent-API-Key', auth.key).set('X-Test-User-Ref', 'usr_key_a').set('X-Test-Acp-Session-Id', 'acp_key_a');
  }
  const res = await req.send(body);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  assert.ok(res.body.result, JSON.stringify(res.body).slice(0, 400));
  return res.body.result;
}

async function ok(auth, body) {
  const result = await call(auth, body);
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 600));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

// The backend's money routes, answering as the backend does for a call that is NOT refused: a 200 whose content
// does not depend on who the owner is (the backend decides ownership; the gateway only relays the answer).
// `refuse` names a path whose next call is answered 409 PARTNER_ASSERTION_REJECTED instead.
function interceptMoney({ refuse } = {}) {
  const calls = [];
  const record = (path) => function reply(uri, body) {
    calls.push({ path, uri, headers: { ...this.req.headers }, body });
    if (refuse === path) {
      return [409, { detail: {
        error: 'PARTNER_ASSERTION_REJECTED', reason: 'stale',
        message: 'The partner assertion on this request was refused; it was not made as any partner.',
      } }];
    }
    if (path === 'quote') {
      return [200, { quote: {
        quote_id: 'q_1', expires_at: '2099-12-31T00:00:00Z', currency: 'USD',
        price_breakdown: { subtotal: '29.00', discount_total: '0.00', total: '29.00', currency: 'USD' },
        shipping_breakdown: { shipping_fee: '0.00', delivery_options: [] }, tax_breakdown: { tax: '0.00' },
        line_items: [{ product_id: 'p_1', variant_id: 'v_1', quantity: 1 }],
      } }];
    }
    if (path === 'order') return [200, { status: 'success', order: { order_id: 'ORD_1', amounts: { total: '29.00', currency: 'USD' } } }];
    return [200, { status: 'success', checkout_session: {
      checkout_session_id: 'cs_1', hosted_url: 'https://checkout.example.com/s/1', state: 'created',
    } }];
  };
  nock(BACKEND).persist()
    .post('/agent/v2/quotes/preview').reply(record('quote'))
    .post('/agent/v2/orders').reply(record('order'))
    .post('/agent/v2/payments/checkout-sessions').reply(record('session'));
  return calls;
}

const QUOTE = {
  merchant_id: 'm_shop_a',
  items: [{ product_id: 'p_1', variant_id: 'v_1', quantity: 1 }],
  customer_email: 'buyer@example.com',
  shipping_address: {
    name: 'Buyer', address_line1: '1 Example St', city: 'Example City', state: 'CA', postal_code: '94105', country: 'US',
  },
};

async function buy(auth, tag) {
  const session = await ok(auth, rpc('create_checkout_session', { idempotency_key: `idem_session_${tag}`, quote: QUOTE }));
  assert.ok(session.session_id, JSON.stringify(session).slice(0, 300));
  const link = await ok(auth, rpc('create_payment_link', {
    idempotency_key: `idem_link_${tag}`, session_id: session.session_id, customer_email: 'buyer@example.com',
  }, 2));
  return { session, link };
}

// The answer an agent sees, minus what is unique per call (the kernel's own session ids and tokens).
function stable(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => (
    /(^|_)(session_id|confirmation_token|expires_at|created_at|request_id)$/.test(key) ? '<per-call>' : v
  )));
}

const signedSteps = (calls) => calls.map((c) => {
  const a = assertionOf(c.headers, { path: c.uri.split('?')[0], body: c.body });
  return [c.path, a && a.v, a && a.kind, a && (a.kind === 'oauth' ? `${a.iss}|${a.cid}` : a.sub), a && a.op, 'sub' in (a || {}),
    c.headers['x-api-key']];
});

for (const [label, clientId] of [['a public connector', PUBLIC_CLIENT], ['a provisioned confidential client', PROVISIONED_CLIENT]]) {
  test(`flag on: ${label}'s quote, order and hosted link are signed {kind: oauth, iss, cid}, each bound to its call`, async () => {
    setFlag(true);
    nock.cleanAll();
    const calls = interceptMoney();
    try {
      await buy({ bearer: await tokenFor(clientId, `buyer-${clientId}`), session: `mcp_${clientId}` }, `on_${clientId}`);
      const subject = `${ISS}|${clientId}`;
      assert.deepEqual(signedSteps(calls), [
        ['quote', 2, 'oauth', subject, 'preview_quote', false, 'gateway-service-key'],
        ['order', 2, 'oauth', subject, 'create_order', false, 'gateway-service-key'],
        ['session', 2, 'oauth', subject, 'create_payment_link', false, 'gateway-service-key'],
      ]);
      const nonces = calls.map((c) => JSON.parse(Buffer.from(c.headers['x-pivota-issuing-agent'].split('.')[1], 'base64url')).jti);
      assert.equal(new Set(nonces).size, 3, 'one nonce per call');
    } finally {
      nock.cleanAll();
      setFlag(false);
    }
  });
}

test('flag on: an unregistered OAuth client the backend leaves as the gateway gets exactly today\'s answers', async () => {
  const bearer = await tokenFor(PUBLIC_CLIENT, 'buyer-today');
  nock.cleanAll();
  let calls = interceptMoney();
  setFlag(false);
  const today = await buy({ bearer, session: 'mcp_today_off' }, 'today_off');
  const offCalls = calls;
  nock.cleanAll();
  calls = interceptMoney();
  setFlag(true);
  try {
    const flagOn = await buy({ bearer, session: 'mcp_today_on' }, 'today_on');
    assert.deepEqual(stable(flagOn), stable(today), 'the agent sees the same answers');
    // Bodies equal but for the per-call request id and the run's own tag in the idempotency key.
    const bodies = (cs, tag) => cs.map((c) => [c.path, stable(JSON.parse(JSON.stringify(c.body).split(tag).join('today_x')))]);
    assert.deepEqual(bodies(calls, 'today_on'), bodies(offCalls, 'today_off'), 'the same calls and bodies');
    assert.ok(offCalls.every((c) => c.headers['x-pivota-issuing-agent'] === undefined), 'flag off: no assertion');
    assert.ok(calls.every((c) => String(c.headers['x-pivota-issuing-agent']).startsWith('v2.')), 'flag on: only the header differs');
  } finally {
    nock.cleanAll();
    setFlag(false);
  }
});

test('flag on: an api-key partner is signed {kind: agent, sub}: the subject the backend stamps partner_agent_id from', async () => {
  setFlag(true);
  nock.cleanAll();
  introspect();
  const calls = interceptMoney();
  try {
    await buy({ key: KEY_A }, 'key_a');
    assert.deepEqual(signedSteps(calls).map((s) => s.slice(0, 5)), [
      ['quote', 2, 'agent', PARTNER_A, 'preview_quote'],
      ['order', 2, 'agent', PARTNER_A, 'create_order'],
      ['session', 2, 'agent', PARTNER_A, 'create_payment_link'],
    ]);
  } finally {
    nock.cleanAll();
    setFlag(false);
  }
});

test('a backend 409 PARTNER_ASSERTION_REJECTED is a non-retriable tool error, sent once and logged', async () => {
  setFlag(true);
  nock.cleanAll();
  const calls = interceptMoney({ refuse: 'order' });
  const warned = [];
  const realWarn = logger.warn;
  logger.warn = function captureWarn(fields, ...rest) {
    if (fields && fields.event === 'partner_assertion_rejected') warned.push(fields);
    return realWarn.call(this, fields, ...rest);
  };
  try {
    const auth = { bearer: await tokenFor(PUBLIC_CLIENT, 'buyer-refused'), session: 'mcp_refused' };
    const session = await ok(auth, rpc('create_checkout_session', { idempotency_key: 'idem_session_refused', quote: QUOTE }));
    const result = await call(auth, rpc('create_payment_link', {
      idempotency_key: 'idem_link_refused', session_id: session.session_id, customer_email: 'buyer@example.com',
    }, 2));
    assert.equal(result.isError, true, JSON.stringify(result).slice(0, 400));
    const { error } = JSON.parse(result.content[0].text);
    assert.equal(error.code, 'PARTNER_ASSERTION_REJECTED');
    assert.equal(error.retriable, false);
    assert.ok(!/try again shortly|temporarily/i.test(error.message), error.message);
    assert.equal(calls.filter((c) => c.path === 'order').length, 1, 'never retried by the gateway');
    assert.equal(calls.filter((c) => c.path === 'session').length, 0, 'nothing after the refused order');
    assert.deepEqual(warned.map((w) => [w.operation, w.upstream_status, w.reason]), [['create_order', 409, 'stale']]);
  } finally {
    logger.warn = realWarn;
    nock.cleanAll();
    setFlag(false);
  }
});
