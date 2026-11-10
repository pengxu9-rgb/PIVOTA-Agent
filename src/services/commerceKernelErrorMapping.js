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

/**
 * @param {{ operation?: string, upstreamCode?: string|null, status?: number|null }} input
 * @returns {'QUOTE_EXPIRED'|'PRICE_CHANGED'|'OUT_OF_STOCK'|'UNKNOWN_PRODUCT_ID'|'NO_MERCHANT_OFFER'|'MERCHANT_UNAVAILABLE'}
 */
function mapUpstreamErrorToKernelCode({ operation, upstreamCode, status } = {}) {
  const op = String(operation || '').trim();
  const code = String(upstreamCode || '').trim().toUpperCase();
  const isReadOp = COMMERCE_KERNEL_READ_OPS.has(op);

  if (code === 'QUOTE_EXPIRED') return 'QUOTE_EXPIRED';
  if (code === 'PRICE_CHANGED' || code === 'QUOTE_MISMATCH') return 'PRICE_CHANGED';
  if (code === 'OUT_OF_STOCK') return 'OUT_OF_STOCK';

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
  COMMERCE_KERNEL_READ_OPS,
  SINGLE_PRODUCT_READ_OPS,
};
