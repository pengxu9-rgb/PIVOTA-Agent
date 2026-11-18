// C4 — Shared error taxonomy + recovery hints.
// Imported by the Safety Kernel (track C) AND every platform adapter (track X)
// so the codes/recovery are identical across Claude/ChatGPT/Gemini surfaces.
// Mirrors §5 of docs/agent-checkout/safety-kernel-contract.md.

/** @typedef {'QUOTE_REQUIRED'|'QUOTE_NOT_FOUND'|'QUOTE_EXPIRED'|'QUOTE_ALREADY_USED'|'PRICE_CHANGED'|'OUT_OF_STOCK'|'CONFIRMATION_REQUIRED'|'CONFIRMATION_INVALID'|'IDEMPOTENCY_CONFLICT'|'IDEMPOTENT_REPLAY'|'PAYMENT_REQUIRES_ACTION'|'MERCHANT_UNAVAILABLE'|'NO_MERCHANT_OFFER'|'UNKNOWN_PRODUCT_ID'|'PRODUCT_NOT_SERVABLE'|'PRODUCT_GROUP_ID_NOT_PRODUCT_ID'|'MERCHANT_PRODUCT_MISMATCH'|'USER_AUTH_REQUIRED'|'STATE_LINKAGE_MISMATCH'|'OPERATION_NOT_ALLOWED'|'CHECKOUT_OUTCOME_UNKNOWN'|'CHECKOUT_ATTEMPT_RETIRED'|'PARTNER_ASSERTION_REJECTED'|'ORDER_CANCELED'|'MERCHANT_NOT_ACCEPTING_ORDERS'} PivotaErrorCode */

/**
 * code -> { retriable, userMessage, recovery, claimsNoEffect? }
 * - retriable: may the SAME request be re-sent (always via the same idempotency_key)?
 * - recovery: what the adapter should drive next.
 * - claimsNoEffect: the words say the request had no effect ("nothing was done", "nothing was ordered", "without
 *   creating a purchase"). An order call answered with such a code is answered as raised ONLY on the quote-claim release
 *   rule's proof that it came before any order write (kernel.js createOrder, upstreamRefusal.js); otherwise it is the
 *   kernel's unknown outcome. safety-kernel/test/noEffectWordsGated.test.js scans these words and fails on an unflagged
 *   one.
 */
export const ERROR_CATALOG = Object.freeze({
  QUOTE_REQUIRED:         { retriable: false, recovery: 'call pivota_quote first',                 userMessage: 'I need a fresh price quote before placing this order.' },
  // The quote-stage codes below can also answer a call after an order exists (a payment step's amount echo, an order
  // call's refusal), so their recoveries ask for a new quote only when no order was placed, and say what to read if one
  // may have been. Never a bare "re-quote", which an agent obeys by placing a second order.
  QUOTE_NOT_FOUND:        { retriable: false, recovery: 'get a new quote only if there is no order for this purchase yet; if there may be one, read it (get_order) first', userMessage: 'That quote is no longer available. Let me get a new price.' },
  QUOTE_EXPIRED:          { retriable: false, recovery: 'get a new quote and confirm it again only if there is no order for this purchase yet; if there may be one, read it (get_order) first', userMessage: 'The price quote expired. Let me refresh it.' },
  // Fires when a locked quote has already been turned into an ORDER (INV-1 single-use) — which is NOT the
  // same as "paid". The order may be unpaid (a post-create failure, an abandoned charge), so claiming the
  // checkout "was already completed" told buyers money had moved when it had not. Say what is actually
  // true: the session is spent and a fresh quote is needed.
  QUOTE_ALREADY_USED:     { retriable: false, recovery: 'read the order this session already placed (get_order) before anything else; re-quote only for a new order the buyer asked for',                 userMessage: 'This checkout session was already used to place an order, so it can\'t be used again. Read that order first (get_order) before doing anything else; start a new checkout only if the buyer wants another order.' },
  PRICE_CHANGED:          { retriable: false, recovery: 'show the buyer the new price and confirm again before going on; if an order was already placed for this purchase, read it (get_order) instead of starting another', userMessage: 'The price changed since you confirmed. Here is the updated total.' },
  OUT_OF_STOCK:           { retriable: false, recovery: 'get a new quote for the items still available only if there is no order for this purchase yet; if there may be one, read it (get_order) first', userMessage: 'An item just went out of stock. A new quote for what is still available is needed, unless an order was already placed for this purchase.' },
  CONFIRMATION_REQUIRED:  { retriable: false, recovery: 'render confirmation card',                 userMessage: 'Please confirm the order details to continue.' },
  CONFIRMATION_INVALID:   { retriable: false, recovery: 're-confirm',                               userMessage: 'That confirmation is no longer valid. Please confirm again.' },
  // The words every IDEMPOTENCY_CONFLICT without its own (IDEMPOTENCY_CONFLICT_ANSWERS below) is given: a key that is
  // missing or too short, or one an earlier request with other details used. True of each; never "start again", which an
  // agent obeys by opening a second checkout while the first may have placed an order.
  IDEMPOTENCY_CONFLICT:   { retriable: false, recovery: 'send this request with an idempotency_key of its own; reuse a key only to resend the exact request it was first sent with; if an earlier request used this key, read the checkout session or its order before anything else', userMessage: 'This idempotency_key cannot be used for this request: it is missing or too short, or an earlier request with other details already used it. If an earlier request used this key, read the checkout session or its order before anything else, and do not start another checkout for this purchase without the buyer.' },
  IDEMPOTENT_REPLAY:      { retriable: false, recovery: 'return original result',                   userMessage: 'This order was already placed — here are the details.' },
  PAYMENT_REQUIRES_ACTION:{ retriable: false, recovery: 'surface redirect/qr/instructions verbatim', userMessage: 'One more step is needed to complete payment.' },
  CHECKOUT_ATTEMPT_RETIRED: { retriable: false, claimsNoEffect: true, recovery: 'the original attempt is permanently closed; explicitly start a new checkout with a fresh idempotency_key', userMessage: 'The earlier attempt was closed without creating a purchase. You can start a new checkout.' },
  CHECKOUT_OUTCOME_UNKNOWN: { retriable: true, recovery: 'retry only the exact request with the same idempotency_key; do not open another checkout', userMessage: 'The checkout request may have been accepted. Its outcome is unknown. Keep the same request and reference when checking again; do not start another purchase.' },
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
  // PARTNER DOOR, ONE PRODUCT ID (PARTNER_DOOR_ONE_PRODUCT_ID; thrown by the `/mcp` door only, and never while
  // the flag is off). Three read outcomes that door used to report as NO_MERCHANT_OFFER or UNKNOWN_PRODUCT_ID.
  // The id IS a product, and a serving gate withholds it: `detail.reason` carries the gate's own reason code.
  PRODUCT_NOT_SERVABLE:   { retriable: false, recovery: 'do not retry; the product exists but is withheld from serving (detail.reason); offer alternatives', userMessage: 'This product id is known, but the product is not servable right now (see detail.reason). This will not change on retry.' },
  // The id is an identity GROUP id (`sig_` + 24 hex), not a product id (`sig_` + 32 hex). Same prefix, another
  // namespace: it is refused by name instead of being answered as a product with no offer.
  PRODUCT_GROUP_ID_NOT_PRODUCT_ID: { retriable: false, recovery: 'do not retry; pass the product_id of a search_catalog row (sig_ + 32 hex), not a group id', userMessage: 'That id is a product group id, not a product id. Pass the product_id from a search_catalog row instead. This will not change on retry.' },
  // The seller named beside the product id is not the product's seller. Refused rather than dropped, so one
  // seller's row is never served under another seller's name.
  MERCHANT_PRODUCT_MISMATCH: { retriable: false, recovery: 'do not retry as sent; omit merchant_id, or pass the merchant_id returned with this product', userMessage: 'The merchant_id does not match this product\'s seller. Omit merchant_id, or pass the merchant_id returned with the product. This will not change on retry.' },
  USER_AUTH_REQUIRED:     { retriable: false, recovery: 'trigger OAuth',                            userMessage: 'Please sign in so I can place this order on your behalf.' },
  // Another user, another session or another agent than the one a checkout or order belongs to (kernel._requireOrder,
  // the quote registry, the ACP session record). The SAME words for every one of them, with no id and no state, so a
  // stranger learns nothing; and true for the order's own buyer in another conversation, whose order may exist and may be
  // charged: read it where it was started, never "start the order over".
  STATE_LINKAGE_MISMATCH: { retriable: false, recovery: 'read it from the session or agent that started it; do not start another order for this purchase without the buyer', userMessage: 'This checkout or order cannot be continued from this session or agent. If it was started in another conversation, an order may exist there and its payment outcome may not be known here: read it from the conversation that started it, and do not start another order for this purchase without the buyer.' },
  OPERATION_NOT_ALLOWED:  { retriable: false, recovery: 'use the correct tool for this operation',  userMessage: 'That action is not available here.' },
  // FIX_PLAN O-04: the backend refused the gateway's request-bound partner assertion (409
  // PARTNER_ASSERTION_REJECTED) BEFORE the route ran, so nothing was written. That is a fault between our own
  // two services (a clock, a path rewrite, a stale secret), not a merchant outage, and re-sending the same call
  // meets the same refusal. As MERCHANT_UNAVAILABLE (retriable, "try again shortly") every chaining agent would
  // retry forever. retriable:false is the load-bearing bit; the gateway logs and counts each one.
  PARTNER_ASSERTION_REJECTED: { retriable: false, claimsNoEffect: true, recovery: 'do not retry this call; nothing was written; report it to Pivota', userMessage: 'Pivota could not confirm the account this request was made for, so nothing was done. Retrying the same call will not change this.' },
  // FIX_PLAN C-11: the backend refused to open (or keep) a payment surface for an order that was canceled (409
  // ORDER_CANCELED from POST /agent/v1/payments, sent only with its CHECKOUT_CANCEL_UPSTREAM_ENABLED on). Terminal:
  // a canceled order never becomes payable again, so as MERCHANT_UNAVAILABLE (retriable) an agent would keep
  // retrying a charge that is refused every time. retriable:false is the load-bearing bit.
  ORDER_CANCELED:         { retriable: false, recovery: 'do not retry; this order was canceled; if the buyer still wants the item, start a new checkout', userMessage: 'This order was canceled, so it can no longer be paid. Retrying will not change this.' },
  // The seller's store refused the order call because it is not taking orders (the backend's 403
  // MERCHANT_NOT_ACCEPTING_ORDERS, named by its order route). Raised ONLY when that answer is one the quote-claim release
  // rule proves came before any order write (safety-kernel/src/upstreamRefusal.js); otherwise the same answer is the
  // kernel's unknown outcome. So "nothing was ordered" is said only when it is shown. Terminal for this checkout.
  MERCHANT_NOT_ACCEPTING_ORDERS: { retriable: false, claimsNoEffect: true, recovery: 'do not retry this checkout; nothing was ordered; offer the buyer another seller', userMessage: 'This seller is not taking orders, so nothing was ordered and nothing was charged. Retrying this checkout will not change that: offer the buyer another seller.' },
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

/**
 * A KEY THAT CANNOT RUN THIS REQUEST NOW, FOR A REASON THE KERNEL KNOWS: its own words, on every door (the curated
 * `acp_message` / `acp_detail` opt-in every door reads; invoke names these reasons in contractValidation.js). The code
 * stays IDEMPOTENCY_CONFLICT. Each is true where it is raised, and none tells the caller to begin again:
 *   - `in_flight`             an attempt with this key holds it and has not finished (idempotencyLedger.js);
 *   - `race`                  an attempt with this key held it a moment ago and no longer does (idempotencyLedger.js);
 *   - `lease_lost_after_op`   this attempt ran, but another took its key over before it finished (idempotencyLedger.js);
 *   - `ambiguous_prior_attempt`  an earlier attempt with this key made an irreversible call and then failed;
 *   - `charge_in_progress`    another request holds this order's payment lock (kernel.js submitPayment, before the order
 *                             is read, so no order id is given);
 *   - `charge_pending`        this order's payment was already asked for and has no known outcome yet (the caller's own
 *                             order: the id is given);
 *   - `order_already_paid`    this order is paid (the caller's own order: the id is given).
 */
export const IDEMPOTENCY_CONFLICT_ANSWERS = Object.freeze({
  in_flight: Object.freeze({
    message: 'An attempt with this idempotency_key is still running, and its outcome is not known yet. Read the checkout session or its order before anything else, and do not start another checkout for this purchase without the buyer.',
    recovery: 'read the checkout session or its order before anything else; do not start another checkout for this purchase without the buyer; do not reuse this idempotency_key for a new request',
  }),
  race: Object.freeze({
    message: 'An attempt with this idempotency_key was running a moment ago, and its outcome is not known here. Read the checkout session or its order before anything else, and do not start another checkout for this purchase without the buyer.',
    recovery: 'read the checkout session or its order before anything else; do not start another checkout for this purchase without the buyer; do not reuse this idempotency_key for a new request',
  }),
  lease_lost_after_op: Object.freeze({
    message: 'This attempt ran, but another attempt with the same idempotency_key took it over before this one finished, so its outcome is not known here. Read the checkout session or its order before anything else, and do not start another checkout for this purchase without the buyer.',
    recovery: 'read the checkout session or its order before anything else; do not start another checkout for this purchase without the buyer; do not reuse this idempotency_key for a new request',
  }),
  ambiguous_prior_attempt: Object.freeze({
    message: 'An earlier attempt with this idempotency_key may have taken effect, and its outcome is not known here. Read the checkout session or its order before anything else, and do not start another checkout for this purchase without the buyer.',
    recovery: 'read the checkout session or its order before anything else; do not start another checkout for this purchase without the buyer; do not reuse this idempotency_key for a new request',
  }),
  charge_in_progress: Object.freeze({
    message: 'Another request is paying for this order right now, and its outcome is not known yet. Read the order with get_order before anything else, and do not pay for it again or start another checkout for this purchase without the buyer.',
    recovery: 'read the order with get_order before anything else; do not pay for it again or start another checkout for this purchase without the buyer',
  }),
  charge_pending: Object.freeze({
    message: 'The payment for this order (detail.order_id) was already asked for, and its outcome is not known yet. Read that order with get_order before anything else, and do not pay for it again or start another checkout for this purchase without the buyer.',
    recovery: 'read the order in detail.order_id with get_order before anything else; do not pay for it again or start another checkout for this purchase without the buyer',
  }),
  order_already_paid: Object.freeze({
    message: 'This order (detail.order_id) is already paid. Read it with get_order; do not pay for it again.',
    recovery: 'read the order in detail.order_id with get_order; do not pay for it again',
  }),
});
// The reasons whose answer names the caller's own order (detail.order_id).
const IDEMPOTENCY_CONFLICT_NAMES_ORDER = new Set(['charge_pending', 'order_already_paid']);

/**
 * The IDEMPOTENCY_CONFLICT for `reason` (a key of IDEMPOTENCY_CONFLICT_ANSWERS), in its own words. `order_id` is surfaced
 * only for a reason whose answer names it, and only when the caller passes it as its own (`ownedOrderId`); every other
 * member stays in the detail, as before, for logs.
 */
export function idempotencyConflict(reason, detail = {}, { ownedOrderId } = {}) {
  const words = IDEMPOTENCY_CONFLICT_ANSWERS[reason];
  if (!words) throw new Error(`Unknown idempotency conflict reason: ${reason}`);
  const orderId = IDEMPOTENCY_CONFLICT_NAMES_ORDER.has(reason) && typeof ownedOrderId === 'string' && ownedOrderId.trim() !== '' ? ownedOrderId : null;
  if (IDEMPOTENCY_CONFLICT_NAMES_ORDER.has(reason) && !orderId) throw new Error(`An idempotency conflict for ${reason} names the caller's own order`);
  return new PivotaCommerceError('IDEMPOTENCY_CONFLICT', {
    ...detail,
    reason,
    acp_message: words.message,
    acp_detail: orderId ? { reason, order_id: orderId } : { reason },
  });
}

/**
 * THE KERNEL'S OWN "OUTCOME UNKNOWN" ANSWERS. A money call was made and no readable answer came back, so nobody here
 * can say whether it did what it was asked:
 *   - `payment_outcome_unknown_after_order`       the order exists (its id is known) and its payment step was asked
 *                                                 for: no answer, a 5xx, or a 2xx that names neither a payment status
 *                                                 nor a payment page;
 *   - `payment_link_outcome_unknown_after_order`  the order exists and its payment page was asked for: no answer, a
 *                                                 5xx, or a 2xx that names no page;
 *   - `order_create_outcome_unknown`              the order was asked for and no readable answer came back (no answer,
 *                                                 a 5xx, a 2xx that is not an order): an order may exist, and its id is
 *                                                 not known here.
 * Same code as every other door's unknown outcome (CHECKOUT_OUTCOME_UNKNOWN), but NOT retriable: re-sending the same
 * call with the same key returns this same answer (the ledger keeps it), so the way on is to read the order, never to
 * send again or to open another checkout.
 */
export const KERNEL_OUTCOME_UNKNOWN_REASONS = Object.freeze({
  payment: 'payment_outcome_unknown_after_order',
  paymentLink: 'payment_link_outcome_unknown_after_order',
  orderCreate: 'order_create_outcome_unknown',
  // An after-sales request (a refund) on an order, refused by the order service in words that would say it had no
  // effect, without the proof that it came before any write: whether it was filed is not known.
  afterSales: 'after_sales_outcome_unknown',
});
const KERNEL_OUTCOME_UNKNOWN_REASON_SET = new Set(Object.values(KERNEL_OUTCOME_UNKNOWN_REASONS));

/**
 * AN ORDER CALL THE ORDER SERVICE DID ANSWER, WITH A REFUSAL THAT KEEPS THE QUOTE'S CLAIM. Still an unknown outcome (the claim is
 * kept, and nothing here can show that no order exists for this checkout), but not one with "no readable answer": the
 * words say what the store did answer. Only on `order_create_outcome_unknown` with no order id. Carried on the answer
 * as `answeredRefusal`, beside its detail and not in it (the ledger keeps it beside the reason as `answered`), and never
 * surfaced to a caller as a member: only the words change.
 *   - `refused`       any other status below 500 the store answered (400, 401, 403, 404, 409, 422 ...) that did not
 *                     give the claim back; a 408 (a deadline in front of the store) is not one;
 *   - `rate_limited`  a 429. The store can answer it to a second copy of a request it already accepted, before it looks
 *                     for that first copy's order, so an earlier attempt of this checkout may have placed one.
 */
export const KERNEL_ANSWERED_REFUSALS = Object.freeze({
  refused: Object.freeze({
    message: 'The order service refused this order request. This checkout cannot be retried, and an order for it may still exist: do not place a new order for this purchase without the buyer.',
    recovery: 'the order service refused this order request, and this checkout cannot be retried; an order for it may still exist: do not place a new order for this purchase without the buyer; re-sending the same call returns this same answer',
  }),
  rate_limited: Object.freeze({
    message: 'The order service refused this order request for rate limiting. An earlier attempt of this checkout may already have placed an order, so this checkout cannot be retried: do not place a new order for this purchase without the buyer.',
    recovery: 'the order service refused this order request for rate limiting, and an earlier attempt of this checkout may already have placed an order: do not place a new order for this purchase without the buyer; re-sending the same call returns this same answer',
  }),
});

/**
 * A CALL AFTER THE ORDER EXISTS (its payment step, its payment page, an after-sales request) that the order service
 * refused in words that would say it had no effect (errors.js claimsNoEffect: "nothing was done"). The order exists, so
 * "nothing was done" is never true of the tool call: it is the kernel's unknown outcome, with the order id, in these
 * words (`answered: 'refused'`), never "no readable answer".
 */
export const KERNEL_ANSWERED_AFTER_ORDER = Object.freeze({
  payment_outcome_unknown_after_order: Object.freeze({
    message: 'The order was created (detail.order_id), but whether its payment step went through is unknown: the order service refused that request in a way that cannot show what happened. Read that order with get_order before anything else, and do not start another checkout for this purchase. Sending this call again with the same idempotency_key returns this same answer.',
    recovery: 'read the order in detail.order_id with get_order before anything else; do not open another checkout for this purchase',
  }),
  payment_link_outcome_unknown_after_order: Object.freeze({
    message: 'The order was created (detail.order_id), but whether its payment page was opened is unknown: the order service refused that request in a way that cannot show what happened, so no link can be given. Read that order with get_order before anything else, and do not start another checkout for this purchase. Sending this call again with the same idempotency_key returns this same answer.',
    recovery: 'read the order in detail.order_id with get_order before anything else; do not open another checkout for this purchase',
  }),
  after_sales_outcome_unknown: Object.freeze({
    message: 'Whether this after-sales request was filed for the order (detail.order_id) is unknown: the order service refused it in a way that cannot show what happened. Send the same call again with the same idempotency_key; do not file another request for this order until it answers.',
    recovery: 'send the same call again with the same idempotency_key; do not file another after-sales request for this order until it answers',
  }),
});

/**
 * A CALL AFTER THE ORDER EXISTS THAT GOT NO READABLE ANSWER (no answer, a 5xx, a page from in front of the backend, a 2xx
 * with nothing in it): the words, with the order id. One source for the tool doors (mcp-server commerceToolSurface.js)
 * and invoke (contractValidation.js invokeErrorOf).
 */
export const KERNEL_NO_ANSWER_AFTER_ORDER = Object.freeze({
  payment_outcome_unknown_after_order: Object.freeze({
    message: 'The order was created (detail.order_id), but whether its payment step went through is unknown: the payment service gave no readable answer. Read that order with get_order before anything else, and do not start another checkout for this purchase. Sending this call again with the same idempotency_key returns this same answer.',
  }),
  payment_link_outcome_unknown_after_order: Object.freeze({
    message: 'The order was created (detail.order_id), but whether its payment page was opened is unknown: the payment service gave no readable answer, so no link can be given. Read that order with get_order before anything else, and do not start another checkout for this purchase. Sending this call again with the same idempotency_key returns this same answer.',
  }),
  after_sales_outcome_unknown: Object.freeze({ message: KERNEL_ANSWERED_AFTER_ORDER.after_sales_outcome_unknown.message }),
});

/** Is `answered` a refusal kind the kernel gives `reason` with this order id? */
function answeredFits(answered, reason, orderId) {
  if (reason === KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate) return orderId === null && Object.hasOwn(KERNEL_ANSWERED_REFUSALS, answered);
  return orderId !== null && answered === 'refused' && Object.hasOwn(KERNEL_ANSWERED_AFTER_ORDER, reason);
}

/**
 * The kernel's unknown-outcome answer for `reason` (one of KERNEL_OUTCOME_UNKNOWN_REASONS) and the order it is about.
 * `answered`: the order service answered with a refusal (KERNEL_ANSWERED_REFUSALS for the order call itself, with no
 * order id; `refused` for a call after the order exists, KERNEL_ANSWERED_AFTER_ORDER). `upstreamCode`: the refusal's own
 * code, kept beside the answer (never in its detail) so a door's observability still counts it by that code.
 */
export function kernelOutcomeUnknown(reason, orderId, { answered, upstreamCode } = {}) {
  if (!KERNEL_OUTCOME_UNKNOWN_REASON_SET.has(reason)) throw new Error(`Unknown kernel outcome-unknown reason: ${reason}`);
  const order_id = typeof orderId === 'string' && orderId.trim() !== '' ? orderId : null;
  if (answered !== undefined && answered !== null && !answeredFits(answered, reason, order_id)) {
    throw new Error(`Unknown kernel answered refusal: ${answered}`);
  }
  const refusal = !answered ? null
    : reason === KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate ? KERNEL_ANSWERED_REFUSALS[answered] : KERNEL_ANSWERED_AFTER_ORDER[reason];
  const err = new PivotaCommerceError('CHECKOUT_OUTCOME_UNKNOWN', { reason, order_id });
  err.retriable = false;
  if (typeof upstreamCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(upstreamCode)) {
    Object.defineProperty(err, 'upstreamRefusalCode', { value: upstreamCode, enumerable: false });
  }
  if (refusal) {
    // Beside the detail, never in it: the detail stays `{ reason, order_id }`, as every door and log reads it.
    Object.defineProperty(err, 'answeredRefusal', { value: answered, enumerable: false });
    err.message = refusal.message;
    err.userMessage = refusal.message;
    err.recovery = refusal.recovery;
    return err;
  }
  err.recovery = reason === KERNEL_OUTCOME_UNKNOWN_REASONS.afterSales ? KERNEL_ANSWERED_AFTER_ORDER.after_sales_outcome_unknown.recovery
    : order_id
      ? 'read the order in detail.order_id with get_order before anything else; do not open another checkout for this purchase'
      : 'the store may hold an order for this checkout, and its id is not known here: do not place a new order for this purchase without the buyer; re-sending the same call returns this same answer';
  return err;
}

/**
 * A CALL AFTER THE ORDER EXISTS FAILED: the answer to give. No readable answer, or a refusal whose words would say it
 * had no effect (claimsNoEffect; the order exists, so that is never true of the tool call), is the kernel's unknown
 * outcome for `reason` with the order id; anything else is answered as raised.
 */
export function answerAfterOrder(err, orderId, reason) {
  if (kernelOutcomeUnknownOf(err)) return err;
  if (claimsNoEffect(err)) return kernelOutcomeUnknown(reason, orderId, { answered: 'refused', upstreamCode: err.code });
  if (upstreamFailureOutcomeUnknown(err)) return kernelOutcomeUnknown(reason, orderId);
  return err;
}

/**
 * IS THE OUTCOME OF THIS FAILED UPSTREAM MONEY CALL UNKNOWN? True when no readable answer came back: the transport's
 * deadline mark, no response at all (`upstream_status` not a status), a 5xx, or an error that is not this taxonomy's
 * (a raw transport or adapter error). False for a refusal the upstream ANSWERED with a status below 500, and for every
 * refusal raised in this process before anything was sent (no `upstream_status` member: not the transport's).
 * The transport writes these members (src/server.js throwCommerceKernelUpstreamError).
 */
export function upstreamFailureOutcomeUnknown(err) {
  if (!(err instanceof PivotaCommerceError)) return true;
  const detail = err.detail && typeof err.detail === 'object' && !Array.isArray(err.detail) ? err.detail : {};
  if (detail.upstream_timeout === true) return true;
  if (!Object.hasOwn(detail, 'upstream_status')) return false; // raised here, not by the transport
  const status = detail.upstream_status;
  return !Number.isInteger(status) || status >= 500;
}

/**
 * `{ reason, order_id }` when `err` is one of the kernel's own unknown-outcome answers, else null; with `answered` beside
 * them when the store answered the order call with a refusal (KERNEL_ANSWERED_REFUSALS).
 */
export function kernelOutcomeUnknownOf(err) {
  if (!(err instanceof PivotaCommerceError) || err.code !== 'CHECKOUT_OUTCOME_UNKNOWN') return null;
  const detail = err.detail && typeof err.detail === 'object' ? err.detail : {};
  if (!KERNEL_OUTCOME_UNKNOWN_REASON_SET.has(detail.reason)) return null;
  const order_id = typeof detail.order_id === 'string' && detail.order_id !== '' ? detail.order_id : null;
  const answered = typeof err.answeredRefusal === 'string' && answeredFits(err.answeredRefusal, detail.reason, order_id) ? err.answeredRefusal : null;
  return answered ? { reason: detail.reason, order_id, answered } : { reason: detail.reason, order_id };
}

/**
 * DOES THIS ANSWER SAY THE REQUEST HAD NO EFFECT? Its code's catalog words do (`claimsNoEffect`), or its curated words do
 * (`detail.claims_no_effect`, which src/services/commerceKernelErrorMapping.js sets on such a refusal). Read by
 * kernel.createOrder, which answers such an error as raised only on the release rule's proof.
 */
export function claimsNoEffect(err) {
  if (!(err instanceof PivotaCommerceError)) return false;
  if (Object.prototype.hasOwnProperty.call(ERROR_CATALOG, err.code) && ERROR_CATALOG[err.code].claimsNoEffect === true) return true;
  return Boolean(err.detail && typeof err.detail === 'object' && err.detail.claims_no_effect === true);
}

export function isPivotaErrorCode(x) {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, x);
}
