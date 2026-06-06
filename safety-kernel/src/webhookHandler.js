// Payment webhook handler — the HTTP boundary that receives PSP/backend payment-completion webhooks,
// VERIFIES the signature, and drives kernel.onPaymentWebhook. Without this, async charges
// (processing/requires_action) never reach a terminal state and every order is stuck charge_pending.
//
// SECURITY: the signature MUST be verified over the RAW request body (not the parsed JSON) using a
// shared webhook secret, in constant time. An unverified or mis-signed event is rejected (401) and the
// kernel is NEVER called — otherwise a forged webhook could mark an order paid. (The kernel itself
// trusts that whatever calls onPaymentWebhook has verified the event; this handler is that gate.)
//
// Wiring (in the gateway):
//   const onWebhook = createPaymentWebhookHandler({ kernel, secret: process.env.PAYMENT_WEBHOOK_SECRET, parseEvent });
//   app.post('/agent/shop/v1/payment-webhook', rawBodyParser, async (req, res) => {
//     const out = await onWebhook({ headers: req.headers, rawBody: req.rawBody });
//     res.status(out.status).json(out.body);
//   });

import { createHmac, timingSafeEqual } from 'node:crypto';
import { redact } from './redact.js';

const DEFAULT_SIGNATURE_HEADER = 'x-pivota-webhook-signature';

/**
 * Constant-time HMAC-SHA256 verification over the raw body.
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, provided, secret, { encoding = 'base64' } = {}) {
  if (!secret || typeof provided !== 'string' || provided === '') return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? '', 'utf8');
  const expected = createHmac('sha256', secret).update(body).digest(encoding);
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Default event parser: the body is JSON with { order_id, status, payment_id } (or nested under
 * `data`/`object`). Override via opts.parseEvent for a specific PSP payload shape. Returns the
 * canonical { order_id, status, payment_id } or null if it can't be extracted.
 */
function defaultParseEvent(json) {
  const o = json?.data?.object ?? json?.data ?? json?.object ?? json ?? {};
  const order_id = o.order_id ?? o.orderId ?? o.metadata?.order_id ?? json?.order_id;
  const status = o.status ?? o.payment_status ?? json?.status;
  const payment_id = o.payment_id ?? o.payment_intent_id ?? o.checkout_session_id ?? o.id ?? json?.payment_id;
  if (!order_id) return null;
  return { order_id, status, payment_id };
}

/**
 * @param {{ kernel: { onPaymentWebhook: Function }, secret: string,
 *           signatureHeader?: string, encoding?: string,
 *           parseEvent?: (json:object) => ({order_id,status,payment_id}|null),
 *           log?: object }} deps
 * @returns {(req: { headers: object, rawBody: string|Buffer }) => Promise<{status:number, body:object}>}
 */
export function createPaymentWebhookHandler({ kernel, secret, signatureHeader = DEFAULT_SIGNATURE_HEADER, encoding = 'base64', parseEvent = defaultParseEvent, log = console } = {}) {
  if (!kernel || typeof kernel.onPaymentWebhook !== 'function') {
    throw new Error('createPaymentWebhookHandler requires a kernel with onPaymentWebhook()');
  }
  if (!secret || secret.length < 16) {
    throw new Error('createPaymentWebhookHandler requires a strong webhook secret');
  }

  return async function handlePaymentWebhook({ headers = {}, rawBody = '' } = {}) {
    // 1) Verify signature over the RAW body BEFORE parsing/trusting anything.
    const provided = getHeader(headers, signatureHeader);
    if (!verifyWebhookSignature(rawBody, provided, secret, { encoding })) {
      log.warn?.('payment_webhook_rejected', { reason: 'bad_signature' });
      return { status: 401, body: { error: 'invalid_signature' } };
    }

    // 2) Parse the (now-trusted) body.
    let json;
    try {
      json = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
    } catch {
      return { status: 400, body: { error: 'invalid_json' } };
    }
    const event = parseEvent(json);
    if (!event || !event.order_id) {
      return { status: 400, body: { error: 'unparseable_event' } };
    }

    // 3) Drive the kernel state machine (idempotent + attempt-correlated inside the kernel).
    try {
      const result = await kernel.onPaymentWebhook(event);
      // Codex P2-2: an unknown order after a VALID signature is operationally suspicious — usually the
      // order isn't durably visible yet (replication lag) or the route is pointed at the wrong DB.
      // Return a RETRYABLE 404 (so the PSP retries and finds it once visible) and alert, rather than a
      // silent 200 that stops retries and hides the misconfig.
      if (result?.reason === 'unknown_order') {
        log.warn?.('payment_webhook_unknown_order', redact({ order_id: event.order_id }));
        return { status: 404, body: result };
      }
      log.info?.('payment_webhook', redact({ order_id: event.order_id, result }));
      // 200 for transitioned/idempotent/ignored — accepted + processed; tell the PSP not to retry.
      return { status: 200, body: result };
    } catch (err) {
      // A kernel/store error: 500 so the PSP retries later (the kernel transitions are idempotent).
      log.error?.('payment_webhook_error', redact({ order_id: event.order_id, message: err?.message }));
      return { status: 500, body: { error: 'processing_error' } };
    }
  };
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}
