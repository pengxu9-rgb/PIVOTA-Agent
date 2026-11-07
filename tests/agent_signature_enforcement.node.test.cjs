'use strict';

// Enforce-mode policy (src/services/agentSignatureEnforcement.js), driven by REAL verification results:
// every signed request below is made with signTapRequest and checked by createAgentSignatureVerifier, so
// the decision table is exercised with what the verifier actually returns for valid, invalid, expired,
// replayed and unknown-key signatures, not with hand-made result objects.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');
const { signTapRequest } = require('../src/services/tapSigner');
const { createAgentSignatureVerifier } = require('../src/services/agentSignatureVerifier');
const {
  ROUTE_GROUP,
  claimsTapTag,
  loadEnforcementConfig,
  merchantIdFromRpcBody,
  decideAgentSignatureEnforcement,
  enforcementErrorBody,
} = require('../src/services/agentSignatureEnforcement');

const HOST = 'commerce.mcp.pivota.cc';
const VISA_URL = 'https://mcp.visa.com/.well-known/jwks';
const T0 = 1_790_000_000;

const visa = nodeCrypto.generateKeyPairSync('ed25519');
const stranger = nodeCrypto.generateKeyPairSync('ed25519');
const JWKS = { keys: [{ ...visa.publicKey.export({ format: 'jwk' }), kid: 'visa-k1' }] };

function makeVerifier(now = T0) {
  const fetchImpl = async (url) => (url === VISA_URL
    ? { status: 200, text: async () => JSON.stringify(JWKS) }
    : { status: 404, text: async () => '' });
  return createAgentSignatureVerifier({ env: {}, fetchImpl, nowMs: () => now * 1000 });
}

function signed(path, opts = {}) {
  const { headers } = signTapRequest({ url: `https://${HOST}${path}`, privateKey: visa.privateKey, keyid: 'visa-k1', created: T0, ...opts });
  return { method: 'POST', originalUrl: path, headers: { host: HOST, ...headers } };
}

const ENFORCE_ALL = loadEnforcementConfig({ AGENT_SIGNATURE_ENFORCE_ROUTE_GROUPS: 'merchant_doors,checkout' });

async function decide(verifier, req, { config = ENFORCE_ALL, mode = 'enforce', routeGroup = ROUTE_GROUP.CHECKOUT, merchantId = null } = {}) {
  const result = req.headers['signature-input'] === undefined ? null : await verifier.verifyRequest(req);
  return { result, decision: decideAgentSignatureEnforcement({ mode, config, routeGroup, merchantId, result, tapClaimed: claimsTapTag(req.headers) }) };
}

// ---- the five signature outcomes ----------------------------------------------------------------------

test('valid TAP signature: passes and carries the verified identity (authority, keyid, tag)', async () => {
  const { result, decision } = await decide(makeVerifier(), signed('/acp/checkout_sessions', { tag: 'agent-payer-auth' }));
  assert.equal(result.verified, true, result.reason);
  assert.equal(decision.action, 'pass');
  assert.equal(decision.reason, 'verified_tap');
  assert.deepEqual(
    { protocol: decision.identity.protocol, authority: decision.identity.authority, keyid: decision.identity.keyid, tag: decision.identity.tag, agent: decision.identity.agent },
    { protocol: 'visa-tap', authority: HOST, keyid: 'visa-k1', tag: 'agent-payer-auth', agent: 'visa' },
  );
  assert.ok(Object.isFrozen(decision.identity));
});

test('invalid TAP signature (signed for another path): 401 AGENT_SIGNATURE_INVALID', async () => {
  const req = signed('/acp/checkout_sessions');
  req.originalUrl = '/acp/checkout_sessions/cs_1/complete';
  const { result, decision } = await decide(makeVerifier(), req);
  assert.equal(result.reason, 'bad_signature');
  assert.equal(decision.action, 'reject');
  assert.equal(decision.status, 401);
  assert.equal(decision.code, 'AGENT_SIGNATURE_INVALID');
  assert.equal(decision.reason, 'bad_signature');
  assert.equal(decision.identity, null);
});

test('expired TAP signature: 401', async () => {
  const { result, decision } = await decide(makeVerifier(), signed('/mcp', { created: T0 - 1000, expires: T0 - 700 }));
  assert.equal(result.reason, 'expired');
  assert.equal(decision.status, 401);
  assert.equal(decision.reason, 'expired');
});

test('replayed TAP signature: the first use passes, the replay is 401 nonce_replay', async () => {
  const verifier = makeVerifier();
  const req = signed('/mcp', { nonce: 'once-only' });
  const first = await decide(verifier, req);
  assert.equal(first.decision.action, 'pass');
  const replay = await decide(verifier, { ...req, headers: { ...req.headers } });
  assert.equal(replay.result.reason, 'nonce_replay');
  assert.equal(replay.decision.status, 401);
  assert.equal(replay.decision.reason, 'nonce_replay');
});

test('unknown-key TAP signature (kid not in Visa\'s JWKS, or right kid with a stranger\'s key): 401', async () => {
  const verifier = makeVerifier();
  const unknownKid = signTapRequest({ url: `https://${HOST}/mcp`, privateKey: stranger.privateKey, keyid: 'not-visa', created: T0 });
  const a = await decide(verifier, { method: 'POST', originalUrl: '/mcp', headers: { host: HOST, ...unknownKid.headers } });
  assert.equal(a.result.reason, 'unknown_key');
  assert.equal(a.decision.status, 401);
  const wrongKey = signTapRequest({ url: `https://${HOST}/mcp`, privateKey: stranger.privateKey, keyid: 'visa-k1', created: T0 });
  const b = await decide(verifier, { method: 'POST', originalUrl: '/mcp', headers: { host: HOST, ...wrongKey.headers } });
  assert.equal(b.result.reason, 'bad_signature');
  assert.equal(b.decision.status, 401);
});

// ---- what enforce does NOT refuse ---------------------------------------------------------------------

test('unsigned and non-TAP signed requests pass under enforce', async () => {
  const verifier = makeVerifier();
  const unsigned = await decide(verifier, { method: 'POST', originalUrl: '/mcp', headers: { host: HOST } });
  assert.equal(unsigned.decision.action, 'pass');
  assert.equal(unsigned.decision.reason, 'unsigned');
  // A Web Bot Auth / unknown-tag signature is not a TAP claim, whatever it verifies to.
  const otherTag = signed('/mcp', { tag: 'web-bot-auth' });
  const other = await decide(verifier, otherTag);
  assert.equal(other.result.verified, false);
  assert.equal(other.decision.action, 'pass');
  assert.equal(other.decision.reason, 'not_a_tap_claim');
  // The ACP adapter's lone HMAC `Signature` header.
  const hmac = await decide(verifier, { method: 'POST', originalUrl: '/acp/checkout_sessions', headers: { host: HOST, signature: 'deadbeef' } });
  assert.equal(hmac.decision.action, 'pass');
});

test('a TAP claim we could not CHECK passes unverified on a route group, but is a retryable 503 under tap_only', () => {
  const config = loadEnforcementConfig({ AGENT_SIGNATURE_ENFORCE_ROUTE_GROUPS: 'checkout', AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON: '{"m_tap":"tap_only"}' });
  for (const reason of ['verification_timeout', 'key_source_unavailable', 'verifier_error', 'nonce_store_full']) {
    const result = { present: true, verified: false, reason };
    const group = decideAgentSignatureEnforcement({ mode: 'enforce', config, routeGroup: 'checkout', merchantId: null, result, tapClaimed: true });
    assert.equal(group.action, 'pass', reason);
    assert.equal(group.identity, null);
    const tapOnly = decideAgentSignatureEnforcement({ mode: 'enforce', config, routeGroup: 'checkout', merchantId: 'm_tap', result, tapClaimed: true });
    assert.equal(tapOnly.status, 503, reason);
    assert.equal(tapOnly.code, 'AGENT_SIGNATURE_UNAVAILABLE');
  }
});

test('a TAP claim whose headers do not parse is still a claim (401 on an enforced group)', async () => {
  const req = signed('/mcp');
  req.headers.signature = 'not a dictionary ((';
  const { result, decision } = await decide(makeVerifier(), req);
  assert.equal(result.reason, 'malformed_signature_headers');
  assert.equal(decision.status, 401);
});

// ---- scope: route groups and merchant opt-ins -----------------------------------------------------------

test('enforce with no route groups and no opt-ins refuses nothing (it is observe)', async () => {
  const empty = loadEnforcementConfig({});
  const req = signed('/acp/checkout_sessions');
  req.originalUrl = '/acp/other';
  const { decision } = await decide(makeVerifier(), req, { config: empty });
  assert.equal(decision.action, 'pass');
  assert.equal(decision.reason, 'scope_not_enforced');
  assert.equal(decision.enforced, false);
});

test('route groups are independent: checkout-only enforcement leaves merchant doors alone', async () => {
  const checkoutOnly = loadEnforcementConfig({ AGENT_SIGNATURE_ENFORCE_ROUTE_GROUPS: ' Checkout ,nonsense' });
  assert.deepEqual([...checkoutOnly.routeGroups], ['checkout']);
  const forged = () => {
    const req = signed('/mcp');
    req.originalUrl = '/ucp/mcp';
    return req;
  };
  const doors = await decide(makeVerifier(), forged(), { config: checkoutOnly, routeGroup: ROUTE_GROUP.MERCHANT_DOORS });
  assert.equal(doors.decision.action, 'pass');
  const checkout = await decide(makeVerifier(), forged(), { config: checkoutOnly, routeGroup: ROUTE_GROUP.CHECKOUT });
  assert.equal(checkout.decision.status, 401);
});

test('merchant opt-in: `enforce` refuses its forged TAP claims; `tap_only` refuses everything but verified TAP', async () => {
  const config = loadEnforcementConfig({ AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON: JSON.stringify({ m_enf: 'enforce', m_tap: 'TAP_ONLY', m_bad: 'block', '': 'tap_only' }) });
  assert.deepEqual([...config.merchantPolicies.entries()], [['m_enf', 'enforce'], ['m_tap', 'tap_only']]);
  assert.equal(config.hasTapOnly, true);
  const verifier = makeVerifier();
  const forged = () => {
    const req = signed('/mcp');
    req.originalUrl = '/ucp/mcp';
    return req;
  };
  const unsignedReq = { method: 'POST', originalUrl: '/mcp', headers: { host: HOST } };
  const opts = (merchantId) => ({ config, routeGroup: ROUTE_GROUP.MERCHANT_DOORS, merchantId });

  assert.equal((await decide(verifier, forged(), opts('m_enf'))).decision.status, 401);
  assert.equal((await decide(verifier, unsignedReq, opts('m_enf'))).decision.action, 'pass');
  assert.equal((await decide(verifier, forged(), opts('m_other'))).decision.action, 'pass', 'route group not enforced, merchant not opted in');

  const tapOnlyUnsigned = (await decide(verifier, unsignedReq, opts('m_tap'))).decision;
  assert.equal(tapOnlyUnsigned.status, 401);
  assert.equal(tapOnlyUnsigned.code, 'AGENT_SIGNATURE_REQUIRED');
  assert.equal(tapOnlyUnsigned.reason, 'tap_signature_required');
  assert.equal((await decide(verifier, forged(), opts('m_tap'))).decision.code, 'AGENT_SIGNATURE_REQUIRED');
  assert.equal((await decide(verifier, signed('/mcp', { tag: 'web-bot-auth' }), opts('m_tap'))).decision.status, 401, 'another profile is not TAP');
  const ok = (await decide(verifier, signed('/mcp'), opts('m_tap'))).decision;
  assert.equal(ok.action, 'pass');
  assert.equal(ok.identity.keyid, 'visa-k1');
});

test('observe and off never refuse and never attach an identity, whatever the config', async () => {
  const config = loadEnforcementConfig({ AGENT_SIGNATURE_ENFORCE_ROUTE_GROUPS: 'merchant_doors,checkout', AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON: '{"m":"tap_only"}' });
  for (const mode of ['observe', 'off']) {
    const forged = signed('/mcp');
    forged.originalUrl = '/ucp/mcp';
    assert.equal((await decide(makeVerifier(), forged, { mode, config, merchantId: 'm' })).decision.action, 'pass', mode);
    const valid = await decide(makeVerifier(), signed('/mcp'), { mode, config });
    assert.equal(valid.decision.identity, null, mode);
  }
});

// ---- helpers --------------------------------------------------------------------------------------------

test('config parsing fails safe: bad JSON and arrays give no opt-ins', () => {
  const warnings = [];
  const log = { warn: (o, m) => warnings.push(m) };
  assert.equal(loadEnforcementConfig({ AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON: '{nope' }, log).merchantPolicies.size, 0);
  assert.equal(warnings.length, 1);
  assert.equal(loadEnforcementConfig({ AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON: '["m"]' }).merchantPolicies.size, 0);
  assert.equal(loadEnforcementConfig({ AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON: JSON.stringify({ ['m'.repeat(200)]: 'tap_only' }) }).merchantPolicies.size, 0);
  assert.equal(loadEnforcementConfig({ AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON: '{"m":"enforce"}' }).hasTapOnly, false);
});

test('claimsTapTag reads Signature-Input only, for both TAP tags', () => {
  assert.equal(claimsTapTag({}), false);
  assert.equal(claimsTapTag({ signature: 'x' }), false);
  assert.equal(claimsTapTag({ 'signature-input': 'sig1=("@authority");tag="web-bot-auth"' }), false);
  assert.equal(claimsTapTag({ 'signature-input': 'sig2=("@authority");tag="agent-browser-auth"' }), true);
  assert.equal(claimsTapTag({ 'signature-input': ['a=();tag="x"', 'b=();tag="agent-payer-auth"'] }), true);
});

test('merchantIdFromRpcBody: one call, a batch naming one merchant, and a mixed batch', () => {
  const call = (id) => ({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'create_checkout_session', arguments: { merchant_id: id } } });
  assert.equal(merchantIdFromRpcBody(call(' m1 ')), 'm1');
  assert.equal(merchantIdFromRpcBody([call('m1'), call('m1')]), 'm1');
  assert.equal(merchantIdFromRpcBody([call('m1'), call('m2')]), null);
  assert.equal(merchantIdFromRpcBody({ items: [] }), null);
  assert.equal(merchantIdFromRpcBody(undefined), null);
  assert.equal(merchantIdFromRpcBody(call(42)), null);
});

test('the error body names the code and reason and echoes nothing else', () => {
  const body = enforcementErrorBody({ code: 'AGENT_SIGNATURE_INVALID', reason: 'bad_signature' });
  assert.deepEqual(Object.keys(body).sort(), ['error', 'message', 'reason']);
  assert.equal(body.error, 'AGENT_SIGNATURE_INVALID');
});
