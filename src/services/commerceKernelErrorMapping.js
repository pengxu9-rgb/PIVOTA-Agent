'use strict';

// Which shared-taxonomy code does an upstream failure become?
//
// Extracted from src/server.js so the decision is unit-testable without booting the app, for the same reason
// services/publicReadChainResolvability.js was: this is a small predicate whose failure mode is large. The
// function it came from (`throwCommerceKernelUpstreamError`) is shared by EVERY kernel operation — the read
// lanes AND preview_quote / create_order / submit_payment / create_payment_link / request_after_sales. A
// mapping that is right for a read and wrong for a charge is one line away at all times.
//
// THE RULE THIS ENCODES: `retriable` is a promise to the agent, and a wrong promise costs real money in both
// directions.
//
//   - Say retriable:true for a permanent condition and every chaining agent retries forever. That was the
//     measured bug (#1829, and again here): 22% of public search results led to `get_product` returning
//     "The merchant is temporarily unreachable. Please try again shortly." for ids that would never resolve.
//   - Say retriable:false for a transient one and a checkout agent abandons a live order during a blip.
//
// So terminal classifications are granted narrowly, keyed on an unambiguous upstream signal, and — where the
// signal is ambiguous (a bare status code) — only on read ops.

// Read-only kernel ops. Mirrors the read() calls in safety-kernel/src/protocol/canonicalExecutor.js and
// BACKEND_READ_OPS in safety-kernel/src/protocol/productionWiring.js.
const COMMERCE_KERNEL_READ_OPS = new Set(['get_product_detail', 'find_products', 'find_products_multi']);

// NARROWER STILL: the ops where "the id resolved to nothing" is a sentence that can be true. A search op has
// a query, not an id, so "No product matches that id — search again" would be nonsense advice for what would
// actually be a bad search argument. `MISSING_MERCHANT_CONTEXT` provably originates only from the get_pdp_v2
// lane today (single emit site in src/server.js), so this is not a behaviour difference — it is the arm
// refusing to hold an opinion it has no basis for if the backend ever starts emitting that code elsewhere.
const SINGLE_PRODUCT_READ_OPS = new Set(['get_product_detail']);

// THE ORDER CALL REFUSED THE BUYER'S DETAILS. The backend's order create answers 400 INVALID_BUYER_CONTEXT, from its
// prologue, before it can have written an order (safety-kernel/contracts/order_create_prologue_refusals.json), for a
// buyer context it cannot order with: no complete shipping address, no buyer email. As MERCHANT_UNAVAILABLE
// ("temporarily unreachable", retriable) the agent re-sent the identical call, which can never succeed, and was never
// told what to fix. It is terminal for the request as sent, and named.
//
// Granted on exactly the proof the quote-claim release needs (safety-kernel/src/upstreamRefusal.js): the order op,
// the exact status, and the route's own detail naming the code (`error.details.error`), not a message or the
// status-derived code. So the answer says "nothing was ordered, fix and retry" exactly when the claim was given back
// and a corrected retry can succeed; anything short of that proof stays MERCHANT_UNAVAILABLE.
const BUYER_CONTEXT_REFUSAL_CODE = 'INVALID_BUYER_CONTEXT';
function isBuyerContextRefusal({ operation, upstreamCode, status, upstreamDetail } = {}) {
  return String(operation || '').trim() === 'create_order'
    && status === 400
    && String(upstreamCode || '').trim() === BUYER_CONTEXT_REFUSAL_CODE
    && upstreamDetail != null && typeof upstreamDetail === 'object' && !Array.isArray(upstreamDetail)
    && upstreamDetail.error === BUYER_CONTEXT_REFUSAL_CODE;
}

// THE SELLER IS NOT TAKING ORDERS. The backend's order create answers 403 MERCHANT_NOT_ACCEPTING_ORDERS from its order
// route, before it writes an order, for a seller whose store does not accept orders now. It is named
// MERCHANT_NOT_ACCEPTING_ORDERS (terminal, "nothing was ordered") on the same proof as above: the order op, the exact
// status, the route's own detail naming the code. That name is only a candidate: the kernel answers it as raised ONLY
// when the quote-claim release rule matches it too (the pair is in safety-kernel/contracts/order_create_prologue_refusals.json,
// no deadline mark), and otherwise answers the kernel's unknown outcome (safety-kernel/src/kernel.js createOrder). So a
// list without the pair can never be told "nothing was ordered".
const MERCHANT_NOT_ACCEPTING_CODE = 'MERCHANT_NOT_ACCEPTING_ORDERS';
function isMerchantNotAcceptingOrders({ operation, upstreamCode, status, upstreamDetail } = {}) {
  return String(operation || '').trim() === 'create_order'
    && status === 403
    && String(upstreamCode || '').trim() === MERCHANT_NOT_ACCEPTING_CODE
    && upstreamDetail != null && typeof upstreamDetail === 'object' && !Array.isArray(upstreamDetail)
    && upstreamDetail.error === MERCHANT_NOT_ACCEPTING_CODE;
}

/**
 * The curated refusal members for an upstream failure that has one (the shape safety-kernel's intakeRefusal builds:
 * `reason`, `acp_message`, `acp_detail`, which every door surfaces), or null. Names fields only, never a value.
 */
function curatedUpstreamRefusal(input = {}) {
  if (isMerchantNotAcceptingOrders(input)) {
    // The words are the catalog's (safety-kernel/src/errors.js MERCHANT_NOT_ACCEPTING_ORDERS); the detail names the reason.
    const reason = 'merchant_not_accepting_orders';
    return { reason, acp_detail: { reason } };
  }
  if (!isBuyerContextRefusal(input)) return null;
  const reason = 'buyer_context_refused';
  return {
    reason,
    acp_message: [
      'The order could not be created: the buyer details this checkout carries were refused (an order needs a complete shipping address, with name, address_line1, city, postal_code and country, and a buyer email).',
      'No order was created and nothing was charged. Supply the missing details, with this call or by updating the checkout session, then try again.',
      'Retrying this request unchanged will not succeed.',
    ].join(' '),
    acp_detail: { reason, required_fields: ['name', 'address_line1', 'city', 'postal_code', 'country', 'customer_email'] },
  };
}

/**
 * @param {{ operation?: string, upstreamCode?: string|null, status?: number|null, upstreamDetail?: object|null }} input
 * @returns {'MERCHANT_NOT_ACCEPTING_ORDERS'|'QUOTE_EXPIRED'|'PRICE_CHANGED'|'OUT_OF_STOCK'|'UNKNOWN_PRODUCT_ID'|'NO_MERCHANT_OFFER'|'PARTNER_ASSERTION_REJECTED'|'ORDER_CANCELED'|'QUOTE_REQUIRED'|'MERCHANT_UNAVAILABLE'}
 */
function mapUpstreamErrorToKernelCode({ operation, upstreamCode, status, upstreamDetail } = {}) {
  const op = String(operation || '').trim();
  const code = String(upstreamCode || '').trim().toUpperCase();
  const isReadOp = COMMERCE_KERNEL_READ_OPS.has(op);

  if (isBuyerContextRefusal({ operation, upstreamCode, status, upstreamDetail })) return 'QUOTE_REQUIRED';
  if (isMerchantNotAcceptingOrders({ operation, upstreamCode, status, upstreamDetail })) return 'MERCHANT_NOT_ACCEPTING_ORDERS';

  if (code === 'QUOTE_EXPIRED') return 'QUOTE_EXPIRED';
  if (code === 'PRICE_CHANGED' || code === 'QUOTE_MISMATCH') return 'PRICE_CHANGED';
  if (code === 'OUT_OF_STOCK') return 'OUT_OF_STOCK';

  // FIX_PLAN O-04: the backend refused this call's request-bound partner assertion before its route ran
  // (routes/agent_forwarded_owner.py, 409). Terminal and op-independent: the code is our own backend's, by
  // name, and it says nothing was written, so "never retry" is true on the money ops as well. It is not a
  // merchant outage, and as one (retriable) every agent would retry a call that is refused every time.
  if (code === 'PARTNER_ASSERTION_REJECTED') return 'PARTNER_ASSERTION_REJECTED';

  // FIX_PLAN C-11: the backend will not take a payment for an order that was canceled (409 ORDER_CANCELED from
  // POST /agent/v1/payments, before or after the PSP call; sent only with the backend's
  // CHECKOUT_CANCEL_UPSTREAM_ENABLED on). Terminal and op-independent: the code is our own backend's, by name, and
  // a canceled order never becomes payable again, so "never retry" is true on every op that can meet it.
  if (code === 'ORDER_CANCELED') return 'ORDER_CANCELED';

  // THE ID RESOLVED TO NOTHING. Unscoped get_product_detail routes to this gateway's own get_pdp_v2, which
  // answers HTTP 400 `MISSING_MERCHANT_CONTEXT` ("merchant_id is required when canonical product identity
  // cannot be resolved") for an id it cannot turn into a canonical identity — a stale or invented `sig_…`, or
  // a non-signature id like `rejuran:…`. Measured on prod 2026-07-27: both shapes came back
  // MERCHANT_UNAVAILABLE / retriable:true, because 400 misses the not-found arm below.
  //
  // SINGLE-PRODUCT READS ONLY, and matched on the CODE rather than the bare 400. Two independent guards,
  // both load-bearing:
  //   - op scope, because the money ops share this function and no product-identity story should ever be able
  //     to tell a checkout agent "never retry";
  //   - code (not status), because a 400 on a read op is just as likely a malformed page_size — a caller bug,
  //     not a statement about any product id.
  // Note this arm is checked BEFORE the not-found arms, so a `MISSING_MERCHANT_CONTEXT` that happens to
  // arrive with HTTP 404 reports UNKNOWN_PRODUCT_ID rather than NO_MERCHANT_OFFER. Same terminal semantics
  // and the same HTTP 404 out; it only moves that slice onto the more accurate metric.
  if (SINGLE_PRODUCT_READ_OPS.has(op) && code === 'MISSING_MERCHANT_CONTEXT') return 'UNKNOWN_PRODUCT_ID';

  // A not-found from a read lane is a persistent data condition: no acceptable offer/seed answers the id's
  // content route, and that is true again on the next call. The explicit PRODUCT_NOT_FOUND code is unambiguous
  // by name so it stays op-independent; the bare 404 is not, so it is read-only.
  if (code === 'PRODUCT_NOT_FOUND') return 'NO_MERCHANT_OFFER';
  if (status === 404 && isReadOp) return 'NO_MERCHANT_OFFER';

  return 'MERCHANT_UNAVAILABLE';
}

module.exports = {
  mapUpstreamErrorToKernelCode,
  curatedUpstreamRefusal,
  COMMERCE_KERNEL_READ_OPS,
  SINGLE_PRODUCT_READ_OPS,
};
