// Reconcile for kernel orders stuck at 'charge_pending' with NO payment_id (FIX_PLAN follow-up to the A–D review,
// P2-3, 2026-11-17).
//
// WHY THESE ROWS ARE STUCK. submitPayment writes 'charge_pending' with payment_id null BEFORE the charge call
// (kernel.js, the lock-first re-model). When that call's outcome is unknown (it timed out, errored, or answered an
// empty 2xx), no PSP id is ever stamped. onPaymentWebhook then ignores every event for the row
// (`uncorrelated_attempt`), and reconcile.js holds such rows back (`no_payment_id`), so nothing ever moves them.
// The buyer is parked: submit refuses 'charge_pending', the flag-off cancel refuses it, and the agent is told the
// order exists (CHECKOUT_OUTCOME_UNKNOWN) with no step that can settle it.
//
// WHAT THIS DOES. For each such row, oldest first and within bounds, it READS the backend's own order
// (GET /agent/v2/orders/{order_id}: its state, its payment_status, and whether a PSP payment surface (the hosted
// page's PaymentIntent or Checkout Session) was ever attached to it). Then it settles the kernel row to that truth:
//
//   backend payment_status is a paid state            -> 'paid'
//   backend order cancelled (its page was closed)     -> 'expired'
//   backend unpaid, no PSP surface ever attached, and
//     the row is older than any hosted session lives  -> 'expired'
//   anything else (a payment failed on a page that may
//     still take a retry, an open PSP surface, money
//     after cancel, a status this does not know, the
//     read failing)                                   -> unchanged, logged with the reason
//
// It never creates, re-creates or charges anything, and never calls the PSP: its only reads are the backend's
// order read, and its only write is kernel.settleUncorrelatedCharge, a compare-and-set that loses to every other
// writer of the row (see kernel.js). Pivota never holds money; this moves no money.
//
// BOUNDED. A batch size, an age window (too-recent rows may still be in flight; too-old rows are left to ops), a
// rate limit on backend reads, a deadline per run, and a run lease so one instance runs it at a time. Idempotent:
// a settled row leaves the candidate list, and a second settle of the same row is refused by the compare-and-set.
//
// MODES. 'off' (default) never runs. 'observe' reads and decides and logs what it would do, writing nothing.
// 'apply' also writes.

export const RECONCILE_MODES = Object.freeze({ off: 'off', observe: 'observe', apply: 'apply' });

// The backend's paid payment_status values (pivota-backend services/checkout_cancel_upstream.py _PAID_PAYMENT_STATES,
// less `paid_after_cancel`, which is money on a cancelled order: a refund request the backend already raised).
const BACKEND_PAID = new Set(['paid', 'completed', 'succeeded', 'success', 'settled', 'partially_refunded', 'refunded']);
const BACKEND_PAID_AFTER_CANCEL = 'paid_after_cancel';
const BACKEND_FAILED = new Set(['failed', 'payment_failed']);
// An order with no payment yet (routes/agent_v2.py _order_state_from_row reads these as awaiting_checkout; an empty
// payment_status reads as draft).
const BACKEND_UNPAID = new Set(['', 'awaiting_payment', 'pending', 'unpaid']);

export const DECISION = Object.freeze({ paid: 'paid', expire: 'expire', hold: 'hold' });

/**
 * What the reconcile may know about a backend order, from GET /agent/v2/orders/{id}. Only these three facts: the
 * body also carries the buyer's contact and address and the PSP client secret, none of which leaves this function.
 * Null (with a reason) for any answer that is not a 200 carrying this order.
 *
 * @returns {{ ok:true, state:string, payment_status:string, has_payment_surface:boolean } | { ok:false, reason:string }}
 */
export function projectBackendOrder(orderId, httpStatus, body) {
  if (httpStatus !== 200) return { ok: false, reason: `http_${httpStatus ?? 'none'}` };
  const order = body && typeof body === 'object' ? body.order : null;
  if (!order || typeof order !== 'object' || Array.isArray(order)) return { ok: false, reason: 'malformed_body' };
  if (typeof order.state !== 'string' || order.state.trim() === '') return { ok: false, reason: 'malformed_body' };
  // A body for some other order is not an answer about this one.
  if (order.order_id != null && String(order.order_id) !== String(orderId)) return { ok: false, reason: 'order_id_mismatch' };
  const ps = order.payment_status;
  if (ps != null && typeof ps !== 'string') return { ok: false, reason: 'malformed_body' };
  const surface = order.payment_summary && typeof order.payment_summary === 'object' ? order.payment_summary.payment_intent_id : null;
  return {
    ok: true,
    state: order.state.trim().toLowerCase(),
    payment_status: String(ps ?? '').trim().toLowerCase(),
    has_payment_surface: typeof surface === 'string' && surface.trim() !== '',
  };
}

/**
 * The settle decision: pure, from the backend's projected order and the kernel row.
 *
 * @param {{ state:string, payment_status:string, has_payment_surface:boolean }} backend
 * @param {{ status:string, charge_pending_at?:number }} row
 * @param {{ now:number, sessionMaxAgeMs:number }} opts
 * @returns {{ decision:'paid'|'expire'|'hold', reason:string }}
 */
export function decideSettlement(backend, row, { now, sessionMaxAgeMs }) {
  const ps = backend.payment_status;
  if (ps === BACKEND_PAID_AFTER_CANCEL) return { decision: DECISION.hold, reason: 'backend_paid_after_cancel' };
  if (BACKEND_PAID.has(ps)) return { decision: DECISION.paid, reason: 'backend_paid' };
  // An 'expired' row (settled by an earlier run) only ever moves to paid; it is re-read for that alone.
  if (row.status === 'expired') return { decision: DECISION.hold, reason: 'still_not_paid' };
  if (backend.state === 'cancelled') return { decision: DECISION.expire, reason: 'backend_order_cancelled' };
  // A failed payment on a hosted page that may still take a retry is not the end of that page.
  if (BACKEND_FAILED.has(ps)) return { decision: DECISION.hold, reason: 'backend_payment_failed' };
  if (!BACKEND_UNPAID.has(ps)) return { decision: DECISION.hold, reason: 'backend_status_unrecognized' };
  // Unpaid. A PSP surface attached to the order can still be confirmed by whoever holds the page; only the
  // backend's cancel (C-11) closes one, and this never touches the PSP.
  if (backend.has_payment_surface) return { decision: DECISION.hold, reason: 'payment_surface_open' };
  // Unpaid and no surface was ever attached: either the hosted session was never minted (the call that timed out
  // never reached it), or it was minted and nobody opened it. Once the row is older than any hosted session can
  // live, nothing can pay it.
  if (!Number.isSafeInteger(row.charge_pending_at)) return { decision: DECISION.hold, reason: 'no_timestamp' };
  if (now - row.charge_pending_at < sessionMaxAgeMs) return { decision: DECISION.hold, reason: 'session_may_be_open' };
  return { decision: DECISION.expire, reason: 'session_lapsed_no_payment_surface' };
}

/**
 * One bounded run.
 *
 * @param {{
 *   kernel: { settleUncorrelatedCharge: Function },
 *   listCandidates: (q:{ pendingOlderThan:number, pendingNewerThan:number, expiredNewerThan:number,
 *                        pendingLimit:number, expiredLimit:number }) => Promise<Array<object>>,
 *   readBackendOrder: (orderId:string, opts:{ timeoutMs:number }) => Promise<{ status:number, body:any }>,
 *   mode: 'off'|'observe'|'apply',
 *   lease?: { acquire: () => Promise<boolean>, release: () => Promise<void> },
 *   now?: () => number, sleep?: (ms:number) => Promise<void>, log?: object,
 *   batchSize?: number, recheckBatchSize?: number, minAgeMs?: number, maxAgeMs?: number,
 *   sessionMaxAgeMs?: number, recheckWindowMs?: number, readsPerSecond?: number,
 *   deadlineMs?: number, readTimeoutMs?: number,
 * }} deps
 */
export async function reconcileUncorrelatedChargePending(deps = {}) {
  const {
    kernel, listCandidates, readBackendOrder, lease = null,
    now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console,
  } = deps;
  const cfg = normalizeConfig(deps);
  const mode = cfg.mode;
  if (mode === RECONCILE_MODES.off) return { mode, skipped: 'off' };
  if (!kernel || typeof kernel.settleUncorrelatedCharge !== 'function') throw new Error('reconcile requires kernel.settleUncorrelatedCharge');
  if (typeof listCandidates !== 'function') throw new Error('reconcile requires listCandidates()');
  if (typeof readBackendOrder !== 'function') throw new Error('reconcile requires readBackendOrder()');

  if (lease && !(await lease.acquire())) return { mode, skipped: 'lease_held' };
  const started = now();
  const deadline = started + cfg.deadlineMs;
  const summary = {
    mode, scanned: 0, read_failed: 0, applied: 0, raced: 0, stopped: null,
    decisions: { paid: 0, expire: 0, hold: 0 }, by_reason: {},
  };
  try {
    const rows = await listCandidates({
      pendingOlderThan: started - cfg.minAgeMs,
      pendingNewerThan: started - cfg.maxAgeMs,
      expiredNewerThan: started - cfg.recheckWindowMs,
      pendingLimit: cfg.batchSize,
      expiredLimit: cfg.recheckBatchSize,
    });
    const list = Array.isArray(rows) ? rows.slice(0, cfg.batchSize + cfg.recheckBatchSize) : [];
    const gapMs = Math.ceil(1000 / cfg.readsPerSecond);
    let lastReadAt = null;
    for (const row of list) {
      if (!row || typeof row.order_id !== 'string' || row.order_id === '') continue;
      if (lastReadAt != null) {
        const wait = lastReadAt + gapMs - now();
        if (wait > 0) await sleep(wait);
      }
      const remaining = deadline - now();
      if (remaining <= 0) { summary.stopped = 'deadline'; break; }
      summary.scanned += 1;
      lastReadAt = now();
      let projected;
      try {
        const answered = await readBackendOrder(row.order_id, { timeoutMs: Math.min(cfg.readTimeoutMs, remaining) });
        projected = projectBackendOrder(row.order_id, answered?.status, answered?.body);
      } catch (err) {
        projected = { ok: false, reason: `read_error:${err?.code || err?.name || 'error'}` };
      }
      if (!projected.ok) {
        summary.read_failed += 1;
        bump(summary.by_reason, `read_failed:${projected.reason}`);
        logWarn(log, { event: 'kernel_charge_pending_reconcile', mode, order_id: row.order_id, row_status: row.status, decision: 'none', reason: `read_failed:${projected.reason}`, applied: false });
        continue;
      }
      const { decision, reason } = decideSettlement(projected, row, { now: now(), sessionMaxAgeMs: cfg.sessionMaxAgeMs });
      summary.decisions[decision] += 1;
      bump(summary.by_reason, reason);
      let applied = false;
      let outcome = null;
      if (mode === RECONCILE_MODES.apply && decision !== DECISION.hold) {
        const result = await kernel.settleUncorrelatedCharge({
          order_id: row.order_id,
          observed: { status: row.status, attempt: row.attempt, charge_pending_at: row.charge_pending_at, settled_at: row.settled_at },
          to: decision === DECISION.paid ? 'paid' : 'expired',
          reason,
        });
        applied = Boolean(result && result.transitioned);
        if (applied) summary.applied += 1;
        else { summary.raced += 1; outcome = result?.reason || 'not_applied'; }
      }
      logInfo(log, {
        event: 'kernel_charge_pending_reconcile', mode, order_id: row.order_id, row_status: row.status,
        decision, reason, applied, ...(outcome ? { not_applied: outcome } : {}),
        backend_state: projected.state, backend_payment_status: projected.payment_status,
        backend_payment_surface: projected.has_payment_surface,
      });
    }
  } finally {
    if (lease) { try { await lease.release(); } catch { /* the lease's TTL frees it */ } }
  }
  summary.elapsed_ms = now() - started;
  (summary.stopped ? logWarn : logInfo)(log, { event: 'kernel_charge_pending_reconcile_run', ...summary });
  return summary;
}

// Defaults and clamps. A value out of range is clamped, never rejected: a typo in an env var must not stop the
// gateway, and every clamp keeps the run bounded.
export const RECONCILE_DEFAULTS = Object.freeze({
  batchSize: 25,
  recheckBatchSize: 5,
  // Past the upstream charge timeout (AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS, 30 s) and the charge lock (2 min) by far.
  minAgeMs: 30 * 60 * 1000,
  // Older rows are left to ops (the count query in the PR names them).
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  // Longer than any hosted session lives: the backend clamps CHECKOUT_INTENT_TTL_SECONDS to at most 6 h. Its
  // CHECKOUT_TOKEN_TTL_SECONDS is not clamped, so this must stay above whatever that is set to.
  sessionMaxAgeMs: 24 * 60 * 60 * 1000,
  recheckWindowMs: 72 * 60 * 60 * 1000,
  readsPerSecond: 2,
  deadlineMs: 60 * 1000,
  readTimeoutMs: 5000,
});
const BOUNDS = Object.freeze({
  batchSize: [1, 200],
  recheckBatchSize: [0, 50],
  minAgeMs: [5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000],
  maxAgeMs: [60 * 60 * 1000, 90 * 24 * 60 * 60 * 1000],
  sessionMaxAgeMs: [6 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000],
  recheckWindowMs: [0, 30 * 24 * 60 * 60 * 1000],
  readsPerSecond: [0.1, 20],
  deadlineMs: [5 * 1000, 10 * 60 * 1000],
  readTimeoutMs: [500, 30 * 1000],
});

export function normalizeConfig(raw = {}) {
  const mode = Object.values(RECONCILE_MODES).includes(raw.mode) ? raw.mode : RECONCILE_MODES.off;
  const out = { mode };
  for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
    const n = Number(raw[k]);
    const v = raw[k] == null || raw[k] === '' || !Number.isFinite(n) ? RECONCILE_DEFAULTS[k] : n;
    out[k] = Math.min(hi, Math.max(lo, v));
  }
  out.batchSize = Math.floor(out.batchSize);
  out.recheckBatchSize = Math.floor(out.recheckBatchSize);
  // The window must be a window.
  if (out.maxAgeMs <= out.minAgeMs) out.maxAgeMs = Math.min(BOUNDS.maxAgeMs[1], out.minAgeMs + 60 * 60 * 1000);
  return out;
}

/**
 * A run lease on a kernel state store, so one instance runs a tick at a time. putIfAbsent with a TTL a little past
 * the run's own deadline: a crashed holder frees it by expiry, never by a second run starting beside it.
 */
export function makeStoreLease(store, { owner, ttlMs, key = 'run-lease' }) {
  return {
    acquire: () => store.putIfAbsent(key, { owner }, { ttlMs }),
    release: async () => { await store.compareAndDelete(key, 'owner', owner); },
  };
}

/**
 * The candidate list over the kernel's Postgres order namespace (commerce_kv): charge_pending rows with no payment
 * id inside the age window, oldest first, then a few rows this reconcile expired, newest first, re-read only to
 * catch a late payment. A malformed charge_pending_at (not a JSON number) is never cast: the CASE yields NULL and
 * the row is left out (the count query names such rows).
 */
export function makePostgresListCandidates({ db, namespace = 'orders' }) {
  if (!db || typeof db.query !== 'function') throw new Error('makePostgresListCandidates requires a db with query()');
  return async ({ pendingOlderThan, pendingNewerThan, expiredNewerThan, pendingLimit, expiredLimit }) => {
    const pending = await db.query(PENDING_SQL, [namespace, pendingOlderThan, pendingNewerThan, pendingLimit]);
    const out = (pending.rows || []).map((r) => ({
      order_id: r.order_id, status: 'charge_pending', attempt: r.attempt ?? undefined, payment_id: null,
      charge_pending_at: r.charge_pending_at == null ? undefined : Number(r.charge_pending_at),
    }));
    if (expiredLimit > 0) {
      const expired = await db.query(EXPIRED_SQL, [namespace, RECONCILE_SETTLER_NAME, expiredNewerThan, expiredLimit]);
      for (const r of expired.rows || []) {
        out.push({ order_id: r.order_id, status: 'expired', payment_id: null, settled_at: r.settled_at == null ? undefined : Number(r.settled_at) });
      }
    }
    return out;
  };
}

// Kept equal to kernel.js RECONCILE_SETTLER (a test pins it), without importing the kernel into the lister.
export const RECONCILE_SETTLER_NAME = 'kernel_charge_pending_reconcile';

export const PENDING_SQL = `
  SELECT order_id, attempt, charge_pending_at FROM (
    SELECT k AS order_id,
           v ->> 'attempt' AS attempt,
           CASE WHEN jsonb_typeof(v -> 'charge_pending_at') = 'number'
                THEN (v -> 'charge_pending_at')::numeric END AS charge_pending_at
      FROM commerce_kv
     WHERE ns = $1
       AND v ->> 'status' = 'charge_pending'
       AND (v ->> 'payment_id') IS NULL
       AND (expires_at IS NULL OR expires_at > now())
  ) c
  WHERE c.charge_pending_at IS NOT NULL
    AND c.charge_pending_at <= $2
    AND c.charge_pending_at >= $3
  ORDER BY c.charge_pending_at ASC, c.order_id ASC
  LIMIT $4`;

export const EXPIRED_SQL = `
  SELECT order_id, settled_at FROM (
    SELECT k AS order_id,
           CASE WHEN jsonb_typeof(v -> 'settled_at') = 'number'
                THEN (v -> 'settled_at')::numeric END AS settled_at
      FROM commerce_kv
     WHERE ns = $1
       AND v ->> 'status' = 'expired'
       AND v ->> 'settled_by' = $2
       AND (v ->> 'payment_id') IS NULL
       AND (expires_at IS NULL OR expires_at > now())
  ) c
  WHERE c.settled_at IS NOT NULL
    AND c.settled_at >= $3
  ORDER BY c.settled_at DESC, c.order_id ASC
  LIMIT $4`;

/** The same list over an InMemoryKvStore (tests, and a non-durable dev gateway). */
export function makeInMemoryListCandidates(inMemoryStore) {
  return async ({ pendingOlderThan, pendingNewerThan, expiredNewerThan, pendingLimit, expiredLimit }) => {
    const pending = [];
    const expired = [];
    const m = inMemoryStore?._m;
    if (!m) return [];
    for (const [key, rec] of m) {
      const v = rec?.value;
      if (!v || typeof v !== 'object') continue;
      if (v.payment_id != null) continue;
      if (v.status === 'charge_pending' && Number.isSafeInteger(v.charge_pending_at)
        && v.charge_pending_at <= pendingOlderThan && v.charge_pending_at >= pendingNewerThan) {
        pending.push({ order_id: key, status: 'charge_pending', attempt: v.attempt, payment_id: null, charge_pending_at: v.charge_pending_at });
      } else if (v.status === 'expired' && v.settled_by === RECONCILE_SETTLER_NAME && Number.isSafeInteger(v.settled_at)
        && v.settled_at >= expiredNewerThan) {
        expired.push({ order_id: key, status: 'expired', payment_id: null, settled_at: v.settled_at });
      }
    }
    pending.sort((a, b) => a.charge_pending_at - b.charge_pending_at || (a.order_id < b.order_id ? -1 : 1));
    expired.sort((a, b) => b.settled_at - a.settled_at || (a.order_id < b.order_id ? -1 : 1));
    return [...pending.slice(0, pendingLimit), ...expired.slice(0, expiredLimit)];
  };
}

function bump(obj, key) { obj[key] = (obj[key] || 0) + 1; }
// The gateway's logger is pino (object first); a console-style logger takes the same call.
function logInfo(log, fields) { log?.info?.(fields, 'kernel charge_pending reconcile'); }
function logWarn(log, fields) { (log?.warn || log?.info)?.call(log, fields, 'kernel charge_pending reconcile'); }
