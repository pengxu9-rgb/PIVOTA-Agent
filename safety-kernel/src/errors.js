// C4 — Shared error taxonomy + recovery hints.
// Imported by the Safety Kernel (track C) AND every platform adapter (track X)
// so the codes/recovery are identical across Claude/ChatGPT/Gemini surfaces.
// Mirrors §5 of docs/agent-checkout/safety-kernel-contract.md.

/** @typedef {'QUOTE_REQUIRED'|'QUOTE_NOT_FOUND'|'QUOTE_EXPIRED'|'QUOTE_ALREADY_USED'|'PRICE_CHANGED'|'OUT_OF_STOCK'|'CONFIRMATION_REQUIRED'|'CONFIRMATION_INVALID'|'IDEMPOTENCY_CONFLICT'|'IDEMPOTENT_REPLAY'|'PAYMENT_REQUIRES_ACTION'|'MERCHANT_UNAVAILABLE'|'NO_MERCHANT_OFFER'|'UNKNOWN_PRODUCT_ID'|'USER_AUTH_REQUIRED'|'STATE_LINKAGE_MISMATCH'|'OPERATION_NOT_ALLOWED'} PivotaErrorCode */

/**
 * code -> { retriable, userMessage, recovery }
 * - retriable: may the SAME request be re-sent (always via the same idempotency_key)?
 * - recovery: what the adapter should drive next.
 */
export const ERROR_CATALOG = Object.freeze({
  QUOTE_REQUIRED:         { retriable: false, recovery: 'call pivota_quote first',                 userMessage: 'I need a fresh price quote before placing this order.' },
  QUOTE_NOT_FOUND:        { retriable: false, recovery: 're-quote',                                 userMessage: 'That quote is no longer available. Let me get a new price.' },
  QUOTE_EXPIRED:          { retriable: false, recovery: 're-quote, re-confirm',                     userMessage: 'The price quote expired. Let me refresh it.' },
  // Fires when a locked quote has already been turned into an ORDER (INV-1 single-use) — which is NOT the
  // same as "paid". The order may be unpaid (a post-create failure, an abandoned charge), so claiming the
  // checkout "was already completed" told buyers money had moved when it had not. Say what is actually
  // true: the session is spent and a fresh quote is needed.
  QUOTE_ALREADY_USED:     { retriable: false, recovery: 're-quote for a new order',                 userMessage: 'This checkout session was already used to place an order, so it can\'t be used again. Let me start a fresh order.' },
  PRICE_CHANGED:          { retriable: false, recovery: 'show new quote, re-confirm',               userMessage: 'The price changed since you confirmed. Here is the updated total.' },
  OUT_OF_STOCK:           { retriable: false, recovery: 're-quote remaining items',                 userMessage: 'An item just went out of stock. Let me re-quote what is available.' },
  CONFIRMATION_REQUIRED:  { retriable: false, recovery: 'render confirmation card',                 userMessage: 'Please confirm the order details to continue.' },
  CONFIRMATION_INVALID:   { retriable: false, recovery: 're-confirm',                               userMessage: 'That confirmation is no longer valid. Please confirm again.' },
  IDEMPOTENCY_CONFLICT:   { retriable: false, recovery: 'use a new idempotency_key for a new request', userMessage: 'This looks like a different request reusing an old reference. Starting fresh.' },
  IDEMPOTENT_REPLAY:      { retriable: false, recovery: 'return original result',                   userMessage: 'This order was already placed — here are the details.' },
  PAYMENT_REQUIRES_ACTION:{ retriable: false, recovery: 'surface redirect/qr/instructions verbatim', userMessage: 'One more step is needed to complete payment.' },
  MERCHANT_UNAVAILABLE:   { retriable: true,  recovery: 'no silent fallback (rail rule); inform user', userMessage: 'The merchant is temporarily unreachable. Please try again shortly.' },
  // A PERSISTENT data condition, deliberately distinct from MERCHANT_UNAVAILABLE. The product identity is
  // real (it is in the catalog and search can return it) but nothing backs it with servable detail — no
  // acceptable merchant offer / seed answers its content route. That does not heal on its own: it changes
  // only when an offer is attached. Collapsing it into MERCHANT_UNAVAILABLE (retriable, "try again shortly")
  // told every chaining agent to retry forever and told operators to go hunting for an outage that was not
  // happening. retriable:false is the load-bearing bit — see docs/public_read_chain_contract.md.
  NO_MERCHANT_OFFER:      { retriable: false, recovery: 'do not retry; treat as unavailable and offer alternatives', userMessage: 'This product has no purchasable merchant offer attached, so no detail is available. This will not change on retry.' },
  // The OTHER half of the retry trap, and deliberately not folded into NO_MERCHANT_OFFER. There, the identity
  // is real and only the offer is missing. Here the id resolves to NOTHING — a hallucinated or stale
  // `sig_…`, or a non-signature id like `rejuran:…` that the unscoped detail lane cannot route at all. Both
  // are terminal, but they are different facts and they meter differently: NO_MERCHANT_OFFER is a
  // catalog-COVERAGE signal (we advertised an id with nothing behind it) and folding garbage ids into it
  // would pollute exactly the metric #1829 created to find real gaps. Measured on prod 2026-07-27: both
  // shapes returned MERCHANT_UNAVAILABLE / retriable:true — "try again shortly" for an id that will never
  // resolve. retriable:false is the load-bearing bit; the honest message is the rest of it.
  UNKNOWN_PRODUCT_ID:     { retriable: false, recovery: 'do not retry; re-run search to obtain a valid product_id', userMessage: 'No product matches that id. Retrying will not change this — search again to get a valid product_id.' },
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
