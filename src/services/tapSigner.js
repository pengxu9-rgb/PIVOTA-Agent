'use strict';

// SIGN a request the way a Visa Trusted Agent Protocol agent does — RFC 9421 over @authority and @path,
// with created / expires / keyid / alg / nonce / tag. The verifying half is agentSignatureVerifier.js.
//
// Two callers: the tests, which sign with THIS instead of hand-writing header strings (so a TAP request in
// a test is exactly what a conforming agent would send, and a change to the profile shows up in both
// halves at once); and, later, Pivota's own agent side (VIC Agent Enabler), which signs outbound requests
// to TAP-recognising merchants with the same profile.
//
// The base is built by the same buildSignatureBase the verifier uses. That is deliberate — one builder is
// what makes "signed here verifies there" a statement about the profile, not about two copies agreeing.
// The builder's own correctness is pinned separately against RFC 9421 B.2.6 and literal bases in
// tests/agent_signature_verifier.node.test.cjs, and tests/tap_signer.node.test.cjs checks this signer's
// output against a base written out by hand.

const nodeCrypto = require('crypto');
const { requestView, buildSignatureBase } = require('./httpMessageSignatures');
const { parseDictionary, serializeItem } = require('./httpStructuredFields');

const TAP_TAGS = Object.freeze(['agent-browser-auth', 'agent-payer-auth']);
const TAP_DEFAULT_WINDOW_S = 300;

// alg parameter value → how node:crypto signs it (RFC 9421 §3.3 encodings: raw r||s for ECDSA, not DER).
const SIGNERS = Object.freeze({
  ed25519: (data, key) => nodeCrypto.sign(null, data, key),
  eddsa: (data, key) => nodeCrypto.sign(null, data, key),
  es256: (data, key) => nodeCrypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }),
  'ecdsa-p256-sha256': (data, key) => nodeCrypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }),
  ps256: (data, key) => nodeCrypto.sign('sha256', data, { key, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }),
  ps512: (data, key) => nodeCrypto.sign('sha512', data, { key, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 }),
  'rsa-pss-sha512': (data, key) => nodeCrypto.sign('sha512', data, { key, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 }),
});

const sfString = (value) => serializeItem({ type: 'string', value: String(value), params: new Map() });

/**
 * Sign one request with the TAP profile.
 *
 * @param {object} p
 * @param {string} p.url              absolute URL the request goes to (authority and path are taken from it)
 * @param {import('crypto').KeyObject} p.privateKey
 * @param {string} p.keyid            the kid of the matching public key in the agent's JWKS
 * @param {string} [p.alg]            'ed25519' (default), 'es256' or 'ps256' (and RFC 9421 spellings)
 * @param {string} [p.tag]            'agent-browser-auth' (default) or 'agent-payer-auth'
 * @param {string} [p.nonce]          default: 16 random bytes, base64url
 * @param {number} [p.created]        unix seconds; default now
 * @param {number} [p.expires]        unix seconds; default created + 300 (TAP allows at most 8 minutes)
 * @param {string} [p.label]          signature label; default 'sig2' (Visa's examples)
 * @returns {{ headers: { 'signature-input': string, signature: string }, signatureBase: string, nonce: string }}
 */
function signTapRequest({ url, privateKey, keyid, alg = 'ed25519', tag = TAP_TAGS[0], nonce, created, expires, label = 'sig2', nowMs = Date.now } = {}) {
  if (!privateKey) throw new Error('signTapRequest: privateKey is required');
  if (!keyid) throw new Error('signTapRequest: keyid is required');
  const sign = Object.hasOwn(SIGNERS, String(alg).toLowerCase()) ? SIGNERS[String(alg).toLowerCase()] : null;
  if (!sign) throw new Error(`signTapRequest: unsupported alg ${alg}`);
  if (!/^[a-z][a-z0-9_-]*$/.test(label)) throw new Error('signTapRequest: label must be an sf-key');
  const u = new URL(url);
  const c = Number.isInteger(created) ? created : Math.floor(nowMs() / 1000);
  const e = Number.isInteger(expires) ? expires : c + TAP_DEFAULT_WINDOW_S;
  const n = nonce == null ? nodeCrypto.randomBytes(16).toString('base64url') : String(nonce);

  // serializeItem refuses non-printable input, so an odd keyid/nonce throws here instead of being sent.
  const params = `("@authority" "@path");created=${c};expires=${e};keyid=${sfString(keyid)};alg=${sfString(alg)};nonce=${sfString(n)};tag=${sfString(tag)}`;
  const inputMember = parseDictionary(`${label}=${params}`).get(label);
  // The request as the receiving door will see it: Host = the URL's authority, raw path from the URL.
  const view = requestView({ method: 'GET', originalUrl: `${u.pathname}${u.search}`, headers: { host: u.host }, protocol: u.protocol.replace(':', '') });
  const built = buildSignatureBase(view, inputMember);
  if (built.reason) throw new Error(`signTapRequest: ${built.reason}`);
  const sig = sign(Buffer.from(built.base, 'utf8'), privateKey);
  return {
    headers: {
      'signature-input': `${label}=${params}`,
      signature: `${label}=:${sig.toString('base64')}:`,
    },
    signatureBase: built.base,
    nonce: n,
  };
}

module.exports = { signTapRequest, TAP_TAGS, TAP_DEFAULT_WINDOW_S };
