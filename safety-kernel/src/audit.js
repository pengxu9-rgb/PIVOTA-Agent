// C6 — Observability: money-path audit log (v3) + completion metrics + readiness scorecard.
//
// Closes Codex P1-6 (audit log asserted but not implemented) and the readiness gap. The audit log
// is append-only and ALWAYS redacted (contract §7): no ap2_state, tokens, confirmation_token, PANs,
// or amounts-as-PII ever reach it. Amounts live only as coarse booleans/counters here; the precise
// figure stays in the order store, not in logs/metrics.
//
// Pair with test_audit_v3_end_to_end.py (the standing CI gate): a full quote->order->pay flow must
// emit a complete, redacted audit trail. `audit.test.js` is the JS-side mirror of that gate.

import { redact } from './redact.js';

export const AUDIT_EVENTS = Object.freeze([
  'quote_issued',
  'order_created',
  'payment_succeeded',
  'payment_requires_action',
  'payment_failed',
  'idempotent_replay',
  'price_changed_blocked',
  'confirmation_blocked',
  'quote_violation_blocked',
  'linkage_blocked',
  'user_auth_blocked',
  'operation_blocked',
  'merchant_unavailable',
  // Distinct from merchant_unavailable on purpose: a catalog-coverage signal (an id advertised with no
  // servable offer behind it), not an availability one. Folding the two together is what let a persistent
  // dead-id condition read as a transient outage.
  'no_merchant_offer',
  'idempotency_conflict_blocked',
  'after_sales_requested',
]);

export class AuditLog {
  /** @param {{now?: ()=>number, sink?: (entry:object)=>void}} [opts] */
  constructor({ now = () => Date.now(), sink } = {}) {
    this._now = now;
    this._sink = sink; // optional durable writer; reference impl keeps an in-memory array
    this._entries = [];
  }

  /**
   * Append one redacted audit entry. `detail` is redacted defensively even though callers should
   * already pass non-sensitive fields only.
   * @param {string} event one of AUDIT_EVENTS
   * @param {{user_ref?:string, order_id?:string, quote_id?:string, idempotency_key?:string,
   *          currency?:string, operation?:string, detail?:object}} ctx
   */
  record(event, ctx = {}) {
    // Codex P2-6: redact the WHOLE entry, not just `detail`. idempotency_key and other identifier
    // fields are client-supplied; a token/PAN accidentally placed there must be masked too. PAN
    // patterns are scrubbed from every string field; sensitive keys masked.
    const entry = Object.freeze(
      redact({
        ts: this._now(),
        event,
        user_ref: ctx.user_ref,
        order_id: ctx.order_id,
        quote_id: ctx.quote_id,
        idempotency_key: ctx.idempotency_key,
        currency: ctx.currency, // currency code is fine; the AMOUNT is never logged
        operation: ctx.operation,
        detail: ctx.detail,
      }),
    );
    this._entries.push(entry);
    if (this._sink) this._sink(entry);
    return entry;
  }

  entries() {
    return this._entries.slice();
  }

  /** All audit entries for one order — used by the e2e gate to assert a complete trail. */
  trailFor(order_id) {
    return this._entries.filter((e) => e.order_id === order_id);
  }
}

export class CommerceMetrics {
  constructor() {
    this._c = new Map();
  }
  inc(name, by = 1) {
    this._c.set(name, (this._c.get(name) || 0) + by);
  }
  get(name) {
    return this._c.get(name) || 0;
  }
  snapshot() {
    return Object.fromEntries(this._c);
  }
}

/**
 * Commerce-completion readiness scorecard, derived from metrics. Extends the existing
 * `audit:readiness:commerce-core` dimensions with money-path completion signals.
 * Returns per-dimension green/amber/red + the raw numbers.
 */
export function readinessScorecard(metrics) {
  const m = metrics.snapshot();
  const quotes = m.quote_issued || 0;
  const orders = m.order_created || 0;
  const paid = m.payment_succeeded || 0;

  // Safety invariants that must be ZERO to be green.
  const doubleCharges = m.double_charge || 0;
  const priceLockViolations = m.price_lock_violation || 0;
  const confirmationBypass = m.confirmation_bypass || 0;

  const ratio = (a, b) => (b > 0 ? a / b : null);

  // Codex P2-7: zero traffic must NOT read as green — an unexercised path is 'unknown', not 'ready'.
  // A safety dimension is green only once the path has been exercised AND no violation occurred.
  const exercised = quotes + orders + paid > 0;
  const safetyDim = (zeroMetric) => (zeroMetric > 0 ? 'red' : exercised ? 'green' : 'unknown');

  return {
    dimensions: {
      QuoteToOrderConversion: quotes === 0 ? 'unknown' : orders === 0 ? 'amber' : 'green',
      OrderToPaymentConversion: orders === 0 ? 'unknown' : paid === 0 ? 'amber' : 'green',
      NoDoubleCharge: safetyDim(doubleCharges),
      PriceLockIntegrity: safetyDim(priceLockViolations),
      ConfirmationIntegrity: safetyDim(confirmationBypass),
    },
    exercised,
    rates: {
      quote_to_order: ratio(orders, quotes),
      order_to_payment: ratio(paid, orders),
    },
    counters: m,
  };
}
