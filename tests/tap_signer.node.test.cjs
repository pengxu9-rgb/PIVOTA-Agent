'use strict';

// signTapRequest (src/services/tapSigner.js): what it signs, and that the verifier accepts it.
//
// Independence anchor: the first test writes the expected TAP signature base out LITERALLY and checks the
// signature with node:crypto directly. The signer reuses the verifier's buildSignatureBase on purpose (one
// builder), so without this literal check a builder bug could sign and verify its own mistake.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');
const { signTapRequest } = require('../src/services/tapSigner');
const { createAgentSignatureVerifier } = require('../src/services/agentSignatureVerifier');

const HOST = 'commerce.mcp.pivota.cc';
const VISA_URL = 'https://mcp.visa.com/.well-known/jwks';
const T0 = 1_790_000_000;

function keypair(type, opts) {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync(type, opts);
  return { publicJwk: publicKey.export({ format: 'jwk' }), publicKey, privateKey };
}

function verifierWith(keys, now = T0) {
  const fetchImpl = async (url) => (url === VISA_URL
    ? { status: 200, text: async () => JSON.stringify({ keys }) }
    : { status: 404, text: async () => '' });
  return createAgentSignatureVerifier({ env: {}, fetchImpl, nowMs: () => now * 1000 });
}

const asRequest = (path, headers) => ({ method: 'POST', originalUrl: path, headers: { host: HOST, ...headers } });

test('the signed base is exactly the TAP base, written out by hand', () => {
  const { publicKey, privateKey } = keypair('ed25519');
  const out = signTapRequest({ url: `https://${HOST}/ucp/mcp?x=1`, privateKey, keyid: 'k1', nonce: 'n1', created: T0, expires: T0 + 300 });
  const params = `("@authority" "@path");created=${T0};expires=${T0 + 300};keyid="k1";alg="ed25519";nonce="n1";tag="agent-browser-auth"`;
  const literal = `"@authority": ${HOST}\n"@path": /ucp/mcp\n"@signature-params": ${params}`;
  assert.equal(out.signatureBase, literal);
  assert.equal(out.headers['signature-input'], `sig2=${params}`);
  const sig = Buffer.from(/^sig2=:(.*):$/.exec(out.headers.signature)[1], 'base64');
  assert.equal(nodeCrypto.verify(null, Buffer.from(literal, 'utf8'), publicKey, sig), true);
});

test('Ed25519, ES256 and PS256 TAP signatures from the signer verify; the identity carries authority, keyid and tag', async () => {
  const ed = keypair('ed25519');
  const ec = keypair('ec', { namedCurve: 'P-256' });
  const rsa = keypair('rsa', { modulusLength: 2048 });
  const verifier = verifierWith([
    { ...ed.publicJwk, kid: 'ed' },
    { ...ec.publicJwk, kid: 'ec' },
    { ...rsa.publicJwk, kid: 'rsa' },
  ]);
  for (const [kp, kid, alg, tag] of [[ed, 'ed', 'ed25519', 'agent-browser-auth'], [ec, 'ec', 'es256', 'agent-payer-auth'], [rsa, 'rsa', 'ps256', 'agent-browser-auth']]) {
    const { headers } = signTapRequest({ url: `https://${HOST}/acp/checkout_sessions`, privateKey: kp.privateKey, keyid: kid, alg, tag, created: T0 });
    const result = await verifier.verifyRequest(asRequest('/acp/checkout_sessions', headers));
    assert.equal(result.verified, true, `${alg}: ${result.reason}`);
    assert.equal(result.profile, 'visa-tap');
    assert.equal(result.authority, HOST);
    assert.equal(result.keyid, kid);
    assert.equal(result.tag, tag);
  }
});

test('the signer refuses what a conforming agent could not send', () => {
  const { privateKey } = keypair('ed25519');
  assert.throws(() => signTapRequest({ url: `https://${HOST}/mcp`, privateKey }), /keyid/);
  assert.throws(() => signTapRequest({ url: `https://${HOST}/mcp`, keyid: 'k' }), /privateKey/);
  assert.throws(() => signTapRequest({ url: `https://${HOST}/mcp`, privateKey, keyid: 'k', alg: 'hmac-sha256' }), /unsupported alg/);
  assert.throws(() => signTapRequest({ url: `https://${HOST}/mcp`, privateKey, keyid: 'k\n' }));
  // Default nonce is fresh per call.
  const a = signTapRequest({ url: `https://${HOST}/mcp`, privateKey, keyid: 'k' });
  const b = signTapRequest({ url: `https://${HOST}/mcp`, privateKey, keyid: 'k' });
  assert.notEqual(a.nonce, b.nonce);
});
