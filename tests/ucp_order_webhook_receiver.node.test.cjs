'use strict';

// UCP business-endpoint port tests (retired ucp-web-production + ucp-platform-receiver services):
//   1. /.well-known/ucp is DECOUPLED from AGENT_CHECKOUT_STRICT (discovery flag alone gates it) and
//      publishes signing_keys from UCP_BUSINESS_SIGNING_PUBLIC_JWK (private material refused).
//   2. POST /ucp/order-webhook verifies the retired signer's detached ES256 JWS over the EXACT raw
//      body bytes, dedups by body sha256 into a metadata-only ring buffer, and GET /events serves it.
// Pure-handler tests use injected env/fetch (model: tests/ucpWarmHandoffInternalRoute.test.js);
// route tests run supertest against the exported app with env set BEFORE require('../src/server')
// (model: tests/public_read_mcp_route.node.test.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const supertest = require('supertest');

// ---- test keypair + detached-JWS signer (mirrors the retired Python signer exactly) -----------------

const { publicKey: PUB_KEY, privateKey: PRIV_KEY } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PUBLIC_JWK = { ...PUB_KEY.export({ format: 'jwk' }), kid: 'test-1', use: 'sig' };
const { publicKey: OTHER_PUB, privateKey: OTHER_PRIV } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Protected header serialized with SORTED keys (the retired signer used json.dumps(sort_keys=True)),
// signing input = protected_b64 + '.' + raw body bytes, raw r||s (64-byte) signature, empty payload segment.
function signDetached(body, { kid = 'test-1', privateKey = PRIV_KEY, header } = {}) {
  const h = header || { alg: 'ES256', b64: false, crit: ['b64'], kid, typ: 'JWT' };
  const sorted = {};
  for (const k of Object.keys(h).sort()) sorted[k] = h[k];
  const protectedB64 = b64url(JSON.stringify(sorted));
  const signingInput = Buffer.concat([Buffer.from(`${protectedB64}.`, 'utf8'), Buffer.from(body, 'utf8')]);
  const sig = crypto.sign('sha256', signingInput, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${protectedB64}..${b64url(sig)}`;
}

const profileFetch = (signingKeys, { flat = false, ok = true } = {}) => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (!ok) return { ok: false, status: 503, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => (flat ? { signing_keys: signingKeys } : { ucp: { signing_keys: signingKeys } }),
    };
  };
  impl.calls = calls;
  return impl;
};

// ---- app boot (env BEFORE require) ------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
// Decoupling under test: the profile must serve with the checkout kill-switch OFF.
delete process.env.AGENT_CHECKOUT_STRICT;
process.env.AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED = '1';
process.env.UCP_BASE_URL = 'https://ucp.test.local';
process.env.UCP_BUSINESS_SIGNING_PUBLIC_JWK = JSON.stringify(PUBLIC_JWK);
process.env.UCP_ORDER_WEBHOOK_RECEIVER_ENABLED = '1';
delete process.env.UCP_VERIFY_ORDER_WEBHOOK;

const app = require('../src/server');

const { createUcpOrderWebhookReceiver, verifyDetachedJws } = require('../src/services/ucpOrderWebhookReceiver');

// ---- deliverable 1+2: profile decoupling + published signing keys (via the live app) ----------------

test('GET /.well-known/ucp serves with AGENT_CHECKOUT_STRICT off and publishes the env signing key', async () => {
  const resp = await supertest(app).get('/.well-known/ucp').expect(200);
  assert.ok(resp.body.ucp_version, 'has ucp_version');
  assert.equal(resp.body.signing_keys.length, 1);
  const key = resp.body.signing_keys[0];
  assert.equal(key.kid, 'test-1');
  assert.equal(key.kty, 'EC');
  assert.equal(key.crv, 'P-256');
  assert.equal(key.d, undefined, 'never a private component');
});

test('GET /.well-known/ucp is dark (404) when the discovery flag is off', async () => {
  delete process.env.AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED;
  try {
    await supertest(app).get('/.well-known/ucp').expect(404);
    await supertest(app).get('/ucp/capabilities').expect(404);
  } finally {
    process.env.AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED = '1';
  }
});

test('signing-key resolver refuses private material and defaults to [] when unset (buyer-profile precedent)', async () => {
  const { resolveBusinessSigningKeys } = await import('../safety-kernel/src/protocol/ucpProfile.js');
  assert.throws(
    () => resolveBusinessSigningKeys({ env: { UCP_BUSINESS_SIGNING_PUBLIC_JWK: JSON.stringify({ ...PUBLIC_JWK, d: 'secret' }) } }),
    /private material/,
  );
  assert.deepEqual(resolveBusinessSigningKeys({ env: {} }), []);
});

// ---- deliverable 3: order-webhook receiver — route surface (flag gating, dedup, events) -------------

test('POST /ucp/order-webhook: 200 ok with verification off; duplicate:true on the same body', async () => {
  const body = { checkout_id: 'chk_route_1', order_id: 'ord_route_1', total: '12.00' };
  const first = await supertest(app).post('/ucp/order-webhook').set('UCP-Business-Id', 'biz-route').send(body).expect(200);
  assert.equal(first.body.status, 'ok');
  assert.equal(first.body.meta.duplicate, false);
  assert.equal(first.body.meta.signature_verified, false);
  assert.match(first.body.meta.body_sha256, /^[0-9a-f]{64}$/);

  const second = await supertest(app).post('/ucp/order-webhook').set('UCP-Business-Id', 'biz-route').send(body).expect(200);
  assert.equal(second.body.meta.duplicate, true);
  assert.equal(second.body.meta.body_sha256, first.body.meta.body_sha256);

  const events = await supertest(app)
    .get('/ucp/order-webhook/events')
    .query({ checkout_id: 'chk_route_1' })
    .expect(200);
  assert.equal(events.body.count, 1);
  const entry = events.body.events[0];
  assert.equal(entry.body_sha256, first.body.meta.body_sha256);
  assert.equal(entry.business_id, 'biz-route');
  assert.equal(entry.order_id, 'ord_route_1');
  // Metadata only: the raw body / amounts must never be stored.
  assert.equal(entry.total, undefined);
  assert.equal(entry.raw_body, undefined);
});

test('POST /ucp/order-webhook and GET /events are dark (404) when the receiver flag is off', async () => {
  delete process.env.UCP_ORDER_WEBHOOK_RECEIVER_ENABLED;
  try {
    const resp = await supertest(app).post('/ucp/order-webhook').send({ a: 1 }).expect(404);
    assert.equal(resp.body.error, 'not_found');
    await supertest(app).get('/ucp/order-webhook/events').expect(404);
  } finally {
    process.env.UCP_ORDER_WEBHOOK_RECEIVER_ENABLED = '1';
  }
});

// ---- deliverable 3: pure handler — detached-JWS verification (injected env + fetch) -----------------

const VERIFY_ENV = {
  UCP_ORDER_WEBHOOK_RECEIVER_ENABLED: '1',
  UCP_VERIFY_ORDER_WEBHOOK: '1',
  UCP_BUSINESS_PROFILE_URL: 'https://ucp.test.local/.well-known/ucp',
};

function verifyingReceiver(overrides = {}) {
  return createUcpOrderWebhookReceiver({
    env: { ...VERIFY_ENV, ...(overrides.env || {}) },
    fetchImpl: overrides.fetchImpl || profileFetch([PUBLIC_JWK]),
    now: overrides.now,
  });
}

const post = (receiver, rawBody, headers = {}) =>
  receiver.handleOrderWebhook({ headers, rawBody, body: JSON.parse(rawBody) });

test('verification on: a validly-signed detached JWS verifies (200, signature_verified, kid)', async () => {
  const receiver = verifyingReceiver();
  const rawBody = JSON.stringify({ checkout_id: 'chk_1', order_id: 'ord_1' });
  const out = await post(receiver, rawBody, {
    'request-signature': signDetached(rawBody),
    'ucp-business-id': 'biz-1',
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.status, 'ok');
  assert.equal(out.body.meta.signature_verified, true);
  assert.equal(out.body.meta.kid, 'test-1');
});

test('verification on: missing signature -> 401 missing Request-Signature', async () => {
  const receiver = verifyingReceiver();
  const out = await post(receiver, JSON.stringify({ a: 1 }), {});
  assert.equal(out.status, 401);
  assert.equal(out.body.detail, 'missing Request-Signature');
});

test('verification on: tampered body -> 401 invalid Request-Signature', async () => {
  const receiver = verifyingReceiver();
  const signature = signDetached(JSON.stringify({ amount: '10.00' }));
  const out = await post(receiver, JSON.stringify({ amount: '99.00' }), { 'request-signature': signature });
  assert.equal(out.status, 401);
  assert.equal(out.body.detail, 'invalid Request-Signature');
});

test('verification on: signature from the wrong key -> 401', async () => {
  const receiver = verifyingReceiver();
  const rawBody = JSON.stringify({ a: 1 });
  const out = await post(receiver, rawBody, {
    'request-signature': signDetached(rawBody, { privateKey: OTHER_PRIV }),
  });
  assert.equal(out.status, 401);
});

test('TIGHTENED vs platform_receiver.py: wrong alg / missing b64:false / missing crit are rejected', async () => {
  const receiver = verifyingReceiver();
  const rawBody = JSON.stringify({ a: 1 });
  for (const header of [
    { alg: 'ES384', b64: false, crit: ['b64'], kid: 'test-1', typ: 'JWT' }, // alg confusion
    { alg: 'ES256', kid: 'test-1', typ: 'JWT' },                            // no b64:false
    { alg: 'ES256', b64: false, kid: 'test-1', typ: 'JWT' },                // b64 not in crit
  ]) {
    const out = await post(receiver, rawBody, { 'request-signature': signDetached(rawBody, { header }) });
    assert.equal(out.status, 401, `header ${JSON.stringify(header)} must be rejected`);
  }
});

test('malformed signatures are rejected: non-detached (payload present), bad segments, non-64-byte sig', async () => {
  const receiver = verifyingReceiver();
  const rawBody = JSON.stringify({ a: 1 });
  const good = signDetached(rawBody);
  const [protectedB64, , sigB64] = good.split('.');
  for (const sig of [
    `${protectedB64}.${b64url('payload')}.${sigB64}`, // payload segment not empty
    protectedB64,                                     // one segment
    `${protectedB64}..${b64url('short')}`,            // raw signature not 64 bytes
    'not-base64..!!!',
  ]) {
    const out = await post(receiver, rawBody, { 'request-signature': sig });
    assert.equal(out.status, 401, `signature ${sig.slice(0, 24)}... must be rejected`);
  }
});

test('a profile key carrying private material ("d") is never used to verify', async () => {
  // The profile (wrongly) exposes the private JWK: the receiver must drop it, leaving no usable key -> 401.
  const privateJwk = { ...PRIV_KEY.export({ format: 'jwk' }), kid: 'test-1' };
  assert.ok(privateJwk.d, 'sanity: exported private JWK carries d');
  const receiver = verifyingReceiver({ fetchImpl: profileFetch([privateJwk]) });
  const rawBody = JSON.stringify({ a: 1 });
  const out = await post(receiver, rawBody, { 'request-signature': signDetached(rawBody) });
  assert.equal(out.status, 401);
});

test('profile fetch failure / unset profile URL -> empty keys -> verification fails closed', async () => {
  const failing = verifyingReceiver({ fetchImpl: profileFetch([], { ok: false }) });
  const rawBody = JSON.stringify({ a: 1 });
  const out = await post(failing, rawBody, { 'request-signature': signDetached(rawBody) });
  assert.equal(out.status, 401);

  const unset = verifyingReceiver({ env: { UCP_BUSINESS_PROFILE_URL: '' } });
  const out2 = await post(unset, rawBody, { 'request-signature': signDetached(rawBody) });
  assert.equal(out2.status, 401);
});

test('a flat signing_keys profile shape (this gateway\'s own /.well-known/ucp) also works', async () => {
  const receiver = verifyingReceiver({ fetchImpl: profileFetch([PUBLIC_JWK], { flat: true }) });
  const rawBody = JSON.stringify({ a: 1 });
  const out = await post(receiver, rawBody, { 'request-signature': signDetached(rawBody) });
  assert.equal(out.status, 200);
  assert.equal(out.body.meta.signature_verified, true);
});

test('profile keys are cached 300s (one fetch across requests; refetched after TTL)', async () => {
  let clock = 1_000_000;
  const fetchImpl = profileFetch([PUBLIC_JWK]);
  const receiver = verifyingReceiver({ fetchImpl, now: () => clock });
  const bodies = ['{"n":1}', '{"n":2}'];
  for (const rawBody of bodies) {
    const out = await post(receiver, rawBody, { 'request-signature': signDetached(rawBody) });
    assert.equal(out.status, 200);
  }
  assert.equal(fetchImpl.calls.length, 1, 'second request within TTL reuses the cache');
  clock += 301 * 1000;
  const rawBody = '{"n":3}';
  await post(receiver, rawBody, { 'request-signature': signDetached(rawBody) });
  assert.equal(fetchImpl.calls.length, 2, 'expired TTL refetches');
});

test('signatures with no kid still verify against all published keys (retired fallback)', async () => {
  const receiver = verifyingReceiver();
  const rawBody = JSON.stringify({ a: 1 });
  const header = { alg: 'ES256', b64: false, crit: ['b64'], typ: 'JWT' }; // no kid
  const out = await post(receiver, rawBody, { 'request-signature': signDetached(rawBody, { header }) });
  assert.equal(out.status, 200);
  assert.equal(out.body.meta.kid, null);
});

// ---- deliverable 3: pure handler — ring buffer bounds + event filtering -----------------------------

test('ring buffer honors UCP_ORDER_WEBHOOK_MAX_EVENTS and evicts oldest-first', async () => {
  const receiver = createUcpOrderWebhookReceiver({
    env: { UCP_ORDER_WEBHOOK_RECEIVER_ENABLED: '1', UCP_ORDER_WEBHOOK_MAX_EVENTS: '2' },
  });
  for (const n of [1, 2, 3]) {
    const rawBody = JSON.stringify({ order_id: `ord_${n}` });
    await receiver.handleOrderWebhook({ headers: {}, rawBody, body: JSON.parse(rawBody) });
  }
  const out = await receiver.handleListEvents({});
  assert.equal(out.body.count, 2);
  assert.deepEqual(out.body.events.map((e) => e.order_id), ['ord_3', 'ord_2'], 'newest first; ord_1 evicted');
  // An evicted sha is accepted again as a fresh (non-duplicate) event.
  const rawBody = JSON.stringify({ order_id: 'ord_1' });
  const again = await receiver.handleOrderWebhook({ headers: {}, rawBody, body: JSON.parse(rawBody) });
  assert.equal(again.body.meta.duplicate, false);
});

test('events endpoint filters by body_sha256 / checkout_id / order_id', async () => {
  const receiver = createUcpOrderWebhookReceiver({ env: { UCP_ORDER_WEBHOOK_RECEIVER_ENABLED: '1' } });
  const bodies = [
    { checkout_id: 'chk_a', order_id: 'ord_a' },
    { checkout_id: 'chk_b', order_id: 'ord_b' },
  ];
  let firstSha;
  for (const b of bodies) {
    const rawBody = JSON.stringify(b);
    const out = await receiver.handleOrderWebhook({ headers: { 'ucp-business-id': 'biz-x' }, rawBody, body: b });
    if (!firstSha) firstSha = out.body.meta.body_sha256;
  }
  const all = await receiver.handleListEvents({});
  assert.equal(all.body.count, 2);
  const byCheckout = await receiver.handleListEvents({ query: { checkout_id: 'chk_b' } });
  assert.deepEqual(byCheckout.body.events.map((e) => e.order_id), ['ord_b']);
  const byOrder = await receiver.handleListEvents({ query: { order_id: 'ord_a' } });
  assert.equal(byOrder.body.count, 1);
  const bySha = await receiver.handleListEvents({ query: { body_sha256: firstSha } });
  assert.deepEqual(bySha.body.events.map((e) => e.checkout_id), ['chk_a']);
  const miss = await receiver.handleListEvents({ query: { order_id: 'nope' } });
  assert.equal(miss.body.count, 0);
});
