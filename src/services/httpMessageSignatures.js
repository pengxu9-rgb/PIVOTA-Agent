'use strict';

// RFC 9421 HTTP Message Signatures — VERIFYING a signed request that reached one of our doors.
//
// The outbound half already exists (ucpBuyerAgentClient.signUcpRequest signs our own calls to merchant
// UCP doors with one fixed component list). This is the general inbound half: an agent picks its own
// covered components, label and algorithm, and we have to rebuild the exact signature base it signed
// from the request as WE received it, then check the signature with a public key someone else
// publishes. Profile policy (which tags, which keys, what windows) lives in agentSignatureVerifier.js;
// this module only knows the RFC.
//
// What "as we received it" means behind Cloud Run: @authority is the Host header the agent sent
// (Cloud Run forwards it unchanged), @scheme is https on every public host (TLS terminates at the
// edge, x-forwarded-proto says so), and @path / @query come from the raw request-target
// (req.originalUrl), never from Express's decoded req.path — the agent signed the bytes it sent.
//
// Every failure is a REASON string, not an exception, so the caller can count them.

const nodeCrypto = require('crypto');
const { parseDictionary, serializeInnerList, serializeMemberValue, serializeParameters } = require('./httpStructuredFields');

const DERIVED = new Set(['@method', '@target-uri', '@authority', '@scheme', '@request-target', '@path', '@query']);

// Algorithms we will verify, keyed by every spelling an agent puts in the `alg` parameter. RFC 9421 §6.2
// names (ed25519, ecdsa-p256-sha256, rsa-pss-sha512) and the JOSE names Visa's TAP spec uses (PS256,
// ES256, EdDSA). Deliberately absent: hmac-sha256 (a shared secret is not an agent identity) and the
// PKCS#1 v1.5 RSA forms (TAP itself prefers PS256 over RS256).
// `canonical` makes spellings of the same algorithm comparable (a JWK's `alg` vs the request's `alg`).
const ALGORITHMS = Object.freeze({
  ed25519: { canonical: 'ed25519', kty: 'OKP', crv: 'Ed25519', verify: verifyEd25519 },
  eddsa: { canonical: 'ed25519', kty: 'OKP', crv: 'Ed25519', verify: verifyEd25519 },
  'ecdsa-p256-sha256': { canonical: 'es256', kty: 'EC', crv: 'P-256', verify: verifyEs256 },
  es256: { canonical: 'es256', kty: 'EC', crv: 'P-256', verify: verifyEs256 },
  'rsa-pss-sha512': { canonical: 'ps512', kty: 'RSA', verify: (k, d, s) => verifyRsaPss(k, d, s, 'sha512', 64) },
  ps512: { canonical: 'ps512', kty: 'RSA', verify: (k, d, s) => verifyRsaPss(k, d, s, 'sha512', 64) },
  ps256: { canonical: 'ps256', kty: 'RSA', verify: (k, d, s) => verifyRsaPss(k, d, s, 'sha256', 32) },
});

function lookupAlgorithm(name) {
  const key = String(name || '').toLowerCase();
  return Object.hasOwn(ALGORITHMS, key) ? ALGORITHMS[key] : null;
}

const MIN_RSA_BITS = 2048;

function verifyEd25519(keyObject, data, sig) {
  return sig.length === 64 && nodeCrypto.verify(null, data, keyObject, sig);
}

function verifyEs256(keyObject, data, sig) {
  // RFC 9421 §3.3.4: r||s, 32 bytes each — NOT DER.
  return sig.length === 64 && nodeCrypto.verify('sha256', data, { key: keyObject, dsaEncoding: 'ieee-p1363' }, sig);
}

function verifyRsaPss(keyObject, data, sig, hash, saltLength) {
  return nodeCrypto.verify(hash, data, {
    key: keyObject,
    padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength,
  }, sig);
}

/**
 * Import a PUBLIC JWK. Refuses anything carrying private material — a directory that serves `d` is
 * broken or hostile, and either way it is not something we hand to crypto.verify.
 * @returns {{ keyObject: import('crypto').KeyObject, kty: string, crv?: string, alg?: string } | null}
 */
function importPublicJwk(jwk) {
  if (!jwk || typeof jwk !== 'object') return null;
  if (jwk.d !== undefined || jwk.p !== undefined || jwk.k !== undefined) return null;
  // A key the publisher restricted to something other than verifying signatures is not ours to use.
  if (jwk.use !== undefined && jwk.use !== 'sig') return null;
  if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify'))) return null;
  const { kty, crv } = jwk;
  // e=1 makes every "signature" valid (s^1 = s); only the standard exponent 65537 is accepted.
  if (kty === 'RSA' && jwk.e !== 'AQAB') return null;
  if (!['OKP', 'EC', 'RSA'].includes(kty)) return null;
  if (kty === 'OKP' && crv !== 'Ed25519') return null;
  if (kty === 'EC' && crv !== 'P-256') return null;
  try {
    const keyObject = nodeCrypto.createPublicKey({ key: jwk, format: 'jwk' });
    if (kty === 'RSA') {
      const bits = keyObject.asymmetricKeyDetails?.modulusLength || 0;
      if (bits < MIN_RSA_BITS) return null;
    }
    return { keyObject, kty, crv, alg: typeof jwk.alg === 'string' ? jwk.alg : undefined };
  } catch {
    return null;
  }
}

/**
 * RFC 7638 JWK SHA-256 thumbprint, base64url — Web Bot Auth's mandatory keyid (and RFC 8037 A.3 for OKP).
 */
function jwkThumbprint(jwk) {
  let members;
  if (jwk.kty === 'OKP') members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  else if (jwk.kty === 'EC') members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  else if (jwk.kty === 'RSA') members = { e: jwk.e, kty: jwk.kty, n: jwk.n };
  else return null;
  if (Object.values(members).some((v) => typeof v !== 'string')) return null;
  return nodeCrypto.createHash('sha256').update(JSON.stringify(members), 'utf8').digest('base64url');
}

/**
 * Pick the algorithm for (alg param, key). When the agent names one it must exist and match the key
 * type; when it does not, an OKP/EC key implies its only algorithm and an RSA key is ambiguous.
 */
function resolveAlgorithm(algParam, key) {
  // A JWK that pins an algorithm only verifies that algorithm (RFC 7517 §4.4), whatever the request says.
  const keyAlg = key.alg ? lookupAlgorithm(key.alg) : null;
  if (key.alg && !keyAlg) return { reason: 'algorithm_not_allowed' };
  const name = algParam ? String(algParam).toLowerCase() : null;
  if (name) {
    const alg = lookupAlgorithm(name);
    if (!alg) return { reason: 'algorithm_not_allowed' };
    if (alg.kty !== key.kty || (alg.crv && alg.crv !== key.crv)) return { reason: 'algorithm_key_mismatch' };
    if (keyAlg && keyAlg.canonical !== alg.canonical) return { reason: 'algorithm_key_mismatch' };
    return { alg, name };
  }
  if (keyAlg) return resolveAlgorithm(key.alg, key);
  if (key.kty === 'OKP') return { alg: ALGORITHMS.ed25519, name: 'ed25519' };
  if (key.kty === 'EC') return { alg: ALGORITHMS['ecdsa-p256-sha256'], name: 'ecdsa-p256-sha256' };
  return { reason: 'algorithm_ambiguous' };
}

// ---- request view -----------------------------------------------------------------------------------

/**
 * The parts of an Express request a signature can cover, read once. `originalUrl` is the raw
 * request-target; the authority is lower-cased with a default port dropped (RFC 9421 §2.2.3).
 */
function requestView(req) {
  const headers = (req && req.headers) || {};
  // Field values come from rawHeaders when Node provides it: req.headers keeps only the FIRST value of a
  // repeated singleton header (content-type, …) and joins Cookie with "; ", while RFC 9421 §2.1 wants
  // every line, trimmed, joined with ", ". Plain objects (tests, other callers) fall back to req.headers.
  const fields = new Map();
  const raw = Array.isArray(req && req.rawHeaders) ? req.rawHeaders : null;
  if (raw) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = String(raw[i]).toLowerCase();
      if (!fields.has(name)) fields.set(name, []);
      fields.get(name).push(String(raw[i + 1]));
    }
  } else {
    for (const name of Object.keys(headers)) {
      const v = headers[name];
      fields.set(name.toLowerCase(), (Array.isArray(v) ? v : [v]).map(String));
    }
  }
  const scheme = String(headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim().toLowerCase();
  let authority = String(headers.host || '').trim().toLowerCase();
  let target = String(req.originalUrl || req.url || '/');
  // Absolute-form request-target (RFC 9112 §3.2.2): the authority is the TARGET's (Host is ignored) and the
  // path/query are the raw characters after it — split by hand, not through WHATWG URL, which would
  // rewrite them (dot-segments, percent-encoding) away from what the agent signed.
  const abs = /^https?:\/\/([^/?#]*)(.*)$/i.exec(target);
  if (abs) {
    authority = abs[1].toLowerCase();
    target = abs[2] || '/';
    if (!target.startsWith('/')) target = `/${target}`;
  }
  if ((scheme === 'https' && authority.endsWith(':443')) || (scheme === 'http' && authority.endsWith(':80'))) {
    authority = authority.replace(/:\d+$/, '');
  }
  const q = target.indexOf('?');
  const rawPath = q === -1 ? target : target.slice(0, q);
  const rawQuery = q === -1 ? '' : target.slice(q + 1);
  return {
    method: String(req.method || 'GET').toUpperCase(),
    scheme,
    authority,
    path: rawPath || '/',
    query: rawQuery,
    hasQuery: q !== -1,
    headers,
    fields,
  };
}

function headerValue(view, name) {
  const values = view.fields.get(name);
  if (!values) return undefined;
  return values.map((v) => v.trim()).join(', ');
}

function derivedValue(view, name) {
  switch (name) {
    case '@method': return view.method;
    case '@scheme': return view.scheme;
    case '@authority': return view.authority;
    case '@path': return view.path;
    case '@query': return `?${view.query}`;
    case '@request-target': return view.hasQuery ? `${view.path}?${view.query}` : view.path;
    case '@target-uri': return `${view.scheme}://${view.authority}${view.path}${view.hasQuery ? `?${view.query}` : ''}`;
    default: return undefined;
  }
}

/**
 * Value of one covered component, or a failure reason. Supported component parameters: `key` (a
 * Dictionary member — how Web Bot Auth covers its own Signature-Agent member) and nothing else; `sf`,
 * `bs`, `req`, `tr` and `@query-param` would each need their own canonicalisation and no agent profile
 * we accept uses them, so they fail loudly instead of verifying against the wrong bytes.
 */
function componentValue(view, item) {
  if (item.type !== 'string') return { reason: 'malformed_component' };
  const name = item.value;
  if (name !== name.toLowerCase()) return { reason: 'malformed_component' };
  const params = item.params || new Map();
  for (const p of params.keys()) if (p !== 'key') return { reason: 'unsupported_component_parameter' };

  if (name.startsWith('@')) {
    if (params.size) return { reason: 'unsupported_component_parameter' };
    if (!DERIVED.has(name)) return { reason: 'unsupported_component' };
    return { value: derivedValue(view, name) };
  }

  const raw = headerValue(view, name);
  if (raw === undefined) return { reason: 'missing_covered_header' };
  if (!params.has('key')) return { value: raw };

  const keyParam = params.get('key');
  if (keyParam.type !== 'string') return { reason: 'malformed_component' };
  let dict;
  try {
    dict = parseDictionary(raw);
  } catch {
    return { reason: 'malformed_covered_header' };
  }
  const member = dict.get(keyParam.value);
  if (!member) return { reason: 'missing_covered_header' };
  return { value: serializeMemberValue(member) };
}

function componentIdentifier(item) {
  return `"${item.value}"${serializeParameters(item.params)}`;
}

/**
 * RFC 9421 §2.5 signature base for one parsed Signature-Input member.
 * @returns {{ base?: string, covered?: string[], reason?: string }}
 */
function buildSignatureBase(view, inputMember) {
  if (!inputMember || inputMember.type !== 'inner_list') return { reason: 'malformed_signature_input' };
  const lines = [];
  const covered = [];
  const seen = new Set();
  for (const item of inputMember.value) {
    const id = componentIdentifier(item);
    if (seen.has(id)) return { reason: 'duplicate_component' };
    seen.add(id);
    const { value, reason } = componentValue(view, item);
    if (reason) return { reason, component: id };
    if (/[\r\n]/.test(value)) return { reason: 'malformed_covered_header', component: id };
    lines.push(`${id}: ${value}`);
    covered.push(id);
  }
  lines.push(`"@signature-params": ${serializeInnerList(inputMember)}`);
  return { base: lines.join('\n'), covered };
}

/**
 * Read the scalar signature parameters an agent put on its Signature-Input member.
 */
function signatureParams(inputMember) {
  const out = {};
  for (const [k, v] of inputMember.params || new Map()) {
    if (k === 'created' || k === 'expires') {
      if (v.type !== 'integer') return { reason: 'malformed_signature_input' };
      out[k] = v.value;
    } else if (k === 'keyid' || k === 'alg' || k === 'nonce' || k === 'tag') {
      if (v.type !== 'string') return { reason: 'malformed_signature_input' };
      out[k] = v.value;
    }
  }
  return { params: out };
}

/**
 * Check one signature value against a base with one public key.
 * @returns {{ ok: boolean, reason?: string, alg?: string }}
 */
function verifySignature({ base, signature, key, algParam }) {
  const choice = resolveAlgorithm(algParam, key);
  if (choice.reason) return { ok: false, reason: choice.reason };
  if (!Buffer.isBuffer(signature) || signature.length === 0) return { ok: false, reason: 'malformed_signature' };
  let ok = false;
  try {
    ok = choice.alg.verify(key.keyObject, Buffer.from(base, 'utf8'), signature);
  } catch {
    ok = false;
  }
  return ok ? { ok: true, alg: choice.name } : { ok: false, reason: 'bad_signature', alg: choice.name };
}

module.exports = {
  ALGORITHMS,
  importPublicJwk,
  jwkThumbprint,
  requestView,
  buildSignatureBase,
  signatureParams,
  verifySignature,
};
