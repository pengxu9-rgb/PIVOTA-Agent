'use strict';

/*
 * ucpDiscountVerifyInternalRoute.js — INTERNAL route that checks ONE discount code on a seller's own UCP door.
 *
 *   POST /internal/ucp/discount-code/verify   (X-Internal-Key auth; NEVER public)
 *   { seller_host, discovery_host?, variant_gid, market, code, expected_currency? }
 *   -> 200 { result, reason, currency?, totals?, unit_price?, discount?, automatic? }
 *   -> 400 { error: "invalid_request", reason }     a field is missing, malformed or unknown
 *   -> 401 { error: "unauthorized" }                key missing or wrong
 *   -> 404 { error: "not_found" }                   dark: the flag is off or no key is configured
 *
 * The backend's coupon verifier calls this for each candidate code (design: coupon discovery lane, 2026-11-07): one
 * store variant at quantity 1, one code, the buyer's market. It runs mcp-server/src/ucpMerchantDoorPricing.js
 * `verifyCodeOnMerchantDoor` — the SAME discovery, create_cart, cart reader and discount reader the storefront checkout
 * door uses — so a verification and a buyer's checkout cannot read a seller differently.
 *
 * HARD BOUNDS: create_cart only (the buyer-agent client hard-refuses complete_checkout); no buyer data (a market hint,
 * never an address or email); the code is never logged; per-store pacing and daily caps are the CALLER's
 * (deal_verify_host_daily_carts), this route answers one call.
 *
 * Fail-closed mounting: 404 unless the flag is on AND a key is configured. An unconfigured key never means "open".
 */

const crypto = require('crypto');

const ROUTE_FLAG_ENV = 'UCP_DISCOUNT_VERIFY_ROUTE_ENABLED';
const INTERNAL_KEY_ENV = 'UCP_DISCOUNT_VERIFY_INTERNAL_KEY';
// At least 32 random bytes, base64/hex encoded: 43+ characters. Anything shorter keeps the route dark.
const MIN_KEY_CHARS = 43;
const BODY_FIELDS = new Set(['seller_host', 'discovery_host', 'variant_gid', 'market', 'code', 'expected_currency']);
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;

function isFlagOn(value) {
  return /^(1|true|yes|on|enabled)$/i.test(String(value || '').trim());
}

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

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

function headerValue(headers, name) {
  if (!headers) return undefined;
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

async function defaultVerify(args) {
  const mod = await import('../../mcp-server/src/ucpMerchantDoorPricing.js');
  return mod.verifyCodeOnMerchantDoor(args);
}

async function defaultProblem(args) {
  const mod = await import('../../mcp-server/src/ucpMerchantDoorPricing.js');
  return mod.verifyInputProblem(args);
}

/**
 * @param {object} [deps]
 * @param {object} [deps.env]      read PER REQUEST, so a flag flip applies live (default process.env)
 * @param {Function} [deps.verify] test seam: (args) => result (default: verifyCodeOnMerchantDoor)
 * @param {Function} [deps.problem] test seam: (args) => reason|null (default: verifyInputProblem)
 * @param {object} [deps.logger]
 */
function createUcpDiscountVerifyInternalHandler(deps = {}) {
  const verify = typeof deps.verify === 'function' ? deps.verify : defaultVerify;
  const problemOf = typeof deps.problem === 'function' ? deps.problem : defaultProblem;
  const logger = deps.logger || null;
  return async function handle({ headers, body } = {}) {
    const env = deps.env || process.env;
    const key = String(env[INTERNAL_KEY_ENV] || '').trim();
    // A key shorter than MIN_KEY_CHARS is treated as no key: a guessable key on a public URL prefix is not a lock.
    if (!isFlagOn(env[ROUTE_FLAG_ENV]) || key.length < MIN_KEY_CHARS) return { status: 404, body: { error: 'not_found' } };
    if (!timingSafeKeyMatch(headerValue(headers, 'x-internal-key'), key)) {
      // WARN, so a burst of wrong keys is visible to log-based alerting (there is no throttle on this route).
      if (logger && typeof logger.warn === 'function') {
        try { logger.warn({ event: 'ucp_discount_verify_unauthorized' }, 'ucp discount verify: wrong or missing key'); } catch { /* never throw */ }
      }
      return { status: 401, body: { error: 'unauthorized' } };
    }
    if (!isPlainObject(body)) return { status: 400, body: { error: 'invalid_request', reason: 'body_not_object' } };
    const unknown = Object.keys(body).find((k) => !BODY_FIELDS.has(k));
    if (unknown) return { status: 400, body: { error: 'invalid_request', reason: 'unknown_field', field: unknown } };
    if (body.discovery_host !== undefined && !(typeof body.discovery_host === 'string' && HOST_RE.test(body.discovery_host))) {
      return { status: 400, body: { error: 'invalid_request', reason: 'discovery_host_invalid' } };
    }
    const args = {
      sellerHost: body.seller_host,
      ...(body.discovery_host !== undefined ? { discoveryHost: body.discovery_host } : {}),
      variantGid: body.variant_gid,
      market: body.market,
      code: body.code,
      ...(body.expected_currency !== undefined ? { expectedCurrency: body.expected_currency } : {}),
    };
    const problem = await problemOf(args);
    if (problem) return { status: 400, body: { error: 'invalid_request', reason: problem } };
    const startedAt = Date.now();
    const out = await verify(logger ? { ...args, log: logger } : args);
    if (logger && typeof logger.info === 'function') {
      // Counts and outcome only: never the code, never the variant.
      try {
        logger.info({ event: 'ucp_discount_verify', seller_host: String(body.seller_host), result: out && out.result, reason: (out && out.reason) || null, latency_ms: Date.now() - startedAt }, 'ucp discount verify');
      } catch { /* never throw the route */ }
    }
    return { status: 200, body: out };
  };
}

module.exports = {
  createUcpDiscountVerifyInternalHandler,
  ROUTE_FLAG_ENV,
  INTERNAL_KEY_ENV,
  MIN_KEY_CHARS,
};
