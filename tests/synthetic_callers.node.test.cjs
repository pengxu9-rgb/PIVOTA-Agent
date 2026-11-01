'use strict';

// src/guardrails/syntheticCallers.js and the loopback synthetic marker, as units: who is listed, what a
// listed caller may send, the backend assertion, and the loopback marker that carries a synthetic call back
// into this process. The door wiring is covered end to end in synthetic_callers_mcp_door.node.test.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  SYNTHETIC_ASSERTION_HEADER,
  SYNTHETIC_READ_TOOLS,
  classifySyntheticCaller,
  filterToolsListForSynthetic,
  keyFingerprint,
  parseSyntheticCallers,
  syntheticCarrierReady,
  syntheticRequestRefusal,
  syntheticTrafficMode,
  withSyntheticAssertion,
} = require('../src/guardrails/syntheticCallers');
const {
  LOOPBACK_SYNTHETIC_HEADER,
  loopbackCallerHeaders,
  signLoopbackSynthetic,
  verifyLoopbackSynthetic,
} = require('../src/guardrails/loopbackCallerAssertion');

const OWN = 'https://as.pivota.test';
const OTHER = 'https://other-issuer.test';
const CID = 'mcpc_eval_1';
const listed = (extra = {}) => ({
  SYNTHETIC_CALLERS_JSON: JSON.stringify([{ iss: OWN, client_id: CID }]),
  ...extra,
});
const classify = (claims, env) => classifySyntheticCaller(claims, { env, ownIssuers: [OWN] });

test('mode: off unless exactly observe or enforce', () => {
  assert.equal(syntheticTrafficMode({}), 'off');
  assert.equal(syntheticTrafficMode({ SYNTHETIC_TRAFFIC_MODE: 'ENFORCE' }), 'enforce');
  assert.equal(syntheticTrafficMode({ SYNTHETIC_TRAFFIC_MODE: 'observe' }), 'observe');
  assert.equal(syntheticTrafficMode({ SYNTHETIC_TRAFFIC_MODE: 'on' }), 'off');
});

test('config: an entry on a foreign or missing issuer is kept as invalid, never dropped', () => {
  const { entries } = parseSyntheticCallers(
    { SYNTHETIC_CALLERS_JSON: JSON.stringify([{ iss: OWN, client_id: 'a' }, { iss: OTHER, client_id: 'b' }, { client_id: 'c' }, { iss: OWN }]) },
    { ownIssuers: [OWN] },
  );
  assert.deepEqual(entries.map((e) => [e.client_id, e.valid, e.reason]), [
    ['a', true, null],
    ['b', false, 'issuer_not_own'],
    ['c', false, 'missing_iss'],
  ]);
  assert.match(parseSyntheticCallers({ SYNTHETIC_CALLERS_JSON: '{' }).error, /not valid JSON/);
  assert.match(parseSyntheticCallers({ SYNTHETIC_CALLERS_JSON: '{}' }).error, /JSON array/);
});

test('classify: only the verified (iss, client_id) pair matches, and synthetic only in enforce', () => {
  assert.equal(classify({ iss: OWN, client_id: CID }, {}), null, 'nothing listed');
  const off = classify({ iss: OWN, client_id: CID }, listed());
  assert.deepEqual(off, { listed: true, valid: true, caller: `${OWN}|${CID}`, mode: 'off', synthetic: false });
  assert.equal(classify({ iss: OWN, client_id: CID }, listed({ SYNTHETIC_TRAFFIC_MODE: 'observe' })).synthetic, false);
  assert.equal(classify({ iss: OWN, client_id: CID }, listed({ SYNTHETIC_TRAFFIC_MODE: 'enforce' })).synthetic, true);
  assert.equal(classify({ iss: OTHER, client_id: CID }, listed({ SYNTHETIC_TRAFFIC_MODE: 'enforce' })), null, 'another issuer');
  assert.equal(classify({ iss: OWN, client_id: 'mcpc_partner' }, listed()), null, 'another client');
  assert.equal(classify({ iss: OWN, client_id: `${CID} ` }, listed()).caller, `${OWN}|${CID}`, 'trimmed like the claim reader');
  assert.equal(classify(null, listed()), null);
});

test('classify: azp alone never makes a call synthetic', () => {
  const env = listed({ SYNTHETIC_TRAFFIC_MODE: 'enforce' });
  // Another issuer minting azp = our eval client's id is an ordinary caller.
  assert.equal(classify({ iss: OTHER, azp: CID }, env), null);
  // Our own issuer naming the eval client only as azp: listed, but refused (it cannot run as an ordinary caller).
  assert.deepEqual(classify({ iss: OWN, azp: CID }, env), { listed: true, valid: false, reason: 'client_id_claim_missing' });
  // client_id wins over azp, exactly as the door's claim reader does.
  assert.equal(classify({ iss: OWN, client_id: 'mcpc_partner', azp: CID }, env), null);
});

test('classify: a listed entry on a foreign issuer refuses its own tokens (fail closed)', () => {
  const env = { SYNTHETIC_CALLERS_JSON: JSON.stringify([{ iss: OTHER, client_id: CID }]), SYNTHETIC_TRAFFIC_MODE: 'enforce' };
  assert.deepEqual(classify({ iss: OTHER, client_id: CID }, env), { listed: true, valid: false, reason: 'issuer_not_own' });
});

test('allowlist: handshake methods and the five read tools pass; everything else is refused', () => {
  const call = (name) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
  for (const name of SYNTHETIC_READ_TOOLS) assert.equal(syntheticRequestRefusal(call(name)), null, name);
  assert.equal(SYNTHETIC_READ_TOOLS.size, 5);
  for (const name of [
    'create_checkout_session', 'update_checkout_session', 'complete_checkout_session', 'cancel_checkout_session',
    'create_payment_link', 'request_after_sales', 'start_purchase', 'get_order', 'get_checkout_session',
    'recommend_products', 'search_catalog ', 'SEARCH_CATALOG', 'tomorrows_new_tool',
  ]) {
    assert.equal(syntheticRequestRefusal(call(name))?.reason, 'tool_not_allowed', name);
  }
  for (const method of ['initialize', 'notifications/initialized', 'ping', 'tools/list']) {
    assert.equal(syntheticRequestRefusal({ jsonrpc: '2.0', id: 1, method }), null, method);
  }
  assert.equal(syntheticRequestRefusal({ jsonrpc: '2.0', id: 1, method: 'resources/list' }).reason, 'method_not_allowed');
});

test('allowlist: malformed bodies are refused, including a name that only stringifies to an allowed one', () => {
  const r = (body) => syntheticRequestRefusal(body)?.reason;
  assert.equal(r([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]), 'body_not_single_object', 'batch');
  assert.equal(r(null), 'body_not_single_object');
  assert.equal(r('tools/list'), 'body_not_single_object');
  assert.equal(r({ jsonrpc: '2.0', id: 1 }), 'method_not_allowed', 'missing method');
  assert.equal(r({ jsonrpc: '2.0', id: 1, method: ['tools/list'] }), 'method_not_allowed');
  assert.equal(r({ jsonrpc: '2.0', id: 1, method: 'tools/call' }), 'tool_not_allowed', 'missing params');
  assert.equal(r({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: [] }), 'tool_not_allowed');
  assert.equal(r({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { arguments: {} } }), 'tool_not_allowed', 'missing name');
  assert.equal(r({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: ['search_catalog'] } }), 'tool_not_allowed');
});

test('allowlist: the UCP dialect refuses a listed caller outright; an invalid entry refuses every tools/call', () => {
  assert.equal(syntheticRequestRefusal({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { dialect: 'ucp' }).reason, 'dialect_not_allowed');
  const invalid = { listed: true, valid: false, reason: 'issuer_not_own' };
  const search = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_catalog' } };
  assert.equal(syntheticRequestRefusal(search, { classification: invalid }).reason, 'config_invalid');
  assert.equal(syntheticRequestRefusal({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { classification: invalid }), null);
});

test('tools/list is narrowed to the five read tools; any other shape passes through', () => {
  const out = { status: 200, body: { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'search_catalog' }, { name: 'create_payment_link' }, { name: 'get_offers' }, {}] } } };
  assert.deepEqual(filterToolsListForSynthetic(out).body.result.tools.map((t) => t.name), ['search_catalog', 'get_offers']);
  assert.equal(out.body.result.tools.length, 4, 'the adapter answer is not mutated');
  const err = { status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32601 } } };
  assert.equal(filterToolsListForSynthetic(err), err);
});

function decodeAssertion(value, secret) {
  const [version, body, mac] = String(value).split('.');
  assert.equal(version, 'v1');
  assert.equal(mac, crypto.createHmac('sha256', secret).update(`${version}.${body}`).digest('base64url'));
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

test('backend assertion: only on a synthetic context with a secret, bound to the key these headers send', () => {
  const env = { SYNTHETIC_ASSERTION_SECRET: 'syn-secret' };
  const ctx = { synthetic: true, synthetic_caller: `${OWN}|${CID}`, gw_request_id: 'req-1' };
  const headers = { 'X-API-Key': 'gateway-service-key', Authorization: 'Bearer gateway-service-key' };

  assert.equal(withSyntheticAssertion(headers, { ...ctx, synthetic: false }, { env }), headers, 'real call: untouched');
  assert.equal(withSyntheticAssertion(headers, null, { env }), headers);
  assert.equal(withSyntheticAssertion(headers, ctx, { env: {} }), headers, 'no secret: nothing added');
  assert.equal(syntheticCarrierReady({}), false);
  assert.equal(syntheticCarrierReady(env), true);

  const out = withSyntheticAssertion(headers, ctx, { env, nowSec: 1_800_000_000 });
  assert.equal(out['X-API-Key'], 'gateway-service-key');
  const p = decodeAssertion(out[SYNTHETIC_ASSERTION_HEADER], 'syn-secret');
  assert.equal(p.c, `${OWN}|${CID}`);
  assert.equal(p.r, 'req-1');
  assert.equal(p.iat, 1_800_000_000);
  assert.equal(p.kfp, keyFingerprint('gateway-service-key'));
  assert.equal(p.kfp, crypto.createHash('sha256').update('gateway-service-key').digest('hex').slice(0, 32));
  assert.match(p.jti, /^[A-Za-z0-9_-]{16}$/);

  const again = decodeAssertion(withSyntheticAssertion(headers, ctx, { env })[SYNTHETIC_ASSERTION_HEADER], 'syn-secret');
  assert.notEqual(again.jti, p.jti, 'each build is a fresh assertion');

  const checkout = withSyntheticAssertion({ 'X-Checkout-Token': 'ct' }, ctx, { env });
  assert.equal(decodeAssertion(checkout[SYNTHETIC_ASSERTION_HEADER], 'syn-secret').kfp, null, 'no key, no fingerprint');
});

// A loopback request as the invoke route sees it: a socket address, and no X-Forwarded-For.
function loopbackReq(headers, remoteAddress = '127.0.0.1') {
  return { headers, socket: { remoteAddress }, ip: remoteAddress };
}

test('loopback marker: emitted for a synthetic context whatever the limits mode, and verified back', () => {
  const ctx = { synthetic: true, synthetic_caller: `${OWN}|${CID}`, gw_request_id: 'req-9' };
  const headers = loopbackCallerHeaders(ctx, { env: { MCP_CALLER_LIMITS_MODE: 'off' } });
  assert.ok(headers[LOOPBACK_SYNTHETIC_HEADER], 'sent with limits off');
  assert.equal(headers['X-Pivota-Loopback-Caller'], undefined, 'the limits header still is not');
  const got = verifyLoopbackSynthetic(loopbackReq({ [LOOPBACK_SYNTHETIC_HEADER.toLowerCase()]: headers[LOOPBACK_SYNTHETIC_HEADER] }));
  assert.deepEqual(got, { synthetic_caller: `${OWN}|${CID}`, gw_request_id: 'req-9' });
  assert.deepEqual(loopbackCallerHeaders({ ...ctx, synthetic: false }, { env: { MCP_CALLER_LIMITS_MODE: 'off' } }), {});
});

test('loopback marker: refused from outside, forged, expired or malformed', () => {
  const h = LOOPBACK_SYNTHETIC_HEADER.toLowerCase();
  const good = signLoopbackSynthetic({ caller: 'c', requestId: 'r' });
  assert.equal(verifyLoopbackSynthetic(loopbackReq({ [h]: good }, '203.0.113.5')), null, 'not a loopback socket');
  assert.equal(verifyLoopbackSynthetic(loopbackReq({ [h]: good, 'x-forwarded-for': '203.0.113.5' })), null, 'routed in from outside');
  assert.equal(verifyLoopbackSynthetic(loopbackReq({ [h]: signLoopbackSynthetic({ caller: 'c', requestId: 'r' }, { secret: crypto.randomBytes(32) }) })), null, 'another process');
  const old = signLoopbackSynthetic({ caller: 'c', requestId: 'r' }, { nowSec: Math.floor(Date.now() / 1000) - 120 });
  assert.equal(verifyLoopbackSynthetic(loopbackReq({ [h]: old })), null, 'outside the window');
  assert.equal(verifyLoopbackSynthetic(loopbackReq({ [h]: 'v1.e30.AAAA' })), null);
  assert.equal(verifyLoopbackSynthetic(loopbackReq({})), null);
});
