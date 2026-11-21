'use strict';

// ucpSignatureVerifier.js — the receiving half of UCP request signatures (ucp.dev 2026-04-08).
//
// Requests are signed with the GATEWAY'S OWN outbound signer (ucpBuyerAgentClient.signUcpRequest), so a
// pass here also says our outbound requests are what a UCP verifier accepts. Every key is generated here;
// every host is a placeholder or one of ours; no test touches the network (fetch is injected).

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');

const { signUcpRequest } = require('../src/services/ucpBuyerAgentClient');
const {
  createUcpSignatureVerifier,
  parseUcpAgentHeader,
  parseTrustedProfiles,
  keysFromProfile,
  metaProfileBinding,
  ucpSignatureMode,
  PROFILE_KIND,
  UCP_ERRORS,
} = require('../src/services/ucpSignatureVerifier');

const PLATFORM_PROFILE = 'https://platform.example/.well-known/ucp-agent';
const OTHER_PROFILE = 'https://other-platform.example/profiles/agent.json';
const HOST = 'ucp.pivota.cc';
const URL_MCP = `https://${HOST}/ucp/mcp`;
const KID = 'platform-test-key-1';

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PUBLIC_JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'ES256' };
const ed = nodeCrypto.generateKeyPairSync('ed25519');
const ED_JWK = { ...ed.publicKey.export({ format: 'jwk' }), kid: 'platform-ed-key' };

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const r = routes[String(url)];
    if (!r) return { status: 404, headers: { get: () => null }, text: async () => '' };
    if (typeof r === 'function') return r();
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(r) };
  };
  return { impl, calls };
}

function rpcBody({ name = 'search_catalog', profile = PLATFORM_PROFILE, extra = {} } = {}) {
  const meta = profile === null ? undefined : { 'ucp-agent': { profile } };
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: { ...(meta ? { meta } : {}), query: 'serum', ...extra } },
  });
}

const nowS = () => Math.floor(Date.now() / 1000);

/** A request signed exactly as our gateway signs outbound. */
function signedRequest({
  url = URL_MCP,
  bodyString = rpcBody(),
  profile = PLATFORM_PROFILE,
  idempotencyKey,
  keyObject = privateKey,
  keyid = KID,
  created = nowS(),
  expires = nowS() + 300,
  method = 'POST',
} = {}) {
  const ucpAgentValue = profile ? `profile="${profile}"` : undefined;
  const { headers: sig } = signUcpRequest({ method, url, bodyString, ucpAgentValue, idempotencyKey, keyObject, keyid, created, expires });
  const u = new URL(url);
  const headers = { host: u.host, ...sig };
  if (bodyString != null) headers['content-type'] = 'application/json';
  if (ucpAgentValue) headers['ucp-agent'] = ucpAgentValue;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  return {
    req: { method, originalUrl: `${u.pathname}${u.search}`, headers },
    rawBody: bodyString == null ? null : Buffer.from(bodyString, 'utf8'),
  };
}

function verifier(opts = {}) {
  const { impl, calls } = fakeFetch(opts.routes || { [PLATFORM_PROFILE]: { ucp: { version: '2026-04-08' }, signing_keys: [PUBLIC_JWK] } });
  const v = createUcpSignatureVerifier({
    env: opts.env || {},
    fetchImpl: impl,
    nowMs: opts.nowMs || Date.now,
    trustedProfiles: opts.trustedProfiles || [PLATFORM_PROFILE],
    kind: opts.kind,
    requireUcpAgentCoverage: opts.requireUcpAgentCoverage,
    requireCreated: opts.requireCreated,
  });
  return { v, calls };
}

// ---- the conformance cases our own outbound requests must pass ------------------------------------------

test('case 1: a search_catalog call signed by our gateway signer verifies', async () => {
  const { v } = verifier();
  const { req, rawBody } = signedRequest();
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.verified, true, r.reason);
  assert.equal(r.alg, 'es256'); // the JWK pins alg ES256
  assert.equal(r.profile_url, PLATFORM_PROFILE);
  assert.equal(r.keyid, KID);
  assert.deepEqual(r.covered, ['"@method"', '"@authority"', '"@path"', '"ucp-agent"', '"content-digest"', '"content-type"']);
  assert.equal(r.meta_binding, 'match');
  assert.equal(r.ucp_error, null);
});

test('case 2: a create_checkout call with an idempotency key verifies and covers it', async () => {
  const { v } = verifier();
  const { req, rawBody } = signedRequest({ bodyString: rpcBody({ name: 'create_checkout' }), idempotencyKey: '7d1f3c1e-0000-4000-8000-000000000001' });
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.verified, true, r.reason);
  assert.ok(r.covered.includes('"idempotency-key"'));
});

test('case 4: a request with a query string must cover @query, and does', async () => {
  const { v } = verifier();
  const { req, rawBody } = signedRequest({ url: `${URL_MCP}?shop=demo` });
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.verified, true, r.reason);
  assert.ok(r.covered.includes('"@query"'));
});

test('case 8: a body changed after signing is digest_mismatch (400 / -32600) — before any key fetch', async () => {
  const { v, calls } = verifier();
  const { req } = signedRequest();
  const r = await v.verifyRequest(req, { rawBody: Buffer.from(rpcBody({ extra: { query: 'tampered' } }), 'utf8') });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'digest_mismatch');
  assert.deepEqual(r.ucp_error, { code: 'digest_mismatch', ...UCP_ERRORS.digest_mismatch });
  assert.equal(r.ucp_error.http_status, 400);
  assert.equal(r.ucp_error.jsonrpc_code, -32600);
  assert.equal(calls.length, 0);
});

test('case 9: an unsigned request is signature_missing (401 / -32000)', async () => {
  const { v } = verifier();
  const r = await v.verifyRequest({ method: 'POST', originalUrl: '/ucp/mcp', headers: { host: HOST } });
  assert.equal(r.present, false);
  assert.equal(r.reason, 'signature_missing');
  assert.equal(r.ucp_error.http_status, 401);
  assert.equal(r.ucp_error.jsonrpc_code, -32000);
});

// ---- trust and key discovery ----------------------------------------------------------------------------

test('a profile not on the allowlist is never fetched and is counted as profile_not_trusted (403)', async () => {
  const { v, calls } = verifier();
  const { req, rawBody } = signedRequest({ profile: OTHER_PROFILE, bodyString: rpcBody({ profile: OTHER_PROFILE }) });
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.reason, 'profile_not_trusted');
  assert.equal(r.claimed_profile, OTHER_PROFILE);
  assert.equal(r.ucp_error.http_status, 403);
  assert.equal(calls.length, 0);
});

test('an empty allowlist (the default) trusts nothing and fetches nothing', async () => {
  const { v, calls } = verifier({ trustedProfiles: [] });
  const { req, rawBody } = signedRequest();
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.reason, 'profile_not_trusted');
  assert.equal(calls.length, 0);
});

test('UCP-Agent: missing, non-https, or not a Dictionary -> invalid_profile_url', async () => {
  assert.equal(parseUcpAgentHeader(undefined).reason, 'ucp_agent_missing');
  assert.equal(parseUcpAgentHeader('profile="http://platform.example/p"').reason, 'invalid_profile_url');
  assert.equal(parseUcpAgentHeader('profile=notastring').reason, 'invalid_profile_url');
  assert.equal(parseUcpAgentHeader('"just a string"').reason, 'invalid_profile_url');
  assert.equal(parseUcpAgentHeader('profile="https://user:pw@platform.example/p"').reason, 'invalid_profile_url');
  assert.equal(parseUcpAgentHeader(`profile="${PLATFORM_PROFILE}"`).url, PLATFORM_PROFILE);
});

test('a business profile must be /.well-known/ucp; a platform profile is not path-constrained', () => {
  assert.equal(parseUcpAgentHeader(`profile="${OTHER_PROFILE}"`, PROFILE_KIND.PLATFORM).url, OTHER_PROFILE);
  assert.equal(parseUcpAgentHeader(`profile="${OTHER_PROFILE}"`, PROFILE_KIND.BUSINESS).reason, 'invalid_profile_url');
  assert.equal(parseUcpAgentHeader('profile="https://shop.example/.well-known/ucp"', PROFILE_KIND.BUSINESS).url, 'https://shop.example/.well-known/ucp');
});

test('keys are found in signing_keys[], in keys[] alone (2026-08-25 shape), and in ucp.signing_keys', async () => {
  for (const doc of [{ signing_keys: [PUBLIC_JWK] }, { keys: [PUBLIC_JWK] }, { ucp: { signing_keys: [PUBLIC_JWK] } }]) {
    const { v } = verifier({ routes: { [PLATFORM_PROFILE]: doc } });
    const { req, rawBody } = signedRequest();
    const r = await v.verifyRequest(req, { rawBody });
    assert.equal(r.verified, true, `${JSON.stringify(Object.keys(doc))}: ${r.reason}`);
  }
});

test('a JWK carrying private material is dropped, never used', () => {
  const priv = { ...privateKey.export({ format: 'jwk' }), kid: KID };
  assert.deepEqual(keysFromProfile({ signing_keys: [priv] }), []);
  assert.equal(keysFromProfile({ nothing: [] }), null);
});

test('an unknown kid forces one refresh (rotation), then key_not_found (401); no second refresh inside 60s', async () => {
  let t = Date.now();
  let served = { signing_keys: [ED_JWK] };
  const { v, calls } = verifier({ nowMs: () => t, routes: { [PLATFORM_PROFILE]: () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(served) }) } });
  const first = signedRequest();
  let r = await v.verifyRequest(first.req, { rawBody: first.rawBody });
  assert.equal(r.reason, 'key_not_found');
  assert.equal(r.ucp_error.http_status, 401);
  assert.equal(calls.length, 1, 'first fetch; the forced refresh is suppressed by the 60s gap right after it');

  t += 61_000;
  served = { signing_keys: [ED_JWK, PUBLIC_JWK] }; // the platform rotated in its new key
  const second = signedRequest();
  r = await v.verifyRequest(second.req, { rawBody: second.rawBody });
  assert.equal(r.verified, true, r.reason);
  assert.equal(calls.length, 2, 'exactly one forced refresh');
});

test('a redirected profile is profile_unreachable (424); a non-JSON one is profile_malformed (422)', async () => {
  const redirect = verifier({ routes: { [PLATFORM_PROFILE]: () => ({ status: 302, headers: { get: () => 'https://elsewhere.example/' }, text: async () => '' }) } });
  let { req, rawBody } = signedRequest();
  let r = await redirect.v.verifyRequest(req, { rawBody });
  assert.equal(r.reason, 'profile_unreachable');
  assert.equal(r.ucp_error.http_status, 424);

  const junk = verifier({ routes: { [PLATFORM_PROFILE]: () => ({ status: 200, headers: { get: () => null }, text: async () => '<html>' }) } });
  ({ req, rawBody } = signedRequest());
  r = await junk.v.verifyRequest(req, { rawBody });
  assert.equal(r.reason, 'profile_malformed');
  assert.equal(r.ucp_error.http_status, 422);
});

test('the profile fetch never follows redirects', async () => {
  let init;
  const v = createUcpSignatureVerifier({
    env: {},
    trustedProfiles: [PLATFORM_PROFILE],
    fetchImpl: async (url, i) => { init = i; return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ signing_keys: [PUBLIC_JWK] }) }; },
  });
  const { req, rawBody } = signedRequest();
  await v.verifyRequest(req, { rawBody });
  assert.equal(init.redirect, 'manual');
});

// ---- coverage, authority, freshness ---------------------------------------------------------------------

function resign({ components, values, extraHeaders = {}, bodyString = rpcBody(), originalUrl = '/ucp/mcp', created = nowS() }) {
  // Hand-built signature over a chosen component list, to model a signer that leaves something out.
  const params = `(${components.map((c) => `"${c}"`).join(' ')});created=${created};keyid="${KID}"`;
  const lines = components.map((c) => `"${c}": ${values[c]}`);
  lines.push(`"@signature-params": ${params}`);
  const sig = nodeCrypto.sign('sha256', Buffer.from(lines.join('\n'), 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const digest = `sha-256=:${nodeCrypto.createHash('sha256').update(bodyString).digest('base64')}:`;
  return {
    req: {
      method: 'POST',
      originalUrl,
      headers: {
        host: HOST,
        'content-type': 'application/json',
        'content-digest': digest,
        'ucp-agent': `profile="${PLATFORM_PROFILE}"`,
        'signature-input': `sig1=${params}`,
        signature: `sig1=:${sig.toString('base64')}:`,
        ...extraHeaders,
      },
    },
    rawBody: Buffer.from(bodyString, 'utf8'),
    digest,
  };
}

test('coverage: leaving out ucp-agent, content-digest, @query or a present idempotency-key is coverage_insufficient', async () => {
  const { v } = verifier();
  const body = rpcBody();
  const digest = `sha-256=:${nodeCrypto.createHash('sha256').update(body).digest('base64')}:`;
  const values = {
    '@method': 'POST', '@authority': HOST, '@path': '/ucp/mcp', '@query': '?shop=demo',
    'ucp-agent': `profile="${PLATFORM_PROFILE}"`, 'content-digest': digest, 'content-type': 'application/json', 'idempotency-key': 'k-1',
  };
  const cases = [
    { name: 'no ucp-agent', components: ['@method', '@authority', '@path', 'content-digest', 'content-type'] },
    { name: 'no content-digest', components: ['@method', '@authority', '@path', 'ucp-agent', 'content-type'] },
    { name: 'no @query', components: ['@method', '@authority', '@path', 'ucp-agent', 'content-digest', 'content-type'], originalUrl: '/ucp/mcp?shop=demo' },
    { name: 'no idempotency-key', components: ['@method', '@authority', '@path', 'ucp-agent', 'content-digest', 'content-type'], extraHeaders: { 'idempotency-key': 'k-1' } },
  ];
  for (const c of cases) {
    const { req, rawBody } = resign({ components: c.components, values, bodyString: body, originalUrl: c.originalUrl, extraHeaders: c.extraHeaders });
    const r = await v.verifyRequest(req, { rawBody });
    assert.equal(r.reason, 'coverage_insufficient', c.name);
    assert.equal(r.ucp_error.code, 'signature_invalid', c.name);
  }
  // Control: the full set verifies through the same hand-built path.
  const ok = resign({ components: ['@method', '@authority', '@path', 'ucp-agent', 'content-digest', 'content-type'], values, bodyString: body });
  assert.equal((await v.verifyRequest(ok.req, { rawBody: ok.rawBody })).verified, true);
});

test('a business-kind verifier records, but does not require, ucp-agent coverage (the spec webhook example)', async () => {
  const BUSINESS = 'https://shop.example/.well-known/ucp';
  const { v } = verifier({ kind: PROFILE_KIND.BUSINESS, requireUcpAgentCoverage: false, trustedProfiles: [BUSINESS], routes: { [BUSINESS]: { ucp: { signing_keys: [PUBLIC_JWK] } } } });
  const body = JSON.stringify({ id: 'order-1', checkout_id: 'co-1' });
  const digest = `sha-256=:${nodeCrypto.createHash('sha256').update(body).digest('base64')}:`;
  const { req, rawBody } = resign({
    components: ['@method', '@authority', '@path', 'content-digest', 'content-type'],
    values: { '@method': 'POST', '@authority': HOST, '@path': '/ucp/order-webhook', 'content-digest': digest, 'content-type': 'application/json' },
    bodyString: body,
    originalUrl: '/ucp/order-webhook',
    extraHeaders: { 'ucp-agent': `profile="${BUSINESS}"` },
  });
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.verified, true, r.reason);
  assert.equal(r.ucp_agent_covered, false);
  assert.equal(r.meta_binding, 'not_checked');
});

test('a signature made for another host is authority_mismatch', async () => {
  const { v } = verifier();
  const { req, rawBody } = signedRequest({ url: 'https://shop.example/ucp/mcp' });
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.reason, 'authority_mismatch');
});

test('freshness: created in the future, created too old, or expires passed all fail; created is optional by default', async () => {
  const { v } = verifier();
  let s = signedRequest({ created: nowS() + 600, expires: nowS() + 900 });
  assert.equal((await v.verifyRequest(s.req, { rawBody: s.rawBody })).reason, 'not_yet_valid');
  s = signedRequest({ created: nowS() - 3600, expires: nowS() + 60 });
  assert.equal((await v.verifyRequest(s.req, { rawBody: s.rawBody })).reason, 'expired');
  s = signedRequest({ created: nowS() - 200, expires: nowS() - 120 });
  assert.equal((await v.verifyRequest(s.req, { rawBody: s.rawBody })).reason, 'expired');
  s = signedRequest({ created: null, expires: null });
  assert.equal((await v.verifyRequest(s.req, { rawBody: s.rawBody })).verified, true);
  const strict = verifier({ env: { UCP_SIGNATURE_REQUIRE_CREATED: '1' } });
  s = signedRequest({ created: null, expires: null });
  assert.equal((await strict.v.verifyRequest(s.req, { rawBody: s.rawBody })).reason, 'created_missing');
});

test('the requireCreated option overrides UCP_SIGNATURE_REQUIRE_CREATED in both directions', async () => {
  const forced = verifier({ env: { UCP_SIGNATURE_REQUIRE_CREATED: '0' }, requireCreated: true });
  let s = signedRequest({ created: null, expires: null });
  assert.equal((await forced.v.verifyRequest(s.req, { rawBody: s.rawBody })).reason, 'created_missing');
  assert.equal(forced.v.requireCreated, true);
  const relaxed = verifier({ env: { UCP_SIGNATURE_REQUIRE_CREATED: '1' }, requireCreated: false });
  s = signedRequest({ created: null, expires: null });
  assert.equal((await relaxed.v.verifyRequest(s.req, { rawBody: s.rawBody })).verified, true);
  assert.equal(verifier().v.maxAgeS, 300);
  assert.equal(verifier({ env: { UCP_SIGNATURE_MAX_AGE_S: '120' } }).v.maxAgeS, 120);
});

test('a verified result carries the sha256 of the signature bytes, never the signature', async () => {
  const { v } = verifier();
  const s = signedRequest();
  const r = await v.verifyRequest(s.req, { rawBody: s.rawBody });
  assert.equal(r.verified, true, r.reason);
  const sigB64 = /=:([^:]+):/.exec(s.req.headers.signature)[1];
  const expected = nodeCrypto.createHash('sha256').update(Buffer.from(sigB64, 'base64')).digest('hex');
  assert.equal(r.signature_sha256, expected);
  assert.ok(!JSON.stringify(r).includes(sigB64));
});

test('UCP_SIGNATURE_MAX_AGE_S widens the created window', async () => {
  const wide = verifier({ env: { UCP_SIGNATURE_MAX_AGE_S: '7200' } });
  const s = signedRequest({ created: nowS() - 3600, expires: nowS() + 60 });
  assert.equal((await wide.v.verifyRequest(s.req, { rawBody: s.rawBody })).verified, true);
});

// ---- the body and the signature bytes -------------------------------------------------------------------

test('no captured raw body is raw_body_unavailable: unchecked, not a spec error', async () => {
  const { v } = verifier();
  const { req } = signedRequest();
  const r = await v.verifyRequest(req, { rawBody: null });
  assert.equal(r.reason, 'raw_body_unavailable');
  assert.equal(r.ucp_error, null);
});

test('a Content-Digest with no sha-256 member is refused (sha-256 only)', async () => {
  const { v } = verifier();
  const { req, rawBody } = signedRequest();
  req.headers['content-digest'] = 'sha-512=:AAAA:';
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.reason, 'digest_algorithm_unsupported');
  assert.equal(r.ucp_error.code, 'digest_mismatch');
});

test('a DER-encoded ECDSA signature does not verify (raw r||s only)', async () => {
  const { v } = verifier();
  const { req, rawBody } = signedRequest();
  // Re-sign the same base as DER.
  const m = /^sig1=(.*)$/.exec(req.headers['signature-input']);
  const base = [
    `"@method": POST`, `"@authority": ${HOST}`, `"@path": /ucp/mcp`, `"ucp-agent": ${req.headers['ucp-agent']}`,
    `"content-digest": ${req.headers['content-digest']}`, `"content-type": application/json`, `"@signature-params": ${m[1]}`,
  ].join('\n');
  const der = nodeCrypto.sign('sha256', Buffer.from(base, 'utf8'), privateKey);
  req.headers.signature = `sig1=:${der.toString('base64')}:`;
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.verified, false);
  assert.equal(r.ucp_error.code, 'signature_invalid');
});

test('a signature by another key under our kid is signature_invalid', async () => {
  const { v } = verifier();
  const other = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const { req, rawBody } = signedRequest({ keyObject: other });
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.reason, 'bad_signature');
  assert.equal(r.ucp_error.code, 'signature_invalid');
});

test('an Ed25519 platform key verifies (optional algorithm), with no alg on the wire', async () => {
  const { v } = verifier({ routes: { [PLATFORM_PROFILE]: { signing_keys: [ED_JWK] } } });
  const body = rpcBody();
  const digest = `sha-256=:${nodeCrypto.createHash('sha256').update(body).digest('base64')}:`;
  const params = `("@method" "@authority" "@path" "ucp-agent" "content-digest" "content-type");created=${nowS()};keyid="platform-ed-key"`;
  const base = [`"@method": POST`, `"@authority": ${HOST}`, `"@path": /ucp/mcp`, `"ucp-agent": profile="${PLATFORM_PROFILE}"`,
    `"content-digest": ${digest}`, `"content-type": application/json`, `"@signature-params": ${params}`].join('\n');
  const sig = nodeCrypto.sign(null, Buffer.from(base, 'utf8'), ed.privateKey);
  const req = { method: 'POST', originalUrl: '/ucp/mcp', headers: {
    host: HOST, 'content-type': 'application/json', 'content-digest': digest, 'ucp-agent': `profile="${PLATFORM_PROFILE}"`,
    'signature-input': `sig1=${params}`, signature: `sig1=:${sig.toString('base64')}:` } };
  const r = await v.verifyRequest(req, { rawBody: Buffer.from(body) });
  assert.equal(r.verified, true, r.reason);
  assert.equal(r.alg, 'ed25519');
});

// ---- header <-> body binding ----------------------------------------------------------------------------

test('meta["ucp-agent"].profile naming another profile than the header is profile_binding_mismatch', async () => {
  const { v } = verifier();
  const { req, rawBody } = signedRequest({ bodyString: rpcBody({ profile: OTHER_PROFILE }) });
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'profile_binding_mismatch');
});

test('a body with no meta["ucp-agent"] verifies with meta_binding absent', async () => {
  const { v } = verifier();
  const { req, rawBody } = signedRequest({ bodyString: rpcBody({ profile: null }) });
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.verified, true, r.reason);
  assert.equal(r.meta_binding, 'absent');
});

test('metaProfileBinding reads params.arguments.meta and params.meta, across a batch', () => {
  const call = (profile, where = 'arguments') => ({ params: where === 'arguments' ? { arguments: { meta: { 'ucp-agent': { profile } } } } : { meta: { 'ucp-agent': { profile } } } });
  assert.equal(metaProfileBinding([call(PLATFORM_PROFILE), call(PLATFORM_PROFILE, 'params')], PLATFORM_PROFILE).binding, 'match');
  assert.equal(metaProfileBinding([call(PLATFORM_PROFILE), call(OTHER_PROFILE)], PLATFORM_PROFILE).binding, 'mismatch');
  assert.equal(metaProfileBinding({ params: {} }, PLATFORM_PROFILE).binding, 'absent');
});

// ---- labels ---------------------------------------------------------------------------------------------

test('a label tagged web-bot-auth or for Visa TAP belongs to the other verifier: no_ucp_label', async () => {
  const { v, calls } = verifier();
  const { req, rawBody } = signedRequest();
  req.headers['signature-input'] = req.headers['signature-input'].replace(/;keyid=/, ';tag="web-bot-auth";keyid=');
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.reason, 'no_ucp_label');
  assert.equal(calls.length, 0);
});

test('two labels: one broken, one good -> verified (at least one signature verifies)', async () => {
  const { v } = verifier();
  const { req, rawBody } = signedRequest();
  const params = /^sig1=(.*)$/.exec(req.headers['signature-input'])[1];
  const sig = /^sig1=(.*)$/.exec(req.headers.signature)[1];
  req.headers['signature-input'] = `bad=("@method");keyid="${KID}", sig1=${params}`;
  req.headers.signature = `bad=:AAAA:, sig1=${sig}`;
  const r = await v.verifyRequest(req, { rawBody });
  assert.equal(r.verified, true, r.reason);
  assert.equal(r.label, 'sig1');
});

test('malformed signature headers never throw', async () => {
  const { v } = verifier();
  const r = await v.verifyRequest({ method: 'POST', originalUrl: '/ucp/mcp', headers: { host: HOST, 'ucp-agent': `profile="${PLATFORM_PROFILE}"`, 'signature-input': 'sig1=((', signature: '!!' } });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'malformed_signature_headers');
});

// ---- config ---------------------------------------------------------------------------------------------

test('mode is off unless UCP_SIGNATURE_VERIFY_MODE=observe; anything else reads as off', () => {
  assert.equal(ucpSignatureMode({}), 'off');
  assert.equal(ucpSignatureMode({ UCP_SIGNATURE_VERIFY_MODE: 'observe' }), 'observe');
  assert.equal(ucpSignatureMode({ UCP_SIGNATURE_VERIFY_MODE: 'enforce' }), 'off');
});

test('parseTrustedProfiles keeps https URLs only, normalized, from several lists', () => {
  const s = parseTrustedProfiles(`${PLATFORM_PROFILE}, http://plain.example/p, not a url`, 'https://SHOP.example/.well-known/ucp#x');
  assert.deepEqual([...s].sort(), ['https://platform.example/.well-known/ucp-agent', 'https://shop.example/.well-known/ucp']);
});

// ---- R4: the key fetch reaches public addresses only ----------------------------------------------------

function recordingLookup(addresses) {
  const calls = [];
  const lookup = (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    calls.push(hostname);
    cb(null, addresses);
  };
  return { lookup, calls };
}

function withNoGlobalFetch(fn) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('global fetch must not be used'); };
  return Promise.resolve().then(() => fn(calls)).finally(() => { globalThis.fetch = saved; });
}

for (const [label, addresses] of [
  ['a private address', [{ address: '10.0.0.5', family: 4 }]],
  ['the metadata address', [{ address: '169.254.169.254', family: 4 }]],
  ['loopback v6', [{ address: '::1', family: 6 }]],
  ['a mixed public/private answer', [{ address: '8.8.8.8', family: 4 }, { address: '192.168.1.1', family: 4 }]],
]) {
  test(`an allowlisted profile host resolving to ${label} is refused at connect: profile_unreachable`, async () => {
    await withNoGlobalFetch(async (globalCalls) => {
      const dns = recordingLookup(addresses);
      const v = createUcpSignatureVerifier({ env: {}, dnsLookup: dns.lookup, trustedProfiles: [PLATFORM_PROFILE] });
      const s = signedRequest();
      const r = await v.verifyRequest(s.req, { rawBody: s.rawBody });
      assert.equal(r.verified, false);
      assert.equal(r.reason, 'profile_unreachable');
      assert.deepEqual(dns.calls, ['platform.example']);
      assert.equal(globalCalls.length, 0);
    });
  });
}

for (const profile of [
  'https://127.0.0.1/.well-known/ucp-agent',
  'https://[::ffff:169.254.169.254]/.well-known/ucp-agent',
  'https://shop.internal/.well-known/ucp-agent',
]) {
  test(`an allowlisted ${new URL(profile).hostname} profile is refused before any DNS lookup`, async () => {
    await withNoGlobalFetch(async (globalCalls) => {
      const dns = recordingLookup([{ address: '8.8.8.8', family: 4 }]);
      const v = createUcpSignatureVerifier({ env: {}, dnsLookup: dns.lookup, trustedProfiles: [profile] });
      const s = signedRequest({ profile, bodyString: rpcBody({ profile }) });
      const r = await v.verifyRequest(s.req, { rawBody: s.rawBody });
      assert.equal(r.reason, 'profile_unreachable');
      assert.equal(dns.calls.length, 0);
      assert.equal(globalCalls.length, 0);
    });
  });
}

test('an injected fetchImpl is still used as given (tests and callers with their own transport)', async () => {
  const { v, calls } = verifier();
  const s = signedRequest();
  assert.equal((await v.verifyRequest(s.req, { rawBody: s.rawBody })).verified, true);
  assert.deepEqual(calls, [PLATFORM_PROFILE]);
});
