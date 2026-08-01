'use strict';

/*
 * ucpOrderWebhookReceiver.js — inbound UCP order-webhook door (port of the retired
 * `ucp-platform-receiver` Railway service, platform_receiver.py). ucp.pivota.cc now routes to this
 * gateway, so the door the business profile promises has to live here.
 *
 *   POST /ucp/order-webhook          — receive a platform order event (detached-JWS ES256 verified when
 *                                      UCP_VERIFY_ORDER_WEBHOOK is on)
 *   GET  /ucp/order-webhook/events   — the in-memory event ring buffer (e2e positive-control surface;
 *                                      the retired service had GET /events)
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
 *   - the protected header MUST declare `b64: false` with `crit` including "b64" (RFC 7797 requires it
 *     for detached payloads; the original never checked).
 *
 * Pure/dependency-injected: env, fetch, logger and clock all arrive via deps; the logic functions never
 * touch process.env directly (env is read PER REQUEST so flag flips apply live, like the warm-handoff
 * internal route). Fail-closed: dark (404) unless UCP_ORDER_WEBHOOK_RECEIVER_ENABLED is set.
 */

const crypto = require('crypto');

const FLAG_ENV = 'UCP_ORDER_WEBHOOK_RECEIVER_ENABLED';
const VERIFY_ENV = 'UCP_VERIFY_ORDER_WEBHOOK';
const PROFILE_URL_ENV = 'UCP_BUSINESS_PROFILE_URL';
const MAX_EVENTS_ENV = 'UCP_ORDER_WEBHOOK_MAX_EVENTS';

const DEFAULT_MAX_EVENTS = 200;
const JWKS_CACHE_TTL_MS = 300 * 1000; // matches the retired receiver's 300s profile cache
const JWKS_FAILURE_TTL_MS = 30 * 1000; // failed fetches retry sooner, but never per-request hammering

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

/** A usable PUBLIC verification key: EC P-256 with both coordinates and NO private component. */
function isUsableVerificationJwk(jwk) {
  return isPlainObject(jwk) && jwk.d === undefined && jwk.kty === 'EC' && jwk.crv === 'P-256'
    && Boolean(jwk.x) && Boolean(jwk.y);
}

/**
 * Verify an RFC 7797 detached JWS (`<protected_b64>..<sig_b64>`) over rawBodyBytes against candidate JWKs.
 * Kid-matching keys are tried first; if none carries the kid, every usable key is tried (the retired
 * receiver's fallback). Returns { verified, kid }.
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
  // another alg with an ES256 key), and RFC 7797 detached mode must be declared (b64:false, crit:["b64"]).
  if (protectedHeader.alg !== 'ES256') return { verified: false, kid };
  if (protectedHeader.b64 !== false) return { verified: false, kid };
  if (!Array.isArray(protectedHeader.crit) || !protectedHeader.crit.includes('b64')) return { verified: false, kid };

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
  const kidMatched = kid ? usable.filter((k) => k.kid === kid) : [];
  const candidates = kidMatched.length ? kidMatched : usable;

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
  let jwksCache = null; // { url, keys, expiresAt }

  async function loadSigningKeys(env) {
    const url = firstNonEmptyString(env[PROFILE_URL_ENV]);
    // Unset profile URL -> empty key list -> verification (when required) fails closed.
    if (!url) return [];
    const t = now();
    if (jwksCache && jwksCache.url === url && jwksCache.expiresAt > t) return jwksCache.keys;

    let keys = [];
    let ttl = JWKS_FAILURE_TTL_MS;
    try {
      const fetchImpl = typeof deps.fetchImpl === 'function'
        ? deps.fetchImpl
        : (typeof fetch === 'function' ? fetch : null);
      if (!fetchImpl) throw new Error('no fetch implementation available');
      const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
      if (!res || !res.ok) throw new Error(`business profile fetch failed (${res ? res.status : 'no response'})`);
      const json = await res.json();
      // Shopify-shaped profiles nest under `ucp`; this gateway's own /.well-known/ucp is flat.
      const raw = Array.isArray(json?.ucp?.signing_keys)
        ? json.ucp.signing_keys
        : (Array.isArray(json?.signing_keys) ? json.signing_keys : []);
      // Drop anything unusable — including any key that (wrongly) carries private material.
      keys = raw.filter(isUsableVerificationJwk);
      ttl = JWKS_CACHE_TTL_MS;
    } catch (err) {
      keys = [];
      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          { err: err?.message || String(err), surface: 'ucp_order_webhook' },
          'UCP business profile signing-key fetch failed',
        );
      }
    }
    jwksCache = { url, keys, expiresAt: t + ttl };
    return keys;
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

    let verified = false;
    let kid = null;
    if (isFlagOn(env[VERIFY_ENV])) {
      if (!signature) return { status: 401, body: { detail: 'missing Request-Signature' } };
      // No raw bytes captured -> nothing the signature could have signed -> invalid, never re-serialize.
      if (!rawBodyBytes) return { status: 401, body: { detail: 'invalid Request-Signature' } };
      const jwks = await loadSigningKeys(env);
      const out = verifyDetachedJws({ signature, rawBodyBytes, jwks });
      if (!out.verified) return { status: 401, body: { detail: 'invalid Request-Signature' } };
      verified = true;
      kid = out.kid;
    }

    // Dedup key: sha256 of the exact raw bytes (falls back to the parsed body only when no raw body
    // was captured — dedup-only, verification above never uses this fallback).
    const shaSource = rawBodyBytes || Buffer.from(JSON.stringify(body ?? {}), 'utf8');
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

  async function handleListEvents({ query = {} } = {}) {
    const env = deps.env || process.env;
    if (!isFlagOn(env[FLAG_ENV])) return { status: 404, body: { error: 'not_found' } };

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
  verifyDetachedJws,
  FLAG_ENV,
  VERIFY_ENV,
  PROFILE_URL_ENV,
  MAX_EVENTS_ENV,
  DEFAULT_MAX_EVENTS,
};
