// Reconciliation sweeper — resolves orders stuck in 'charge_pending'. The payment state machine fails
// CLOSED: an ambiguous charge timeout, an unmapped backend status, or a never-arriving terminal webhook
// leaves an order 'charge_pending' (no double charge, but unredeemable). This sweeper finds those orders
// past a max age, asks the PSP/backend for the TRUE status, and drives kernel.onPaymentWebhook to
// resolve them — so a payment that actually succeeded gets fulfilled and one that failed is freed.
//
// Store-agnostic: you inject `listPending()` (the discovery query) and `queryStatus(order)` (the truth
// source). A reference in-memory listPending is provided; the Postgres query is documented below.
//
// ⚠️ Codex P1-3 — queryStatus MUST be AUTHORITATIVE, not a guess. The sweeper never charges (it only
// drives kernel.onPaymentWebhook), so it cannot DIRECTLY double-charge. But if queryStatus returns a
// WRONG 'failed' for a charge that is actually still in flight, the order is marked 'failed', which
// ADMITS a retry — and if the original then succeeds, a second charge can result. This is inherent to
// any "retry after failure" flow over an eventually-consistent PSP; it CANNOT be fully closed in the
// kernel. Mitigations the integrator MUST provide: (1) queryStatus returns the PSP's definitive
// terminal status (resolve 'still processing' to null → left pending, never 'failed'); (2) the upstream
// charge carries a per-ORDER PSP idempotency key so a second charge for the same order is rejected at
// the PSP. Without (2), a wrong 'failed' + retry is a residual double-charge risk.
//
// Run it from a cron/interval (every few minutes):
//   const summary = await reconcilePendingOrders({
//     kernel,
//     listPending: makeInMemoryListPending(orderStore),        // or a Postgres-backed query
//     queryStatus: (o) => pspClient.getStatus(o.payment_id),   // → 'succeeded'|'payment_failed'|...
//     now: () => Date.now(),
//     maxAgeMs: 10 * 60 * 1000,
//   });

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000; // only reconcile orders pending longer than this

/**
 * @param {{
 *   kernel: { onPaymentWebhook: Function },
 *   listPending: () => Promise<Array<{ order_id:string, payment_id?:string, charge_pending_at?:number }>>,
 *   queryStatus: (order:object) => Promise<string|null>, // true status from the PSP/backend, or null if unknown
 *   now?: () => number, maxAgeMs?: number, log?: object,
 * }} deps
 * @returns {Promise<{ scanned:number, reconciled:Array, stillPending:Array, errors:Array }>}
 */
export async function reconcilePendingOrders({ kernel, listPending, queryStatus, now = () => Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, log = console } = {}) {
  if (!kernel || typeof kernel.onPaymentWebhook !== 'function') throw new Error('reconcilePendingOrders requires a kernel with onPaymentWebhook()');
  if (typeof listPending !== 'function') throw new Error('reconcilePendingOrders requires listPending()');
  if (typeof queryStatus !== 'function') throw new Error('reconcilePendingOrders requires queryStatus()');

  const pending = await listPending();
  const t = now();
  const reconciled = [];
  const stillPending = [];
  const errors = [];

  for (const order of pending) {
    // Codex P2-1: a row without a charge_pending_at timestamp must be HELD BACK, not swept — we cannot
    // prove it is old enough, and resolving an in-flight charge too early is the very risk this gate
    // guards against. (Old/migrated/partially-repaired rows land here; surface them for inspection.)
    if (order.charge_pending_at == null) { stillPending.push({ order_id: order.order_id, reason: 'no_timestamp' }); continue; }
    // Only sweep orders pending longer than maxAgeMs (give in-flight charges time to complete normally).
    if (t - order.charge_pending_at < maxAgeMs) { stillPending.push({ order_id: order.order_id, reason: 'too_recent' }); continue; }
    // Codex P1 (lock-first re-model): the kernel writes charge_pending with payment_id=null BEFORE the
    // upstream charge response returns, and only stamps the real payment_id afterward. A crash/timeout in
    // that window leaves an OLD pending row with no payment_id — we cannot correlate it to a PSP charge by
    // id, and calling queryStatus(null) would either throw forever or, worse, be mapped to a terminal
    // 'failed' that admits a retry while the first charge may have actually succeeded. HOLD BACK such rows
    // (reason 'no_payment_id') for authoritative, order-level reconciliation; never query/resolve by a null
    // id. (A RECENT null-id row is caught by the too_recent gate above — it may still get its id when the
    // in-flight submit completes.)
    if (order.payment_id == null || order.payment_id === '') { stillPending.push({ order_id: order.order_id, reason: 'no_payment_id' }); continue; }
    try {
      const status = await queryStatus(order);
      if (status == null) { stillPending.push({ order_id: order.order_id, reason: 'psp_unknown' }); continue; }
      // Drive the SAME idempotent, attempt-correlated webhook path. payment_id keeps it bound to the
      // current attempt; the kernel ignores it if the order already moved on.
      const result = await kernel.onPaymentWebhook({ order_id: order.order_id, status, payment_id: order.payment_id });
      if (result.transitioned) reconciled.push({ order_id: order.order_id, to: result.transitioned });
      else stillPending.push({ order_id: order.order_id, reason: result.reason || 'not_transitioned' });
    } catch (err) {
      errors.push({ order_id: order.order_id, message: err?.message });
    }
  }

  const summary = { scanned: pending.length, reconciled, stillPending, errors };
  log.info?.('reconcile_pending_orders', { scanned: summary.scanned, reconciled: reconciled.length, stillPending: stillPending.length, errors: errors.length });
  return summary;
}

/**
 * Reference in-memory `listPending` for the InMemoryKvStore order namespace. Scans the store's map for
 * records whose status is 'charge_pending'. PRODUCTION (Postgres) should instead run an indexed query.
 * charge_pending_at is stored as epoch MILLISECONDS (a JSON number). Use a GUARDED cast so a single
 * malformed JSONB value (e.g. a stray string) does not abort the whole pending-list query and stall the
 * sweeper — a bad row simply yields NULL → held back as 'no_timestamp' (Codex P2):
 *
 *   SELECT k AS order_id,
 *          v->>'payment_id' AS payment_id,
 *          CASE WHEN jsonb_typeof(v->'charge_pending_at') = 'number'
 *               THEN (v->>'charge_pending_at')::numeric END AS charge_pending_at
 *   FROM commerce_kv
 *   WHERE ns = 'orders' AND v->>'status' = 'charge_pending';
 *
 * @param {{ _m: Map }} inMemoryStore  the InMemoryKvStore backing the order namespace
 */
export function makeInMemoryListPending(inMemoryStore) {
  return async () => {
    const out = [];
    const m = inMemoryStore?._m;
    if (!m) return out;
    for (const [key, rec] of m) {
      const v = rec?.value;
      // The order_id is the STORE KEY. Skip charge-lock entries (no status) and non-pending orders.
      if (v && typeof v === 'object' && v.status === 'charge_pending') {
        out.push({ order_id: key, payment_id: v.payment_id, charge_pending_at: v.charge_pending_at });
      }
    }
    return out;
  };
}
