'use strict';

// POST /ucp/order-webhook, RFC 9421 (UCP 2026-04-08 order webhooks): UCP_ORDER_WEBHOOK_RFC9421_MODE.
//   off (default)  byte-identical to before: no verification, no log line, no new response or event fields;
//   observe        verified and logged; the accept/refuse decision is still the detached-JWS one;
//   accept         a verified RFC 9421 signature stands in for the missing Request-Signature.
// Pure handler, injected env/fetch/logger; placeholder business hosts; keys generated here.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createUcpOrderWebhookReceiver } = require('../src/services/ucpOrderWebhookReceiver');

const BUSINESS = 'https://shop.example/.well-known/ucp';
const UNTRUSTED = 'https://other-shop.example/.well-known/ucp';
const HOST = 'ucp.pivota.cc';
const EVENTS_KEY = 'events-internal-key-0123456789abc';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const BUSINESS_JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'shop-2026', use: 'sig' };

const nowS = () => Math.floor(Date.now() / 1000);

/** The spec's webhook example shape: covers @method @authority @path content-digest content-type. */
function signWebhook(bodyString, { profile = BUSINESS, coverUcpAgent = false, key = privateKey, kid = 'shop-2026' } = {}) {
  const digest = `sha-256=:${crypto.createHash('sha256').update(bodyString).digest('base64')}:`;
  const ucpAgent = `profile="${profile}"`;
  const comps = [['@method', 'POST'], ['@authority', HOST], ['@path', '/ucp/order-webhook']];
  if (coverUcpAgent) comps.push(['ucp-agent', ucpAgent]);
  comps.push(['content-digest', digest], ['content-type', 'application/json']);
  const params = `(${comps.map(([n]) => `"${n}"`).join(' ')});created=${nowS()};keyid="${kid}"`;
  const base = [...comps.map(([n, v]) => `"${n}": ${v}`), `"@signature-params": ${params}`].join('\n');
  const sig = crypto.sign('sha256', Buffer.from(base, 'utf8'), { key, dsaEncoding: 'ieee-p1363' });
  return {
    host: HOST,
    'content-type': 'application/json',
    'content-digest': digest,
    'ucp-agent': ucpAgent,
    'webhook-id': 'evt-0001',
    'webhook-timestamp': String(nowS()),
    'signature-input': `sig1=${params}`,
    signature: `sig1=:${sig.toString('base64')}:`,
  };
}

function harness(envExtra = {}) {
  const fetchCalls = [];
  const logs = [];
  const env = {
    UCP_ORDER_WEBHOOK_RECEIVER_ENABLED: '1',
    UCP_ORDER_WEBHOOK_EVENTS_KEY: EVENTS_KEY,
    UCP_ORDER_WEBHOOK_TRUSTED_BUSINESS_PROFILES: BUSINESS,
    ...envExtra,
  };
  const receiver = createUcpOrderWebhookReceiver({
    env,
    logger: { info: (o) => logs.push(o), warn: (o) => logs.push(o) },
    fetchImpl: async (url) => {
      fetchCalls.push(String(url));
      if (String(url) === BUSINESS) {
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ ucp: { version: '2026-04-08', signing_keys: [BUSINESS_JWK] } }), json: async () => ({}) };
      }
      return { status: 404, ok: false, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
    },
  });
  const post = (headers, bodyString) => receiver.handleOrderWebhook({
    headers,
    rawBody: bodyString,
    rawBodyBytes: Buffer.from(bodyString, 'utf8'),
    body: JSON.parse(bodyString),
    request: { method: 'POST', originalUrl: '/ucp/order-webhook' },
  });
  const events = async () => (await receiver.handleListEvents({ headers: { 'x-pivota-internal-key': EVENTS_KEY } })).body.events;
  return { post, events, fetchCalls, logs, env };
}

const rfcLogs = (logs) => logs.filter((l) => l && l.event === 'ucp_order_webhook_rfc9421');
const orderBody = (n = 1) => JSON.stringify({ id: `order-${n}`, checkout_id: `co-${n}`, status: 'confirmed' });

test('off (default): an RFC 9421-only webhook is refused exactly as before; nothing fetched or logged', async () => {
  const h = harness();
  const body = orderBody(1);
  const out = await h.post(signWebhook(body), body);
  assert.equal(out.status, 401);
  assert.deepEqual(out.body, { detail: 'missing Request-Signature' });
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(rfcLogs(h.logs).length, 0);
});

test('off (default): an accepted webhook keeps exactly the old response and event shape', async () => {
  const h = harness({ UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED: '1' });
  const body = orderBody(2);
  const out = await h.post(signWebhook(body), body);
  assert.equal(out.status, 200);
  assert.deepEqual(Object.keys(out.body.meta).sort(), ['body_sha256', 'duplicate', 'kid', 'signature_verified']);
  const [entry] = await h.events();
  assert.deepEqual(Object.keys(entry).sort(), ['body_sha256', 'business_id', 'checkout_id', 'kid', 'order_id', 'received_at', 'signature_verified']);
});

test('observe: the RFC 9421 signature is verified and logged; the decision is still the JWS one', async () => {
  const h = harness({ UCP_ORDER_WEBHOOK_RFC9421_MODE: 'observe' });
  const body = orderBody(3);
  const out = await h.post(signWebhook(body), body);
  assert.equal(out.status, 401, 'no Request-Signature -> refused as before');
  const [line] = rfcLogs(h.logs);
  assert.ok(line);
  assert.equal(line.verified, true, line.reason);
  assert.equal(line.mode, 'observe');
  assert.equal(line.profile_url, BUSINESS);
  assert.equal(line.keyid, 'shop-2026');
  assert.equal(line.ucp_agent_covered, false);
  assert.equal(line.webhook_id, 'evt-0001');
  assert.equal(line.has_request_signature, false);
});

test('accept: a verified RFC 9421 webhook is accepted and recorded with its signer profile', async () => {
  const h = harness({ UCP_ORDER_WEBHOOK_RFC9421_MODE: 'accept' });
  const body = orderBody(4);
  const out = await h.post(signWebhook(body, { coverUcpAgent: true }), body);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.meta.signature_verified, true);
  assert.equal(out.body.meta.signature_scheme, 'rfc9421');
  assert.equal(out.body.meta.kid, 'shop-2026');
  const [entry] = await h.events();
  assert.equal(entry.signature_scheme, 'rfc9421');
  assert.equal(entry.rfc9421_verified, true);
  assert.equal(entry.signer_profile, BUSINESS);
  assert.equal(entry.webhook_id, 'evt-0001');
  assert.equal(entry.checkout_id, 'co-4');
});

test('accept: a body changed after signing is refused 401 with digest_mismatch, before any fetch', async () => {
  const h = harness({ UCP_ORDER_WEBHOOK_RFC9421_MODE: 'accept' });
  const headers = signWebhook(orderBody(5));
  const out = await h.post(headers, orderBody(6));
  assert.equal(out.status, 401);
  assert.equal(out.body.code, 'digest_mismatch');
  assert.equal(h.fetchCalls.length, 0);
  assert.equal((await h.events()).length, 0);
});

test('accept: an untrusted business profile is refused (profile_not_trusted) and never fetched', async () => {
  const h = harness({ UCP_ORDER_WEBHOOK_RFC9421_MODE: 'accept' });
  const body = orderBody(7);
  const out = await h.post(signWebhook(body, { profile: UNTRUSTED }), body);
  assert.equal(out.status, 401);
  assert.equal(out.body.code, 'profile_not_trusted');
  assert.equal(h.fetchCalls.length, 0);
});

test('accept: a signature by another key is refused signature_invalid', async () => {
  const h = harness({ UCP_ORDER_WEBHOOK_RFC9421_MODE: 'accept' });
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const body = orderBody(8);
  const out = await h.post(signWebhook(body, { key: other }), body);
  assert.equal(out.status, 401);
  assert.equal(out.body.code, 'signature_invalid');
});

test('accept: UCP_BUSINESS_PROFILE_URL alone is also a trusted business profile', async () => {
  const h = harness({ UCP_ORDER_WEBHOOK_RFC9421_MODE: 'accept', UCP_ORDER_WEBHOOK_TRUSTED_BUSINESS_PROFILES: '', UCP_BUSINESS_PROFILE_URL: BUSINESS });
  const body = orderBody(9);
  const out = await h.post(signWebhook(body), body);
  assert.equal(out.status, 200, JSON.stringify(out.body));
});

test('accept: a webhook with a detached-JWS Request-Signature still goes through the JWS check', async () => {
  const h = harness({ UCP_ORDER_WEBHOOK_RFC9421_MODE: 'accept' });
  const body = orderBody(10);
  const headers = { ...signWebhook(body), 'request-signature': 'not-a-jws' };
  const out = await h.post(headers, body);
  assert.equal(out.status, 401);
  assert.deepEqual(out.body, { detail: 'invalid Request-Signature' });
});

test('an unknown mode reads as off', async () => {
  const h = harness({ UCP_ORDER_WEBHOOK_RFC9421_MODE: 'enforce' });
  const body = orderBody(11);
  const out = await h.post(signWebhook(body), body);
  assert.deepEqual(out.body, { detail: 'missing Request-Signature' });
  assert.equal(rfcLogs(h.logs).length, 0);
});
