// OpenAI ACP (Agentic Commerce Protocol) merchant-side REST adapter — the ChatGPT path. It exposes the five
// ACP checkout-session endpoints + a product feed, normalizes each into a CANONICAL operation, and routes it
// through the ONE canonical executor → kernel. Safety (quote-first, amount-from-quote, host-minted
// confirmation, idempotency, single-use, charge-once, ownership/T7, cross-user isolation) is enforced once in
// the executor/kernel and never re-implemented here — this module only does ACP protocol mechanics:
//
//   POST /checkout_sessions                      -> create_checkout_session
//   POST /checkout_sessions/{id}                 -> update_checkout_session   (re-quote)
//   GET  /checkout_sessions/{id}                 -> get_checkout_session
//   POST /checkout_sessions/{id}/complete        -> complete_checkout_session (verify payment_data -> order + charge)
//   POST /checkout_sessions/{id}/cancel          -> cancel_checkout_session
//   GET  /feed                                   -> product feed (discovery)
//
// Framework-agnostic: every handler takes a normalized request `{ headers, rawBody, body, params }` and returns
// `{ status, body, headers? }`. Wire it to Express/Fastify/etc. at the edge.
//
// SECURITY MODEL (the adapter boundary's job):
//   - Authenticate the PLATFORM per request (HMAC Signature + Timestamp with replay window, constant-time),
//     BEFORE any processing. Per-BUYER identity (ACP has no stable buyer id) is resolved from a verified
//     credential via the injected resolveUserRef — never from the request body.
//   - An ACP checkout session is bound to one buyer at creation (sessionStore); a later call with a different
//     resolved buyer is refused (no cross-buyer session access via a leaked/guessed session id).
//   - Request bodies are mapped to canonical params by ALLOWLIST — model/caller-set amounts never reach pricing.
//   - Errors are mapped to ACP error shapes with curated messages; internal detail is never surfaced.

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { PivotaCommerceError } from '../errors.js';
import { PIVOTA_TO_ACP_STATUS } from '../acpAp2.js';
import { sanitizeResult } from './resultSanitizer.js';

const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000; // reject a Timestamp more than 5 minutes off (replay window)
const CREATE_DEDUP_TTL_MS = 15 * 60 * 1000; // window over which a replayed (buyer, idempotency_key) create dedupes
// Build a sanitized ACP checkout-session response. handoffAllowed=FALSE: a quote/session response carries NO
// legitimate payment redirect (that arrives at /complete via requires_action), so a merchant-supplied
// redirect-named string in line_items is NOT trusted as a handoff — it is scrubbed like any other string
// (Codex round-2 #2). Only the /complete response uses handoffAllowed=true.
const acpSessionBody = (id, session, stored) => sanitizeResult(toAcpSession(id, session, stored), { handoffAllowed: false });
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * Verify an ACP request signature. HMAC-SHA256 over `${timestamp}.${rawBody}`, hex, constant-time compared,
 * with a freshness window on the Timestamp (replay protection). Throws PivotaCommerceError on any failure.
 * Standalone + exported so the exact signing string can be swapped per the production integration contract.
 */
export function verifyAcpSignature({ signature, timestamp, rawBody, secret, maxSkewMs = DEFAULT_MAX_SKEW_MS, now = () => Date.now() }) {
  if (!nonEmpty(secret)) throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'no_signing_secret' });
  if (!nonEmpty(signature) || !nonEmpty(timestamp)) {
    throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'missing_signature_or_timestamp' });
  }
  // Timestamp freshness (replay protection). Accept unix seconds or millis.
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'bad_timestamp' });
  const tsMs = tsNum < 1e12 ? tsNum * 1000 : tsNum;
  if (Math.abs(now() - tsMs) > maxSkewMs) throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'stale_timestamp' });

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody ?? ''}`).digest('hex');
  // constant-time compare; mismatched lengths can't be timingSafeEqual'd, so length-check first (not secret-dependent).
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'signature_mismatch' });
  }
  return true;
}

/**
 * @param {{
 *   executor: { execute: Function },         // canonical executor
 *   sessionStore: { get, set },              // KV: acpSid -> { quote_id, order_id, user_ref }
 *   signingSecret?: string,                  // for the built-in HMAC verifier
 *   authenticate?: (req) => Promise<void>,   // custom auth (overrides built-in); MUST throw on failure
 *   resolveUserRef: (req) => Promise<string|undefined>,  // verified per-buyer identity (NEVER from body)
 *   getProducts?: (query) => Promise<Array>, // product feed source
 *   mapFeedItem?: (product) => object,       // product -> ACP feed item
 *   maxClockSkewMs?: number,
 *   now?: () => number,
 * }} deps
 */
export function createAcpRestAdapter(deps = {}) {
  const { executor, sessionStore, signingSecret, authenticate, resolveUserRef, getProducts, mapFeedItem, publicFeed = false, maxClockSkewMs = DEFAULT_MAX_SKEW_MS, now = () => Date.now() } = deps;
  if (!executor || typeof executor.execute !== 'function') throw new Error('createAcpRestAdapter requires a canonical executor');
  if (!sessionStore || typeof sessionStore.get !== 'function' || typeof sessionStore.set !== 'function' || typeof sessionStore.putIfAbsent !== 'function') throw new Error('createAcpRestAdapter requires a sessionStore (get/set/putIfAbsent)');
  if (typeof resolveUserRef !== 'function') throw new Error('createAcpRestAdapter requires resolveUserRef');
  if (typeof authenticate !== 'function' && !nonEmpty(signingSecret)) {
    throw new Error('createAcpRestAdapter requires signingSecret or a custom authenticate() — refusing to run unauthenticated');
  }

  const auth = typeof authenticate === 'function'
    ? authenticate
    : async (req) => verifyAcpSignature({
        signature: header(req, 'signature'), timestamp: header(req, 'timestamp'),
        rawBody: req.rawBody, secret: signingSecret, maxSkewMs: maxClockSkewMs, now,
      });

  // Resolve the verified buyer; checkout ops are user-scoped so a missing buyer fails closed.
  async function requireBuyer(req) {
    const user_ref = await resolveUserRef(req);
    if (!nonEmpty(user_ref)) throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'no_verified_buyer' });
    return user_ref.trim();
  }

  // Load a session the requester OWNS (bound to their buyer at creation). A leaked/guessed id from another
  // buyer is refused; a malformed store record fails closed (Codex P2).
  async function ownedSession(acpSid, user_ref) {
    const s = await sessionStore.get(acpSid);
    if (!s) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { reason: 'unknown_checkout_session', checkout_session_id: acpSid });
    if (!isPlainObject(s) || !nonEmpty(s.user_ref) || !nonEmpty(s.quote_id)) {
      throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { reason: 'malformed_session_record' });
    }
    if (s.user_ref !== user_ref) throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { reason: 'session_buyer_mismatch' });
    return s;
  }

  function requireIdempotencyKey(req) {
    const key = header(req, 'idempotency-key');
    if (!nonEmpty(key)) throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { reason: 'missing_idempotency_key' });
    return key;
  }

  // The signature authenticates rawBody (the exact signed bytes). Derive the trusted body by PARSING THOSE
  // bytes — never a separately-supplied parsed `body` that a middleware could have mutated after signing
  // (Codex P0). Body-bearing requests with no raw body fail closed.
  function trustedBody(req) {
    if (!nonEmpty(req?.rawBody)) throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'missing_raw_body' });
    let parsed;
    try { parsed = JSON.parse(req.rawBody); } catch { throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'invalid_json_body' }); }
    if (!isPlainObject(parsed)) throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'body_not_object' });
    return parsed;
  }

  // ---- handlers -------------------------------------------------------------------------------------------

  async function createCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const idempotency_key = requireIdempotencyKey(req);
      const user_ref = await requireBuyer(req);
      const quote = mapItemsToQuote(trustedBody(req)); // priced from the SIGNED bytes (validates non-empty items)

      // ACP-layer create idempotency (Codex P1): a replayed (buyer, key) returns the ORIGINAL session instead
      // of minting a new one — no quote/inventory-hold amplification. (Concurrent first-time creates with the
      // same key race on the claim; the loser's quote simply expires unused — documented, acceptable.)
      // JSON-tuple key (NOT a delimiter-join): unambiguous regardless of whether buyer/key contain spaces, so
      // two distinct (buyer, key) pairs can never collide (Codex round-2 #3; same lesson as the executor scoping).
      const createKey = JSON.stringify(['acpcreate', user_ref, idempotency_key]);
      const minted = randomUUID();
      const claimed = await sessionStore.putIfAbsent(createKey, { acp_session_id: minted }, { ttlMs: CREATE_DEDUP_TTL_MS });
      if (!claimed) {
        const prior = await sessionStore.get(createKey);
        const stored = await ownedSession(prior.acp_session_id, user_ref);
        const session = await executor.execute('get_checkout_session', { session_id: stored.quote_id }, { user_ref, acp_session_id: prior.acp_session_id });
        return { status: 200, body: acpSessionBody(prior.acp_session_id, session, stored) };
      }

      const ctx = { user_ref, acp_session_id: minted };
      const session = await executor.execute('create_checkout_session', { idempotency_key, quote }, ctx);
      await sessionStore.set(minted, { quote_id: session.session_id, order_id: null, user_ref });
      return { status: 201, body: acpSessionBody(minted, session) };
    });
  }

  async function updateCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const idempotency_key = requireIdempotencyKey(req);
      const user_ref = await requireBuyer(req);
      const acp_session_id = pathId(req);
      const stored = await ownedSession(acp_session_id, user_ref);
      const quote = mapItemsToQuote(trustedBody(req));
      const ctx = { user_ref, acp_session_id };
      const session = await executor.execute('update_checkout_session', { idempotency_key, session_id: stored.quote_id, quote }, ctx);
      await sessionStore.set(acp_session_id, { ...stored, quote_id: session.session_id });
      return { status: 200, body: acpSessionBody(acp_session_id, session, stored) };
    });
  }

  async function getCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const user_ref = await requireBuyer(req);
      const acp_session_id = pathId(req);
      const stored = await ownedSession(acp_session_id, user_ref);
      const ctx = { user_ref, acp_session_id };
      const session = await executor.execute('get_checkout_session', { session_id: stored.quote_id }, ctx);
      return { status: 200, body: acpSessionBody(acp_session_id, session, stored) };
    });
  }

  async function completeCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const idempotency_key = requireIdempotencyKey(req);
      const user_ref = await requireBuyer(req);
      const acp_session_id = pathId(req);
      const stored = await ownedSession(acp_session_id, user_ref);
      const body = trustedBody(req);
      const ctx = { user_ref, acp_session_id };
      const out = await executor.execute('complete_checkout_session', {
        idempotency_key,
        session_id: stored.quote_id,
        authorization_checkout_session_id: acp_session_id,
        payment_authorization: paymentAuthorization(body), // ACP `payment_data` — verified by the executor
        shipping_address: mapAddress(body),
      }, ctx);
      await sessionStore.set(acp_session_id, { ...stored, order_id: out.order?.order_id ?? stored.order_id });
      // checkout flow → payment redirect handoff preserved verbatim; secrets/amounts elsewhere scrubbed.
      return { status: 200, body: sanitizeResult(toAcpOrder(acp_session_id, out), { handoffAllowed: true }) };
    });
  }

  async function cancelCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const idempotency_key = requireIdempotencyKey(req);
      const user_ref = await requireBuyer(req);
      const acp_session_id = pathId(req);
      const stored = await ownedSession(acp_session_id, user_ref);
      const ctx = { user_ref, acp_session_id };
      await executor.execute('cancel_checkout_session', { idempotency_key, session_id: stored.quote_id, order_id: stored.order_id ?? undefined }, ctx);
      return { status: 200, body: { id: acp_session_id, object: 'checkout_session', status: 'canceled' } };
    });
  }

  // Product feed (discovery). Authenticated by default like every other endpoint; only served unauthenticated
  // when the integrator EXPLICITLY opts in via publicFeed:true (catalog is public data). Codex P1.
  async function productFeed(req) {
    return guard(async () => {
      if (!publicFeed) await auth(req);
      if (typeof getProducts !== 'function') throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'no_feed_source' });
      // For an AUTHENTICATED feed, the filter query must come from the SIGNED body, not an unsigned parsed body
      // (Codex round-2 #1). For a public feed there is no signature, so the unsigned body/params are expected.
      const query = publicFeed
        ? (req?.body?.query ?? req?.params ?? {})
        : (nonEmpty(req?.rawBody) ? (trustedBody(req).query ?? {}) : {});
      const products = await getProducts(query);
      const items = (Array.isArray(products) ? products : []).map((p) => (mapFeedItem ? mapFeedItem(p) : defaultFeedItem(p)));
      // feed is NOT a checkout flow → no handoff preservation; scrub aggressively.
      return { status: 200, body: sanitizeResult({ version: ACP_FEED_VERSION, count: items.length, products: items }, { handoffAllowed: false }) };
    });
  }

  return {
    createCheckoutSession, updateCheckoutSession, getCheckoutSession,
    completeCheckoutSession, cancelCheckoutSession, productFeed,
  };
}

// ---- request helpers --------------------------------------------------------------------------------------

const header = (req, name) => {
  const h = req?.headers ?? {};
  const v = h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
  return typeof v === 'string' ? v.trim() : undefined;
};
const pathId = (req) => {
  const id = req?.params?.checkout_session_id ?? req?.params?.id;
  if (!nonEmpty(id)) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { reason: 'missing_checkout_session_id' });
  return id.trim();
};

// ACP items -> canonical quote request, by ALLOWLIST (a caller-set amount/total/currency never reaches pricing).
// Requires a non-empty items array with a scalar product/SKU id and a positive safe-integer quantity each, so a
// `{}` / `{items:[]}` body can't drive a default/zero-item quote on a loose backend (Codex P2).
function mapItemsToQuote(body) {
  const b = isPlainObject(body) ? body : {};
  const rawItems = Array.isArray(b.items) ? b.items : [];
  if (rawItems.length === 0) throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'no_items' });
  const items = rawItems.map((it) => {
    const item = pick(it, ['product_id', 'sku_id', 'variant_id', 'quantity']);
    if (!nonEmpty(item.product_id) && !nonEmpty(item.sku_id)) throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'item_missing_product_id' });
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'item_bad_quantity' });
    return item;
  });
  const quote = { merchant_id: str(b.merchant_id) ?? str(b.merchant?.id), items };
  const codes = Array.isArray(b.discount_codes) ? b.discount_codes.filter((c) => typeof c === 'string') : undefined;
  if (codes && codes.length) quote.discount_codes = codes;
  const addr = mapAddress(b);
  if (addr) quote.shipping_address = addr;
  return quote;
}

function mapAddress(body) {
  const a = isPlainObject(body?.fulfillment_address) ? body.fulfillment_address
    : isPlainObject(body?.shipping_address) ? body.shipping_address
    : isPlainObject(body?.address) ? body.address : null;
  if (!a) return undefined;
  return pick(a, ['country', 'city', 'state', 'postal_code', 'address_line1', 'address_line2', 'recipient_name', 'phone']);
}

// ACP `payment_data` is the delegated-token / credential envelope; opaque to the kernel, VERIFIED by the
// executor's verifyPaymentAuthorization. Safe-clone so a hostile __proto__ key can't pollute downstream.
function paymentAuthorization(body) {
  const pd = body?.payment_data ?? body?.payment;
  return pd === undefined ? undefined : safeClone(pd);
}

// ---- response mapping (ACP shapes; reuses the canonical status vocabulary) --------------------------------

function toAcpSession(id, session, stored) {
  return {
    id,
    object: 'checkout_session',
    status: stored?.order_id ? PIVOTA_TO_ACP_STATUS.order_created : PIVOTA_TO_ACP_STATUS.quote_issued,
    currency: session.currency,
    merchant_of_record: session.merchant_of_record,
    line_items: session.line_items,
    totals: session.totals,
    expires_at: session.expires_at,
    order: stored?.order_id ? { id: stored.order_id } : undefined,
  };
}

function toAcpOrder(id, out) {
  // Read the raw payment; the response is run through the shared sanitizer at the boundary (which preserves the
  // redirect handoff verbatim and scrubs secrets). requires_action is built from redirect/qr/instructions only —
  // never client_secret/ap2_state.
  const payment = (out && typeof out.payment === 'object' && out.payment) || {};
  const acpStatus = payment.order_status === 'paid' ? PIVOTA_TO_ACP_STATUS.payment_succeeded
    : payment.order_status === 'charge_pending' ? PIVOTA_TO_ACP_STATUS.payment_requires_action
    : payment.order_status === 'failed' ? PIVOTA_TO_ACP_STATUS.payment_failed
    : PIVOTA_TO_ACP_STATUS.order_created;
  return {
    id,
    object: 'checkout_session',
    status: acpStatus,
    order: { id: out.order?.order_id, amount_total: out.order?.amount_total, currency: out.order?.currency },
    // requires_action handoff surfaced verbatim for the buyer (never fabricated); raw secrets already scrubbed.
    requires_action: payment.redirect_url || payment.qr_code || payment.instructions
      ? { redirect_url: payment.redirect_url, qr_code: payment.qr_code, instructions: payment.instructions }
      : undefined,
    payment_status: payment.payment_status,
  };
}

const ACP_FEED_VERSION = '2026-04-17';
function defaultFeedItem(p) {
  const o = isPlainObject(p) ? p : {};
  // raw mapping; the whole feed body is run through the shared sanitizer at the response boundary.
  return {
    id: o.id ?? o.product_id ?? o.sku_id,
    title: o.title ?? o.name,
    description: o.description,
    link: o.link ?? o.url,
    image_link: o.image_link ?? o.image ?? (Array.isArray(o.images) ? o.images[0] : undefined),
    price: o.price,
    currency: o.currency,
    availability: o.availability ?? (o.in_stock === false ? 'out_of_stock' : o.in_stock === true ? 'in_stock' : undefined),
    brand: o.brand ?? o.merchant_id,
    variants: o.variants,
  };
}

// ---- error mapping (ACP error shape; never leaks internal detail) -----------------------------------------

const STATUS_BY_CODE = Object.freeze({
  USER_AUTH_REQUIRED: 401,
  STATE_LINKAGE_MISMATCH: 409,
  QUOTE_NOT_FOUND: 404,
  QUOTE_EXPIRED: 409,
  QUOTE_ALREADY_USED: 409,
  QUOTE_REQUIRED: 400,
  PRICE_CHANGED: 409,
  OUT_OF_STOCK: 409,
  CONFIRMATION_REQUIRED: 402,
  CONFIRMATION_INVALID: 402,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENT_REPLAY: 409,
  PAYMENT_REQUIRES_ACTION: 402,
  MERCHANT_UNAVAILABLE: 503,
  OPERATION_NOT_ALLOWED: 409,
});

// Run a handler, mapping any throw to an ACP error response. PivotaCommerceError → its code + curated
// userMessage; anything else → a generic 500 (a raw error message is NEVER surfaced).
async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PivotaCommerceError) {
      return { status: STATUS_BY_CODE[err.code] ?? 400, body: { type: 'error', code: err.code, message: err.userMessage } };
    }
    return { status: 500, body: { type: 'error', code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } };
  }
}

// ---- small utilities --------------------------------------------------------------------------------------

function pick(src, keys) {
  const out = {};
  if (!isPlainObject(src)) return out;
  for (const k of keys) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) out[k] = src[k];
  }
  return out;
}
function safeClone(v, depth = 0) {
  if (v === null || typeof v !== 'object') return v;
  if (depth > 32) return null;
  if (Array.isArray(v)) return v.map((x) => safeClone(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = safeClone(v[k], depth + 1);
  }
  return out;
}
function str(v) { return typeof v === 'string' ? v : undefined; }
