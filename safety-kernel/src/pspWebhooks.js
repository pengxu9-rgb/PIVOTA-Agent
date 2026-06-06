// PSP-native payment webhook adapters — let the protocol edge ingest RAW Stripe / Adyen webhooks (their real
// signature schemes differ from the Pivota-normalized HMAC in webhookHandler.js). Each adapter:
//   1. verifies the PSP-native signature over the RAW request body in constant time (+ replay window),
//   2. maps the PSP event → the canonical { order_id, payment_id, status } the kernel understands,
//   3. drives kernel.onPaymentWebhook (idempotent + payment_id-correlated inside the kernel).
//
// order_id MUST be the KERNEL order id (the value the backend stored as the order's id at create_order /
// submit_payment time) — carried in Stripe PaymentIntent metadata or Adyen merchantReference. payment_id MUST
// be the same id the backend recorded at submit (Stripe PaymentIntent id / Adyen pspReference) so the kernel's
// attempt-correlation matches. Both mappers are overridable for backend-specific metadata placement.
//
// No PSP SDK dependency — schemes implemented per the public specs with node:crypto. FAIL CLOSED on any
// signature/parse/mapping problem. ⚠️ Validate the Adyen HMAC field order/escaping against a real Adyen test
// notification before go-live (the algorithm here follows Adyen's standard-webhook HMAC spec).

import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

const STRIPE_DEFAULT_TOLERANCE_S = 300; // reject events whose timestamp is >5min from now (replay window)
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

function ctEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

const rawString = (rawBody) => (Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? ''));

// Constant-time HTTP Basic Auth check: header = `Basic base64(user:pass)`. Compares the FULL decoded
// `user:pass` so neither field's match can be probed independently. (Codex round-4) STRICT base64 token (the
// `$` anchor + canonical round-trip reject trailing junk that Node's permissive decoder would otherwise
// ignore), and a LENGTH-SAFE compare: both sides are SHA-256'd to a fixed 32 bytes before timingSafeEqual, so
// neither the match nor the credential LENGTH leaks via timing/early-return.
function verifyBasicAuth(headerValue, username, password) {
  if (!nonEmpty(headerValue)) return false;
  const m = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/.exec(headerValue.trim());
  if (!m) return false;
  const token = m[1];
  let buf;
  try { buf = Buffer.from(token, 'base64'); } catch { return false; }
  if (buf.toString('base64') !== token) return false; // reject non-canonical base64
  const a = createHash('sha256').update(buf).digest();
  const b = createHash('sha256').update(`${username}:${password}`, 'utf8').digest();
  return timingSafeEqual(a, b);
}
// TRUE byte length (Codex P2): a Buffer's byte length is its .length; a string's is its UTF-8 byte length —
// NOT its .length (UTF-16 code units), so a multibyte body can't slip past a byte cap.
const byteLen = (rawBody) => (Buffer.isBuffer(rawBody) ? rawBody.length : Buffer.byteLength(String(rawBody ?? ''), 'utf8'));

// ---- Stripe ----------------------------------------------------------------------------------------------

/**
 * Verify a Stripe `Stripe-Signature` header. Scheme: header = `t=<unix>,v1=<hex>,v1=<hex>,...`; the signed
 * payload is `${t}.${rawBody}`; expected = HMAC-SHA256(signedPayload, secret) hex; the secret is the endpoint
 * signing secret (`whsec_…`) used directly as the key. Constant-time compared against EVERY v1 (secret
 * rotation yields multiple), with a timestamp tolerance to block replay. Returns true or throws nothing —
 * returns false on any failure (caller fails closed).
 */
export function verifyStripeSignature(rawBody, signatureHeader, secret, { toleranceSec = STRIPE_DEFAULT_TOLERANCE_S, now = () => Date.now() } = {}) {
  if (!nonEmpty(secret) || !nonEmpty(signatureHeader)) return false;
  let t;
  const v1 = [];
  for (const part of signatureHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (k === 't') t = val;
    else if (k === 'v1') v1.push(val);
  }
  if (!nonEmpty(t) || v1.length === 0) return false;
  const tsSec = Number(t);
  if (!Number.isFinite(tsSec)) return false;
  // replay window — Stripe timestamps are unix SECONDS
  if (Math.abs(Math.floor(now() / 1000) - tsSec) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawString(rawBody)}`).digest('hex');
  // constant-time compare against each provided v1; accept if any matches (don't short-circuit on the first)
  let ok = false;
  for (const sig of v1) { if (ctEqual(expected, sig)) ok = true; }
  return ok;
}

// Stripe event → canonical { order_id, payment_id, status }. SECURITY (Codex P0): ONLY a PaymentIntent
// terminal event finalizes. We REQUIRE `data.object.object === 'payment_intent'` and map by exact event type;
// we NEVER fall back to `obj.status` (a `checkout.session.completed` with status "complete" / "unpaid", a
// `charge.refunded`, a dispute, etc. would otherwise be mis-mapped to success). Anything else → status
// undefined → the kernel treats it as in-flight and does NOT transition. A deployment using Checkout Sessions
// (or capture-on-charge) must supply an explicit `stripeMapEvent` that asserts true payment success.
export function defaultStripeMapEvent(event) {
  const obj = event?.data?.object ?? {};
  const md = (obj.metadata && typeof obj.metadata === 'object') ? obj.metadata : {};
  const order_id = md.pivota_order_id ?? md.order_id ?? md.orderId;
  const payment_id = typeof obj.id === 'string' ? obj.id : undefined; // pi_… recorded as the order's attempt
  if (obj.object !== 'payment_intent') return { order_id, payment_id, status: undefined }; // held, never finalized
  const type = String(event?.type ?? '');
  let status;
  if (type === 'payment_intent.succeeded') status = 'succeeded';
  else if (type === 'payment_intent.payment_failed' || type === 'payment_intent.canceled') status = 'failed';
  // every other PI event (processing, requires_action, amount_capturable_updated, …) → held
  return { order_id, payment_id, status };
}

/**
 * @param {{ kernel:{onPaymentWebhook:Function}, secret:string, signatureHeader?:string, toleranceSec?:number,
 *           mapEvent?:Function, now?:()=>number, log?:object }} cfg
 * @returns {(req:{headers:object, rawBody:string|Buffer}) => Promise<{status:number, body:object}>}
 */
export function createStripeWebhookHandler({ kernel, secret, signatureHeader = 'stripe-signature', toleranceSec = STRIPE_DEFAULT_TOLERANCE_S, mapEvent = defaultStripeMapEvent, maxBytes = 1_000_000, now = () => Date.now(), log = console } = {}) {
  if (!kernel || typeof kernel.onPaymentWebhook !== 'function') throw new Error('createStripeWebhookHandler requires a kernel with onPaymentWebhook()');
  if (!nonEmpty(secret) || secret.length < 16) throw new Error('createStripeWebhookHandler requires a strong webhook secret');
  return async function handleStripeWebhook({ headers = {}, rawBody = '' } = {}) {
    if (byteLen(rawBody) > maxBytes) return { status: 413, body: { error: 'payload_too_large' } }; // bound HMAC work
    if (!verifyStripeSignature(rawBody, getHeader(headers, signatureHeader), secret, { toleranceSec, now })) {
      log.warn?.('stripe_webhook_rejected', { reason: 'bad_signature' });
      return { status: 401, body: { error: 'invalid_signature' } };
    }
    return driveKernel(kernel, rawBody, mapEvent, 'stripe', log);
  };
}

// ---- Adyen -----------------------------------------------------------------------------------------------

// Adyen standard-webhook HMAC: per NotificationRequestItem, sign the `:`-joined list of these fields (missing
// → empty), with `\` and `:` escaped INSIDE each value; key is the HEX-decoded HMAC key; expected = base64.
const ADYEN_FIELDS = ['pspReference', 'originalReference', 'merchantAccountCode', 'merchantReference', 'amountValue', 'amountCurrency', 'eventCode', 'success'];
function adyenEscape(v) { return String(v ?? '').replace(/\\/g, '\\\\').replace(/:/g, '\\:'); }
function adyenSignedString(item) {
  const f = {
    pspReference: item.pspReference, originalReference: item.originalReference,
    merchantAccountCode: item.merchantAccountCode, merchantReference: item.merchantReference,
    amountValue: item.amount?.value, amountCurrency: item.amount?.currency,
    eventCode: item.eventCode, success: item.success,
  };
  return ADYEN_FIELDS.map((k) => adyenEscape(f[k])).join(':');
}

// Decode + VALIDATE an Adyen HMAC key (Codex P1): Buffer.from(hex,'hex') silently TRUNCATES at the first
// non-hex byte, so "0123NOTHEX" would become a 2-byte key. Require strict even-length hex that round-trips and
// is a real 256-bit Adyen key (32 bytes). Returns the Buffer or null (caller fails closed / throws at boot).
function adyenKeyBytes(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const buf = Buffer.from(hex, 'hex');
  if (buf.toString('hex') !== hex.toLowerCase()) return null; // no truncation
  if (buf.length < 32) return null; // Adyen HMAC keys are 32 bytes (64 hex chars)
  return buf;
}

/**
 * Verify an Adyen NotificationRequestItem HMAC. hmacKey is the HEX key from the Adyen dashboard. Returns
 * true/false (caller fails closed). Constant-time compared against additionalData.hmacSignature (base64).
 */
export function verifyAdyenHmac(item, hmacKeyHex) {
  const key = adyenKeyBytes(hmacKeyHex);
  if (!key) return false;
  const provided = item?.additionalData?.hmacSignature;
  if (!nonEmpty(provided)) return false;
  const expected = createHmac('sha256', key).update(adyenSignedString(item), 'utf8').digest('base64');
  return ctEqual(expected, provided);
}

// Adyen item → canonical { order_id, payment_id, status }. order_id = merchantReference (the kernel order id
// the backend set), payment_id = pspReference (recorded at submit), status from eventCode + success.
export function defaultAdyenMapItem(item) {
  const order_id = item?.merchantReference;
  const payment_id = item?.pspReference;
  const code = String(item?.eventCode ?? '');
  const success = String(item?.success ?? '').toLowerCase() === 'true';
  let status;
  if (code === 'AUTHORISATION' || code === 'CAPTURE') status = success ? 'succeeded' : 'failed';
  else if (code === 'CANCELLATION' || code === 'REFUND') status = success ? 'failed' : undefined; // cancel/refund → not a success
  else status = undefined; // unknown eventCode → in_flight (held)
  return { order_id, payment_id, status };
}

/**
 * Adyen sends `{ live, notificationItems: [{ NotificationRequestItem: {...} }, ...] }`. Each item is HMAC-
 * verified individually; an item with a bad/missing HMAC is REJECTED (the whole request 401s — fail closed,
 * Adyen retries). Verified items drive the kernel. Adyen expects the literal body `[accepted]` on 200.
 *
 * Production Adyen also protects the endpoint with HTTP **Basic Auth** (configured in the Adyen dashboard) IN
 * ADDITION to the per-item HMAC. Pass `basicAuth: { username, password }` to enforce it — the Authorization
 * header is constant-time-checked BEFORE any body work (rejecting unauthenticated floods cheaply). The HMAC
 * remains the cryptographic per-item integrity proof; Basic Auth is the transport gate.
 * @param {{ kernel:{onPaymentWebhook:Function}, hmacKey:string, basicAuth?:{username,password}, mapItem?:Function, log?:object }} cfg
 */
export function createAdyenWebhookHandler({ kernel, hmacKey, basicAuth, mapItem = defaultAdyenMapItem, maxBytes = 1_000_000, maxItems = 100, log = console } = {}) {
  if (!kernel || typeof kernel.onPaymentWebhook !== 'function') throw new Error('createAdyenWebhookHandler requires a kernel with onPaymentWebhook()');
  // Codex P1: validate the key at BOOT — refuse to start on a malformed/short hex key (which Buffer.from would
  // silently truncate into brute-forceable material).
  if (!adyenKeyBytes(hmacKey)) throw new Error('createAdyenWebhookHandler requires a valid 32-byte hex hmacKey');
  // Require BOTH fields non-empty when basicAuth is configured (Codex round-4: a `user:` / `:pass` half-config
  // is almost certainly a misconfiguration on a money-path auth gate).
  const requireBasic = Boolean(basicAuth);
  if (requireBasic && !(nonEmpty(basicAuth.username) && nonEmpty(basicAuth.password))) {
    throw new Error('createAdyenWebhookHandler basicAuth requires a non-empty username AND password');
  }
  return async function handleAdyenWebhook({ headers = {}, rawBody = '' } = {}) {
    // Basic Auth gate FIRST (cheap, before any body read/HMAC) — rejects unauthenticated callers outright.
    if (requireBasic && !verifyBasicAuth(getHeader(headers, 'authorization'), basicAuth.username, basicAuth.password)) {
      log.warn?.('adyen_webhook_rejected', { reason: 'bad_basic_auth' });
      return { status: 401, body: { error: 'unauthorized' } };
    }
    if (byteLen(rawBody) > maxBytes) return { status: 413, body: { error: 'payload_too_large' } }; // Codex P2: bound work (true bytes)
    let json;
    try { json = JSON.parse(rawString(rawBody)); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
    const items = Array.isArray(json?.notificationItems) ? json.notificationItems : null;
    if (!items || items.length === 0) return { status: 400, body: { error: 'no_notification_items' } };
    if (items.length > maxItems) return { status: 413, body: { error: 'too_many_items' } };

    // Codex P2: VERIFY EVERY item's HMAC FIRST (no side effects). Any bad/missing item → reject the whole
    // batch with NO kernel call — "one bad item rejects the batch, no partial trust".
    const verified = [];
    for (const wrapper of items) {
      const item = wrapper?.NotificationRequestItem;
      if (!item || !verifyAdyenHmac(item, hmacKey)) {
        log.warn?.('adyen_webhook_rejected', { reason: 'bad_hmac' });
        return { status: 401, body: { error: 'invalid_signature' } };
      }
      verified.push(item);
    }
    // MAP every verified item BEFORE any kernel call (Codex P2): if ANY item is unmappable, reject the whole
    // batch (400) with ZERO side effects — a later map-throw must not leave an earlier item already finalized.
    const events = [];
    for (const item of verified) {
      let evt;
      try { evt = mapItem(item); }
      catch (err) { log.error?.('adyen_webhook_map_error', { message: err?.message }); return { status: 400, body: { error: 'unmappable_event' } }; }
      events.push(evt);
    }
    // Only after the WHOLE batch is verified AND mapped do we drive the kernel (idempotent + correlated).
    const results = [];
    for (const evt of events) {
      if (!evt || !nonEmpty(evt.order_id)) { results.push({ ignored: true, reason: 'no_order_id' }); continue; }
      try { results.push(await kernel.onPaymentWebhook(evt)); }
      catch (err) { log.error?.('adyen_webhook_error', { message: err?.message }); return { status: 500, body: { error: 'processing_error' } }; }
    }
    // Adyen requires the literal '[accepted]' acknowledgement to stop retries.
    return { status: 200, body: '[accepted]', results };
  };
}

// ---- shared kernel drive (Stripe + the normalized handler shape) -----------------------------------------

async function driveKernel(kernel, rawBody, mapEvent, psp, log) {
  let json;
  try { json = JSON.parse(rawString(rawBody)); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
  let evt;
  try { evt = mapEvent(json); } catch (err) { log.error?.(`${psp}_webhook_map_error`, { message: err?.message }); return { status: 400, body: { error: 'unmappable_event' } }; }
  if (!evt || !nonEmpty(evt.order_id)) return { status: 400, body: { error: 'unmappable_event' } };
  try {
    const result = await kernel.onPaymentWebhook(evt);
    if (result?.reason === 'unknown_order') {
      log.warn?.(`${psp}_webhook_unknown_order`, { order_id: evt.order_id });
      return { status: 404, body: result }; // retryable — backend/order not visible yet, or wrong env
    }
    return { status: 200, body: result };
  } catch (err) {
    log.error?.(`${psp}_webhook_error`, { message: err?.message });
    return { status: 500, body: { error: 'processing_error' } };
  }
}
