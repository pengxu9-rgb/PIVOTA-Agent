// C4 — Shared error taxonomy + recovery hints.
// Imported by the Safety Kernel (track C) AND every platform adapter (track X)
// so the codes/recovery are identical across Claude/ChatGPT/Gemini surfaces.
// Mirrors §5 of docs/agent-checkout/safety-kernel-contract.md.

/** @typedef {'QUOTE_REQUIRED'|'QUOTE_NOT_FOUND'|'QUOTE_EXPIRED'|'QUOTE_ALREADY_USED'|'PRICE_CHANGED'|'OUT_OF_STOCK'|'CONFIRMATION_REQUIRED'|'CONFIRMATION_INVALID'|'IDEMPOTENCY_CONFLICT'|'IDEMPOTENT_REPLAY'|'PAYMENT_REQUIRES_ACTION'|'MERCHANT_UNAVAILABLE'|'UPSTREAM_REJECTED'|'USER_AUTH_REQUIRED'|'STATE_LINKAGE_MISMATCH'|'OPERATION_NOT_ALLOWED'} PivotaErrorCode */

/**
 * code -> { retriable, userMessage, recovery }
 * - retriable: may the SAME request be re-sent (always via the same idempotency_key)?
 * - recovery: what the adapter should drive next.
 */
export const ERROR_CATALOG = Object.freeze({
  QUOTE_REQUIRED:         { retriable: false, recovery: 'call pivota_quote first',                 userMessage: 'I need a fresh price quote before placing this order.' },
  QUOTE_NOT_FOUND:        { retriable: false, recovery: 're-quote',                                 userMessage: 'That quote is no longer available. Let me get a new price.' },
  QUOTE_EXPIRED:          { retriable: false, recovery: 're-quote, re-confirm',                     userMessage: 'The price quote expired. Let me refresh it.' },
  QUOTE_ALREADY_USED:     { retriable: false, recovery: 're-quote for a new order',                 userMessage: 'This checkout was already completed. Let me start a fresh order.' },
  PRICE_CHANGED:          { retriable: false, recovery: 'show new quote, re-confirm',               userMessage: 'The price changed since you confirmed. Here is the updated total.' },
  OUT_OF_STOCK:           { retriable: false, recovery: 're-quote remaining items',                 userMessage: 'An item just went out of stock. Let me re-quote what is available.' },
  CONFIRMATION_REQUIRED:  { retriable: false, recovery: 'render confirmation card',                 userMessage: 'Please confirm the order details to continue.' },
  CONFIRMATION_INVALID:   { retriable: false, recovery: 're-confirm',                               userMessage: 'That confirmation is no longer valid. Please confirm again.' },
  IDEMPOTENCY_CONFLICT:   { retriable: false, recovery: 'use a new idempotency_key for a new request', userMessage: 'This looks like a different request reusing an old reference. Starting fresh.' },
  IDEMPOTENT_REPLAY:      { retriable: false, recovery: 'return original result',                   userMessage: 'This order was already placed — here are the details.' },
  PAYMENT_REQUIRES_ACTION:{ retriable: false, recovery: 'surface redirect/qr/instructions verbatim', userMessage: 'One more step is needed to complete payment.' },
  MERCHANT_UNAVAILABLE:   { retriable: true,  recovery: 'no silent fallback (rail rule); inform user', userMessage: 'The merchant is temporarily unreachable. Please try again shortly.' },
  // The upstream merchant service REJECTED the request (a 4xx that is not a known quote/stock/auth case —
  // e.g. a missing/invalid field). Distinct from MERCHANT_UNAVAILABLE: NOT retriable as-sent (a blind retry
  // with the same body fails the same way), and NOT a merchant outage. The specific reason is logged
  // server-side (never surfaced verbatim — may carry merchant-internal validation text).
  UPSTREAM_REJECTED:      { retriable: false, recovery: 'inspect server logs for the upstream reason; correct the request fields; retry with a new idempotency_key', userMessage: 'The merchant could not process this checkout request as sent. Please review the order details and try again.' },
  USER_AUTH_REQUIRED:     { retriable: false, recovery: 'trigger OAuth',                            userMessage: 'Please sign in so I can place this order on your behalf.' },
  STATE_LINKAGE_MISMATCH: { retriable: false, recovery: 're-quote in this session',                userMessage: 'Something about this session does not line up. Let me start the order over.' },
  OPERATION_NOT_ALLOWED:  { retriable: false, recovery: 'use the correct tool for this operation',  userMessage: 'That action is not available here.' },
});

export class PivotaCommerceError extends Error {
  /** @param {PivotaErrorCode} code @param {object} [detail] */
  constructor(code, detail = {}) {
    const entry = ERROR_CATALOG[code];
    if (!entry) throw new Error(`Unknown PivotaErrorCode: ${code}`);
    super(detail.message || entry.userMessage);
    this.name = 'PivotaCommerceError';
    this.code = code;
    this.retriable = entry.retriable;
    this.recovery = entry.recovery;
    this.userMessage = entry.userMessage;
    this.detail = detail; // NOTE: callers must not put sensitive payment data here (see redact.js)
  }

  /** Stable wire shape for adapters to translate into channel-native errors. */
  toResult() {
    return { ok: false, error: { code: this.code, retriable: this.retriable, recovery: this.recovery, message: this.userMessage } };
  }
}

export function isPivotaErrorCode(x) {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, x);
}
