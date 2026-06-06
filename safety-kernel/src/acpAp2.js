// C5 — ACP / AP2 alignment (Wave 2).
//
// The gateway keeps treating acp_state / ap2_state as OPAQUE pass-through (per
// docs/acp-spec-bridge.md and docs/ap2-spec-bridge.md). This module does NOT change that:
// it adds a *translation* layer that surfaces (ChatGPT/Gemini) can use to present Pivota's
// lifecycle in Agentic Commerce Protocol (ACP) / Agent Payments Protocol (AP2) shapes, plus
// linkage helpers so opaque state can still be safely validated without being inspected for
// business meaning.
//
// Every mapping is documented and reversible where possible. Where Pivota has no confident
// ACP/AP2 equivalent, the opaque blob is carried through untouched.

import { PivotaCommerceError } from './errors.js';

// --- Lifecycle mapping: Pivota canonical -> ACP checkout/order status ------------------------

// ACP models a checkout session that moves discovery -> cart/quote -> order -> fulfillment.
export const PIVOTA_TO_ACP_STATUS = Object.freeze({
  quote_issued: 'checkout.created',
  order_created: 'checkout.completed', // order exists, not yet paid
  payment_succeeded: 'order.confirmed',
  payment_requires_action: 'checkout.requires_action',
  payment_failed: 'checkout.failed',
  shipped: 'order.fulfilled',
  delivered: 'order.delivered',
  refunded: 'order.refunded',
});

export const ACP_TO_PIVOTA_STATUS = Object.freeze(
  Object.fromEntries(Object.entries(PIVOTA_TO_ACP_STATUS).map(([k, v]) => [v, k])),
);

// --- AP2 mandate / payment state mapping -----------------------------------------------------

// AP2 expresses payment authorization as a mandate progressing through these states.
export const PIVOTA_TO_AP2_PAYMENT = Object.freeze({
  succeeded: 'mandate.captured',
  requires_action: 'mandate.pending_user_action',
  failed: 'mandate.declined',
  processing: 'mandate.processing',
});

// --- Linkage helpers (validate opaque state WITHOUT interpreting its contents) ----------------

/**
 * Pull the session id the gateway stamped into acp_state without assuming any other structure.
 * The gateway is the only writer of `acp_session_id`; everything else stays opaque.
 */
export function acpSessionId(acp_state) {
  if (acp_state == null) return undefined;
  if (typeof acp_state !== 'object') throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { reason: 'acp_state_not_object' });
  return acp_state.acp_session_id;
}

/**
 * Confirm an inbound acp_state belongs to the expected session. Used before trusting a
 * model-supplied acp_state on a write (contract §6). Opaque-safe: only compares the id.
 *
 * Codex P3-3: by default this fails closed — if a session is expected, a missing inbound session id
 * is a mismatch (it must not silently pass). Pass { allowMissing: true } only for read paths where
 * absent linkage is acceptable.
 */
export function assertAcpLinkage(acp_state, expectedSessionId, { allowMissing = false } = {}) {
  const sid = acpSessionId(acp_state);
  if (expectedSessionId) {
    if (!sid && !allowMissing) {
      throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { reason: 'acp_session_missing' });
    }
    if (sid && sid !== expectedSessionId) {
      throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { reason: 'acp_session_mismatch' });
    }
  }
  return true;
}

// --- Translation: Pivota canonical responses -> ACP / AP2 message shapes ----------------------

/**
 * Build an ACP checkout view from a Pivota quote (+ optional order). For surfaces that speak ACP.
 * The opaque acp_state is carried through verbatim under `state`.
 */
export function toAcpCheckout(quote, order = null) {
  if (!quote || typeof quote !== 'object') throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'toAcpCheckout_requires_quote' });
  const status = order ? PIVOTA_TO_ACP_STATUS.order_created : PIVOTA_TO_ACP_STATUS.quote_issued;
  return {
    protocol: 'acp',
    type: 'checkout',
    status,
    checkout: {
      quote_id: quote.quote_id,
      expires_at: quote.expires_at,
      currency: quote.currency,
      merchant_of_record: quote.merchant_of_record,
      totals: quote.locked_totals,
      line_items: quote.line_items,
      order_id: order?.order_id,
    },
    state: quote.acp_state, // opaque pass-through
  };
}

/**
 * Build an AP2 payment view from a Pivota payment result. Opaque ap2_state carried under `state`.
 * NB: never includes raw amounts/tokens — those are intentionally excluded from the AP2 view here;
 * the authoritative amount lives server-side in the order record.
 */
export function toAp2Payment(payment) {
  if (!payment || typeof payment !== 'object') throw new PivotaCommerceError('PRICE_CHANGED', { reason: 'toAp2Payment_requires_payment' });
  const mandateState = PIVOTA_TO_AP2_PAYMENT[payment.payment_status] || 'mandate.unknown';
  const view = {
    protocol: 'ap2',
    type: 'payment',
    mandate_state: mandateState,
    payment: {
      payment_id: payment.payment_id,
      status: payment.payment_status,
      // requires_action surfaced verbatim; never fabricated
      redirect_url: payment.redirect_url,
      qr_code: payment.qr_code,
      instructions: payment.instructions,
    },
  };
  // Codex P2-8: carry the opaque ap2_state as a NON-ENUMERABLE property so a generic
  // JSON.stringify / log of the view CANNOT leak mandate/token contents. Adapters that must
  // round-trip it read it explicitly via getAp2State(view).
  Object.defineProperty(view, 'state', { value: payment.ap2_state, enumerable: false });
  return view;
}

/** Explicit, intentional accessor for the non-enumerable opaque AP2 state on a toAp2Payment view. */
export function getAp2State(ap2View) {
  return ap2View?.state;
}

/**
 * Normalize an inbound ACP event (e.g. from a surface webhook) back to a Pivota status string.
 * Unknown ACP statuses map to null so callers fail safe rather than guess.
 */
export function fromAcpEvent(evt) {
  if (!evt || typeof evt !== 'object') return null;
  const acpStatus = evt.status || evt.type;
  return ACP_TO_PIVOTA_STATUS[acpStatus] || null;
}
