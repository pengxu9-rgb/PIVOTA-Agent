'use strict';

// WHICH AGENT signed this request — verified, not claimed.
//
// callerIdentity.js classifies callers by User-Agent, which any client can type. The card networks now
// ask merchants (and the "site protection providers" in front of them) to recognise agents by
// SIGNATURE instead: Visa's Trusted Agent Protocol and Mastercard's Agent Pay acceptance framework both
// put an RFC 9421 HTTP Message Signature on the agent's requests, and the IETF Web Bot Auth draft
// (draft-ietf-webbotauth-httpsig-protocol-00) is the general form of the same thing. As the
// merchant-side gateway in front of our doors, Pivota is in exactly that position. This module answers
// "did a key we trust sign this request, and whose is it?" — and nothing else. It never touches card
// data: TAP's payment container is encrypted to the merchant's key and is not read here.
//
// PROFILES (selected by the signature's `tag` parameter):
//   web-bot-auth        IETF draft. Keys resolved from the request's Signature-Agent member: type
//                       `directory` (an origin → /.well-known/http-message-signatures-directory) or
//                       `jwks_uri`. keyid MUST be the key's RFC 7638 thumbprint. Must cover @authority
//                       or @target-uri, and its own Signature-Agent member. expires − created ≤ 24h.
//   visa-tap            Visa Trusted Agent Protocol, tags `agent-browser-auth` / `agent-payer-auth`.
//                       Keys from Visa's JWKS (kid = keyid). Must cover @authority and @path; created,
//                       expires, keyid, alg and nonce all required; window ≤ 8 minutes; nonce replay
//                       window 8 minutes.
//   Mastercard Agent Pay "extends" Web Bot Auth; its directory and profile are behind Mastercard's
//   developer login, so it is a key source to add (profile web-bot-auth) once confirmed, not code here.
//
// ALLOWLISTED KEY SOURCES ONLY. A Signature-Agent value is attacker-chosen; fetching whatever URL a
// request names would make every door an SSRF primitive and would also attach identity to URLs we
// never vetted. The draft itself says an unresolved Signature-Agent "is a claim rather than an
// identity" and verifiers "MUST NOT attach policy to it". So only sources in
// AGENT_SIGNATURE_TRUSTED_KEY_SOURCES_JSON (default: Visa's TAP JWKS) are ever fetched; any other
// Signature-Agent is reported as `untrusted_signature_agent` with the claim attached for counting.
//
// OUR HOSTS ONLY. A signature names the authority it was made for. One made for another merchant's site
// — which that site, or anything between, could capture and replay here — is refused as
// `authority_mismatch` unless the request's authority is one of ours (AGENT_SIGNATURE_EXPECTED_AUTHORITIES,
// default: the commerce door hosts).
//
// REPLAY. Nonces are remembered per instance (in-memory, bounded). With several gateway instances a
// replay that lands on a different instance is not caught — acceptable while the result only feeds
// logs (observe mode); a shared store is a precondition for ever enforcing on it.
//
// FAILS QUIET, NEVER OPEN. Every outcome is a result object with `verified: true|false` and a reason;
// nothing here throws into the request path, and a failure is never reported as verified.

const {
  importPublicJwk,
  jwkThumbprint,
  requestView,
  buildSignatureBase,
  signatureParams,
  verifySignature,
} = require('./httpMessageSignatures');
const { parseDictionary, parseItem } = require('./httpStructuredFields');

const PROFILE = Object.freeze({ WEB_BOT_AUTH: 'web-bot-auth', VISA_TAP: 'visa-tap' });

const TAG_PROFILE = Object.freeze({
  'web-bot-auth': PROFILE.WEB_BOT_AUTH,
  'agent-browser-auth': PROFILE.VISA_TAP,
  'agent-payer-auth': PROFILE.VISA_TAP,
});

const DEFAULT_KEY_SOURCES = Object.freeze([
  Object.freeze({ id: 'visa', profile: PROFILE.VISA_TAP, url: 'https://mcp.visa.com/.well-known/jwks' }),
]);

const DEFAULT_EXPECTED_AUTHORITIES = Object.freeze(['commerce.mcp.pivota.cc', 'mcp.pivota.cc', 'gateway.pivota.cc', 'ucp.pivota.cc']);

const WBA_DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
const WBA_MAX_WINDOW_S = 24 * 3600; // draft §5.2: "RECOMMENDED that expiry be no more than 24 hours"
const TAP_MAX_WINDOW_S = 8 * 60; // TAP spec: created/expires no more than 8 minutes apart
const CLOCK_SKEW_S = 60;
const MAX_LABELS = 4;

// Below the middleware's default 1.5s budget, so a hung key source cannot outlast it.
const FETCH_TIMEOUT_MS = 1_000;
const MAX_DIRECTORY_BYTES = 64 * 1024;
const KEYS_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 30_000;
// An unknown keyid forces one refresh (key rotation), but no more often than this per source.
const MIN_FORCED_REFRESH_GAP_MS = 60_000;
const NONCE_STORE_MAX = 50_000;

const MODES = new Set(['off', 'observe']);

function agentSignatureMode(env = process.env) {
  const raw = String(env.AGENT_SIGNATURE_VERIFY_MODE || 'off').trim().toLowerCase();
  return MODES.has(raw) ? raw : 'off';
}

function loadExpectedAuthorities(env = process.env) {
  const raw = env.AGENT_SIGNATURE_EXPECTED_AUTHORITIES;
  const list = raw == null || String(raw).trim() === ''
    ? DEFAULT_EXPECTED_AUTHORITIES
    : String(raw).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return new Set(list);
}

function normalizeHttpsUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  u.hash = '';
  u.search = '';
  // URL() already lower-cases scheme and host and drops a default port (RFC 3986 §6.2.2/6.2.3).
  return u.toString();
}

/**
 * Parse AGENT_SIGNATURE_TRUSTED_KEY_SOURCES_JSON. Invalid entries are dropped, not guessed at; an
 * unparseable value falls back to the defaults (and says so) rather than silently trusting nothing.
 */
function loadKeySources(env = process.env, log) {
  const raw = env.AGENT_SIGNATURE_TRUSTED_KEY_SOURCES_JSON;
  if (raw == null || String(raw).trim() === '') return DEFAULT_KEY_SOURCES.slice();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log?.warn?.({ event: 'agent_signature_config' }, 'AGENT_SIGNATURE_TRUSTED_KEY_SOURCES_JSON is not JSON; using defaults');
    return DEFAULT_KEY_SOURCES.slice();
  }
  if (!Array.isArray(parsed)) return DEFAULT_KEY_SOURCES.slice();
  const out = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const profile = Object.values(PROFILE).includes(entry.profile) ? entry.profile : null;
    let url = normalizeHttpsUrl(entry.url);
    // A Web Bot Auth `directory` source may be configured as the bare origin the agent sends; it means
    // that origin's well-known directory, which is the identifier resolution produces (draft §5.5).
    if (url && profile === PROFILE.WEB_BOT_AUTH && new URL(url).pathname === '/') {
      url = normalizeHttpsUrl(`${new URL(url).origin}${WBA_DIRECTORY_PATH}`);
    }
    const id = typeof entry.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.id) ? entry.id : null;
    if (profile && url && id) out.push(Object.freeze({ id, profile, url }));
  }
  return out;
}

// ---- key sources ------------------------------------------------------------------------------------

/** Read a fetch Response body, aborting past `cap` bytes instead of buffering whatever the server sends. */
async function readCapped(res, cap) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > cap) throw new Error('directory too large');
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
      throw new Error('directory too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createKeySourceCache({ fetchImpl, nowMs }) {
  const cache = new Map(); // url → { keys, fetchedAt, failedAt, inflight }

  async function fetchKeys(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      // redirect: 'manual' — the draft: "MUST NOT automatically follow HTTP redirects". A 3xx is a
      // discovery failure, which also keeps an allowlisted URL from bouncing us somewhere else.
      const res = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/http-message-signatures-directory+json, application/jwk-set+json, application/json' },
      });
      if (!res || res.status !== 200) throw new Error(`status ${res && res.status}`);
      const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
      if (Number.isFinite(declared) && declared > MAX_DIRECTORY_BYTES) throw new Error('directory too large');
      const doc = JSON.parse(await readCapped(res, MAX_DIRECTORY_BYTES));
      if (!doc || !Array.isArray(doc.keys)) throw new Error('no keys array');
      const keys = [];
      for (const jwk of doc.keys.slice(0, 64)) {
        const key = importPublicJwk(jwk);
        if (!key) continue;
        keys.push({ ...key, kid: typeof jwk.kid === 'string' ? jwk.kid : undefined, thumbprint: jwkThumbprint(jwk) });
      }
      return keys;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Keys for an allowlisted URL; serves the last good set (stale) when a refresh fails. `force`
   * (an unknown keyid — the agent may have rotated) refetches a fresh set, at most once a minute.
   */
  async function getKeys(url, { force = false } = {}) {
    const now = nowMs();
    const entry = cache.get(url) || {};
    const forced = force && entry.keys && now - entry.fetchedAt >= MIN_FORCED_REFRESH_GAP_MS;
    if (!forced && entry.keys && now - entry.fetchedAt < KEYS_TTL_MS) return { keys: entry.keys };
    if (entry.failedAt && now - entry.failedAt < NEGATIVE_TTL_MS) {
      return entry.keys ? { keys: entry.keys, stale: true } : { reason: 'key_source_unavailable' };
    }
    if (!entry.inflight) {
      entry.inflight = fetchKeys(url)
        .then((keys) => {
          entry.keys = keys;
          entry.fetchedAt = nowMs();
          entry.failedAt = undefined;
        })
        .catch(() => {
          entry.failedAt = nowMs();
        })
        .finally(() => {
          entry.inflight = undefined;
        });
      cache.set(url, entry);
    }
    await entry.inflight;
    // A failed refresh never evicts the last good set (draft-ietf-webbotauth-httpsig-protocol: a directory
    // that fails to resolve "MUST NOT evict a cached entry"); it is served, marked stale, until a successful
    // fetch replaces it.
    if (entry.keys) return { keys: entry.keys, stale: entry.failedAt !== undefined };
    return { reason: 'key_source_unavailable' };
  }

  return { getKeys };
}

// ---- replay -----------------------------------------------------------------------------------------

function createNonceStore({ nowMs, max = NONCE_STORE_MAX }) {
  const seen = new Map(); // key → expiresAtMs

  /**
   * Record a nonce. 'replay' when it was seen and has not expired; 'full' when the store holds `max`
   * unexpired nonces — refusing then is the only bounded option that never forgets a live nonce
   * (evicting one would reopen exactly the replay it was recorded to stop).
   */
  function claim(parts, ttlS) {
    const key = JSON.stringify(parts); // no separator a keyid or nonce can contain
    const now = nowMs();
    const exp = seen.get(key);
    if (exp !== undefined && exp > now) return 'replay';
    seen.delete(key);
    if (seen.size >= max) {
      for (const [k, e] of seen) if (e <= now) seen.delete(k);
      if (seen.size >= max) return 'full';
    }
    seen.set(key, now + ttlS * 1000);
    return 'ok';
  }

  return { claim, size: () => seen.size };
}

// ---- Signature-Agent (Web Bot Auth) -------------------------------------------------------------------

/**
 * Which Signature-Agent member a signature speaks for: the one it COVERS (§5.2.2: never attribute a
 * signature to a member it does not cover). Preference: `"signature-agent";key="<label>"`, then the only
 * `;key` member it covers (the draft's own E.1.1 example signs label sig2 over member agent2), then — when
 * it covers the whole field and the field has exactly one member (or is the legacy bare String) — that.
 * @returns {{ memberKey?: string|null, reason?: string }}  memberKey null = the legacy whole-field form
 */
function coveredSignatureAgentMember(covered, label, rawHeader) {
  const keyed = covered
    .map((id) => /^"signature-agent";key="([^"\\]*)"$/.exec(id))
    .filter(Boolean)
    .map((m) => m[1]);
  if (keyed.includes(label)) return { memberKey: label };
  if (keyed.length === 1) return { memberKey: keyed[0] };
  if (keyed.length > 1) return { reason: 'ambiguous_signature_agent' };
  if (!covered.includes('"signature-agent"')) return { reason: 'signature_agent_not_covered' };
  if (rawHeader === undefined) return { reason: 'missing_signature_agent' };
  const text = String(Array.isArray(rawHeader) ? rawHeader.join(', ') : rawHeader).trim();
  if (text.startsWith('"')) return { memberKey: null };
  try {
    const dict = parseDictionary(text);
    if (dict.size === 1) return { memberKey: [...dict.keys()][0] };
  } catch {
    return { reason: 'malformed_signature_agent' };
  }
  return { reason: 'ambiguous_signature_agent' };
}

/**
 * Resolve one Signature-Agent member to the identifier URL the draft defines (§5.5): for `directory` the
 * origin's well-known URI, for `jwks_uri` the value without query or fragment. `memberKey` null reads the
 * legacy bare-String form (§5.2.1); a String header is also accepted for any key, as the one member.
 * @returns {{ identifier?: string, legacy?: boolean, claimed?: string, reason?: string }}
 */
function resolveSignatureAgent(rawHeader, memberKey) {
  if (rawHeader === undefined) return { reason: 'missing_signature_agent' };
  const text = String(Array.isArray(rawHeader) ? rawHeader.join(', ') : rawHeader).trim();
  let member;
  let legacy = false;
  try {
    if (text.startsWith('"')) {
      member = parseItem(text);
      legacy = true;
    } else if (memberKey != null) {
      member = parseDictionary(text).get(memberKey);
    }
  } catch {
    return { reason: 'malformed_signature_agent' };
  }
  if (!member) return { reason: 'missing_signature_agent' };
  if (member.type !== 'string') return { reason: 'malformed_signature_agent' };
  const claimed = member.value.slice(0, 200);
  const typeParam = member.params && member.params.get('type');
  const type = typeParam ? (typeParam.type === 'token' ? typeParam.value : null) : 'directory';
  if (type === 'directory') {
    let u;
    try {
      u = new URL(member.value);
    } catch {
      return { reason: 'malformed_signature_agent', claimed };
    }
    // §5.5: the value MUST be an origin (an empty path "/" MAY be accepted).
    if (u.protocol !== 'https:' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
      return { reason: 'malformed_signature_agent', claimed };
    }
    return { identifier: normalizeHttpsUrl(`${u.origin}${WBA_DIRECTORY_PATH}`), legacy, claimed };
  }
  if (type === 'jwks_uri') {
    const identifier = normalizeHttpsUrl(member.value);
    return identifier ? { identifier, legacy, claimed } : { reason: 'malformed_signature_agent', claimed };
  }
  return { reason: 'unsupported_signature_agent_type', claimed };
}

// ---- verification -----------------------------------------------------------------------------------

function covers(covered, id) {
  return covered.includes(id);
}

function checkWindow({ created, expires }, maxWindowS, nowS) {
  if (!Number.isInteger(created) || !Number.isInteger(expires)) return 'missing_required_param';
  if (expires <= created) return 'invalid_validity_window';
  if (expires - created > maxWindowS) return 'validity_window_too_long';
  if (created > nowS + CLOCK_SKEW_S) return 'not_yet_valid';
  if (expires < nowS - CLOCK_SKEW_S) return 'expired';
  return null;
}

function createAgentSignatureVerifier({ env = process.env, fetchImpl = globalThis.fetch, nowMs = Date.now, log } = {}) {
  const sources = loadKeySources(env, log);
  const expectedAuthorities = loadExpectedAuthorities(env);
  const keyCache = createKeySourceCache({ fetchImpl, nowMs });
  // One store per key source: a busy agent (Web Bot Auth nonces live up to 24h) can fill only its own.
  const nonceStores = new Map();
  const noncesFor = (id) => {
    if (!nonceStores.has(id)) nonceStores.set(id, createNonceStore({ nowMs }));
    return nonceStores.get(id);
  };

  async function verifyLabel(req, view, label, inputMember, signatureDict) {
    const base = { label, profile: null, tag: null };
    const { params, reason: paramReason } = signatureParams(inputMember);
    if (paramReason) return { ...base, verified: false, reason: paramReason };
    const profile = Object.hasOwn(TAG_PROFILE, String(params.tag)) ? TAG_PROFILE[params.tag] : undefined;
    // tag and keyid are attacker-chosen strings that end up in logs: bounded here, once.
    const out = {
      ...base,
      profile: profile || null,
      tag: params.tag ? String(params.tag).slice(0, 64) : null,
      keyid: params.keyid ? String(params.keyid).slice(0, 100) : null,
    };
    if (!profile) return { ...out, verified: false, reason: 'unsupported_tag' };

    const sigMember = signatureDict.get(label);
    if (!sigMember || sigMember.type !== 'bytes') return { ...out, verified: false, reason: 'missing_signature' };

    const built = buildSignatureBase(view, inputMember);
    if (built.reason) return { ...out, verified: false, reason: built.reason };
    const { covered } = built;
    const nowS = Math.floor(nowMs() / 1000);
    if (!expectedAuthorities.has(view.authority)) return { ...out, verified: false, reason: 'authority_mismatch' };

    let candidates = [];
    let keyMatch;
    if (profile === PROFILE.VISA_TAP) {
      for (const p of ['keyid', 'alg', 'nonce']) if (!params[p]) return { ...out, verified: false, reason: 'missing_required_param' };
      if (!covers(covered, '"@authority"') || !covers(covered, '"@path"')) return { ...out, verified: false, reason: 'missing_required_component' };
      const windowReason = checkWindow(params, TAP_MAX_WINDOW_S, nowS);
      if (windowReason) return { ...out, verified: false, reason: windowReason };
      candidates = sources.filter((s) => s.profile === PROFILE.VISA_TAP);
      if (!candidates.length) return { ...out, verified: false, reason: 'no_trusted_key_source' };
      keyMatch = (k) => k.kid === params.keyid;
    } else {
      if (!params.keyid) return { ...out, verified: false, reason: 'missing_required_param' };
      if (!covers(covered, '"@authority"') && !covers(covered, '"@target-uri"')) return { ...out, verified: false, reason: 'missing_required_component' };
      const windowReason = checkWindow(params, WBA_MAX_WINDOW_S, nowS);
      if (windowReason) return { ...out, verified: false, reason: windowReason };
      const rawAgent = view.headers['signature-agent'];
      const pick = coveredSignatureAgentMember(covered, label, rawAgent);
      if (pick.reason) return { ...out, verified: false, reason: pick.reason };
      const agent = resolveSignatureAgent(rawAgent, pick.memberKey);
      if (agent.reason) return { ...out, verified: false, reason: agent.reason, claimed_agent: agent.claimed || null };
      const source = sources.find((s) => s.profile === PROFILE.WEB_BOT_AUTH && s.url === agent.identifier);
      if (source) candidates = [source];
      if (!source) return { ...out, verified: false, reason: 'untrusted_signature_agent', claimed_agent: agent.identifier.slice(0, 200) };
      keyMatch = (k) => k.thumbprint === params.keyid;
    }

    let source = null;
    let key = null;
    let lastReason = 'unknown_key';
    for (const candidate of candidates) {
      let got = await keyCache.getKeys(candidate.url);
      if (!got.reason && !got.keys.find(keyMatch)) got = await keyCache.getKeys(candidate.url, { force: true });
      if (got.reason) {
        lastReason = got.reason;
        continue;
      }
      const match = got.keys.find(keyMatch);
      if (match) {
        source = candidate;
        key = match;
        break;
      }
      lastReason = 'unknown_key';
    }
    if (!key) return { ...out, verified: false, reason: lastReason, agent: candidates.length === 1 ? candidates[0].id : null };

    const check = verifySignature({ base: built.base, signature: sigMember.value, key, algParam: params.alg });
    if (!check.ok) return { ...out, verified: false, reason: check.reason, agent: source.id, alg: check.alg || null };

    // Only a VERIFIED signature may consume a nonce — otherwise anyone could burn an agent's nonces.
    if (params.nonce) {
      // Remember the nonce for exactly as long as the signature itself can still verify (expires + skew).
      // For TAP that is at least its 8-minute replay window whenever a replay could still verify; past
      // expires + skew the signature fails as `expired` before the nonce is ever consulted.
      const ttl = Math.max(1, params.expires + CLOCK_SKEW_S - nowS);
      const claimed = noncesFor(source.id).claim([params.keyid, params.nonce], ttl);
      if (claimed !== 'ok') {
        return { ...out, verified: false, reason: claimed === 'replay' ? 'nonce_replay' : 'nonce_store_full', agent: source.id, alg: check.alg };
      }
    }

    return {
      ...out,
      verified: true,
      reason: 'ok',
      agent: source.id,
      agent_url: source.url,
      alg: check.alg,
      covered,
      created: params.created,
      expires: params.expires,
    };
  }

  /**
   * Verify the agent signature(s) on a request. Resolves to a result object; never rejects.
   */
  async function verifyRequest(req) {
    const headers = (req && req.headers) || {};
    // Signature-Input is what makes a request RFC 9421-signed. A bare `Signature` header is someone else's
    // scheme (the ACP adapter's HMAC uses that name) and is not ours to judge.
    if (headers['signature-input'] === undefined) {
      return { present: false, verified: false, reason: 'no_signature' };
    }
    try {
      let inputDict;
      let signatureDict;
      try {
        inputDict = parseDictionary(headers['signature-input']);
        signatureDict = parseDictionary(headers.signature);
      } catch {
        return { present: true, verified: false, reason: 'malformed_signature_headers' };
      }
      const view = requestView(req);
      const labels = [...inputDict.keys()].slice(0, MAX_LABELS);
      if (!labels.length) return { present: true, verified: false, reason: 'malformed_signature_headers' };
      let firstFailure = null;
      for (const label of labels) {
        const result = await verifyLabel(req, view, label, inputDict.get(label), signatureDict);
        if (result.verified) return { present: true, ...result };
        // Prefer a failure from a label whose tag we understand over an "unsupported_tag" one.
        if (!firstFailure || (firstFailure.reason === 'unsupported_tag' && result.reason !== 'unsupported_tag')) firstFailure = result;
      }
      return { present: true, ...firstFailure };
    } catch {
      return { present: true, verified: false, reason: 'verifier_error' };
    }
  }

  return { verifyRequest, sources };
}

module.exports = {
  PROFILE,
  TAG_PROFILE,
  DEFAULT_KEY_SOURCES,
  DEFAULT_EXPECTED_AUTHORITIES,
  agentSignatureMode,
  loadKeySources,
  resolveSignatureAgent,
  coveredSignatureAgentMember,
  createAgentSignatureVerifier,
  // exposed for tests
  _internal: { createNonceStore, createKeySourceCache, checkWindow, normalizeHttpsUrl },
};
