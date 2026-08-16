'use strict';

// UCP business-endpoint port tests (retired ucp-web-production + ucp-platform-receiver services):
//   1. /.well-known/ucp is DECOUPLED from AGENT_CHECKOUT_STRICT (discovery flag alone gates it),
//      publishes signing_keys from UCP_BUSINESS_SIGNING_PUBLIC_JWK (private material refused), and —
//      with the kill-switch dark — withholds the money capabilities its doors would hard-404.
//   2. POST /ucp/order-webhook verifies the retired signer's detached ES256 JWS over the EXACT raw
//      body bytes (REQUIRED by default; UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED is the dev-only opt-out),
//      dedups by body sha256 into a metadata-only ring buffer, and GET /events (shared-secret gated)
//      serves it. The POST is body-capped and rate-limited like the other public doors.
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
const { privateKey: OTHER_PRIV } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

const EVENTS_KEY = 'events-internal-key-0123456789abc';

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
// Route-level tests exercise the DEV escape hatch; the default-required path is tested by flipping
// this off at runtime (env is read per request) and in the pure-handler section.
process.env.UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED = '1';
delete process.env.UCP_VERIFY_ORDER_WEBHOOK;
process.env.UCP_ORDER_WEBHOOK_EVENTS_KEY = EVENTS_KEY;

const app = require('../src/server');

const { createUcpOrderWebhookReceiver } = require('../src/services/ucpOrderWebhookReceiver');

// ---- deliverable 1+2: profile decoupling + published signing keys (via the live app) ----------------

test('GET /.well-known/ucp serves with AGENT_CHECKOUT_STRICT off and publishes the env signing key', async () => {
  const resp = await supertest(app).get('/.well-known/ucp').expect(200);
  assert.ok(resp.body.ucp.version, 'has ucp.version');
  // `signing_keys` is a SIBLING of `ucp`, per spec — Key Discovery reads `profile.signing_keys`, so nesting
  // it makes every published key invisible to a verifier.
  assert.equal(resp.body.ucp.signing_keys, undefined, 'must not be nested inside ucp');
  assert.equal(resp.body.signing_keys.length, 1);
  const key = resp.body.signing_keys[0];
  assert.equal(key.kid, 'test-1');
  assert.equal(key.kty, 'EC');
  assert.equal(key.crv, 'P-256');
  assert.equal(key.d, undefined, 'never a private component');
  // Spec: profile responses MUST be publicly cacheable for at least 60s, and MUST NOT be private/no-store.
  const cacheControl = resp.headers['cache-control'];
  assert.match(cacheControl, /(^|[\s,])public([\s,]|$)/);
  assert.ok(Number(/max-age=(\d+)/.exec(cacheControl)?.[1]) >= 60, `weak max-age: ${cacheControl}`);
  assert.ok(!/private|no-store|no-cache/.test(cacheControl), `forbidden directive: ${cacheControl}`);
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

// M8: with the checkout kill-switch dark, the money capabilities must not be advertised.
test('strict off: the profile is SERVED but advertises nothing callable', async () => {
  // This suite boots with AGENT_CHECKOUT_STRICT deleted, which is the point of the file's headline
  // invariant: /.well-known/ucp is decoupled from the money kill-switch and keeps answering 200.
  //
  // WHAT CHANGED (founder decision 2026-08-13). It used to assert that checkout/ap2 were withheld while
  // the READ capabilities stayed advertised. But strict-off also means no transport — the UCP-dialect
  // door requires strict AND its own flag — so those reads named no reachable endpoint. A profile now
  // advertises what a platform can CALL, so with no transport the capability list is empty and the
  // withholding of checkout/ap2 is subsumed by it.
  const resp = await supertest(app).get('/.well-known/ucp').expect(200);
  assert.ok(resp.body.ucp.version, 'the profile itself stays up while checkout is dark');
  // Both members are MAPS in the spec's shape, so empty is `{}` rather than `[]`.
  assert.deepEqual(resp.body.ucp.services, {}, 'nothing speaks for this profile');
  assert.deepEqual(resp.body.ucp.capabilities, {}, 'no transport => no capability advertised');
  // NOTE what is deliberately NOT asserted here. Substring checks for checkout / ap2_mandate /
  // create_payment_link would be VACUOUS in this state: the whole document is
  // {ucp:{version,services:{},capabilities:{},payment_handlers:{}}, provider, signing_keys:[]}, so none of
  // those strings can appear whatever the code does — they would pass with the kill-switch guard deleted.
  // That guard (which ids to withhold while AGENT_CHECKOUT_STRICT is dark) is driven directly in
  // tests/commerce_ucp_mcp_door.node.test.cjs against `ucpOmitCapabilityIdsForFlags`, where the served
  // document cannot mask it.
  // The intersection endpoint reflects the same emptiness — it can never resurrect what is unadvertised.
  const inter = await supertest(app)
    .post('/ucp/capabilities')
    .send({ capabilities: ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.catalog.search'] })
    .expect(200);
  assert.deepEqual(inter.body.ucp.capabilities, {});
});

// M9: the profile is built per request — a bad signing-key env 503s only while it is bad, and key
// rotation (env change) is live without a redeploy.
test('a signing-key env carrying private material 503s the profile — and recovers once fixed', async () => {
  const good = process.env.UCP_BUSINESS_SIGNING_PUBLIC_JWK;
  process.env.UCP_BUSINESS_SIGNING_PUBLIC_JWK = JSON.stringify({ ...PUBLIC_JWK, d: 'secret' });
  try {
    const bad = await supertest(app).get('/.well-known/ucp').expect(503);
    assert.equal(bad.body.error, 'ucp_unavailable');
  } finally {
    process.env.UCP_BUSINESS_SIGNING_PUBLIC_JWK = good;
  }
  const recovered = await supertest(app).get('/.well-known/ucp').expect(200);
  assert.equal(recovered.body.signing_keys[0].kid, 'test-1', 'no cached rejection; next request serves');
});

test('signing-key resolver refuses private material and defaults to [] when unset (buyer-profile precedent)', async () => {
  const { resolveBusinessSigningKeys } = await import('../safety-kernel/src/protocol/ucpProfile.js');
  assert.throws(
    () => resolveBusinessSigningKeys({ env: { UCP_BUSINESS_SIGNING_PUBLIC_JWK: JSON.stringify({ ...PUBLIC_JWK, d: 'secret' }) } }),
    /private material/,
  );
  assert.deepEqual(resolveBusinessSigningKeys({ env: {} }), []);
});

// ---- deliverable 3: order-webhook receiver — route surface ------------------------------------------

test('POST /ucp/order-webhook: 200 ok with the unverified escape hatch on; duplicate:true on the same body', async () => {
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
    .set('x-pivota-internal-key', EVENTS_KEY)
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

// H2: verification is REQUIRED by default — dropping the escape hatch closes the unsigned write path.
test('POST /ucp/order-webhook: with the escape hatch OFF (default), an unsigned event is 401', async () => {
  delete process.env.UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED;
  try {
    const resp = await supertest(app).post('/ucp/order-webhook').send({ a: 1 }).expect(401);
    assert.equal(resp.body.detail, 'missing Request-Signature');
  } finally {
    process.env.UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED = '1';
  }
});

test('POST /ucp/order-webhook and GET /events are dark (404) when the receiver flag is off', async () => {
  delete process.env.UCP_ORDER_WEBHOOK_RECEIVER_ENABLED;
  try {
    const resp = await supertest(app).post('/ucp/order-webhook').send({ a: 1 }).expect(404);
    assert.equal(resp.body.error, 'not_found');
    await supertest(app).get('/ucp/order-webhook/events').set('x-pivota-internal-key', EVENTS_KEY).expect(404);
  } finally {
    process.env.UCP_ORDER_WEBHOOK_RECEIVER_ENABLED = '1';
  }
});

// H1: the events surface is an internal door — shared secret required, 404 either way without it.
test('GET /events: 404 without a key, 404 with a wrong key, 200 via header or Bearer', async () => {
  await supertest(app).get('/ucp/order-webhook/events').expect(404);
  await supertest(app).get('/ucp/order-webhook/events').set('x-pivota-internal-key', 'wrong-key-wrong-key-wrong').expect(404);
  await supertest(app).get('/ucp/order-webhook/events').set('authorization', 'Bearer wrong-key').expect(404);
  await supertest(app).get('/ucp/order-webhook/events').set('x-pivota-internal-key', EVENTS_KEY).expect(200);
  await supertest(app).get('/ucp/order-webhook/events').set('authorization', `Bearer ${EVENTS_KEY}`).expect(200);
});

test('GET /events: 404 when UCP_ORDER_WEBHOOK_EVENTS_KEY is unconfigured (even with any key presented)', async () => {
  delete process.env.UCP_ORDER_WEBHOOK_EVENTS_KEY;
  try {
    await supertest(app).get('/ucp/order-webhook/events').set('x-pivota-internal-key', EVENTS_KEY).expect(404);
    await supertest(app).get('/ucp/order-webhook/events').set('x-pivota-internal-key', '').expect(404);
  } finally {
    process.env.UCP_ORDER_WEBHOOK_EVENTS_KEY = EVENTS_KEY;
  }
});

// H3: pre-parse body cap — a 10mb body must never reach the route (or the JSON parser).
// N1: Express routes case-insensitively and tolerates trailing slashes, so the cap must catch the
// normalized spellings too — otherwise they reach the handler having skipped the cap entirely.
test('POST /ucp/order-webhook rejects oversized bodies with 413 before parsing (all path spellings)', async () => {
  const oversized = { padding: 'x'.repeat(64 * 1024) };
  await supertest(app).post('/ucp/order-webhook').send(oversized).expect(413);
  await supertest(app).post('/ucp/order-webhook/').send(oversized).expect(413);
  await supertest(app).post('/UCP/order-webhook').send(oversized).expect(413);
});

// N1: the rawBody stash must match the same normalized path — a trailing slash previously skipped it,
// turning a correctly-signed webhook into a 415. Verified end-to-end: the app's receiver resolves its
// signing keys via GLOBAL fetch at request time, patched here to serve the test profile.
test('a valid-signature POST to /ucp/order-webhook/ (trailing slash) verifies — rawBody is stashed', async () => {
  const origFetch = globalThis.fetch;
  delete process.env.UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED; // verification required (the default)
  process.env.UCP_VERIFY_ORDER_WEBHOOK = '1';
  process.env.UCP_BUSINESS_PROFILE_URL = 'https://ucp.test.local/.well-known/ucp';
  globalThis.fetch = profileFetch([PUBLIC_JWK]);
  try {
    const rawBody = JSON.stringify({ order_id: 'ord_trailing_slash' });
    const resp = await supertest(app)
      .post('/ucp/order-webhook/')
      .set('content-type', 'application/json')
      .set('request-signature', signDetached(rawBody))
      .send(rawBody)
      .expect(200);
    assert.equal(resp.body.meta.signature_verified, true);
    assert.equal(resp.body.meta.kid, 'test-1');
  } finally {
    globalThis.fetch = origFetch;
    process.env.UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED = '1';
    delete process.env.UCP_VERIFY_ORDER_WEBHOOK;
    delete process.env.UCP_BUSINESS_PROFILE_URL;
  }
});

// N2: Express initializes req.body = {} when no parser claims the request, so a text/plain body used
// to collapse into one sha256("{}") dedup entry. Through the REAL route: both POSTs must come back
// stored:false (never "duplicate") and the ring buffer must stay untouched.
test('text/plain bodies through the real route are stored:false and never pollute dedup', async () => {
  const eventsBefore = await supertest(app)
    .get('/ucp/order-webhook/events')
    .set('x-pivota-internal-key', EVENTS_KEY)
    .expect(200);
  for (let i = 0; i < 2; i += 1) {
    const resp = await supertest(app)
      .post('/ucp/order-webhook')
      .set('content-type', 'text/plain')
      .send('hello, not json')
      .expect(200);
    assert.deepEqual(
      resp.body.meta,
      { stored: false, reason: 'unparsed_body' },
      `attempt ${i + 1}: not stored, never "duplicate"`,
    );
  }
  const eventsAfter = await supertest(app)
    .get('/ucp/order-webhook/events')
    .set('x-pivota-internal-key', EVENTS_KEY)
    .expect(200);
  assert.equal(eventsAfter.body.count, eventsBefore.body.count, 'no sha256("{}") entry recorded');
});

// ---- deliverable 3: pure handler — detached-JWS verification (injected env + fetch) -----------------

const VERIFY_ENV = {
  UCP_ORDER_WEBHOOK_RECEIVER_ENABLED: '1',
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

test('verification (default-on): a validly-signed detached JWS verifies (200, signature_verified, kid)', async () => {
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

test('verification: missing signature -> 401 missing Request-Signature', async () => {
  const receiver = verifyingReceiver();
  const out = await post(receiver, JSON.stringify({ a: 1 }), {});
  assert.equal(out.status, 401);
  assert.equal(out.body.detail, 'missing Request-Signature');
});

test('UCP_VERIFY_ORDER_WEBHOOK force-on beats the allow-unverified escape hatch', async () => {
  const receiver = verifyingReceiver({
    env: { UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED: '1', UCP_VERIFY_ORDER_WEBHOOK: '1' },
  });
  const out = await post(receiver, JSON.stringify({ a: 1 }), {});
  assert.equal(out.status, 401);
});

test('verification: tampered body -> 401 invalid Request-Signature', async () => {
  const receiver = verifyingReceiver();
  const signature = signDetached(JSON.stringify({ amount: '10.00' }));
  const out = await post(receiver, JSON.stringify({ amount: '99.00' }), { 'request-signature': signature });
  assert.equal(out.status, 401);
  assert.equal(out.body.detail, 'invalid Request-Signature');
});

test('verification: signature from the wrong key -> 401', async () => {
  const receiver = verifyingReceiver();
  const rawBody = JSON.stringify({ a: 1 });
  const out = await post(receiver, rawBody, {
    'request-signature': signDetached(rawBody, { privateKey: OTHER_PRIV }),
  });
  assert.equal(out.status, 401);
});

test('TIGHTENED vs platform_receiver.py: wrong alg / missing b64:false / bad crit are rejected', async () => {
  const receiver = verifyingReceiver();
  const rawBody = JSON.stringify({ a: 1 });
  for (const header of [
    { alg: 'ES384', b64: false, crit: ['b64'], kid: 'test-1', typ: 'JWT' },        // alg confusion
    { alg: 'ES256', kid: 'test-1', typ: 'JWT' },                                   // no b64:false
    { alg: 'ES256', b64: false, kid: 'test-1', typ: 'JWT' },                       // b64 not in crit
    { alg: 'ES256', b64: false, crit: ['b64', 'exp'], kid: 'test-1', typ: 'JWT' }, // crit member we do not understand (RFC 7515 §4.1.11)
    { alg: 'ES256', b64: false, crit: ['b64', 'b64'], kid: 'test-1', typ: 'JWT' }, // duplicate crit entries (RFC 7515 forbids)
  ]) {
    const out = await post(receiver, rawBody, { 'request-signature': signDetached(rawBody, { header }) });
    assert.equal(out.status, 401, `header ${JSON.stringify(header)} must be rejected`);
  }
});

test('TIGHTENED vs platform_receiver.py: a declared kid matching no published key fails (no try-all fallback)', async () => {
  const receiver = verifyingReceiver();
  const rawBody = JSON.stringify({ a: 1 });
  // Signed with the RIGHT key but declaring an unknown kid: would pass under the old try-all fallback.
  const out = await post(receiver, rawBody, {
    'request-signature': signDetached(rawBody, { kid: 'ghost-kid' }),
  });
  assert.equal(out.status, 401);
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

// M6: a signed request whose body never reached the JSON parser is a media-type problem, not a
// signature problem — and it must NEVER fall back to verifying re-serialized JSON.
test('verification with no rawBody (non-JSON content type) -> 415, not a misleading 401', async () => {
  const receiver = verifyingReceiver();
  const out = await receiver.handleOrderWebhook({
    headers: { 'request-signature': signDetached('{"a":1}') },
    rawBody: undefined,
    body: { a: 1 },
  });
  assert.equal(out.status, 415);
  assert.equal(out.body.detail, 'unsupported media type: application/json required');
});

// M7/N2 (unparsed-body guard, incl. Express's `req.body = {}` default) is covered end-to-end by the
// text/plain supertest case in the route section above — the pure-handler variant lived here before
// but never exercised the real-route condition (Express hands the handler {} rather than undefined).

// ---- H4: profile-fetch hardening --------------------------------------------------------------------

test('an http:// (non-https) profile URL is refused -> no keys -> 401', async () => {
  const fetchImpl = profileFetch([PUBLIC_JWK]);
  const receiver = verifyingReceiver({
    env: { UCP_BUSINESS_PROFILE_URL: 'http://ucp.test.local/.well-known/ucp' },
    fetchImpl,
  });
  const rawBody = JSON.stringify({ a: 1 });
  const out = await post(receiver, rawBody, { 'request-signature': signDetached(rawBody) });
  assert.equal(out.status, 401);
  assert.equal(fetchImpl.calls.length, 0, 'the plaintext URL is never even fetched');
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

test('a failed refresh keeps serving the last GOOD key set (stale-good, retry after failure TTL)', async () => {
  let clock = 1_000_000;
  let failNow = false;
  const goodFetch = profileFetch([PUBLIC_JWK]);
  const fetchImpl = async (url, opts) => {
    if (failNow) throw new Error('profile origin down');
    return goodFetch(url, opts);
  };
  const receiver = verifyingReceiver({ fetchImpl, now: () => clock });

  const body1 = '{"n":1}';
  assert.equal((await post(receiver, body1, { 'request-signature': signDetached(body1) })).status, 200);

  // Past the 300s TTL the refresh FAILS — the previously-good keys must keep verifying.
  clock += 301 * 1000;
  failNow = true;
  const body2 = '{"n":2}';
  assert.equal(
    (await post(receiver, body2, { 'request-signature': signDetached(body2) })).status,
    200,
    'stale good keys still serve through an origin outage',
  );
});

test('concurrent requests coalesce into a single profile fetch', async () => {
  const fetchImpl = profileFetch([PUBLIC_JWK]);
  const receiver = verifyingReceiver({ fetchImpl });
  const bodies = ['{"c":1}', '{"c":2}', '{"c":3}'];
  const outs = await Promise.all(
    bodies.map((b) => post(receiver, b, { 'request-signature': signDetached(b) })),
  );
  for (const out of outs) assert.equal(out.status, 200);
  assert.equal(fetchImpl.calls.length, 1, 'one in-flight fetch shared by all three');
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
  for (const rawBody of ['{"n":1}', '{"n":2}']) {
    const out = await post(receiver, rawBody, { 'request-signature': signDetached(rawBody) });
    assert.equal(out.status, 200);
  }
  assert.equal(fetchImpl.calls.length, 1, 'second request within TTL reuses the cache');
  clock += 301 * 1000;
  const rawBody = '{"n":3}';
  await post(receiver, rawBody, { 'request-signature': signDetached(rawBody) });
  assert.equal(fetchImpl.calls.length, 2, 'expired TTL refetches');
});

test('signatures with no kid still verify against all published keys (kid-less only)', async () => {
  const receiver = verifyingReceiver();
  const rawBody = JSON.stringify({ a: 1 });
  const header = { alg: 'ES256', b64: false, crit: ['b64'], typ: 'JWT' }; // no kid
  const out = await post(receiver, rawBody, { 'request-signature': signDetached(rawBody, { header }) });
  assert.equal(out.status, 200);
  assert.equal(out.body.meta.kid, null);
});

// ---- deliverable 3: pure handler — ring buffer bounds + event filtering -----------------------------

const UNVERIFIED_EVENTS_ENV = {
  UCP_ORDER_WEBHOOK_RECEIVER_ENABLED: '1',
  UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED: '1',
  UCP_ORDER_WEBHOOK_EVENTS_KEY: EVENTS_KEY,
};
const EVENTS_AUTH = { 'x-pivota-internal-key': EVENTS_KEY };

test('ring buffer honors UCP_ORDER_WEBHOOK_MAX_EVENTS and evicts oldest-first', async () => {
  const receiver = createUcpOrderWebhookReceiver({
    env: { ...UNVERIFIED_EVENTS_ENV, UCP_ORDER_WEBHOOK_MAX_EVENTS: '2' },
  });
  for (const n of [1, 2, 3]) {
    const rawBody = JSON.stringify({ order_id: `ord_${n}` });
    await receiver.handleOrderWebhook({ headers: {}, rawBody, body: JSON.parse(rawBody) });
  }
  const out = await receiver.handleListEvents({ headers: EVENTS_AUTH });
  assert.equal(out.body.count, 2);
  assert.deepEqual(out.body.events.map((e) => e.order_id), ['ord_3', 'ord_2'], 'newest first; ord_1 evicted');
  // An evicted sha is accepted again as a fresh (non-duplicate) event.
  const rawBody = JSON.stringify({ order_id: 'ord_1' });
  const again = await receiver.handleOrderWebhook({ headers: {}, rawBody, body: JSON.parse(rawBody) });
  assert.equal(again.body.meta.duplicate, false);
});

test('events endpoint filters by body_sha256 / checkout_id / order_id', async () => {
  const receiver = createUcpOrderWebhookReceiver({ env: { ...UNVERIFIED_EVENTS_ENV } });
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
  const all = await receiver.handleListEvents({ headers: EVENTS_AUTH });
  assert.equal(all.body.count, 2);
  const byCheckout = await receiver.handleListEvents({ headers: EVENTS_AUTH, query: { checkout_id: 'chk_b' } });
  assert.deepEqual(byCheckout.body.events.map((e) => e.order_id), ['ord_b']);
  const byOrder = await receiver.handleListEvents({ headers: EVENTS_AUTH, query: { order_id: 'ord_a' } });
  assert.equal(byOrder.body.count, 1);
  const bySha = await receiver.handleListEvents({ headers: EVENTS_AUTH, query: { body_sha256: firstSha } });
  assert.deepEqual(bySha.body.events.map((e) => e.checkout_id), ['chk_a']);
  const miss = await receiver.handleListEvents({ headers: EVENTS_AUTH, query: { order_id: 'nope' } });
  assert.equal(miss.body.count, 0);
});

// ---- fetch-failure diagnosis: log the CAUSE, not just "fetch failed" --------------------------------
//
// undici collapses every network-layer failure into the same opaque `TypeError: fetch failed` and hides
// the real reason on `.cause` (measured on node 20 and 24). This receiver refuses a redirected profile
// (`redirect: 'error'`, per UCP 2026-04-08) — so without the cause, a business profile that 302s logs
// byte-identically to its host being dead. The stakes are higher here than in the warm-handoff lane: a
// fetch that keeps failing with no previously-good key set falls back to an EMPTY key list, and that
// rejects EVERY inbound order webhook. These tests pin that the log can tell the two apart.

/** Exactly what `fetch(url, { redirect: 'error' })` throws when the profile 302s. */
function redirectRefusalError() {
  const err = new TypeError('fetch failed');
  err.cause = new Error('unexpected redirect');
  return err;
}

/** Exactly what fetch throws for a host that does not resolve, including the enumerable request detail. */
function dnsFailureError() {
  const err = new TypeError('fetch failed');
  const cause = new Error('getaddrinfo ENOTFOUND ucp.test.local');
  Object.assign(cause, {
    errno: -3008, code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'ucp.test.local',
  });
  err.cause = cause;
  return err;
}

/** Drive a real webhook through a receiver whose profile fetch throws `err`; return the warn records. */
async function warnsFromProfileFetchFailure(err, envOverrides = {}) {
  const warns = [];
  const receiver = createUcpOrderWebhookReceiver({
    env: { ...VERIFY_ENV, ...envOverrides },
    fetchImpl: async () => { throw err; },
    logger: { warn: (rec, msg) => warns.push({ rec, msg }) },
  });
  const rawBody = JSON.stringify({ checkout_id: 'chk_cause', order_id: 'ord_cause' });
  const out = await receiver.handleOrderWebhook({
    headers: { 'request-signature': signDetached(rawBody) },
    rawBody,
    body: JSON.parse(rawBody),
  });
  return { warns, out };
}

test('cause: a refused redirect and a dead host are DISTINGUISHABLE in the receiver log', async () => {
  const redirect = await warnsFromProfileFetchFailure(redirectRefusalError());
  const dns = await warnsFromProfileFetchFailure(dnsFailureError());

  const rr = redirect.warns.find((w) => w.msg === 'UCP business profile signing-key fetch failed').rec;
  const dr = dns.warns.find((w) => w.msg === 'UCP business profile signing-key fetch failed').rec;

  // Both fail CLOSED to an empty key set, which is what makes this worth diagnosing at all.
  assert.equal(redirect.out.status, 401, 'no keys -> every inbound webhook is rejected');
  assert.equal(dns.out.status, 401);

  // The property: identical `err`, identical surface -- the cause is the ONLY discriminator.
  assert.equal(rr.err, dr.err);
  assert.equal(rr.err, 'fetch failed');
  assert.notEqual(rr.cause, dr.cause);

  assert.equal(rr.cause, 'unexpected redirect');
  assert.equal(dr.cause, 'getaddrinfo ENOTFOUND ucp.test.local');
  assert.equal(dr.cause_code, 'ENOTFOUND');
  assert.equal(Object.hasOwn(rr, 'cause_code'), false, 'no errno for a redirect refusal -> key absent');
});

test('cause: the cause object is never spread into the receiver record', async () => {
  // A real fetch cause carries errno/syscall/hostname as its OWN ENUMERABLE keys -- those, not the stack,
  // are what a `{...cause}` spread would leak. Asserted as an ALLOWLIST on the key set, never a denylist.
  const { warns } = await warnsFromProfileFetchFailure(dnsFailureError());
  const rec = warns.find((w) => w.msg === 'UCP business profile signing-key fetch failed').rec;

  assert.deepEqual(Object.keys(rec).sort(), ['cause', 'cause_code', 'err', 'surface']);
  assert.equal(typeof rec.cause, 'string');
  assert.equal(rec.surface, 'ucp_order_webhook', 'the pre-existing fields still ride along');
});

test('cause: a non-fetch warn gains no cause fields', async () => {
  // The https refusal path warns with a hand-built Error that has no `.cause`. The helper must add
  // nothing there rather than emitting empty keys.
  const warns = [];
  const receiver = createUcpOrderWebhookReceiver({
    env: { ...VERIFY_ENV, UCP_BUSINESS_PROFILE_URL: 'http://ucp.test.local/.well-known/ucp' },
    fetchImpl: async () => { throw new Error('must never be called'); },
    logger: { warn: (rec, msg) => warns.push({ rec, msg }) },
  });
  const rawBody = JSON.stringify({ checkout_id: 'chk_plain' });
  await receiver.handleOrderWebhook({
    headers: { 'request-signature': signDetached(rawBody) }, rawBody, body: JSON.parse(rawBody),
  });
  const rec = warns.find((w) => w.msg === 'UCP business profile URL refused').rec;
  assert.deepEqual(Object.keys(rec).sort(), ['err', 'surface']);
});

// The three tests above cover the receiver's own WIRING. These two cover behaviour of the shared helper
// that this lane specifically depends on. They deliberately duplicate coverage that also exists in
// tests/ucp_warm_handoff_service.test.js, because coverage living only in the OTHER consumer's suite is
// not coverage this lane owns: a mutation review found the two properties below killed by zero tests
// here, in the lane this change argues has the higher stakes.

test('cause: a throwing `cause` getter yields 401, not an exception out of the handler', async () => {
  // This is a 500-vs-401 difference, not a logging nicety. `warn()` is called from inside the catch in
  // loadSigningKeys, and nothing wraps the `await loadSigningKeys(env)` in handleOrderWebhook -- so a
  // helper that throws escapes the handler entirely. Measured with the helper's try/catch removed:
  // "handleOrderWebhook THREW -> boom from getter" instead of resolving 401.
  const err = new TypeError('fetch failed');
  Object.defineProperty(err, 'cause', { get() { throw new Error('boom from getter'); } });

  const warns = [];
  const receiver = createUcpOrderWebhookReceiver({
    env: VERIFY_ENV,
    fetchImpl: async () => { throw err; },
    logger: { warn: (rec, msg) => warns.push({ rec, msg }) },
  });
  const rawBody = JSON.stringify({ checkout_id: 'chk_getter' });
  const out = await receiver.handleOrderWebhook({
    headers: { 'request-signature': signDetached(rawBody) }, rawBody, body: JSON.parse(rawBody),
  });

  assert.equal(out.status, 401, 'the lane still fails CLOSED rather than throwing');
  const rec = warns.find((w) => w.msg === 'UCP business profile signing-key fetch failed').rec;
  assert.deepEqual(Object.keys(rec).sort(), ['err', 'surface'], 'no cause fields, and no crash');
});

test('cause: a dual-stack connect failure still reports a reason, and a non-string code is dropped', async () => {
  // AggregateError with an EMPTY message is the real shape for a host with both A and AAAA records; the
  // per-family reasons live in .errors. Without the fallback this lane would log cause_code and NO cause
  // -- on exactly the CDN-fronted profile hosts most likely to be dual-stack.
  const agg = new AggregateError(
    [new Error('connect ECONNREFUSED ::1:443'), new Error('connect ECONNREFUSED 127.0.0.1:443')],
    '',
  );
  agg.code = 'ECONNREFUSED';
  const dualStack = new TypeError('fetch failed');
  dualStack.cause = agg;
  const { warns } = await warnsFromProfileFetchFailure(dualStack);
  const rec = warns.find((w) => w.msg === 'UCP business profile signing-key fetch failed').rec;
  assert.equal(rec.cause, 'connect ECONNREFUSED ::1:443');
  assert.equal(rec.cause_code, 'ECONNREFUSED');

  // A NUMERIC code is dropped rather than published. Needs its own fixture: the redirect-refusal case
  // above has no `code` at all, so it holds whether or not the string guard is there.
  const numeric = new TypeError('fetch failed');
  numeric.cause = Object.assign(new Error('aborted'), { code: 23 });
  const rec2 = (await warnsFromProfileFetchFailure(numeric)).warns
    .find((w) => w.msg === 'UCP business profile signing-key fetch failed').rec;
  assert.equal(Object.hasOwn(rec2, 'cause_code'), false, 'a bare 23 is not a log field');
  assert.equal(rec2.cause, 'aborted');
});

// ---- a profile URL with userinfo must not put the password in the log ------------------------------
//
// `https://user:pass@host/.well-known/ucp` passes the https guard, then fetch rejects it with
// `TypeError: Request cannot be constructed from a URL that includes credentials: <the full URL>` — which
// the fetch catch logs as `err`, password included (measured on node 24). The URL is refused before fetch.

// Each half of `username || password` gets its own row: a token-in-username config is the common real shape,
// and fetch throws the URL-echoing TypeError for both (measured), so a guard on `password` alone still leaks.
for (const [label, userinfo] of [
  ['user:pass', 'svc:operator-typed-password-DO-NOT-LEAK'],
  ['username only', 'operator-api-token-DO-NOT-LEAK'],
  ['password only', ':operator-typed-password-DO-NOT-LEAK'],
]) test(`userinfo (${label}): a credentialed UCP_BUSINESS_PROFILE_URL is refused before fetch and never logged`, async () => {
  const PASSWORD = 'DO-NOT-LEAK';
  const warns = [];
  const fetchCalls = [];
  const receiver = createUcpOrderWebhookReceiver({
    env: { ...VERIFY_ENV, UCP_BUSINESS_PROFILE_URL: `https://${userinfo}@ucp.test.local/.well-known/ucp` },
    // If this were reached, real fetch would throw a TypeError carrying the URL. Model exactly that, so a
    // regression that lets the URL through is caught by the leak assertion, not just by the call count.
    fetchImpl: async (url) => {
      fetchCalls.push(String(url));
      throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`);
    },
    logger: { warn: (rec, msg) => warns.push({ rec, msg }) },
  });
  const rawBody = JSON.stringify({ checkout_id: 'chk_userinfo' });
  const out = await receiver.handleOrderWebhook({
    headers: { 'request-signature': signDetached(rawBody) }, rawBody, body: JSON.parse(rawBody),
  });

  assert.equal(out.status, 401, 'no keys -> fails closed, same as any other refused URL');
  assert.equal(fetchCalls.length, 0, 'refused BEFORE fetch — the URL never reaches the network layer');
  // The property: the password is in NOTHING we emitted. Checked over the whole serialized warn set, so a
  // future field cannot smuggle it either.
  const everything = JSON.stringify(warns);
  assert.equal(everything.includes(PASSWORD), false, `password leaked into logs: ${everything}`);
  const refused = warns.find((w) => w.msg === 'UCP business profile URL refused');
  assert.ok(refused, 'the refusal is logged');
  assert.equal(refused.rec.err, 'UCP_BUSINESS_PROFILE_URL must not contain userinfo');
});

// ---- a redirected business profile is refused as a first-class status ------------------------------
//
// `redirect: 'manual'`: the 3xx is returned, never followed (measured on node 24: status 301, ok false,
// redirected false, target never contacted). It fails through the existing `!res.ok` check as
// `business profile fetch failed (301)` -- greppable, and not undici's wording. Under `redirect: 'error'`
// the same event was an opaque `fetch failed` with the reason on `.cause`. Same rule, better diagnosis.

test('redirect: a 301 business profile is refused with the 301 in the message, never followed', async () => {
  const warns = [];
  const inits = [];
  let targetHits = 0;
  const receiver = createUcpOrderWebhookReceiver({
    env: VERIFY_ENV,
    fetchImpl: async (url, init = {}) => {
      inits.push(init);
      if (init.redirect === 'manual') {
        return {
          ok: false, status: 301, redirected: false,
          async json() { throw new SyntaxError('Unexpected token <'); },
          async text() { return '<html>moved</html>'; },
        };
      }
      if (init.redirect === 'error') throw new TypeError('fetch failed');
      // 'follow' (or unset): the redirect target's 200, carrying a key set we must never adopt.
      targetHits += 1;
      return { ok: true, status: 200, async json() { return { ucp: { signing_keys: [PUBLIC_JWK] } }; } };
    },
    logger: { warn: (rec, msg) => warns.push({ rec, msg }) },
  });
  const rawBody = JSON.stringify({ checkout_id: 'chk_redirect' });
  const out = await receiver.handleOrderWebhook({
    headers: { 'request-signature': signDetached(rawBody) }, rawBody, body: JSON.parse(rawBody),
  });

  // Never followed: under a 'follow' mutant the target's keys VERIFY the signature and this is a 200 --
  // trust anchored to an origin we never resolved. That is the assertion that fails first.
  assert.equal(targetHits, 0, 'the redirect target is never contacted');
  assert.equal(out.status, 401, 'no keys adopted -> fails closed');
  assert.equal(inits[0].redirect, 'manual');
  const rec = warns.find((w) => w.msg === 'UCP business profile signing-key fetch failed').rec;
  assert.equal(rec.err, 'business profile fetch failed (301)');
  assert.equal(Object.hasOwn(rec, 'cause'), false, 'a returned 3xx is not a thrown fetch failure');
});
