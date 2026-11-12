// C3 — Second-stage canonical-contract validator (additive; does NOT replace src/schema.js).
//
// The live `src/schema.js` InvokeRequestSchema is intentionally loose (every business field is
// z.any().passthrough()), and the current gateway contract FORWARDS submit_payment.expected_amount
// unchanged (see tests/integration/submit_payment_contract.test.js). That trust model conflicts
// with the v2 safe-checkout contract. Rather than silently flip the shared schema (and break the
// in-flight test), this module is an opt-in strict validator the server can run for money-path
// operations BEFORE handing off to the Safety Kernel. It reconciles the three documented drifts:
//   1. get_product_detail requires merchant_id + product_id (was product_id/sku_id only)
//   2. create_order requires order.quote_id (pricing comes from the quote, not item.price)
//   3. submit_payment must NOT trust a model amount — expected_amount is a verification echo only
// See docs/agent-checkout/C3-reconciliation.md for the migration plan.

import { PivotaCommerceError } from './errors.js';
import intakeBounds from './protocol/intakeBounds.cjs';
import { intakeBoundRefusal, surfaceableIntakeRefusal } from './protocol/buyerIntake.js';

export const WRITE_OPERATIONS = new Set(['create_order', 'submit_payment', 'request_after_sales']);

// ---- the two bounds every checkout door shares, on the invoke door --------------------------------------------
//
// The numbers, the rules, which invoke operations carry a key or cart lines, and each refusal's wording are
// ./protocol/intakeBounds.cjs's (the gateway's own invoke route loads that file directly); nothing here restates
// them. These throw what it describes, as the kernel error every door throws.

/** The invoke operations a caller may send an idempotency key with, and every operation either bound can refuse. */
export const INVOKE_KEYED_OPERATIONS = new Set(intakeBounds.INVOKE_KEYED_OPERATIONS);
export const { INVOKE_BOUNDED_OPERATIONS } = intakeBounds;

const INVOKE_NAMED_REASONS = new Set([
  intakeBounds.IDEMPOTENCY_KEY_TOO_SHORT_REASON,
  intakeBounds.IDEMPOTENCY_KEY_BAD_CHARACTERS_REASON,
  intakeBounds.QUANTITY_ABOVE_LINE_MAXIMUM_REASON,
]);

const throwIfRefused = (refusal) => { if (refusal) throw intakeBoundRefusal(refusal); };

/** Refuse, by name, an invoke operation with a cart line above the shared per-line ceiling (see intakeBounds.cjs). */
export function assertInvokeLineQuantities(operation, payload, options) {
  throwIfRefused(intakeBounds.invokeLineQuantityRefusal(operation, payload, options));
}

/** Refuse, by name, a present idempotency key below the shared minimum on an invoke operation that takes one. */
export function assertInvokeKeyAcceptable(operation, payload) {
  throwIfRefused(intakeBounds.invokeKeyRefusal(operation, payload));
}

/**
 * Both shared bounds and nothing else, as the invoke route that does not run the strict contract below (and its
 * alias) asks them. Throws the shared refusal; returns for everything else.
 */
export function assertInvokeIntakeBounds(operation, payload) {
  throwIfRefused(intakeBounds.invokeIntakeBoundsRefusal(operation, payload));
}

/**
 * The invoke door's error object for a kernel error: `toResult().error`, and for a shared intake refusal its
 * curated message and its field-level detail (the minimum, the maximum; never a value from the request).
 */
export function invokeErrorOf(err) {
  const error = err.toResult().error;
  // ONLY the shared bounds, by their own reasons. Any other intake refusal that ever reaches this door keeps the plain body.
  const surfaced = INVOKE_NAMED_REASONS.has(err.detail?.reason) ? surfaceableIntakeRefusal(err) : null;
  if (!surfaced) return error;
  // The code's generic recovery hint is about another situation (QUOTE_REQUIRED's is "quote first"); the curated
  // message is the instruction, so the hint is left out rather than sent beside it.
  return { code: error.code, retriable: error.retriable, message: surfaced.message, detail: surfaced.detail };
}

// After-sales actions the backend can actually fulfill today (mapping doc: refunds only).
export const SUPPORTED_AFTER_SALES = new Set(['refund']);

// Codex P1-1: the ONLY fields allowed on submit_payment.payment. Anything else is a money-source
// bypass risk and is rejected (the charge amount/currency come from the server-side order).
const ALLOWED_PAYMENT_FIELDS = new Set([
  'order_id', 'expected_amount', 'currency', 'payment_method_hint',
  'payment_handler_id', 'payment_handler_type', 'return_url',
]);

// Codex P0-2: the ONLY fields allowed on request_after_sales.status. No amount fields — the refund
// total is derived server-side from the locked order, never from the request.
const ALLOWED_AFTER_SALES_STATUS_FIELDS = new Set(['order_id', 'requested_action', 'reason']);

function reqObj(v, code, msg) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PivotaCommerceError(code, { reason: msg });
  return v;
}
function reqStr(v, code, msg) {
  if (typeof v !== 'string' || v.trim().length === 0) throw new PivotaCommerceError(code, { reason: msg });
  return v;
}

/**
 * Validate a canonical invoke envelope for a money/identity-sensitive operation.
 * Returns the (unchanged) payload on success; throws PivotaCommerceError on violation.
 * Discovery/status reads are passed through untouched (return null => "no strict rules").
 *
 * @param {string} operation
 * @param {object} payload
 * @param {{afterSalesSupported?: Set<string>}} [opts]
 */
export function validateCanonical(operation, payload, opts = {}) {
  const afterSalesSupported = opts.afterSalesSupported || SUPPORTED_AFTER_SALES;
  const p = payload || {};

  // A key that IS present has the shared minimum (intakeBounds.cjs), on a write and on a quote alike, and a short
  // one gets that rule's named refusal. What is left for the check below is a write with no key at all.
  assertInvokeKeyAcceptable(operation, p);
  // Writes must carry an idempotency key (INV-4) regardless of which write it is.
  if (WRITE_OPERATIONS.has(operation)) {
    const k = p.idempotency_key;
    if (typeof k !== 'string' || k.trim() === '') {
      throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { reason: 'missing_or_short_idempotency_key' });
    }
  }

  switch (operation) {
    case 'get_product_detail': {
      const product = reqObj(p.product, 'OPERATION_NOT_ALLOWED', 'product_required');
      reqStr(product.merchant_id, 'OPERATION_NOT_ALLOWED', 'merchant_id_required'); // drift #1
      reqStr(product.product_id, 'OPERATION_NOT_ALLOWED', 'product_id_required');
      return p;
    }

    case 'preview_quote': {
      const quote = reqObj(p.quote, 'QUOTE_REQUIRED', 'quote_required');
      reqStr(quote.merchant_id, 'QUOTE_REQUIRED', 'merchant_id_required');
      if (!Array.isArray(quote.items) || quote.items.length === 0) {
        throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'items_required' });
      }
      // The shared per-line ceiling, before any line is otherwise judged and before anything is priced.
      assertInvokeLineQuantities(operation, p);
      for (const it of quote.items) {
        reqStr(it.product_id, 'QUOTE_REQUIRED', 'item_product_id_required');
        if (!Number.isInteger(it.quantity) || it.quantity < 1) {
          throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'item_quantity_invalid' });
        }
      }
      return p;
    }

    case 'create_order': {
      const order = reqObj(p.order, 'QUOTE_REQUIRED', 'order_required');
      reqStr(order.quote_id, 'QUOTE_REQUIRED', 'quote_id_required'); // drift #2: no item.price trusted
      const addr = reqObj(order.shipping_address, 'OPERATION_NOT_ALLOWED', 'shipping_address_required');
      // Codex P2-4: postal_code is required upstream (pivota-api-mapping.md) — needed for the
      // shipping/tax lock to be honest. Include it in the required set.
      for (const f of ['country', 'city', 'address_line1', 'recipient_name', 'postal_code']) {
        reqStr(addr[f], 'OPERATION_NOT_ALLOWED', `shipping_${f}_required`);
      }
      return p;
    }

    case 'submit_payment': {
      reqStr(p.confirmation_token, 'CONFIRMATION_REQUIRED', 'confirmation_token_required'); // INV-3
      const pay = reqObj(p.payment, 'PRICE_CHANGED', 'payment_required');
      reqStr(pay.order_id, 'QUOTE_NOT_FOUND', 'order_id_required');
      reqStr(pay.currency, 'PRICE_CHANGED', 'currency_required');
      // drift #3: expected_amount is a verification ECHO only. It must be present and numeric so the
      // kernel can compare it to the authoritative (quote-derived) amount, but it is NEVER the source.
      if (typeof pay.expected_amount !== 'number' || !Number.isFinite(pay.expected_amount)) {
        throw new PivotaCommerceError('PRICE_CHANGED', { reason: 'expected_amount_required_for_verification' });
      }
      // Codex P1-1: closed payment payload. Reject unknown/aliased money fields (e.g. quote_id,
      // total_amount, amount) so no model-controlled amount source can ride along to upstream.
      for (const k of Object.keys(pay)) {
        if (!ALLOWED_PAYMENT_FIELDS.has(k)) {
          throw new PivotaCommerceError('PRICE_CHANGED', { reason: 'unexpected_payment_field', field: k });
        }
      }
      // And no stray amount-bearing keys at the payload root either.
      for (const k of ['quote', 'expected_amount', 'amount', 'total_amount']) {
        if (k in p) throw new PivotaCommerceError('PRICE_CHANGED', { reason: 'unexpected_root_money_field', field: k });
      }
      return p;
    }

    case 'request_after_sales': {
      const status = reqObj(p.status, 'OPERATION_NOT_ALLOWED', 'status_required');
      reqStr(status.order_id, 'OPERATION_NOT_ALLOWED', 'order_id_required');
      // Codex P1-2: an explicit, supported action is required (missing must not default to refund).
      if (status.requested_action === undefined || !afterSalesSupported.has(status.requested_action)) {
        throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', {
          reason: status.requested_action === undefined ? 'after_sales_action_required' : 'unsupported_after_sales_action',
          requested: status.requested_action ?? null,
          supported: [...afterSalesSupported],
        });
      }
      // Codex P0-2: CLOSED after-sales payload. The refund amount is derived server-side from the
      // locked order (connector orderContext), NEVER from the request. Reject any caller-supplied
      // amount-bearing field on status or at the payload root so a model can't drive the refund total.
      for (const k of Object.keys(status)) {
        if (!ALLOWED_AFTER_SALES_STATUS_FIELDS.has(k)) {
          throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', { reason: 'unexpected_after_sales_field', field: k });
        }
      }
      for (const k of ['refund', 'amount', 'requested_amount', 'total_amount']) {
        if (k in p) throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', { reason: 'unexpected_root_after_sales_field', field: k });
      }
      return p;
    }

    default:
      // Discovery / status reads: no strict money-path rules here.
      return null;
  }
}
