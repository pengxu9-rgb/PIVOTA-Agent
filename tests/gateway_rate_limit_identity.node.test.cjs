'use strict';

// The gateway rate limiter keys ONLY on identity the gateway verified (req.invokeAuth), else the client
// IP our own load balancer observed. Nothing the request says about itself — credential-looking headers,
// metadata.source, the left of X-Forwarded-For — may select a bucket or an exemption.
//
// Every guard in src/guardrails/gatewayGuardrails.js (verifiedClientIdentity, clientIpFromRequest,
// shouldBypassRateLimit, the session tier) has a test here that fails when the guard is removed.

const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATH = require.resolve('../src/guardrails/gatewayGuardrails');
const ENV_KEYS = [
  'GATEWAY_RATE_LIMIT_ENABLED',
  'GATEWAY_RATE_LIMIT_CAPACITY',
  'GATEWAY_RATE_LIMIT_REFILL_PER_SEC',
  'GATEWAY_RATE_LIMIT_TRUSTED_PROXY_HOPS',
  'GATEWAY_RATE_LIMIT_BYPASS_AGENT_IDS',
  'GATEWAY_RATE_LIMIT_BYPASS_SOURCES',
];
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// A fresh module per test: the buckets are module state.
function loadGuardrails() {
  delete require.cache[MODULE_PATH];
  return require(MODULE_PATH);
}

test.beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATEWAY_RATE_LIMIT_ENABLED = 'true';
  // An operation with no tuned limit uses these: 10 tokens, effectively no refill inside a test.
  process.env.GATEWAY_RATE_LIMIT_CAPACITY = '10';
  process.env.GATEWAY_RATE_LIMIT_REFILL_PER_SEC = '0.1';
});

test.after(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[MODULE_PATH];
});

const OP = 'unknown_op'; // base limits: capacity 10
const LB_IP = '34.8.67.235';

// A request as it arrives through the load balancer from `clientIp`.
function lbReq(clientIp, extra = {}) {
  return {
    headers: { 'x-forwarded-for': `${clientIp}, ${LB_IP}`, ...(extra.headers || {}) },
    socket: { remoteAddress: '169.254.1.1' },
    ip: '169.254.1.1',
    ...(extra.invokeAuth ? { invokeAuth: extra.invokeAuth } : {}),
  };
}

// Sends `count` requests built by makeReq(i); returns how many were admitted.
function admitted(guardrails, count, makeReq, { metadata = {}, operation = OP } = {}) {
  let ok = 0;
  for (let i = 0; i < count; i += 1) {
    const out = guardrails.applyGatewayGuardrails({ req: makeReq(i), operation, payload: {}, effectivePayload: {}, metadata });
    if (!out.blocked) ok += 1;
    else {
      assert.equal(out.blocked.status, 429);
      assert.equal(out.blocked.body.error, 'RATE_LIMITED');
    }
  }
  return ok;
}

const apiKeyAuth = (agentId, keyFingerprint = 'fp_default') => ({
  auth_mode: 'api_key',
  auth_source: 'authorization',
  agent_id: agentId,
  key_fingerprint: keyFingerprint,
  raw_token: 'ak_live_x',
});

// The shape authenticateCheckoutTokenOnly writes once the backend has vouched for the token.
const verifiedCheckoutAuth = (tokenFingerprint, agentId = 'agent_ct') => ({
  auth_mode: 'checkout_token',
  auth_source: 'x-checkout-token',
  agent_id: agentId,
  key_fingerprint: null,
  checkout_token_fingerprint: tokenFingerprint,
});

// ---------------------------------------------------------------- unverified input never selects a bucket

for (const header of ['x-agent-api-key', 'authorization', 'x-checkout-token']) {
  test(`an unverified ${header} header does not select a bucket`, () => {
    const g = loadGuardrails();
    const n = admitted(g, 15, (i) => lbReq('203.0.113.9', { headers: { [header]: `junk-${i}` } }));
    assert.equal(n, 10, 'one client rotating the header value must share one bucket');
  });
}

test('metadata.source does not select a bucket', () => {
  const g = loadGuardrails();
  let ok = 0;
  for (let i = 0; i < 15; i += 1) {
    ok += admitted(g, 1, () => lbReq('203.0.113.9'), { metadata: { source: `source-${i}` } });
  }
  assert.equal(ok, 10);
});

test('a checkout_token verdict with no agent_id is not identity (never verified)', () => {
  const g = loadGuardrails();
  const n = admitted(g, 25, (i) =>
    lbReq('203.0.113.9', { invokeAuth: { auth_mode: 'checkout_token', agent_id: null, checkout_token_fingerprint: `tok_${i}` } }),
  );
  // Neither a bucket per token nor the session tier's doubled capacity.
  assert.equal(n, 10);
});

test('a checkout_token verdict with no token fingerprint is not identity', () => {
  const g = loadGuardrails();
  const n = admitted(g, 25, () => lbReq('203.0.113.9', { invokeAuth: { auth_mode: 'checkout_token', agent_id: 'agent_ct' } }));
  assert.equal(n, 10, 'no session tier (2x) without the fingerprint of a verified token');
});

test('the test-bypass auth mode is not identity', () => {
  const g = loadGuardrails();
  const n = admitted(g, 15, (i) =>
    lbReq('203.0.113.9', { invokeAuth: { auth_mode: 'test_bypass', agent_id: `agent_${i}`, key_fingerprint: `fp_${i}` } }),
  );
  assert.equal(n, 10);
});

// ---------------------------------------------------------------- verified identity

test('a verified API key is keyed on its agent: all of one agent\'s keys share a budget', () => {
  const g = loadGuardrails();
  const n = admitted(g, 15, (i) => lbReq(`198.51.100.${i + 1}`, { invokeAuth: apiKeyAuth('agent_a', `fp_${i}`) }));
  assert.equal(n, 10);
});

test('different verified agents get independent budgets, even from one IP', () => {
  const g = loadGuardrails();
  assert.equal(admitted(g, 12, () => lbReq('34.96.52.90', { invokeAuth: apiKeyAuth('agent_a') })), 10);
  assert.equal(admitted(g, 12, () => lbReq('34.96.52.90', { invokeAuth: apiKeyAuth('agent_b') })), 10);
  // And neither spent the anonymous budget of that IP.
  assert.equal(admitted(g, 12, () => lbReq('34.96.52.90')), 10);
});

test('a verified API key with no agent_id is keyed on its fingerprint', () => {
  const g = loadGuardrails();
  assert.equal(admitted(g, 12, () => lbReq('34.96.52.90', { invokeAuth: apiKeyAuth(null, 'fp_one') })), 10);
  assert.equal(admitted(g, 12, () => lbReq('34.96.52.90', { invokeAuth: apiKeyAuth(null, 'fp_two') })), 10);
});

test('an X-Checkout-Token beside a verified API key does not move the bucket', () => {
  const g = loadGuardrails();
  const n = admitted(g, 15, (i) =>
    lbReq('34.96.52.90', { headers: { 'x-checkout-token': `junk-${i}` }, invokeAuth: apiKeyAuth('agent_a') }),
  );
  assert.equal(n, 10);
});

test('a verified checkout token is its own session-tier bucket with doubled capacity', () => {
  const g = loadGuardrails();
  assert.equal(admitted(g, 25, () => lbReq('34.96.52.90', { invokeAuth: verifiedCheckoutAuth('tok_1') })), 20);
  assert.equal(admitted(g, 25, () => lbReq('34.96.52.90', { invokeAuth: verifiedCheckoutAuth('tok_2') })), 20);
});

// ---------------------------------------------------------------- the client IP

test('client IP is the entry our load balancer appended, not the caller-written left of X-Forwarded-For', () => {
  const g = loadGuardrails();
  const n = admitted(g, 15, (i) => ({
    headers: { 'x-forwarded-for': `10.0.0.${i}, 192.0.2.${i}, 203.0.113.9, ${LB_IP}` },
    socket: { remoteAddress: '169.254.1.1' },
  }));
  assert.equal(n, 10);
});

test('distinct clients behind the load balancer get distinct buckets', () => {
  const g = loadGuardrails();
  assert.equal(admitted(g, 12, () => lbReq('203.0.113.9')), 10);
  assert.equal(admitted(g, 12, () => lbReq('203.0.113.10')), 10);
});

test('GATEWAY_RATE_LIMIT_TRUSTED_PROXY_HOPS moves the trusted entry', () => {
  process.env.GATEWAY_RATE_LIMIT_TRUSTED_PROXY_HOPS = '1';
  const g = loadGuardrails();
  // With one trusted hop the right-most entry is the client; everything left of it is caller text.
  const n = admitted(g, 15, (i) => ({ headers: { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.9` } }));
  assert.equal(n, 10);
  assert.equal(g.__test__.clientIpFromRequest({ headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' } }), '203.0.113.9');
});

test('a non-IP entry is not an identity: it falls back to the socket peer', () => {
  const g = loadGuardrails();
  // Full-length chains, so the non-IP entry sits exactly where the edge's client address would.
  const n = admitted(g, 15, (i) => ({
    headers: { 'x-forwarded-for': `not-an-ip-${i}, ${LB_IP}` },
    socket: { remoteAddress: '169.254.1.1' },
  }));
  assert.equal(n, 10);
  assert.equal(
    g.__test__.clientIpFromRequest({ headers: { 'x-forwarded-for': `nope, ${LB_IP}` }, socket: { remoteAddress: '::ffff:10.1.2.3' } }),
    '10.1.2.3',
  );
});

// A chain shorter than the trusted hop count did not come through our load balancer (only a caller inside
// the VPC can send one), so every entry in it may be the caller's own text.
test('a chain shorter than the trusted hops keys on the socket peer, not on its caller-written entry', () => {
  const g = loadGuardrails();
  assert.equal(
    g.__test__.clientIpFromRequest({ headers: { 'x-forwarded-for': '198.51.100.9' }, socket: { remoteAddress: '10.8.0.5' } }),
    '10.8.0.5',
  );
  // One VPC caller rotating the single entry stays in one bucket.
  const n = admitted(g, 15, (i) => ({
    headers: { 'x-forwarded-for': `198.51.100.${i + 1}` },
    socket: { remoteAddress: '10.8.0.5' },
  }));
  assert.equal(n, 10);
});

test('a chain exactly as long as the trusted hops is edge-attested and keys on its client entry', () => {
  const g = loadGuardrails();
  assert.equal(
    g.__test__.clientIpFromRequest({ headers: { 'x-forwarded-for': `203.0.113.9, ${LB_IP}` }, socket: { remoteAddress: '169.254.1.1' } }),
    '203.0.113.9',
  );
});

test('an IPv4-mapped spelling is the same host', () => {
  const g = loadGuardrails();
  let ok = admitted(g, 6, () => lbReq('203.0.113.9'));
  ok += admitted(g, 6, () => lbReq('::ffff:203.0.113.9'));
  assert.equal(ok, 10);
});

// ---------------------------------------------------------------- exemptions

test('metadata.source can no longer exempt a caller', () => {
  process.env.GATEWAY_RATE_LIMIT_BYPASS_SOURCES = 'partner';
  const g = loadGuardrails();
  assert.equal(admitted(g, 15, () => lbReq('203.0.113.9'), { metadata: { source: 'partner' } }), 10);
});

test('GATEWAY_RATE_LIMIT_BYPASS_AGENT_IDS exempts a verified agent', () => {
  process.env.GATEWAY_RATE_LIMIT_BYPASS_AGENT_IDS = 'agent_proxy, other';
  const g = loadGuardrails();
  assert.equal(admitted(g, 30, () => lbReq('34.96.52.90', { invokeAuth: apiKeyAuth('agent_proxy') })), 30);
  assert.equal(admitted(g, 15, () => lbReq('34.96.52.90', { invokeAuth: apiKeyAuth('agent_other') })), 10);
});

test('GATEWAY_RATE_LIMIT_BYPASS_AGENT_IDS cannot be matched by an unverified claim', () => {
  process.env.GATEWAY_RATE_LIMIT_BYPASS_AGENT_IDS = 'agent_proxy';
  const g = loadGuardrails();
  const n = admitted(
    g,
    15,
    () =>
      lbReq('203.0.113.9', {
        headers: { 'x-agent-id': 'agent_proxy' },
        invokeAuth: { auth_mode: 'checkout_token', agent_id: 'agent_proxy' }, // no verified token fingerprint
      }),
    { metadata: { agent_id: 'agent_proxy', source: 'agent_proxy' } },
  );
  assert.equal(n, 10);
});
