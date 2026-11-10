'use strict';

/*
 * checkoutCancelUpstream.js — what pivota-backend's order cancel answered, as one of a few kinds
 * (FIX_PLAN C-11; backend `POST /agent/v2/orders/{order_id}/cancel`, services/checkout_cancel_upstream.py).
 *
 * WHY IT EXISTS. `cancel_checkout_session` used to flip only the gateway kernel's own row and answer
 * "canceled", while the hosted payment page the buyer already held stayed payable. Behind
 * CHECKOUT_CANCEL_UPSTREAM_ENABLED (default OFF) the kernel asks the backend instead, and answers what the
 * backend did (safety-kernel/src/protocol/canonicalExecutor.js `cancelSessionUpstream`).
 *
 * THE RULE: "canceled" only when the backend said `canceled: true`. Every answer it did not give in so many
 * words is `unavailable`, which the kernel reports as a retriable "not confirmed", never as canceled:
 *
 *   canceled          200, cancel.canceled === true, outcome "canceled"
 *   already_canceled  200, cancel.canceled === true, outcome "already_canceled"
 *   paid              409 ORDER_ALREADY_PAID: the buyer paid first; nothing was canceled
 *   processing        409 PAYMENT_PROCESSING: a payment is in flight at the PSP; nothing was canceled
 *   not_found         404 "Order not found" (unknown, or another agent's: one answer by design)
 *   unavailable       anything else: 503 CANCEL_NOT_CONFIRMED, a 404 with FastAPI's bare "Not Found" (the backend
 *                     flag is off, so the route does not exist), a timeout, a malformed body
 */

const CANCEL_KIND = Object.freeze({
  canceled: 'canceled',
  alreadyCanceled: 'already_canceled',
  paid: 'paid',
  processing: 'processing',
  notFound: 'not_found',
  unavailable: 'unavailable',
});

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * @param {number|null} status  the HTTP status the backend answered (null: no answer)
 * @param {any} body            its parsed JSON body
 * @returns {{ kind: string }}
 */
function classifyUpstreamCancel(status, body) {
  const code = Number(status);
  if (code === 200 && isPlainObject(body) && isPlainObject(body.cancel) && body.cancel.canceled === true) {
    if (body.cancel.outcome === 'canceled') return { kind: CANCEL_KIND.canceled };
    if (body.cancel.outcome === 'already_canceled') return { kind: CANCEL_KIND.alreadyCanceled };
    return { kind: CANCEL_KIND.unavailable };
  }
  const detail = isPlainObject(body) ? body.detail : undefined;
  if (code === 409 && isPlainObject(detail) && detail.canceled === false) {
    if (detail.error === 'ORDER_ALREADY_PAID') return { kind: CANCEL_KIND.paid };
    if (detail.error === 'PAYMENT_PROCESSING') return { kind: CANCEL_KIND.processing };
  }
  if (code === 404 && detail === 'Order not found') return { kind: CANCEL_KIND.notFound };
  return { kind: CANCEL_KIND.unavailable };
}

function isCheckoutCancelUpstreamEnabled(env = process.env) {
  const normalized = String(env.CHECKOUT_CANCEL_UPSTREAM_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(normalized);
}

module.exports = {
  CANCEL_KIND,
  classifyUpstreamCancel,
  isCheckoutCancelUpstreamEnabled,
};
