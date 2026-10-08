'use strict';

// Inbound agent-signature verification (agentSignatureVerifier.js + httpMessageSignatures.js).
//
// Independence: every signature below is made over a signature base written out LITERALLY in the test
// and signed with node:crypto — not built with the module's own buildSignatureBase — so a bug in the base
// builder cannot sign and verify its own mistake. The RFC 9421 B.2.6 vector and the RFC 8037 A.3
// thumbprint are external ground truth for the same reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');
const { createAgentSignatureVerifier, agentSignatureMode, loadKeySources, resolveSignatureAgent, DEFAULT_KEY_SOURCES } = require('../src/services/agentSignatureVerifier');
const { requestView, buildSignatureBase, verifySignature, importPublicJwk, jwkThumbprint } = require('../src/services/httpMessageSignatures');
const { parseDictionary } = require('../src/services/httpStructuredFields');

const HOST = 'commerce.mcp.pivota.cc';
const VISA_URL = 'https://mcp.visa.com/.well-known/jwks';
const T0 = 1_790_000_000; // seconds

// ---- helpers ----------------------------------------------------------------------------------------

function keypair(type, opts) {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync(type, opts);
  return { publicJwk: publicKey.export({ format: 'jwk' }), privateKey };
}

function sign(base, privateKey, kind) {
  const data = Buffer.from(base, 'utf8');
  if (kind === 'ed25519') return nodeCrypto.sign(null, data, privateKey);
  if (kind === 'es256') return nodeCrypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  if (kind === 'ps256') return nodeCrypto.sign('sha256', data, { key: privateKey, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  throw new Error(kind);
}

function fetchStub(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (typeof r === 'function') return r();
    if (!r) return { status: 404, text: async () => '' };
    return { status: r.status || 200, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { impl, calls };
}

function makeVerifier({ routes, sources, now = () => T0 * 1000 }) {
  const env = sources ? { AGENT_SIGNATURE_TRUSTED_KEY_SOURCES_JSON: JSON.stringify(sources) } : {};
  const stub = fetchStub(routes);
  const verifier = createAgentSignatureVerifier({ env, fetchImpl: stub.impl, nowMs: now });
  return { verifier, calls: stub.calls };
}

// TAP request: covers @authority and @path, label sig2, Visa key.
function tapRequest({ privateKey, kind = 'ed25519', alg = 'ed25519', keyid = 'visa-key-1', nonce = 'n-1', created = T0, expires = T0 + 300, path = '/ucp/mcp', signedPath, tag = 'agent-browser-auth', components = '"@authority" "@path"' }) {
  const params = `(${components});created=${created};expires=${expires};keyid="${keyid}"${alg ? `;alg="${alg}"` : ''}${nonce ? `;nonce="${nonce}"` : ''};tag="${tag}"`;
  const lines = [];
  if (components.includes('"@authority"')) lines.push(`"@authority": ${HOST}`);
  if (components.includes('"@path"')) lines.push(`"@path": ${signedPath || path}`);
  lines.push(`"@signature-params": ${params}`);
  const sig = sign(lines.join('\n'), privateKey, kind);
  return {
    method: 'POST',
    originalUrl: path,
    headers: { host: HOST, 'signature-input': `sig2=${params}`, signature: `sig2=:${sig.toString('base64')}:` },
  };
}

// Web Bot Auth request: covers @authority and its own Signature-Agent member.
function wbaRequest({ privateKey, keyid, agentHeader = 'sig1="https://agent.example"', legacy = false, created = T0, expires = T0 + 600, coverAgent = true }) {
  const agentComponent = legacy ? '"signature-agent"' : '"signature-agent";key="sig1"';
  const comps = coverAgent ? `"@authority" ${agentComponent}` : '"@authority"';
  const params = `(${comps});created=${created};expires=${expires};keyid="${keyid}";tag="web-bot-auth"`;
  const lines = [`"@authority": ${HOST}`];
  if (coverAgent) {
    const memberValue = legacy ? agentHeader : agentHeader.replace(/^sig1=/, '');
    lines.push(`${agentComponent}: ${memberValue}`);
  }
  lines.push(`"@signature-params": ${params}`);
  const sig = sign(lines.join('\n'), privateKey, 'ed25519');
  return {
    method: 'GET',
    originalUrl: '/mcp',
    headers: { host: HOST, 'signature-agent': agentHeader, 'signature-input': `sig1=${params}`, signature: `sig1=:${sig.toString('base64')}:` },
  };
}

// ---- external ground truth --------------------------------------------------------------------------

test('RFC 9421 B.2.6 (ed25519) verifies byte for byte', () => {
  const req = {
    method: 'POST',
    originalUrl: '/foo?param=Value&Pet=dog',
    headers: { host: 'example.com', date: 'Tue, 20 Apr 2021 02:07:55 GMT', 'content-type': 'application/json', 'content-length': '18' },
  };
  const input = parseDictionary('sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"').get('sig-b26');
  const signature = parseDictionary('sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:').get('sig-b26').value;
  const built = buildSignatureBase(requestView(req), input);
  assert.equal(built.base, [
    '"date": Tue, 20 Apr 2021 02:07:55 GMT',
    '"@method": POST',
    '"@path": /foo',
    '"@authority": example.com',
    '"content-type": application/json',
    '"content-length": 18',
    '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
  ].join('\n'));
  const key = importPublicJwk({ kty: 'OKP', crv: 'Ed25519', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' });
  assert.deepEqual(verifySignature({ base: built.base, signature, key }), { ok: true, alg: 'ed25519' });
  const tampered = Buffer.from(signature);
  tampered[0] ^= 1;
  assert.equal(verifySignature({ base: built.base, signature: tampered, key }).ok, false);
});

test('RFC 8037 A.3 OKP thumbprint', () => {
  assert.equal(
    jwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }),
    'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
  );
});

test('importPublicJwk refuses private material, small RSA and unsupported curves', () => {
  const { publicJwk } = keypair('ed25519');
  assert.ok(importPublicJwk(publicJwk));
  assert.equal(importPublicJwk({ ...publicJwk, d: 'x' }), null);
  assert.equal(importPublicJwk({ kty: 'oct', k: 'c2VjcmV0' }), null);
  const small = keypair('rsa', { modulusLength: 1024 });
  assert.equal(importPublicJwk(small.publicJwk), null);
  const p384 = keypair('ec', { namedCurve: 'P-384' });
  assert.equal(importPublicJwk(p384.publicJwk), null);
});

// ---- Visa TAP ---------------------------------------------------------------------------------------

test('TAP: Ed25519, ES256 and PS256 signatures from the Visa key source verify', async () => {
  const ed = keypair('ed25519');
  const ec = keypair('ec', { namedCurve: 'P-256' });
  const rsa = keypair('rsa', { modulusLength: 2048 });
  const { verifier, calls } = makeVerifier({
    routes: { [VISA_URL]: { body: { keys: [{ ...ed.publicJwk, kid: 'k-ed' }, { ...ec.publicJwk, kid: 'k-ec' }, { ...rsa.publicJwk, kid: 'k-rsa' }] } } },
  });
  const r1 = await verifier.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k-ed', nonce: 'a' }));
  assert.equal(r1.verified, true, r1.reason);
  assert.equal(r1.profile, 'visa-tap');
  assert.equal(r1.agent, 'visa');
  assert.equal(r1.tag, 'agent-browser-auth');
  const r2 = await verifier.verifyRequest(tapRequest({ privateKey: ec.privateKey, kind: 'es256', alg: 'ecdsa-p256-sha256', keyid: 'k-ec', nonce: 'b', tag: 'agent-payer-auth' }));
  assert.equal(r2.verified, true, r2.reason);
  const r3 = await verifier.verifyRequest(tapRequest({ privateKey: rsa.privateKey, kind: 'ps256', alg: 'PS256', keyid: 'k-rsa', nonce: 'c' }));
  assert.equal(r3.verified, true, r3.reason);
  assert.equal(calls.length, 1, 'key set fetched once and cached');
  assert.equal(calls[0].url, VISA_URL);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('TAP: a nonce is single-use, but only a VALID signature consumes it', async () => {
  const ed = keypair('ed25519');
  const other = keypair('ed25519');
  const { verifier } = makeVerifier({ routes: { [VISA_URL]: { body: { keys: [{ ...ed.publicJwk, kid: 'k' }] } } } });
  // A forged request with the agent's next nonce must not burn it.
  const forged = await verifier.verifyRequest(tapRequest({ privateKey: other.privateKey, keyid: 'k', nonce: 'next' }));
  assert.equal(forged.reason, 'bad_signature');
  const first = await verifier.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k', nonce: 'next' }));
  assert.equal(first.verified, true, first.reason);
  const replay = await verifier.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k', nonce: 'next' }));
  assert.equal(replay.verified, false);
  assert.equal(replay.reason, 'nonce_replay');
});

test('TAP: window, timestamps, required params and components are enforced before any key fetch', async () => {
  const ed = keypair('ed25519');
  const { verifier, calls } = makeVerifier({ routes: { [VISA_URL]: { body: { keys: [{ ...ed.publicJwk, kid: 'k' }] } } } });
  const cases = [
    [{ expires: T0 + 481 }, 'validity_window_too_long'],
    [{ created: T0 - 1000, expires: T0 - 700 }, 'expired'],
    [{ created: T0 + 300, expires: T0 + 600 }, 'not_yet_valid'],
    [{ nonce: null }, 'missing_required_param'],
    [{ alg: null }, 'missing_required_param'],
    [{ components: '"@authority"' }, 'missing_required_component'],
  ];
  for (const [opts, reason] of cases) {
    const r = await verifier.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k', ...opts }));
    assert.equal(r.verified, false);
    assert.equal(r.reason, reason, JSON.stringify(opts));
  }
  assert.equal(calls.length, 0);
});

test('TAP: a signature over another path, an unknown kid, a mismatched or disallowed alg all fail', async () => {
  const ed = keypair('ed25519');
  const { verifier } = makeVerifier({ routes: { [VISA_URL]: { body: { keys: [{ ...ed.publicJwk, kid: 'k' }] } } } });
  let r = await verifier.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k', nonce: '1', path: '/acp/checkout_sessions', signedPath: '/ucp/mcp' }));
  assert.equal(r.reason, 'bad_signature');
  r = await verifier.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'nope', nonce: '2' }));
  assert.equal(r.reason, 'unknown_key');
  r = await verifier.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k', nonce: '3', alg: 'ecdsa-p256-sha256' }));
  assert.equal(r.reason, 'algorithm_key_mismatch');
  r = await verifier.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k', nonce: '4', alg: 'hmac-sha256' }));
  assert.equal(r.reason, 'algorithm_not_allowed');
});

test('key source: redirects and non-200s are discovery failures; private JWKs are never used', async () => {
  const ed = keypair('ed25519');
  let { verifier } = makeVerifier({ routes: { [VISA_URL]: { status: 302, body: '' } } });
  let r = await verifier.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k' }));
  assert.equal(r.reason, 'key_source_unavailable');
  ({ verifier } = makeVerifier({ routes: { [VISA_URL]: { body: { keys: [{ ...ed.privateKey.export({ format: 'jwk' }), kid: 'k' }] } } } }));
  r = await verifier.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k' }));
  assert.equal(r.reason, 'unknown_key');
});

test('key source: a failed refresh never evicts the last good set, and failures are not retried for 30s', async () => {
  const ed = keypair('ed25519');
  let nowS = T0;
  let up = true;
  let fetches = 0;
  const { verifier } = makeVerifier({
    now: () => nowS * 1000,
    routes: { [VISA_URL]: () => { fetches += 1; return up ? { status: 200, text: async () => JSON.stringify({ keys: [{ ...ed.publicJwk, kid: 'k' }] }) } : { status: 503, text: async () => '' }; } },
  });
  const tap = (n) => tapRequest({ privateKey: ed.privateKey, keyid: 'k', nonce: n, created: nowS, expires: nowS + 300 });
  assert.equal((await verifier.verifyRequest(tap('a'))).verified, true);
  up = false;
  nowS += 11 * 60; // past the 10-minute TTL: a refresh is attempted and fails
  assert.equal((await verifier.verifyRequest(tap('b'))).verified, true);
  assert.equal(fetches, 2);
  nowS += 10; // inside the 30s negative window: no new fetch
  assert.equal((await verifier.verifyRequest(tap('c'))).verified, true);
  assert.equal(fetches, 2);
  nowS += 5 * 3600; // a long outage: still the last good set
  const late = await verifier.verifyRequest(tap('d'));
  assert.equal(late.verified, true, late.reason);
});

test('key source: with nothing cached, a failure is remembered for 30s', async () => {
  const ed = keypair('ed25519');
  let nowS = T0;
  let fetches = 0;
  const { verifier } = makeVerifier({ now: () => nowS * 1000, routes: { [VISA_URL]: () => { fetches += 1; return { status: 503, text: async () => '' }; } } });
  const tap = (n) => tapRequest({ privateKey: ed.privateKey, keyid: 'k', nonce: n, created: nowS, expires: nowS + 300 });
  assert.equal((await verifier.verifyRequest(tap('a'))).reason, 'key_source_unavailable');
  nowS += 10;
  assert.equal((await verifier.verifyRequest(tap('b'))).reason, 'key_source_unavailable');
  assert.equal(fetches, 1);
  nowS += 31;
  await verifier.verifyRequest(tap('c'));
  assert.equal(fetches, 2);
});

// ---- Web Bot Auth -----------------------------------------------------------------------------------

const AGENT_DIR = 'https://agent.example/.well-known/http-message-signatures-directory';

test('WBA: dictionary Signature-Agent from an allowlisted directory verifies; keyid is the JWK thumbprint', async () => {
  const ed = keypair('ed25519');
  const tp = jwkThumbprint(ed.publicJwk);
  const { verifier, calls } = makeVerifier({
    sources: [{ id: 'agent-example', profile: 'web-bot-auth', url: AGENT_DIR }],
    routes: { [AGENT_DIR]: { body: { keys: [ed.publicJwk] } } },
  });
  const r = await verifier.verifyRequest(wbaRequest({ privateKey: ed.privateKey, keyid: tp }));
  assert.equal(r.verified, true, r.reason);
  assert.equal(r.profile, 'web-bot-auth');
  assert.equal(r.agent, 'agent-example');
  assert.equal(r.agent_url, AGENT_DIR);
  assert.deepEqual(calls.map((c) => c.url), [AGENT_DIR]);
});

test('WBA: the legacy bare-string Signature-Agent is accepted when it is covered', async () => {
  const ed = keypair('ed25519');
  const { verifier } = makeVerifier({
    sources: [{ id: 'agent-example', profile: 'web-bot-auth', url: AGENT_DIR }],
    routes: { [AGENT_DIR]: { body: { keys: [ed.publicJwk] } } },
  });
  const r = await verifier.verifyRequest(wbaRequest({ privateKey: ed.privateKey, keyid: jwkThumbprint(ed.publicJwk), agentHeader: '"https://agent.example"', legacy: true }));
  assert.equal(r.verified, true, r.reason);
});

test('WBA: an agent that is not allowlisted is never fetched (no SSRF) and is reported as a claim', async () => {
  const ed = keypair('ed25519');
  const { verifier, calls } = makeVerifier({ routes: {} });
  const r = await verifier.verifyRequest(wbaRequest({ privateKey: ed.privateKey, keyid: jwkThumbprint(ed.publicJwk), agentHeader: 'sig1="https://169.254.169.254"' }));
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'untrusted_signature_agent');
  assert.equal(r.claimed_agent, 'https://169.254.169.254/.well-known/http-message-signatures-directory');
  assert.equal(calls.length, 0);
});

test('WBA: a request claiming agent B is not verified against allowlisted agent A, even with A\'s key', async () => {
  const ed = keypair('ed25519');
  const { verifier, calls } = makeVerifier({
    sources: [{ id: 'agent-example', profile: 'web-bot-auth', url: AGENT_DIR }],
    routes: { [AGENT_DIR]: { body: { keys: [ed.publicJwk] } } },
  });
  const r = await verifier.verifyRequest(wbaRequest({ privateKey: ed.privateKey, keyid: jwkThumbprint(ed.publicJwk), agentHeader: 'sig1="https://impostor.example"' }));
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'untrusted_signature_agent');
  assert.equal(r.agent, undefined);
  assert.equal(calls.length, 0);
});

test('WBA: uncovered Signature-Agent, a kid instead of a thumbprint, and a >24h window all fail', async () => {
  const ed = keypair('ed25519');
  const { verifier } = makeVerifier({
    sources: [{ id: 'agent-example', profile: 'web-bot-auth', url: AGENT_DIR }],
    routes: { [AGENT_DIR]: { body: { keys: [{ ...ed.publicJwk, kid: 'friendly-name' }] } } },
  });
  let r = await verifier.verifyRequest(wbaRequest({ privateKey: ed.privateKey, keyid: jwkThumbprint(ed.publicJwk), coverAgent: false }));
  assert.equal(r.reason, 'signature_agent_not_covered');
  r = await verifier.verifyRequest(wbaRequest({ privateKey: ed.privateKey, keyid: 'friendly-name' }));
  assert.equal(r.reason, 'unknown_key');
  r = await verifier.verifyRequest(wbaRequest({ privateKey: ed.privateKey, keyid: jwkThumbprint(ed.publicJwk), expires: T0 + 24 * 3600 + 1 }));
  assert.equal(r.reason, 'validity_window_too_long');
});

test('resolveSignatureAgent: directory origins, jwks_uri, unsupported types and non-origins', () => {
  assert.equal(resolveSignatureAgent('sig1="https://Agent.Example:443/"', 'sig1').identifier, AGENT_DIR);
  assert.equal(resolveSignatureAgent('sig1="https://a.test/jwks.json?x=1";type=jwks_uri', 'sig1').identifier, 'https://a.test/jwks.json');
  assert.equal(resolveSignatureAgent('sig1="https://a.test/card";type=cimd', 'sig1').reason, 'unsupported_signature_agent_type');
  assert.equal(resolveSignatureAgent('sig1="https://a.test/some/path"', 'sig1').reason, 'malformed_signature_agent');
  assert.equal(resolveSignatureAgent('sig1="http://a.test"', 'sig1').reason, 'malformed_signature_agent');
  assert.equal(resolveSignatureAgent('other="https://a.test"', 'sig1').reason, 'missing_signature_agent');
  assert.equal(resolveSignatureAgent(undefined, 'sig1').reason, 'missing_signature_agent');
});

// ---- request-level ----------------------------------------------------------------------------------

test('unsigned, malformed, unknown-tag and multi-label requests', async () => {
  const ed = keypair('ed25519');
  const { verifier } = makeVerifier({ routes: { [VISA_URL]: { body: { keys: [{ ...ed.publicJwk, kid: 'k' }] } } } });
  assert.deepEqual(await verifier.verifyRequest({ headers: { host: HOST } }), { present: false, verified: false, reason: 'no_signature' });
  assert.equal((await verifier.verifyRequest({ headers: { host: HOST, 'signature-input': 'sig1=(', signature: 'sig1=:AA==:' } })).reason, 'malformed_signature_headers');
  const unknown = tapRequest({ privateKey: ed.privateKey, keyid: 'k', tag: 'something-else' });
  assert.equal((await verifier.verifyRequest(unknown)).reason, 'unsupported_tag');
  // An unknown-tag label first, a valid TAP label second: the TAP one is found.
  const good = tapRequest({ privateKey: ed.privateKey, keyid: 'k', nonce: 'multi' });
  const multi = {
    ...good,
    headers: {
      ...good.headers,
      'signature-input': `other=("@authority");created=${T0};keyid="x";tag="vendor-x", ${good.headers['signature-input']}`,
      signature: `other=:AAAA:, ${good.headers.signature}`,
    },
  };
  const r = await verifier.verifyRequest(multi);
  assert.equal(r.verified, true, r.reason);
  assert.equal(r.label, 'sig2');
});

test('config: mode parsing and key-source loading fail safe', () => {
  assert.equal(agentSignatureMode({}), 'off');
  assert.equal(agentSignatureMode({ AGENT_SIGNATURE_VERIFY_MODE: 'observe' }), 'observe');
  assert.equal(agentSignatureMode({ AGENT_SIGNATURE_VERIFY_MODE: 'enforce' }), 'off', 'no enforce mode exists yet');
  assert.deepEqual(loadKeySources({}), DEFAULT_KEY_SOURCES.slice());
  assert.deepEqual(loadKeySources({ AGENT_SIGNATURE_TRUSTED_KEY_SOURCES_JSON: '{nope' }), DEFAULT_KEY_SOURCES.slice());
  const loaded = loadKeySources({
    AGENT_SIGNATURE_TRUSTED_KEY_SOURCES_JSON: JSON.stringify([
      { id: 'ok', profile: 'web-bot-auth', url: 'https://A.test/.well-known/http-message-signatures-directory#x' },
      { id: 'plain-http', profile: 'web-bot-auth', url: 'http://a.test/jwks' },
      { id: 'bad profile', profile: 'web-bot-auth', url: 'https://a.test/jwks' },
      { id: 'unknown-profile', profile: 'mastercard', url: 'https://a.test/jwks' },
    ]),
  });
  assert.deepEqual(loaded.map((s) => s.id), ['ok']);
  assert.equal(loaded[0].url, 'https://a.test/.well-known/http-message-signatures-directory');
});

// ---- review round 1 ---------------------------------------------------------------------------------

test('a signature made for another host is refused (authority_mismatch), before any key fetch', async () => {
  const ed = keypair('ed25519');
  const { verifier, calls } = makeVerifier({ routes: { [VISA_URL]: { body: { keys: [{ ...ed.publicJwk, kid: 'k' }] } } } });
  const req = tapRequest({ privateKey: ed.privateKey, keyid: 'k', nonce: 'x' });
  // Re-sign the same shape for a different merchant's host and send it with that Host.
  const params = req.headers['signature-input'].replace(/^sig2=/, '');
  const base = `"@authority": other-merchant.example\n"@path": /ucp/mcp\n"@signature-params": ${params}`;
  const sig = nodeCrypto.sign(null, Buffer.from(base), ed.privateKey).toString('base64');
  const cross = { ...req, headers: { ...req.headers, host: 'other-merchant.example', signature: `sig2=:${sig}:` } };
  const r = await verifier.verifyRequest(cross);
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'authority_mismatch');
  assert.equal(calls.length, 0);
  // The allowlist is configurable.
  const custom = createAgentSignatureVerifier({
    env: { AGENT_SIGNATURE_EXPECTED_AUTHORITIES: 'other-merchant.example' },
    fetchImpl: fetchStub({ [VISA_URL]: { body: { keys: [{ ...ed.publicJwk, kid: 'k' }] } } }).impl,
    nowMs: () => T0 * 1000,
  });
  assert.equal((await custom.verifyRequest(cross)).verified, true);
});

test('a TAP nonce is remembered for as long as its signature can verify (skew included)', async () => {
  const ed = keypair('ed25519');
  let nowS = T0;
  const { verifier } = makeVerifier({ now: () => nowS * 1000, routes: { [VISA_URL]: { body: { keys: [{ ...ed.publicJwk, kid: 'k' }] } } } });
  const req = tapRequest({ privateKey: ed.privateKey, keyid: 'k', nonce: 'B', created: T0 + 60, expires: T0 + 540 });
  assert.equal((await verifier.verifyRequest(req)).verified, true);
  nowS = T0 + 481; // past 480s, still inside expires (540) + skew (60)
  const replay = await verifier.verifyRequest(req);
  assert.equal(replay.verified, false);
  assert.equal(replay.reason, 'nonce_replay');
});

test('Object.prototype names are neither tags nor headers', async () => {
  const ed = keypair('ed25519');
  const { verifier } = makeVerifier({ routes: { [VISA_URL]: { body: { keys: [{ ...ed.publicJwk, kid: 'k' }] } } } });
  for (const tag of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = await verifier.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k', tag }));
    assert.equal(r.reason, 'unsupported_tag', tag);
    assert.equal(r.profile, null);
  }
  const input = parseDictionary('s=("constructor" "@authority");created=1').get('s');
  const built = buildSignatureBase(requestView({ method: 'GET', originalUrl: '/', headers: { host: HOST } }), input);
  assert.equal(built.reason, 'missing_covered_header');
});

test('RFC 9421 §2.1.2: dictionary members under ;key serialize as items (Boolean true is ?1)', () => {
  const req = { method: 'GET', originalUrl: '/', headers: { host: HOST, 'example-dict': ' a=1, b=2;x=1;y=2, c=(a   b   c), d' } };
  const input = parseDictionary('s=("example-dict";key="a" "example-dict";key="d" "example-dict";key="b" "example-dict";key="c")').get('s');
  const built = buildSignatureBase(requestView(req), input);
  assert.deepEqual(built.base.split('\n').slice(0, 4), [
    '"example-dict";key="a": 1',
    '"example-dict";key="d": ?1',
    '"example-dict";key="b": 2;x=1;y=2',
    '"example-dict";key="c": (a b c)',
  ]);
});

test('JWK restrictions: e≠65537, use≠sig, key_ops without verify, and a pinned alg are honoured', async () => {
  const rsa = keypair('rsa', { modulusLength: 2048 });
  assert.equal(importPublicJwk({ ...rsa.publicJwk, e: 'AQ' }), null, 'e=1 would make any signature valid');
  assert.equal(importPublicJwk({ ...rsa.publicJwk, use: 'enc' }), null);
  assert.equal(importPublicJwk({ ...rsa.publicJwk, key_ops: ['encrypt'] }), null);
  assert.ok(importPublicJwk({ ...rsa.publicJwk, use: 'sig', key_ops: ['verify'] }));
  const { verifier } = makeVerifier({ routes: { [VISA_URL]: { body: { keys: [{ ...rsa.publicJwk, kid: 'k', alg: 'PS512' }] } } } });
  const r = await verifier.verifyRequest(tapRequest({ privateKey: rsa.privateKey, kind: 'ps256', alg: 'PS256', keyid: 'k', nonce: 'p' }));
  assert.equal(r.reason, 'algorithm_key_mismatch');
});

test('key source: only a literal 200 counts, and oversized bodies are refused without buffering them', async () => {
  const ed = keypair('ed25519');
  const jwks = JSON.stringify({ keys: [{ ...ed.publicJwk, kid: 'k' }] });
  // A redirect carrying a perfectly good key set is still a discovery failure.
  let v = createAgentSignatureVerifier({ env: {}, nowMs: () => T0 * 1000, fetchImpl: async () => ({ status: 302, text: async () => jwks }) });
  assert.equal((await v.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k' }))).reason, 'key_source_unavailable');
  // Declared too large: refused from the header alone.
  let read = false;
  v = createAgentSignatureVerifier({
    env: {},
    nowMs: () => T0 * 1000,
    fetchImpl: async () => ({ status: 200, headers: { get: (h) => (h === 'content-length' ? String(10 * 1024 * 1024) : null) }, text: async () => { read = true; return jwks; } }),
  });
  assert.equal((await v.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k' }))).reason, 'key_source_unavailable');
  assert.equal(read, false);
  // Undeclared but streamed past the cap: the read stops.
  let chunksServed = 0;
  const chunk = new Uint8Array(16 * 1024);
  v = createAgentSignatureVerifier({
    env: {},
    nowMs: () => T0 * 1000,
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => { chunksServed += 1; return { done: false, value: chunk }; }, cancel: async () => {} }) },
    }),
  });
  assert.equal((await v.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k' }))).reason, 'key_source_unavailable');
  assert.ok(chunksServed <= 5, `stopped after ${chunksServed} chunks`);
});

test('key rotation: an unknown keyid refetches once a minute at most; every Visa source is tried', async () => {
  const a = keypair('ed25519');
  const b = keypair('ed25519');
  let nowS = T0;
  let published = [{ ...a.publicJwk, kid: 'a' }];
  const { verifier, calls } = makeVerifier({
    now: () => nowS * 1000,
    routes: { [VISA_URL]: () => ({ status: 200, text: async () => JSON.stringify({ keys: published }) }) },
  });
  const tap = (priv, kid, n) => tapRequest({ privateKey: priv, keyid: kid, nonce: n, created: nowS, expires: nowS + 300 });
  assert.equal((await verifier.verifyRequest(tap(a.privateKey, 'a', '1'))).verified, true);
  published = [...published, { ...b.publicJwk, kid: 'b' }];
  nowS += 30;
  assert.equal((await verifier.verifyRequest(tap(b.privateKey, 'b', '2'))).reason, 'unknown_key');
  assert.equal(calls.length, 1, 'no refetch inside the minimum gap');
  nowS += 31;
  const rotated = await verifier.verifyRequest(tap(b.privateKey, 'b', '3'));
  assert.equal(rotated.verified, true, rotated.reason);
  assert.equal(calls.length, 2);

  const second = 'https://visa-secondary.example/jwks';
  const multi = makeVerifier({
    sources: [{ id: 'visa', profile: 'visa-tap', url: VISA_URL }, { id: 'visa-2', profile: 'visa-tap', url: second }],
    routes: { [VISA_URL]: { body: { keys: [] } }, [second]: { body: { keys: [{ ...b.publicJwk, kid: 'b' }] } } },
  });
  const r = await multi.verifier.verifyRequest(tapRequest({ privateKey: b.privateKey, keyid: 'b', nonce: 'm' }));
  assert.equal(r.verified, true, r.reason);
  assert.equal(r.agent, 'visa-2');
});

test('nonce store: refuses when full of live nonces instead of evicting one; keys cannot collide', () => {
  let nowMs = 0;
  const { createNonceStore } = require('../src/services/agentSignatureVerifier')._internal;
  const store = createNonceStore({ nowMs: () => nowMs, max: 2 });
  assert.equal(store.claim(['s', 'k', 'x'], 60), 'ok');
  assert.equal(store.claim(['s', 'k', 'y'], 60), 'ok');
  assert.equal(store.claim(['s', 'k', 'z'], 60), 'full');
  assert.equal(store.claim(['s', 'k', 'x'], 60), 'replay', 'x was not evicted');
  nowMs = 61_000;
  assert.equal(store.claim(['s', 'k', 'z'], 60), 'ok', 'expired entries make room');
  const fresh = createNonceStore({ nowMs: () => 0 });
  assert.equal(fresh.claim(['a|b', 'c', 'n'], 60), 'ok');
  assert.equal(fresh.claim(['a', 'b|c', 'n'], 60), 'ok');
});

test('a bare Signature header (the ACP adapter\'s HMAC) is not an agent signature', async () => {
  const { verifier } = makeVerifier({ routes: {} });
  const r = await verifier.verifyRequest({ method: 'POST', originalUrl: '/acp/checkout_sessions', headers: { host: HOST, signature: 'abc123', timestamp: '1' } });
  assert.deepEqual(r, { present: false, verified: false, reason: 'no_signature' });
});

test('canonicalisation: repeated fields from rawHeaders, empty and absolute-form queries', () => {
  const comps = (list) => parseDictionary(`s=(${list});created=1`).get('s');
  let built = buildSignatureBase(requestView({
    method: 'POST',
    originalUrl: '/p',
    headers: { host: HOST, 'content-type': 'a' },
    rawHeaders: ['Host', HOST, 'Content-Type', ' a ', 'Content-Type', 'b'],
  }), comps('"content-type"'));
  assert.equal(built.base.split('\n')[0], '"content-type": a, b');
  built = buildSignatureBase(requestView({ method: 'GET', originalUrl: '/p?', headers: { host: HOST } }), comps('"@query" "@target-uri" "@request-target"'));
  assert.deepEqual(built.base.split('\n').slice(0, 3), ['"@query": ?', `"@target-uri": https://${HOST}/p?`, '"@request-target": /p?']);
  built = buildSignatureBase(requestView({ method: 'GET', originalUrl: `https://${HOST}/p?q=1`, headers: { host: HOST } }), comps('"@path" "@query"'));
  assert.deepEqual(built.base.split('\n').slice(0, 2), ['"@path": /p', '"@query": ?q=1']);
});

test('component and window edge cases each fail with their own reason', () => {
  const view = requestView({ method: 'GET', originalUrl: '/', headers: { host: HOST, 'x-a': '1' } });
  const base = (list) => buildSignatureBase(view, parseDictionary(`s=(${list});created=1`).get('s'));
  assert.equal(base('"x-a" "x-a"').reason, 'duplicate_component');
  assert.equal(base('"X-A"').reason, 'malformed_component');
  assert.equal(base('"x-a";sf').reason, 'unsupported_component_parameter');
  assert.equal(base('"@status"').reason, 'unsupported_component');
  const { checkWindow } = require('../src/services/agentSignatureVerifier')._internal;
  assert.equal(checkWindow({ created: T0, expires: T0 }, 480, T0), 'invalid_validity_window');
});

test('loadKeySources: a Web Bot Auth origin means its well-known directory; repeated Signature-Agent lines join', () => {
  const [s] = loadKeySources({ AGENT_SIGNATURE_TRUSTED_KEY_SOURCES_JSON: JSON.stringify([{ id: 'a', profile: 'web-bot-auth', url: 'https://agent.example' }]) });
  assert.equal(s.url, AGENT_DIR);
  assert.equal(resolveSignatureAgent(['other="https://b.example"', 'sig1="https://agent.example"'], 'sig1').identifier, AGENT_DIR);
});

// ---- review round 2 ---------------------------------------------------------------------------------

test('WBA: the covered Signature-Agent member is the one used, even under another label (draft E.1.1)', async () => {
  const ed = keypair('ed25519');
  const tp = jwkThumbprint(ed.publicJwk);
  const { verifier } = makeVerifier({ sources: [{ id: 'agent-example', profile: 'web-bot-auth', url: AGENT_DIR }], routes: { [AGENT_DIR]: { body: { keys: [ed.publicJwk] } } } });
  const sign2 = (comps, agentHeader, memberLine) => {
    const params = `(${comps});created=${T0};expires=${T0 + 600};keyid="${tp}";tag="web-bot-auth"`;
    const base = [`"@authority": ${HOST}`, memberLine, `"@signature-params": ${params}`].join('\n');
    const sig = nodeCrypto.sign(null, Buffer.from(base), ed.privateKey).toString('base64');
    return { method: 'GET', originalUrl: '/mcp', headers: { host: HOST, 'signature-agent': agentHeader, 'signature-input': `sig2=${params}`, signature: `sig2=:${sig}:` } };
  };
  // Label sig2 covering member agent2.
  let r = await verifier.verifyRequest(sign2('"@authority" "signature-agent";key="agent2"', 'agent2="https://agent.example"', '"signature-agent";key="agent2": "https://agent.example"'));
  assert.equal(r.verified, true, r.reason);
  // Whole-field coverage of a one-member dictionary.
  r = await verifier.verifyRequest(sign2('"@authority" "signature-agent"', 'agent2="https://agent.example"', '"signature-agent": agent2="https://agent.example"'));
  assert.equal(r.verified, true, r.reason);
  // Whole-field coverage of a two-member dictionary names nobody.
  r = await verifier.verifyRequest(sign2('"@authority" "signature-agent"', 'a="https://agent.example", b="https://other.example"', '"signature-agent": a="https://agent.example", b="https://other.example"'));
  assert.equal(r.reason, 'ambiguous_signature_agent');
});

test('WBA: a signature that covers neither @authority nor @target-uri is refused', async () => {
  const ed = keypair('ed25519');
  const tp = jwkThumbprint(ed.publicJwk);
  const { verifier } = makeVerifier({ sources: [{ id: 'agent-example', profile: 'web-bot-auth', url: AGENT_DIR }], routes: { [AGENT_DIR]: { body: { keys: [ed.publicJwk] } } } });
  const params = `("signature-agent";key="sig1");created=${T0};expires=${T0 + 600};keyid="${tp}";tag="web-bot-auth"`;
  const base = `"signature-agent";key="sig1": "https://agent.example"\n"@signature-params": ${params}`;
  const sig = nodeCrypto.sign(null, Buffer.from(base), ed.privateKey).toString('base64');
  const r = await verifier.verifyRequest({ method: 'GET', originalUrl: '/mcp', headers: { host: HOST, 'signature-agent': 'sig1="https://agent.example"', 'signature-input': `sig1=${params}`, signature: `sig1=:${sig}:` } });
  assert.equal(r.reason, 'missing_required_component');
});

test('nonces are per key source, and a busy source cannot fill another source\'s store', async () => {
  const a = keypair('ed25519');
  const second = 'https://visa-secondary.example/jwks';
  const { verifier } = makeVerifier({
    sources: [{ id: 'visa', profile: 'visa-tap', url: VISA_URL }, { id: 'visa-2', profile: 'visa-tap', url: second }],
    routes: { [VISA_URL]: { body: { keys: [{ ...a.publicJwk, kid: 'k' }] } }, [second]: { body: { keys: [{ ...a.publicJwk, kid: 'k2' }] } } },
  });
  assert.equal((await verifier.verifyRequest(tapRequest({ privateKey: a.privateKey, keyid: 'k', nonce: 'same' }))).verified, true);
  // Same nonce under a different source is a different nonce.
  const other = await verifier.verifyRequest(tapRequest({ privateKey: a.privateKey, keyid: 'k2', nonce: 'same' }));
  assert.equal(other.verified, true, other.reason);
});

test('log hygiene: an attacker-chosen tag and keyid are bounded in the result', async () => {
  const { verifier } = makeVerifier({ routes: {} });
  const r = await verifier.verifyRequest({ method: 'GET', originalUrl: '/mcp', headers: { host: HOST, 'signature-input': `s=("@authority");created=${T0};keyid="${'k'.repeat(5000)}";tag="${'t'.repeat(8000)}"`, signature: 's=:AAAA:' } });
  assert.equal(r.reason, 'unsupported_tag');
  assert.equal(r.tag.length, 64);
  assert.equal(r.keyid.length, 100);
});

test('canonicalisation: default port stripped, @scheme from x-forwarded-proto, absent query is "?", absolute-form authority from the target', () => {
  const comps = (list) => parseDictionary(`s=(${list});created=1`).get('s');
  let built = buildSignatureBase(requestView({ method: 'GET', originalUrl: '/p', headers: { host: 'Commerce.MCP.pivota.cc:443', 'x-forwarded-proto': 'https' } }), comps('"@authority" "@scheme" "@query"'));
  assert.deepEqual(built.base.split('\n').slice(0, 3), [`"@authority": ${HOST}`, '"@scheme": https', '"@query": ?']);
  built = buildSignatureBase(requestView({ method: 'GET', originalUrl: '/p', headers: { host: 'h.test', 'x-forwarded-proto': 'http' } }), comps('"@scheme"'));
  assert.equal(built.base.split('\n')[0], '"@scheme": http');
  built = buildSignatureBase(requestView({ method: 'GET', originalUrl: 'https://Target.Example/a/../b?', headers: { host: 'ignored.example' } }), comps('"@authority" "@path" "@request-target"'));
  assert.deepEqual(built.base.split('\n').slice(0, 3), ['"@authority": target.example', '"@path": /a/../b', '"@request-target": /a/../b?']);
  assert.equal(buildSignatureBase(requestView({ method: 'GET', originalUrl: '/', headers: { host: 'h' } }), comps('"@path";key="x"')).reason, 'unsupported_component_parameter');
});

test('config: expected authorities are trimmed and lower-cased; failure from a known-tag label wins', async () => {
  const ed = keypair('ed25519');
  const v = createAgentSignatureVerifier({
    env: { AGENT_SIGNATURE_EXPECTED_AUTHORITIES: '  Commerce.MCP.pivota.cc , x.example ' },
    fetchImpl: fetchStub({ [VISA_URL]: { body: { keys: [{ ...ed.publicJwk, kid: 'k' }] } } }).impl,
    nowMs: () => T0 * 1000,
  });
  assert.equal((await v.verifyRequest(tapRequest({ privateKey: ed.privateKey, keyid: 'k', nonce: 'cfg' }))).verified, true);
  const { verifier } = makeVerifier({ routes: { [VISA_URL]: { body: { keys: [{ ...ed.publicJwk, kid: 'k' }] } } } });
  const bad = tapRequest({ privateKey: ed.privateKey, keyid: 'nope', nonce: 'pref' });
  const req = { ...bad, headers: { ...bad.headers, 'signature-input': `x=("@authority");created=${T0};keyid="x";tag="vendor-x", ${bad.headers['signature-input']}`, signature: `x=:AAAA:, ${bad.headers.signature}` } };
  assert.equal((await verifier.verifyRequest(req)).reason, 'unknown_key');
});

test('importPublicJwk refuses RSA private (p) and symmetric (k) members', () => {
  const rsa = keypair('rsa', { modulusLength: 2048 });
  assert.equal(importPublicJwk({ ...rsa.publicJwk, p: 'x' }), null);
  assert.equal(importPublicJwk({ ...rsa.publicJwk, k: 'x' }), null);
});

test('WBA: a signature covering several Signature-Agent members speaks for its own label\'s', async () => {
  const ed = keypair('ed25519');
  const tp = jwkThumbprint(ed.publicJwk);
  const { verifier } = makeVerifier({ sources: [{ id: 'agent-example', profile: 'web-bot-auth', url: AGENT_DIR }], routes: { [AGENT_DIR]: { body: { keys: [ed.publicJwk] } } } });
  const header = 'other="https://untrusted.example", sig1="https://agent.example"';
  const params = `("@authority" "signature-agent";key="other" "signature-agent";key="sig1");created=${T0};expires=${T0 + 600};keyid="${tp}";tag="web-bot-auth"`;
  const base = [`"@authority": ${HOST}`, '"signature-agent";key="other": "https://untrusted.example"', '"signature-agent";key="sig1": "https://agent.example"', `"@signature-params": ${params}`].join('\n');
  const sig = nodeCrypto.sign(null, Buffer.from(base), ed.privateKey).toString('base64');
  const r = await verifier.verifyRequest({ method: 'GET', originalUrl: '/mcp', headers: { host: HOST, 'signature-agent': header, 'signature-input': `sig1=${params}`, signature: `sig1=:${sig}:` } });
  assert.equal(r.verified, true, r.reason);
  assert.equal(r.agent, 'agent-example');
});

test('default expected authorities include every host the doors are served on', async () => {
  const ed = keypair('ed25519');
  const { verifier } = makeVerifier({ routes: { [VISA_URL]: { body: { keys: [{ ...ed.publicJwk, kid: 'k' }] } } } });
  for (const host of ['commerce.mcp.pivota.cc', 'mcp.pivota.cc', 'gateway.pivota.cc', 'ucp.pivota.cc']) {
    const params = `("@authority" "@path");created=${T0};expires=${T0 + 300};keyid="k";alg="ed25519";nonce="${host}";tag="agent-browser-auth"`;
    const base = `"@authority": ${host}\n"@path": /ucp/mcp\n"@signature-params": ${params}`;
    const sig = nodeCrypto.sign(null, Buffer.from(base), ed.privateKey).toString('base64');
    const r = await verifier.verifyRequest({ method: 'POST', originalUrl: '/ucp/mcp', headers: { host, 'signature-input': `sig2=${params}`, signature: `sig2=:${sig}:` } });
    assert.equal(r.verified, true, `${host}: ${r.reason}`);
  }
});

test('WBA: whole-field coverage reads every Signature-Agent line, so two lines are two members (ambiguous)', async () => {
  const ed = keypair('ed25519');
  const tp = jwkThumbprint(ed.publicJwk);
  const { verifier } = makeVerifier({ sources: [{ id: 'agent-example', profile: 'web-bot-auth', url: AGENT_DIR }], routes: { [AGENT_DIR]: { body: { keys: [ed.publicJwk] } } } });
  const lines = ['a="https://agent.example"', 'b="https://other.example"'];
  const params = `("@authority" "signature-agent");created=${T0};expires=${T0 + 600};keyid="${tp}";tag="web-bot-auth"`;
  const base = [`"@authority": ${HOST}`, `"signature-agent": ${lines.join(', ')}`, `"@signature-params": ${params}`].join('\n');
  const sig = nodeCrypto.sign(null, Buffer.from(base), ed.privateKey).toString('base64');
  const r = await verifier.verifyRequest({ method: 'GET', originalUrl: '/mcp', headers: { host: HOST, 'signature-agent': lines, 'signature-input': `s=${params}`, signature: `s=:${sig}:` } });
  assert.equal(r.reason, 'ambiguous_signature_agent');
});
