'use strict';

// UCP request signatures, VERIFIED: the default UCP regime (ucp.dev/2026-04-08/specification/signatures).
//
// WHY. Shopline's agent standard (designed with Meta's Muse, 2026-11-20) is UCP's: a platform names its
// profile in a `UCP-Agent: profile="<url>"` header, signs the request per RFC 9421 with ES256, and the
// receiver finds the key in that profile's `signing_keys[]` by `kid`. Pivota signs that way outbound
// (ucpBuyerAgentClient.signUcpRequest). This module is the receiving half, for two callers:
//   - our doors, when Muse / Shopline / any UCP platform calls us signed (observe only:
//     UCP_SIGNATURE_VERIFY_MODE, src/server.js ucpSignatureObserveMiddleware);
//   - our order-webhook receiver, which a UCP business signs with a key from ITS `/.well-known/ucp`
//     (ucpOrderWebhookReceiver.js, UCP_ORDER_WEBHOOK_RFC9421_MODE).
//
// HOW IT DIFFERS FROM agentSignatureVerifier.js (Web Bot Auth / Visa TAP), which stays as it is:
//   - no `tag`. UCP signatures carry none; the key source is the `UCP-Agent` profile, not Signature-Agent.
//     A label tagged for Web Bot Auth or TAP is that verifier's business and is skipped here.
//   - no `alg` on the wire: the algorithm follows the key (ES256 baseline; Ed25519 accepted).
//   - Content-Digest (RFC 9530, sha-256) is CHECKED against the exact body bytes, not just covered.
//   - coverage follows the request: @method @authority @path always; @query when there is one;
//     content-digest + content-type when there is a body; idempotency-key / ucp-agent / signature-agent
//     whenever that header is present (spec verify_rest_request step 2b). Missing = coverage_insufficient.
//   - for a JSON-RPC body, `params.arguments.meta["ucp-agent"].profile` (where UCP MCP puts it, and where we
//     put it outbound) must name the same profile as the header when it is present.
//
// ALLOWLISTED PROFILES ONLY. The profile URL is attacker-chosen. Fetching whatever a request names would make
// every door an SSRF primitive, so only URLs in the caller's trusted list are ever fetched. Any other profile
// is reported as `profile_not_trusted` with the claimed URL attached (bounded) for counting. The spec's own
// rule for businesses: "SHOULD maintain a registry of pre-approved platforms".
//
// FRESHNESS is application-defined in UCP (`created` is optional, replay protection is the signed
// idempotency-key). Here: a `created` in the future beyond the skew, or older than UCP_SIGNATURE_MAX_AGE_S,
// fails; an `expires` in the past fails; a missing `created` fails only with UCP_SIGNATURE_REQUIRE_CREATED.
//
// RESULTS, NEVER THROWS. Every outcome is an object with `verified`, a fine `reason`, and `ucp_error` — the
// spec's error code with its HTTP status and JSON-RPC code — so a later enforce step answers in the
// standard's words. Nothing here refuses a request; callers decide.

const nodeCrypto = require('crypto');
const {
  importPublicJwk,
  requestView,
  buildSignatureBase,
  signatureParams,
  verifySignature,
} = require('./httpMessageSignatures');
const { parseDictionary } = require('./httpStructuredFields');

const PROFILE_KIND = Object.freeze({ PLATFORM: 'platform', BUSINESS: 'business' });

// The spec's error table (signatures + overview pages, 2026-04-08). `profile_not_trusted` has no JSON-RPC
// code there; the profile_* family's -32001 is used. `coverage_insufficient` has no row at all; it is
// reported as `signature_invalid`, which is what the spec's response-verification pseudocode uses for it.
const UCP_ERRORS = Object.freeze({
  signature_missing: { http_status: 401, jsonrpc_code: -32000 },
  signature_invalid: { http_status: 401, jsonrpc_code: -32000 },
  key_not_found: { http_status: 401, jsonrpc_code: -32000 },
  digest_mismatch: { http_status: 400, jsonrpc_code: -32600 },
  algorithm_unsupported: { http_status: 400, jsonrpc_code: -32600 },
  invalid_profile_url: { http_status: 400, jsonrpc_code: -32001 },
  profile_unreachable: { http_status: 424, jsonrpc_code: -32001 },
  profile_malformed: { http_status: 422, jsonrpc_code: -32001 },
  profile_not_trusted: { http_status: 403, jsonrpc_code: -32001 },
});

// Fine reason -> spec code. Reasons not listed are "we could not check" (no spec error: the caller treats
// them as unverified, never as refused).
const REASON_TO_UCP = Object.freeze({
  signature_missing: 'signature_missing',
  malformed_signature_headers: 'signature_invalid',
  missing_signature: 'signature_invalid',
  keyid_missing: 'signature_invalid',
  coverage_insufficient: 'signature_invalid',
  authority_mismatch: 'signature_invalid',
  not_yet_valid: 'signature_invalid',
  expired: 'signature_invalid',
  created_missing: 'signature_invalid',
  malformed_signature_input: 'signature_invalid',
  malformed_component: 'signature_invalid',
  unsupported_component: 'signature_invalid',
  unsupported_component_parameter: 'signature_invalid',
  missing_covered_header: 'signature_invalid',
  malformed_covered_header: 'signature_invalid',
  duplicate_component: 'signature_invalid',
  malformed_signature: 'signature_invalid',
  bad_signature: 'signature_invalid',
  profile_binding_mismatch: 'signature_invalid',
  key_not_found: 'key_not_found',
  digest_mismatch: 'digest_mismatch',
  digest_algorithm_unsupported: 'digest_mismatch',
  algorithm_not_allowed: 'algorithm_unsupported',
  algorithm_key_mismatch: 'algorithm_unsupported',
  algorithm_ambiguous: 'algorithm_unsupported',
  ucp_agent_missing: 'invalid_profile_url',
  invalid_profile_url: 'invalid_profile_url',
  profile_unreachable: 'profile_unreachable',
  profile_malformed: 'profile_malformed',
  profile_not_trusted: 'profile_not_trusted',
});

// Outcomes that say nothing about the signature: we could not check it.
const UNCHECKED_REASONS = Object.freeze(new Set([
  'raw_body_unavailable',
  'verification_timeout',
  'verifier_error',
  'no_ucp_label',
]));

// Labels with these tags belong to agentSignatureVerifier.js (Web Bot Auth, Visa TAP).
const FOREIGN_TAGS = new Set(['web-bot-auth', 'agent-browser-auth', 'agent-payer-auth']);

const BUSINESS_PROFILE_PATH = '/.well-known/ucp';
const DEFAULT_EXPECTED_AUTHORITIES = Object.freeze(['commerce.mcp.pivota.cc', 'mcp.pivota.cc', 'gateway.pivota.cc', 'ucp.pivota.cc']);
const DEFAULT_MAX_AGE_S = 300;
const CLOCK_SKEW_S = 60;
const MAX_LABELS = 4;
const FETCH_TIMEOUT_MS = 1_000;
// Spec: bound the profile body, "no lower than 128 KiB".
const MAX_PROFILE_BYTES = 128 * 1024;
const MAX_KEYS = 64;
const PROFILE_TTL_MS = 10 * 60_000;
// Spec: unknown kid "SHOULD force-refresh the cached profile once", "MUST NOT ... more than once per TTL floor"
// (60s) per origin.
const MIN_FORCED_REFRESH_GAP_MS = 60_000;
const NEGATIVE_TTL_MS = 30_000;

const MODES = new Set(['off', 'observe']);

function isFlagOn(value) {
  return ['1', 'true', 'on', 'yes'].includes(String(value || '').trim().toLowerCase());
}

/** UCP_SIGNATURE_VERIFY_MODE for our doors: off (default) | observe. There is no enforce yet. */
function ucpSignatureMode(env = process.env) {
  const raw = String(env.UCP_SIGNATURE_VERIFY_MODE || 'off').trim().toLowerCase();
  return MODES.has(raw) ? raw : 'off';
}

/** A profile URL in the one spelling the allowlist and the cache compare: https, no userinfo, no fragment. */
function normalizeProfileUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  u.hash = '';
  return u.toString();
}

/** Comma list of profile URLs -> Set of normalized URLs. Unparseable entries are dropped, never guessed at. */
function parseTrustedProfiles(...raws) {
  const out = new Set();
  for (const raw of raws) {
    for (const part of String(raw || '').split(',')) {
      const n = part.trim() ? normalizeProfileUrl(part.trim()) : null;
      if (n) out.add(n);
    }
  }
  return out;
}

function loadExpectedAuthorities(env = process.env) {
  const raw = env.UCP_SIGNATURE_EXPECTED_AUTHORITIES ?? env.AGENT_SIGNATURE_EXPECTED_AUTHORITIES;
  const list = raw == null || String(raw).trim() === ''
    ? DEFAULT_EXPECTED_AUTHORITIES
    : String(raw).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return new Set(list);
}

function positiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The `profile` member of a UCP-Agent header (RFC 8941 Dictionary), as a normalized https URL.
 * @returns {{ url?: string, claimed?: string, reason?: string }}
 */
function parseUcpAgentHeader(raw, kind = PROFILE_KIND.PLATFORM) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { reason: 'ucp_agent_missing' };
  const text = Array.isArray(raw) ? raw.join(', ') : String(raw);
  let member;
  try {
    member = parseDictionary(text).get('profile');
  } catch {
    return { reason: 'invalid_profile_url' };
  }
  if (!member || member.type !== 'string') return { reason: 'invalid_profile_url' };
  const claimed = member.value.slice(0, 200);
  const url = normalizeProfileUrl(member.value);
  if (!url) return { reason: 'invalid_profile_url', claimed };
  // Spec: "For business profiles, URL MUST point to /.well-known/ucp; platform profile URLs are not
  // path-constrained."
  if (kind === PROFILE_KIND.BUSINESS && new URL(url).pathname !== BUSINESS_PROFILE_PATH) {
    return { reason: 'invalid_profile_url', claimed };
  }
  return { url, claimed };
}

/** Every verification key a UCP profile publishes: `signing_keys[]` (canonical), then `keys[]`, then the
 * Shopify-shaped `ucp.signing_keys`, first `kid` wins. Unusable or private-bearing JWKs are dropped. */
function keysFromProfile(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const lists = [doc.signing_keys, doc.keys, doc.ucp && doc.ucp.signing_keys].filter(Array.isArray);
  if (!lists.length) return null;
  const out = [];
  const seen = new Set();
  for (const jwk of lists.flat().slice(0, MAX_KEYS * 3)) {
    if (!jwk || typeof jwk.kid !== 'string' || !jwk.kid || seen.has(jwk.kid)) continue;
    const key = importPublicJwk(jwk);
    if (!key) continue;
    seen.add(jwk.kid);
    out.push({ ...key, kid: jwk.kid });
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

async function readCapped(res, cap) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > cap) throw Object.assign(new Error('too large'), { malformed: true });
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('too large'), { malformed: true });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createProfileKeyCache({ fetchImpl, nowMs }) {
  const cache = new Map(); // url -> { keys, fetchedAt, failedAt, failReason, inflight }

  async function fetchProfileKeys(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let res;
      try {
        // Spec: "Implementations MUST NOT follow redirects (3xx)."
        res = await fetchImpl(url, { redirect: 'manual', signal: controller.signal, headers: { accept: 'application/json' } });
      } catch {
        throw Object.assign(new Error('unreachable'), { reason: 'profile_unreachable' });
      }
      if (!res || res.status !== 200) throw Object.assign(new Error('status'), { reason: 'profile_unreachable' });
      const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
      if (Number.isFinite(declared) && declared > MAX_PROFILE_BYTES) throw Object.assign(new Error('too large'), { reason: 'profile_malformed' });
      let doc;
      try {
        doc = JSON.parse(await readCapped(res, MAX_PROFILE_BYTES));
      } catch {
        throw Object.assign(new Error('parse'), { reason: 'profile_malformed' });
      }
      const keys = keysFromProfile(doc);
      if (!keys) throw Object.assign(new Error('no keys'), { reason: 'profile_malformed' });
      return keys;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Keys for an allowlisted profile URL. A failed refresh keeps serving the last good set, marked stale. */
  async function getKeys(url, { force = false } = {}) {
    const now = nowMs();
    const entry = cache.get(url) || {};
    const forced = force && entry.keys && now - entry.fetchedAt >= MIN_FORCED_REFRESH_GAP_MS;
    if (!forced && entry.keys && now - entry.fetchedAt < PROFILE_TTL_MS) return { keys: entry.keys };
    if (entry.failedAt && now - entry.failedAt < NEGATIVE_TTL_MS) {
      return entry.keys ? { keys: entry.keys, stale: true } : { reason: entry.failReason || 'profile_unreachable' };
    }
    if (!entry.inflight) {
      entry.inflight = fetchProfileKeys(url)
        .then((keys) => {
          entry.keys = keys;
          entry.fetchedAt = nowMs();
          entry.failedAt = undefined;
          entry.failReason = undefined;
        })
        .catch((err) => {
          entry.failedAt = nowMs();
          entry.failReason = (err && err.reason) || 'profile_unreachable';
        })
        .finally(() => {
          entry.inflight = undefined;
        });
      cache.set(url, entry);
    }
    await entry.inflight;
    if (entry.keys) return { keys: entry.keys, stale: entry.failedAt !== undefined };
    return { reason: entry.failReason || 'profile_unreachable' };
  }

  return { getKeys };
}

function contentDigestBytes(rawBody) {
  return nodeCrypto.createHash('sha256').update(rawBody).digest();
}

/**
 * Check a Content-Digest header against the exact body bytes. sha-256 only (spec: "MUST use sha-256").
 * @returns {string|null} a reason, or null when it matches
 */
function checkContentDigest(headerValue, rawBody) {
  let dict;
  try {
    dict = parseDictionary(Array.isArray(headerValue) ? headerValue.join(', ') : String(headerValue || ''));
  } catch {
    return 'digest_mismatch';
  }
  const member = dict.get('sha-256');
  if (!member) return 'digest_algorithm_unsupported';
  if (member.type !== 'bytes') return 'digest_mismatch';
  const want = contentDigestBytes(rawBody);
  return member.value.length === want.length && nodeCrypto.timingSafeEqual(member.value, want) ? null : 'digest_mismatch';
}

/**
 * Every `meta["ucp-agent"].profile` a JSON-RPC body (one call or a batch) names at
 * params.arguments.meta — where UCP MCP carries it — or params.meta.
 * @returns {{ binding: 'absent'|'match'|'mismatch' }}
 */
function metaProfileBinding(body, headerProfileUrl) {
  const calls = Array.isArray(body) ? body : [body];
  let named = 0;
  for (const call of calls) {
    const params = call && typeof call === 'object' ? call.params : null;
    if (!params || typeof params !== 'object') continue;
    for (const meta of [params.arguments && params.arguments.meta, params.meta]) {
      const agent = meta && typeof meta === 'object' ? meta['ucp-agent'] : null;
      if (!agent || typeof agent !== 'object' || agent.profile === undefined) continue;
      named += 1;
      if (normalizeProfileUrl(agent.profile) !== headerProfileUrl) return { binding: 'mismatch' };
    }
  }
  return { binding: named ? 'match' : 'absent' };
}

function withUcpError(result) {
  const code = REASON_TO_UCP[result.reason];
  return { ...result, ucp_error: code ? { code, ...UCP_ERRORS[code] } : null };
}

/**
 * @param {object} [opts]
 * @param {Iterable<string>} opts.trustedProfiles   profile URLs whose keys may be fetched (normalized here)
 * @param {'platform'|'business'} [opts.kind]       who signs: a platform calling our doors, or a business
 *                                                  signing a webhook (profile must be /.well-known/ucp)
 * @param {boolean} [opts.requireUcpAgentCoverage]  default true. The order-webhook example in the spec does not
 *                                                  cover ucp-agent; the webhook caller turns this off and the
 *                                                  result says `ucp_agent_covered: false`.
 * @param {boolean} [opts.checkMetaBinding]         default true for platform, false for business
 */
function createUcpSignatureVerifier({
  env = process.env,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now,
  trustedProfiles = [],
  kind = PROFILE_KIND.PLATFORM,
  requireUcpAgentCoverage = true,
  checkMetaBinding,
} = {}) {
  const trusted = new Set([...trustedProfiles].map(normalizeProfileUrl).filter(Boolean));
  const expectedAuthorities = loadExpectedAuthorities(env);
  const maxAgeS = positiveInt(env.UCP_SIGNATURE_MAX_AGE_S, DEFAULT_MAX_AGE_S);
  const requireCreated = isFlagOn(env.UCP_SIGNATURE_REQUIRE_CREATED);
  const bindMeta = checkMetaBinding === undefined ? kind === PROFILE_KIND.PLATFORM : Boolean(checkMetaBinding);
  const keyCache = createProfileKeyCache({ fetchImpl, nowMs });

  function requiredComponents(view, hasBody) {
    const req = ['"@method"', '"@authority"', '"@path"'];
    if (view.hasQuery) req.push('"@query"');
    if (hasBody) req.push('"content-digest"', '"content-type"');
    if (view.fields.has('idempotency-key')) req.push('"idempotency-key"');
    if (view.fields.has('ucp-agent') && requireUcpAgentCoverage) req.push('"ucp-agent"');
    if (view.fields.has('signature-agent')) req.push('"signature-agent"');
    return req;
  }

  async function verifyLabel({ view, label, inputMember, signatureDict, rawBody, hasBody, profile, body }) {
    const { params, reason: paramReason } = signatureParams(inputMember);
    const out = { label, keyid: null, profile_url: profile.url };
    if (paramReason) return { ...out, verified: false, reason: paramReason };
    out.keyid = params.keyid ? String(params.keyid).slice(0, 100) : null;
    if (!params.keyid) return { ...out, verified: false, reason: 'keyid_missing' };

    const sigMember = signatureDict.get(label);
    if (!sigMember || sigMember.type !== 'bytes') return { ...out, verified: false, reason: 'missing_signature' };

    const built = buildSignatureBase(view, inputMember);
    if (built.reason) return { ...out, verified: false, reason: built.reason };
    const { covered } = built;
    out.covered = covered;
    out.ucp_agent_covered = covered.includes('"ucp-agent"');
    if (requiredComponents(view, hasBody).some((c) => !covered.includes(c))) {
      return { ...out, verified: false, reason: 'coverage_insufficient' };
    }
    // A signature names the authority it was made for; one made for another site is not ours to accept.
    if (!expectedAuthorities.has(view.authority)) return { ...out, verified: false, reason: 'authority_mismatch' };

    const nowS = Math.floor(nowMs() / 1000);
    out.created = Number.isInteger(params.created) ? params.created : null;
    out.expires = Number.isInteger(params.expires) ? params.expires : null;
    if (out.created === null && requireCreated) return { ...out, verified: false, reason: 'created_missing' };
    if (out.created !== null && out.created > nowS + CLOCK_SKEW_S) return { ...out, verified: false, reason: 'not_yet_valid' };
    if (out.created !== null && nowS - out.created > maxAgeS + CLOCK_SKEW_S) return { ...out, verified: false, reason: 'expired' };
    if (out.expires !== null && out.expires < nowS - CLOCK_SKEW_S) return { ...out, verified: false, reason: 'expired' };

    if (covered.includes('"content-digest"')) {
      if (!rawBody) return { ...out, verified: false, reason: 'raw_body_unavailable' };
      const digestReason = checkContentDigest(view.headers['content-digest'], rawBody);
      if (digestReason) return { ...out, verified: false, reason: digestReason };
    }

    let got = await keyCache.getKeys(profile.url);
    if (!got.reason && !got.keys.find((k) => k.kid === params.keyid)) got = await keyCache.getKeys(profile.url, { force: true });
    if (got.reason) return { ...out, verified: false, reason: got.reason };
    const key = got.keys.find((k) => k.kid === params.keyid);
    if (!key) return { ...out, verified: false, reason: 'key_not_found' };

    const check = verifySignature({ base: built.base, signature: sigMember.value, key, algParam: params.alg });
    if (!check.ok) return { ...out, verified: false, reason: check.reason, alg: check.alg || null };

    // Only after the signature verifies: the body's own claim of who sent it must agree with the header.
    let binding = 'not_checked';
    if (bindMeta && body !== undefined) {
      binding = metaProfileBinding(body, profile.url).binding;
      if (binding === 'mismatch') return { ...out, verified: false, reason: 'profile_binding_mismatch', alg: check.alg, meta_binding: binding };
    }
    return {
      ...out,
      verified: true,
      reason: 'ok',
      alg: check.alg,
      authority: view.authority,
      keys_stale: Boolean(got.stale),
      meta_binding: binding,
    };
  }

  /**
   * @param {object} req       an Express request, or { method, originalUrl, headers, rawHeaders? }
   * @param {object} [extra]
   * @param {Buffer|string|null} [extra.rawBody]  the exact body bytes received (Content-Digest is over these)
   * @param {*} [extra.body]                      the parsed body, for the meta binding (parsed from rawBody if absent)
   * @returns {Promise<object>} never rejects
   */
  async function verifyRequest(req, { rawBody, body } = {}) {
    const headers = (req && req.headers) || {};
    if (headers['signature-input'] === undefined) {
      return withUcpError({ present: false, verified: false, reason: 'signature_missing' });
    }
    try {
      const profile = parseUcpAgentHeader(headers['ucp-agent'], kind);
      if (profile.reason) {
        return withUcpError({ present: true, verified: false, reason: profile.reason, claimed_profile: profile.claimed || null });
      }
      if (!trusted.has(profile.url)) {
        return withUcpError({ present: true, verified: false, reason: 'profile_not_trusted', claimed_profile: profile.url.slice(0, 200) });
      }
      let inputDict;
      let signatureDict;
      try {
        inputDict = parseDictionary(headers['signature-input']);
        signatureDict = parseDictionary(headers.signature === undefined ? '' : headers.signature);
      } catch {
        return withUcpError({ present: true, verified: false, reason: 'malformed_signature_headers', profile_url: profile.url });
      }
      const view = requestView(req);
      const bytes = Buffer.isBuffer(rawBody) ? rawBody : (typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : null);
      const declaredLength = Number(headers['content-length']);
      const hasBody = Boolean((bytes && bytes.length) || (Number.isFinite(declaredLength) && declaredLength > 0));
      let parsedBody = body;
      if (parsedBody === undefined && bytes && bytes.length) {
        try { parsedBody = JSON.parse(bytes.toString('utf8')); } catch { parsedBody = undefined; }
      }
      const labels = [...inputDict.keys()].slice(0, MAX_LABELS).filter((label) => {
        const tag = inputDict.get(label)?.params?.get('tag');
        return !(tag && tag.type === 'string' && FOREIGN_TAGS.has(tag.value));
      });
      if (!labels.length) return withUcpError({ present: true, verified: false, reason: 'no_ucp_label', profile_url: profile.url });
      // Spec: "the request is authenticated when at least one signature verifies".
      let firstFailure = null;
      for (const label of labels) {
        const result = await verifyLabel({
          view, label, inputMember: inputDict.get(label), signatureDict, rawBody: bytes, hasBody, profile, body: parsedBody,
        });
        if (result.verified) return withUcpError({ present: true, ...result });
        if (!firstFailure) firstFailure = result;
      }
      return withUcpError({ present: true, ...firstFailure });
    } catch {
      return withUcpError({ present: true, verified: false, reason: 'verifier_error' });
    }
  }

  return { verifyRequest, trustedProfiles: trusted, kind };
}

module.exports = {
  PROFILE_KIND,
  UCP_ERRORS,
  REASON_TO_UCP,
  UNCHECKED_REASONS,
  DEFAULT_MAX_AGE_S,
  ucpSignatureMode,
  normalizeProfileUrl,
  parseTrustedProfiles,
  parseUcpAgentHeader,
  keysFromProfile,
  checkContentDigest,
  metaProfileBinding,
  createUcpSignatureVerifier,
};
