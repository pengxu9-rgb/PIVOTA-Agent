'use strict';

// scripts/probe-ucp-platform-signature.cjs — the S5 probe. Everything here is offline: self mode never
// leaves the process, and the live paths run against injected fetches. Keys are generated here.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const probe = require('../scripts/probe-ucp-platform-signature.cjs');
const { createUcpSignatureVerifier, UCP_ERRORS } = require('../src/services/ucpSignatureVerifier');

function sink() {
  let text = '';
  return { write: (s) => { text += s; }, text: () => text };
}

function keyPair(kid = 'probe-test-kid') {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const priv = privateKey.export({ format: 'jwk' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' };
  return { pem, priv, jwk, kid };
}

function tmpFile(name, obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucp-probe-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('--test-key: every self case passes (or is a documented SKIP) and exit is 0', async () => {
  const out = sink();
  const code = await probe.main(['--test-key', '--json'], { env: {}, stdout: out });
  const report = JSON.parse(out.text());
  assert.equal(code, 0, out.text());
  assert.deepEqual(report.results.filter((r) => r.status === 'FAIL'), []);
  assert.deepEqual(report.results.map((r) => r.id).sort(), ['1', '10', '2', '3', '4', '5', '8', '9', 'K', 'T'].sort());
  assert.equal(report.results.find((r) => r.id === '3').status, 'SKIP');
  assert.doesNotMatch(out.text(), /PRIVATE KEY/);
});

test('env key + the matching public JWK file (the S1 pub.jwk.json shape) passes and never prints key material', async () => {
  const k = keyPair('pivota-ucp-agent-test-kid');
  const out = sink();
  const code = await probe.main(['--profile-file', tmpFile('pub.jwk.json', k.jwk)], {
    env: { UCP_AGENT_SIGNING_PRIVATE_KEY: k.pem, UCP_AGENT_SIGNING_KEY_ID: k.kid },
    stdout: out,
  });
  assert.equal(code, 0, out.text());
  const pemBody = k.pem.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
  assert.equal(out.text().includes(pemBody.slice(0, 24)), false);
  assert.equal(out.text().includes(k.priv.d), false);
  assert.doesNotMatch(out.text(), /BEGIN/);
});

test('a profile publishing a DIFFERENT public key under our kid fails case K (exit 1)', async () => {
  const signer = keyPair('kid-1');
  const other = keyPair('kid-1');
  const out = sink();
  const code = await probe.main(['--profile-file', tmpFile('p.json', { signing_keys: [other.jwk], keys: [other.jwk] }), '--json'], {
    env: { UCP_AGENT_SIGNING_PRIVATE_KEY: signer.pem, UCP_AGENT_SIGNING_KEY_ID: 'kid-1' },
    stdout: out,
  });
  assert.equal(code, 1);
  const k = JSON.parse(out.text()).results.find((r) => r.id === 'K');
  assert.equal(k.status, 'FAIL');
  assert.match(k.detail, /DIFFERENT public key/);
});

test('a profile file holding a PRIVATE JWK is refused as a usage error', async () => {
  const k = keyPair();
  const out = sink();
  const code = await probe.main(['--profile-file', tmpFile('p.json', { ...k.priv, kid: k.kid })], {
    env: { UCP_AGENT_SIGNING_PRIVATE_KEY: k.pem, UCP_AGENT_SIGNING_KEY_ID: k.kid },
    stdout: out,
  });
  assert.equal(code, 2);
  assert.equal(out.text().includes(k.priv.d), false);
});

test('network paths need --live, https, and the exact --allow-host', async () => {
  const run = async (argv) => { const out = sink(); return { code: await probe.main(argv, { env: {}, stdout: out }), text: out.text() }; };
  assert.equal((await run(['--test-key', '--target', 'https://sandbox.example/ucp/mcp', '--allow-host', 'sandbox.example'])).code, 2);
  assert.equal((await run(['--test-key', '--check-profile'])).code, 2);
  assert.equal((await run(['--test-key', '--live', '--target', 'https://sandbox.example/ucp/mcp'])).code, 2);
  assert.equal((await run(['--test-key', '--live', '--target', 'https://sandbox.example/ucp/mcp', '--allow-host', 'other.example'])).code, 2);
  assert.equal((await run(['--test-key', '--live', '--target', 'http://sandbox.example/ucp/mcp', '--allow-host', 'sandbox.example'])).code, 2);
  assert.equal(probe.checkTarget('https://Sandbox.example/ucp/mcp', 'sandbox.example'), null);
});

// ---- case 6 -------------------------------------------------------------------------------------------

function profileResponse({ status = 200, cacheControl = 'public, max-age=300', doc }) {
  return async () => ({ status, headers: { get: (n) => (String(n).toLowerCase() === 'cache-control' ? cacheControl : null) }, text: async () => JSON.stringify(doc) });
}

test('case 6: a conforming profile endpoint passes', async () => {
  const k = keyPair('kid-a');
  const [r] = await probe.checkProfileEndpoint({ keyId: 'kid-a', fetchImpl: profileResponse({ doc: { signing_keys: [k.jwk], keys: [k.jwk] } }) });
  assert.equal(r.status, 'PASS', r.detail);
});

test('case 6: redirect, a short or private cache, no keys[] mirror, or a missing kid each fail', async () => {
  const k = keyPair('kid-a');
  const both = { signing_keys: [k.jwk], keys: [k.jwk] };
  const cases = [
    [{ status: 301, doc: both }, /status_200, no_redirect/],
    [{ cacheControl: 'public, max-age=30', doc: both }, /max_age_ge_60/],
    [{ cacheControl: 'private, max-age=300', doc: both }, /cache_public/],
    // Today's prod shape until the S2 keys[] mirror deploys.
    [{ doc: { signing_keys: [k.jwk] } }, /kid_in_keys, same_kids_both_arrays/],
    [{ doc: { signing_keys: [{ ...k.jwk, kid: 'old' }], keys: [{ ...k.jwk, kid: 'old' }] } }, /kid_in_signing_keys, kid_in_keys/],
  ];
  for (const [resp, why] of cases) {
    const [r] = await probe.checkProfileEndpoint({ keyId: 'kid-a', fetchImpl: profileResponse(resp) });
    assert.equal(r.status, 'FAIL', JSON.stringify(resp));
    assert.match(r.detail, why);
  }
  assert.equal(probe.maxAgeOf('no-cache, max-age=61'), 61);
  assert.equal(probe.maxAgeOf('s-maxage=600'), null);
});

test('case 6: the profile GET never follows a redirect', async () => {
  let init;
  await probe.checkProfileEndpoint({ keyId: 'x', fetchImpl: async (u, i) => { init = i; return { status: 200, headers: { get: () => null }, text: async () => '{}' }; } });
  assert.equal(init.redirect, 'manual');
});

// ---- live cases 1, 8, 9 against a fake sandbox --------------------------------------------------------

/** A sandbox that verifies with OUR verifier and answers in the spec's JSON-RPC error shape. */
function strictSandbox(k, target) {
  const u = new URL(target);
  const verifier = createUcpSignatureVerifier({
    env: { UCP_SIGNATURE_EXPECTED_AUTHORITIES: u.host },
    trustedProfiles: [probe.CANONICAL_PROFILE_URL],
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ signing_keys: [k.jwk] }) }),
  });
  return async (url, init) => {
    const headers = { host: u.host };
    for (const [n, v] of Object.entries(init.headers)) headers[n.toLowerCase()] = v;
    const r = await verifier.verifyRequest({ method: 'POST', originalUrl: u.pathname, headers }, { rawBody: Buffer.from(init.body) });
    const json = r.verified
      ? { jsonrpc: '2.0', id: 1, result: { content: [] } }
      : { jsonrpc: '2.0', id: 1, error: { code: UCP_ERRORS[r.ucp_error.code].jsonrpc_code, message: 'Signature verification failed', data: { code: r.ucp_error.code } } };
    return { status: r.verified ? 200 : r.ucp_error.http_status, text: async () => JSON.stringify(json) };
  };
}

test('live: a sandbox enforcing the standard gives PASS on 1L, 8L, 9L', async () => {
  const k = keyPair('kid-live');
  const target = 'https://sandbox.example/ucp/mcp';
  const results = await probe.sendLiveCases({ target, privateKeyRaw: k.pem, keyId: k.kid, fetchImpl: strictSandbox(k, target) });
  assert.deepEqual(results.map((r) => [r.id, r.status]), [['1L', 'PASS'], ['8L', 'PASS'], ['9L', 'PASS']], JSON.stringify(results));
});

test('live: a sandbox that accepts everything fails 8L and 9L (it is not checking)', async () => {
  const k = keyPair('kid-live');
  const lax = async () => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) });
  const results = await probe.sendLiveCases({ target: 'https://sandbox.example/ucp/mcp', privateKeyRaw: k.pem, keyId: k.kid, fetchImpl: lax });
  assert.deepEqual(results.map((r) => [r.id, r.status]), [['1L', 'PASS'], ['8L', 'FAIL'], ['9L', 'FAIL']]);
});

test('live sends never follow redirects', async () => {
  const k = keyPair();
  const inits = [];
  await probe.sendLiveCases({ target: 'https://sandbox.example/ucp/mcp', privateKeyRaw: k.pem, keyId: k.kid, fetchImpl: async (u, i) => { inits.push(i); return { status: 302, text: async () => '' }; } });
  assert.equal(inits.length, 3);
  assert.ok(inits.every((i) => i.redirect === 'manual'));
});
