'use strict';

/*
 * ucpOrderWebhookReceiver.js — inbound UCP order-webhook door (port of the retired
 * `ucp-platform-receiver` Railway service, platform_receiver.py). ucp.pivota.cc now routes to this
 * gateway, so the door the business profile promises has to live here.
 *
 *   POST /ucp/order-webhook          — receive a platform order event (detached-JWS ES256 verified;
 *                                      required unless UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED opts out)
 *   GET  /ucp/order-webhook/events   — the in-memory event ring buffer (e2e positive-control surface;
 *                                      the retired service had GET /events). INTERNAL: gated by the
 *                                      shared secret UCP_ORDER_WEBHOOK_EVENTS_KEY — unconfigured
 *                                      key means the route does not exist (house pattern).
 *
 * SEMANTICS (mirroring the Python original):
 *   - Signature format is an RFC 7797 detached JWS: `<protected_b64>..<sig_b64>` — double dot, EMPTY
 *     payload segment. Signing input = `protected_b64 + "." + raw request body bytes`; the raw ES256
 *     signature is exactly 64 bytes (r||s, 32+32 big-endian) — node's crypto.verify with
 *     dsaEncoding:'ieee-p1363' consumes r||s directly, no DER conversion needed.
 *   - Verifier keys come from the business profile at UCP_BUSINESS_PROFILE_URL (`ucp.signing_keys`,
 *     with a flat `signing_keys` fallback for this gateway's own /.well-known/ucp shape), cached 300s.
 *   - Dedup by body sha256 in a bounded in-memory ring buffer. METADATA ONLY is stored (sha256,
 *     received_at, business_id, kid, verified flag, checkout_id/order_id) — NEVER the raw body, no PII.
 *
 * TIGHTENED vs the retired platform_receiver.py (deliberate improvements, noted per check below):
 *   - the protected header MUST declare `alg: "ES256"` (the original verified with ES256 regardless of
 *     the declared alg — an alg-confusion foothold);
 *   - the protected header MUST declare `b64: false` with `crit` of exactly ["b64"] (RFC 7797 requires
 *     the declaration; RFC 7515 §4.1.11 requires rejecting crit members we do not understand — the
 *     original checked neither);
 *   - a protected header that CARRIES a kid must match a published key by that kid — no falling back to
 *     trying every key (the original fell back). Only a kid-less header tries all published keys;
 *   - verification is REQUIRED by default when the receiver is enabled. The retired service defaulted
 *     to accept-unverified; here that is an explicit dev-only opt-out (UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED)
 *     so enabling the receiver never silently opens an unauthenticated write door.
 *
 * NO REPLAY PROTECTION YET (documented limitation): the sha256 dedup ring only collapses byte-identical
 * redeliveries — it is NOT a replay defense (a captured signed body replays fine once the ring evicts
 * its sha, and the signature stays valid forever). A timestamp/nonce requirement on the signed payload
 * MUST be added before this receiver drives any order state; today it is observability only.
 *
 * Pure/dependency-injected: env, fetch, logger and clock all arrive via deps; the logic functions never
 * touch process.env directly (env is read PER REQUEST so flag flips apply live, like the warm-handoff
 * internal route). Fail-closed: dark (404) unless UCP_ORDER_WEBHOOK_RECEIVER_ENABLED is set.
 */

const crypto = require('crypto');

const FLAG_ENV = 'UCP_ORDER_WEBHOOK_RECEIVER_ENABLED';
const VERIFY_ENV = 'UCP_VERIFY_ORDER_WEBHOOK';
const ALLOW_UNVERIFIED_ENV = 'UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED';
const PROFILE_URL_ENV = 'UCP_BUSINESS_PROFILE_URL';
const MAX_EVENTS_ENV = 'UCP_ORDER_WEBHOOK_MAX_EVENTS';
const EVENTS_KEY_ENV = 'UCP_ORDER_WEBHOOK_EVENTS_KEY';

const DEFAULT_MAX_EVENTS = 200;
const JWKS_CACHE_TTL_MS = 300 * 1000; // matches the retired receiver's 300s profile cache
const JWKS_FAILURE_TTL_MS = 30 * 1000; // failed fetches retry sooner, but never per-request hammering
const JWKS_FETCH_TIMEOUT_MS = 5000;

function firstNonEmptyString(...values) {
  for (const v of values) {
    const s = String(v == null ? '' : v).trim();
    if (s) return s;
  }
  return '';
}

function isFlagOn(value) {
  const raw = firstNonEmptyString(value).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function header(headers, name) {
  const h = headers || {};
  return h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
}

function b64urlDecode(segment) {
  return Buffer.from(String(segment), 'base64url');
}

function maxEvents(env) {
  const raw = Number(env[MAX_EVENTS_ENV]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_EVENTS;
}

/** Is the receiver door lit at all? Exported so the route can rate-limit only a LIT door. */
function isUcpOrderWebhookReceiverEnabled(env = process.env) {
  return isFlagOn(env[FLAG_ENV]);
}

/** Constant-time key comparison (length leak is fine; content leak is not) — warm-handoff pattern. */
function timingSafeKeyMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function bearerToken(value) {
  const raw = firstNonEmptyString(value);
  if (!raw.toLowerCase().startsWith('bearer ')) return '';
  return raw.slice(7).trim();
}

/** A usable PUBLIC verification key: EC P-256 with both coordinates and NO private component. */
function isUsableVerificationJwk(jwk) {
  return isPlainObject(jwk) && jwk.d === undefined && jwk.kty === 'EC' && jwk.crv === 'P-256'
    && Boolean(jwk.x) && Boolean(jwk.y);
}

/**
 * Verify an RFC 7797 detached JWS (`<protected_b64>..<sig_b64>`) over rawBodyBytes against candidate JWKs.
 * A kid-carrying header must match by kid (no fallback); a kid-less header tries every usable key.
 * Returns { verified, kid }.
 */
function verifyDetachedJws({ signature, rawBodyBytes, jwks }) {
  const parts = String(signature || '').split('.');
  // Detached JWS: exactly three segments with an EMPTY middle (payload) segment.
  if (parts.length !== 3 || parts[1] !== '') return { verified: false, kid: null };
  const [protectedB64, , sigB64] = parts;

  let protectedHeader;
  try {
    protectedHeader = JSON.parse(b64urlDecode(protectedB64).toString('utf8'));
  } catch {
    return { verified: false, kid: null };
  }
  if (!isPlainObject(protectedHeader)) return { verified: false, kid: null };
  const kid = typeof protectedHeader.kid === 'string' ? protectedHeader.kid : null;

  // TIGHTENED vs platform_receiver.py: the declared alg must be ES256 (never verify a header claiming
  // another alg with an ES256 key), and RFC 7797 detached mode must be declared (b64:false) with `crit`
  // of EXACTLY ["b64"] — RFC 7515 §4.1.11 requires rejecting any crit member we do not understand,
  // and forbids duplicate entries, so ["b64","b64"] is refused as well (length must be exactly 1).
  if (protectedHeader.alg !== 'ES256') return { verified: false, kid };
  if (protectedHeader.b64 !== false) return { verified: false, kid };
  const crit = protectedHeader.crit;
  if (!Array.isArray(crit) || crit.length !== 1 || crit[0] !== 'b64') {
    return { verified: false, kid };
  }

  let sig;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    return { verified: false, kid };
  }
  // Raw ES256 signature: exactly r||s, 32+32 big-endian bytes.
  if (sig.length !== 64) return { verified: false, kid };

  const signingInput = Buffer.concat([Buffer.from(`${protectedB64}.`, 'utf8'), rawBodyBytes]);

  const usable = (Array.isArray(jwks) ? jwks : []).filter(isUsableVerificationJwk);
  // TIGHTENED vs platform_receiver.py: a declared kid that matches nothing FAILS — the original fell
  // back to trying every key, which turns kid into decoration. Kid-less headers still try all keys.
  const candidates = kid ? usable.filter((k) => k.kid === kid) : usable;

  for (const jwk of candidates) {
    try {
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      // dsaEncoding 'ieee-p1363' consumes the raw r||s signature directly (no DER conversion).
      if (crypto.verify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, sig)) {
        return { verified: true, kid };
      }
    } catch {
      // Malformed key or verify error — try the next candidate.
    }
  }
  return { verified: false, kid };
}

/**
 * Receiver factory (dep-injectable for tests). Returns pure `async handler(input) -> { status, body }` pairs.
 * @param {object} [deps]
 * @param {object} [deps.env]        env override (default process.env, read PER REQUEST so flag flips apply live)
 * @param {Function} [deps.fetchImpl] fetch override for the business-profile JWKS fetch
 * @param {object} [deps.logger]
 * @param {Function} [deps.now]
 */
function createUcpOrderWebhookReceiver(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const logger = deps.logger || null;

  // Event ring buffer: oldest-first array + sha index, bounded by UCP_ORDER_WEBHOOK_MAX_EVENTS.
  const events = [];
  const eventsBySha = new Map();

  // In-module TTL cache for the business profile's signing keys (single profile URL).
  // `good` marks a set that came from a successful fetch — a later failed refresh must never clobber it.
  let jwksCache = null; // { url, keys, expiresAt, good }
  let jwksInFlight = null; // { url, promise } — coalesces concurrent refreshes into ONE fetch

  function warn(err, msg) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn({ err: err?.message || String(err), surface: 'ucp_order_webhook' }, msg);
    }
  }

  async function loadSigningKeys(env) {
    const url = firstNonEmptyString(env[PROFILE_URL_ENV]);
    // Unset profile URL -> empty key list -> verification (when required) fails closed.
    if (!url) return [];
    // HARDENED: the profile URL must be https — verifier keys fetched over plaintext could be swapped
    // by a network attacker. Mirrors requireHttps in safety-kernel/src/protocol/ucpProfile.js.
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:') {
      warn(new Error('UCP_BUSINESS_PROFILE_URL must be a valid https URL'), 'UCP business profile URL refused');
      return [];
    }

    const t = now();
    if (jwksCache && jwksCache.url === url && jwksCache.expiresAt > t) return jwksCache.keys;
    if (jwksInFlight && jwksInFlight.url === url) return jwksInFlight.promise;

    const promise = (async () => {
      try {
        const fetchImpl = typeof deps.fetchImpl === 'function'
          ? deps.fetchImpl
          : (typeof fetch === 'function' ? fetch : null);
        if (!fetchImpl) throw new Error('no fetch implementation available');
        const res = await fetchImpl(url, {
          headers: { accept: 'application/json' },
          redirect: 'error', // a redirected profile is refused, never followed
          signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
        });
        if (!res || !res.ok) throw new Error(`business profile fetch failed (${res ? res.status : 'no response'})`);
        const json = await res.json();
        // Shopify-shaped profiles nest under `ucp`; this gateway's own /.well-known/ucp is flat.
        const raw = Array.isArray(json?.ucp?.signing_keys)
          ? json.ucp.signing_keys
          : (Array.isArray(json?.signing_keys) ? json.signing_keys : []);
        // Drop anything unusable — including any key that (wrongly) carries private material.
        const keys = raw.filter(isUsableVerificationJwk);
        jwksCache = { url, keys, expiresAt: now() + JWKS_CACHE_TTL_MS, good: true };
        return keys;
      } catch (err) {
        warn(err, 'UCP business profile signing-key fetch failed');
        // Do NOT clobber a previously-good key set: keep serving it and retry after the failure TTL.
        // Fail closed (empty keys) only when there was never a good set for this URL.
        const hadGood = Boolean(jwksCache && jwksCache.url === url && jwksCache.good);
        const keys = hadGood ? jwksCache.keys : [];
        jwksCache = { url, keys, expiresAt: now() + JWKS_FAILURE_TTL_MS, good: hadGood };
        return keys;
      } finally {
        jwksInFlight = null;
      }
    })();
    jwksInFlight = { url, promise };
    return promise;
  }

  async function handleOrderWebhook({ headers = {}, rawBody, body } = {}) {
    const env = deps.env || process.env;
    if (!isFlagOn(env[FLAG_ENV])) return { status: 404, body: { error: 'not_found' } };

    const signature = firstNonEmptyString(header(headers, 'request-signature'));
    const businessId = firstNonEmptyString(header(headers, 'ucp-business-id')) || null;

    // The signature binds the EXACT bytes on the wire, so verification MUST use the raw body the
    // express.json verify hook stashed — never a re-serialized req.body.
    const rawBodyBytes = Buffer.isBuffer(rawBody)
      ? rawBody
      : (typeof rawBody === 'string' && rawBody.length ? Buffer.from(rawBody, 'utf8') : null);

    // Verification is REQUIRED whenever the receiver is enabled; UCP_ORDER_WEBHOOK_ALLOW_UNVERIFIED is
    // the explicit dev-only opt-out (and the force-on UCP_VERIFY_ORDER_WEBHOOK beats even that).
    const verifyRequired = isFlagOn(env[VERIFY_ENV]) || !isFlagOn(env[ALLOW_UNVERIFIED_ENV]);

    let verified = false;
    let kid = null;
    if (verifyRequired) {
      if (!signature) return { status: 401, body: { detail: 'missing Request-Signature' } };
      // No raw bytes captured means the JSON parser never saw this body (non-JSON content type) —
      // there is nothing the signature could have signed. 415 is the honest, diagnosable refusal.
      if (!rawBodyBytes) {
        return { status: 415, body: { detail: 'unsupported media type: application/json required' } };
      }
      const jwks = await loadSigningKeys(env);
      const out = verifyDetachedJws({ signature, rawBodyBytes, jwks });
      if (!out.verified) return { status: 401, body: { detail: 'invalid Request-Signature' } };
      verified = true;
      kid = out.kid;
    }

    // Nothing parseable (no raw bytes AND no parsed content): acknowledge without recording. Express
    // initializes req.body to {} when no parser claims the request (e.g. text/plain), so an EMPTY
    // object with no raw bytes is indistinguishable from an unparsed body — without this guard every
    // such request would collapse into one bogus sha256("{}") dedup entry and silently "duplicate".
    if (!rawBodyBytes && (!isPlainObject(body) || Object.keys(body).length === 0)) {
      return { status: 200, body: { status: 'ok', meta: { stored: false, reason: 'unparsed_body' } } };
    }

    // Dedup key: sha256 of the exact raw bytes (falls back to the parsed body only when no raw body
    // was captured — dedup-only, verification above never uses this fallback).
    const shaSource = rawBodyBytes || Buffer.from(JSON.stringify(body), 'utf8');
    const bodySha256 = crypto.createHash('sha256').update(shaSource).digest('hex');
    const duplicate = eventsBySha.has(bodySha256);

    if (!duplicate) {
      let parsed = isPlainObject(body) ? body : null;
      if (!parsed && rawBodyBytes) {
        try { parsed = JSON.parse(rawBodyBytes.toString('utf8')); } catch { parsed = null; }
      }
      if (!isPlainObject(parsed)) parsed = {};
      // METADATA ONLY — never the raw body, never PII.
      const entry = {
        body_sha256: bodySha256,
        received_at: new Date(now()).toISOString(),
        business_id: businessId,
        kid,
        signature_verified: verified,
        checkout_id: firstNonEmptyString(parsed.checkout_id, parsed.checkout_session_id) || null,
        order_id: firstNonEmptyString(parsed.order_id, isPlainObject(parsed.order) ? parsed.order.id : '') || null,
      };
      events.push(entry);
      eventsBySha.set(bodySha256, entry);
      const cap = maxEvents(env);
      while (events.length > cap) {
        const evicted = events.shift();
        eventsBySha.delete(evicted.body_sha256);
      }
    }

    return {
      status: 200,
      body: {
        status: 'ok',
        meta: { body_sha256: bodySha256, duplicate, signature_verified: verified, kid },
      },
    };
  }

  async function handleListEvents({ headers = {}, query = {} } = {}) {
    const env = deps.env || process.env;
    if (!isFlagOn(env[FLAG_ENV])) return { status: 404, body: { error: 'not_found' } };

    // INTERNAL door: shared-secret gate (x-pivota-internal-key or Bearer). Unconfigured key -> the
    // route does not exist (house pattern: an unconfigured internal door can never mean "open"), and a
    // wrong/missing key gets the same 404 so an unauthenticated caller cannot even confirm the surface.
    const configuredKey = firstNonEmptyString(env[EVENTS_KEY_ENV]);
    if (!configuredKey) return { status: 404, body: { error: 'not_found' } };
    const provided = firstNonEmptyString(
      header(headers, 'x-pivota-internal-key'),
      bearerToken(header(headers, 'authorization')),
    );
    if (!timingSafeKeyMatch(provided, configuredKey)) {
      return { status: 404, body: { error: 'not_found' } };
    }

    let out = events.slice().reverse(); // newest first
    for (const key of ['body_sha256', 'checkout_id', 'order_id']) {
      const want = firstNonEmptyString(isPlainObject(query) ? query[key] : '');
      if (want) out = out.filter((e) => e[key] === want);
    }
    return { status: 200, body: { events: out, count: out.length } };
  }

  return { handleOrderWebhook, handleListEvents };
}

module.exports = {
  createUcpOrderWebhookReceiver,
  isUcpOrderWebhookReceiverEnabled,
  verifyDetachedJws,
  FLAG_ENV,
  VERIFY_ENV,
  ALLOW_UNVERIFIED_ENV,
  PROFILE_URL_ENV,
  MAX_EVENTS_ENV,
  EVENTS_KEY_ENV,
  DEFAULT_MAX_EVENTS,
};
