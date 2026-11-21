'use strict';

// UCP request signatures on the LIVE gateway app (UCP_SIGNATURE_VERIFY_MODE, UCP_ORDER_WEBHOOK_RFC9421_MODE).
//
// What only a route-level test shows: that the observe middleware runs in front of the doors, that a signed
// request gets the SAME response as the same request unsigned (observe never refuses), that `off` is inert,
// that the exact wire bytes reach the Content-Digest check, that delegate_payment and the order webhook are
// never read by the door middleware, and that the webhook route hands the receiver what RFC 9421 needs.
//
// Conventions as tests/agent_signature_door_middleware.node.test.cjs: env before require, supertest, the
// shared pino instance wrapped, fetch stubbed (every call recorded; no real network).

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');
const supertest = require('supertest');

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
delete process.env.AGENT_SIGNATURE_VERIFY_MODE;
delete process.env.UCP_SIGNATURE_VERIFY_MODE;
delete process.env.UCP_SIGNATURE_TRUSTED_PROFILES;
delete process.env.UCP_ORDER_WEBHOOK_RFC9421_MODE;

const app = require('../src/server');
const logger = require('../src/logger');
const { signUcpRequest } = require('../src/services/ucpBuyerAgentClient');

const HOST = 'commerce.mcp.pivota.cc';
const PLATFORM_PROFILE = 'https://platform.example/.well-known/ucp-agent';
const BUSINESS_PROFILE = 'https://shop.example/.well-known/ucp';
const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'platform-test-key-1', use: 'sig' };

const fetchCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push(String(url));
  if (String(url) === PLATFORM_PROFILE) {
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ signing_keys: [JWK] }) };
  }
  if (String(url) === BUSINESS_PROFILE) {
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ ucp: { signing_keys: [JWK] } }), json: async () => ({ ucp: { signing_keys: [JWK] } }) };
  }
  return realFetch(url, init);
};
test.after(() => { globalThis.fetch = realFetch; });

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
async function captureLogs(fn) {
  const entries = [];
  const original = {};
  for (const level of LOG_LEVELS) {
    if (typeof logger[level] !== 'function') continue;
    original[level] = logger[level];
    logger[level] = (...args) => {
      entries.push(args[0]);
      return original[level].apply(logger, args);
    };
  }
  try {
    return { result: await fn(), entries };
  } finally {
    for (const [level, impl] of Object.entries(original)) logger[level] = impl;
  }
}
const ucpEvents = (entries) => entries.filter((e) => e && e.event === 'ucp_signature');

const BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

function signedHeaders(path, bodyString = BODY, { profile = PLATFORM_PROFILE } = {}) {
  const ucpAgentValue = `profile="${profile}"`;
  const now = Math.floor(Date.now() / 1000);
  const { headers } = signUcpRequest({
    method: 'POST', url: `https://${HOST}${path}`, bodyString, ucpAgentValue, keyObject: privateKey,
    keyid: 'platform-test-key-1', created: now, expires: now + 300,
  });
  return { ...headers, 'ucp-agent': ucpAgentValue };
}

function post(path, headers = {}, bodyString = BODY) {
  return supertest(app).post(path).set('host', HOST).set('content-type', 'application/json').set(headers).send(bodyString);
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}

test('off (the default): nothing is verified, logged, fetched or stashed', async () => {
  const { entries } = await captureLogs(() => post('/ucp/mcp', signedHeaders('/ucp/mcp')));
  assert.equal(ucpEvents(entries).length, 0);
  assert.equal(fetchCalls.length, 0);
  const req = { path: '/ucp/mcp', headers: { 'signature-input': 'x', 'ucp-agent': 'x' } };
  assert.equal(app._debug.shouldCaptureUcpSignedRawBody(req), false);
});

test('observe: a signed /ucp/mcp call is verified over the exact bytes, and gets the same response as unsigned', async () => {
  await withEnv({ UCP_SIGNATURE_VERIFY_MODE: 'observe', UCP_SIGNATURE_TRUSTED_PROFILES: PLATFORM_PROFILE }, async () => {
    const unsigned = await captureLogs(() => post('/ucp/mcp'));
    const signed = await captureLogs(() => post('/ucp/mcp', signedHeaders('/ucp/mcp')));
    assert.equal(signed.result.status, unsigned.result.status);
    assert.deepEqual(signed.result.body, unsigned.result.body);
    assert.equal(ucpEvents(unsigned.entries).length, 0);
    const [e] = ucpEvents(signed.entries);
    assert.ok(e, 'a ucp_signature line');
    assert.equal(e.verified, true, e.reason);
    assert.equal(e.profile_url, PLATFORM_PROFILE);
    assert.equal(e.keyid, 'platform-test-key-1');
    assert.equal(e.ucp_error, null);
    assert.equal(e.mode, 'observe');
  });
});

test('observe: a body changed after signing logs digest_mismatch and the request still goes through unchanged', async () => {
  await withEnv({ UCP_SIGNATURE_VERIFY_MODE: 'observe', UCP_SIGNATURE_TRUSTED_PROFILES: PLATFORM_PROFILE }, async () => {
    const tampered = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const unsigned = await captureLogs(() => post('/ucp/mcp', {}, tampered));
    const signed = await captureLogs(() => post('/ucp/mcp', signedHeaders('/ucp/mcp'), tampered));
    assert.equal(signed.result.status, unsigned.result.status);
    assert.deepEqual(signed.result.body, unsigned.result.body);
    const [e] = ucpEvents(signed.entries);
    assert.equal(e.verified, false);
    assert.equal(e.reason, 'digest_mismatch');
    assert.equal(e.ucp_error, 'digest_mismatch');
  });
});

test('observe: an untrusted profile is counted, never fetched', async () => {
  await withEnv({ UCP_SIGNATURE_VERIFY_MODE: 'observe', UCP_SIGNATURE_TRUSTED_PROFILES: PLATFORM_PROFILE }, async () => {
    const other = 'https://unknown-platform.example/agent.json';
    const before = fetchCalls.length;
    const { entries } = await captureLogs(() => post('/ucp/mcp', signedHeaders('/ucp/mcp', BODY, { profile: other })));
    const [e] = ucpEvents(entries);
    assert.equal(e.reason, 'profile_not_trusted');
    assert.equal(e.claimed_profile, other);
    assert.equal(fetchCalls.length, before);
  });
});

test('observe: delegate_payment is never inspected nor stashed; the order webhook is left to its receiver', async () => {
  await withEnv({ UCP_SIGNATURE_VERIFY_MODE: 'observe', UCP_SIGNATURE_TRUSTED_PROFILES: PLATFORM_PROFILE }, async () => {
    const p = '/acp/agentic_commerce/delegate_payment';
    const refusal = await captureLogs(() => post(p, signedHeaders(p)));
    assert.equal(refusal.result.status, 501);
    assert.equal(ucpEvents(refusal.entries).length, 0);
    const req = { path: p, headers: { 'signature-input': 'x', 'ucp-agent': 'x' } };
    assert.equal(app._debug.shouldCaptureUcpSignedRawBody(req), false);
    const hook = await captureLogs(() => post('/ucp/order-webhook', signedHeaders('/ucp/order-webhook')));
    assert.equal(ucpEvents(hook.entries).length, 0);
  });
});

test('webhook accept: the route hands the receiver the exact bytes and request line RFC 9421 needs', async () => {
  await withEnv({
    UCP_ORDER_WEBHOOK_RECEIVER_ENABLED: '1',
    UCP_ORDER_WEBHOOK_RFC9421_MODE: 'accept',
    UCP_ORDER_WEBHOOK_TRUSTED_BUSINESS_PROFILES: BUSINESS_PROFILE,
  }, async () => {
    // Non-canonical JSON spacing on purpose: a re-serialized body would not match the digest.
    const body = '{"id": "order-1",  "checkout_id": "co-1"}';
    const headers = signedHeaders('/ucp/order-webhook', body, { profile: BUSINESS_PROFILE });
    const { result, entries } = await captureLogs(() => post('/ucp/order-webhook', headers, body));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.meta.signature_scheme, 'rfc9421');
    const line = entries.find((x) => x && x.event === 'ucp_order_webhook_rfc9421');
    assert.equal(line.verified, true, line.reason);
    assert.equal(line.ucp_agent_covered, true);
  });
});
