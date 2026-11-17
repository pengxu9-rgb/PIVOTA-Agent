// C2 — Idempotency ledger. Implements INV-4.
// Same key + same request body => the original result, never a duplicate write.
// Same key + DIFFERENT body => IDEMPOTENCY_CONFLICT.
//
// Backed by a KvStore whose putIfAbsent / compareAndSet / compareAndDelete are ATOMIC (Postgres:
// INSERT ON CONFLICT / conditional UPDATE / conditional DELETE). The cross-instance guarantee:
//
//   1. Claim the key atomically with an OWNER token + a generous lease TTL.
//   2. Run the side-effecting op().
//   3. Finalize the result with compareAndSet — ONLY if WE still own the claim. If our lease expired
//      and another caller reclaimed it, our finalize/cleanup no-ops instead of clobbering them.
//
// This closes Codex P0-1 (claim could expire mid-op then a retry double-executes) and P1-1 (failure
// path deleted whatever was there, including a different owner's live claim).

import { createHash, randomUUID } from 'node:crypto';
import { IDEMPOTENCY_CONFLICT_ANSWERS, PivotaCommerceError, idempotencyConflict, kernelOutcomeUnknown, kernelOutcomeUnknownOf } from './errors.js';
import { InMemoryKvStore } from './stores.js';

// The claim lease MUST exceed the slowest expected op() (upstream charge + durable writes). A retry
// before the lease expires is rejected as in_flight; only a genuinely abandoned (crashed) claim is
// reclaimable after it. Sized well above a normal upstream timeout.
const CLAIM_LEASE_MS = 2 * 60 * 1000;
// Completed/terminal records are retained so replays return the original result.
const DONE_TTL_MS = 24 * 60 * 60 * 1000;
// A key whose earlier attempt made an irreversible call and then failed: its words, on every door.
export const AMBIGUOUS_PRIOR_ATTEMPT = 'ambiguous_prior_attempt';
export const AMBIGUOUS_PRIOR_ATTEMPT_MESSAGE = IDEMPOTENCY_CONFLICT_ANSWERS[AMBIGUOUS_PRIOR_ATTEMPT].message;

function fingerprint(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export class IdempotencyLedger {
  /** @param {{store?: object, now?: () => number}} [opts] */
  constructor({ store, now = () => Date.now() } = {}) {
    this._now = now;
    this._store = store || new InMemoryKvStore({ now });
  }

  /**
   * Run `op` exactly once per (key, body). On replay returns the stored result.
   * @returns {Promise<{result:any, replayed:boolean}>}
   */
  async run(key, body, op) {
    if (typeof key !== 'string' || key.trim().length < 8) {
      throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { reason: 'missing_or_short_key' });
    }
    const fp = fingerprint(body);
    const owner = randomUUID(); // this attempt's ownership token

    const claimed = await this._store.putIfAbsent(
      key,
      { fp, status: 'pending', owner, claimed_at: this._now() },
      { ttlMs: CLAIM_LEASE_MS },
    );

    if (!claimed) {
      const existing = await this._store.get(key);
      // The key was held a moment ago (the claim above lost) and no longer is: that attempt's outcome is not known here.
      if (!existing) throw idempotencyConflict('race', { key });
      if (existing.fp !== fp) throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { key });
      if (existing.status === 'done') return { result: existing.result, replayed: true };
      // P1-2: an op that completed its side effect but failed to finalize is recorded as
      // 'ambiguous' — a retry must NOT re-execute; surface a conflict so the caller reconciles.
      if (existing.status === 'ambiguous') {
        // An attempt that was answered with the kernel's own unknown outcome (errors.js kernelOutcomeUnknown) is
        // answered the same way again, with the same order id: the caller learns what the first answer said, not a
        // generic conflict.
        const unknown = kernelOutcomeUnknownOf(kernelOutcomeUnknownRecord(existing.outcome_unknown));
        if (unknown) throw kernelOutcomeUnknown(unknown.reason, unknown.order_id, { answered: unknown.answered });
        // This key's earlier attempt did something irreversible and then failed, so it may have taken effect. Said in its
        // own words, which every door surfaces; the code stays.
        throw idempotencyConflict(AMBIGUOUS_PRIOR_ATTEMPT, { key });
      }
      // status === 'pending' and still leased: refuse rather than double-execute. The attempt holding the key has not
      // finished, so it may yet make the order: said so, never "a different request".
      throw idempotencyConflict('in_flight', { key });
    }

    // We own the key. Mark whether the op performed an irreversible side effect so the catch path
    // can tell "never charged" (safe to release) from "charged but bookkeeping failed" (ambiguous).
    const ctx = { sideEffectDone: false };
    try {
      const result = await op(ctx);
      // Finalize ONLY if we still own the claim (our lease may have lapsed under a very slow op).
      const finalized = await this._store.compareAndSet(key, 'owner', owner, { fp, status: 'done', result }, { ttlMs: DONE_TTL_MS });
      if (!finalized) {
        // Someone reclaimed our key. We must not double-charge; the op already ran, so this is a
        // genuine ambiguous overlap — record it (best-effort) and reject this attempt.
        throw idempotencyConflict('lease_lost_after_op', { key });
      }
      return { result, replayed: false };
    } catch (err) {
      if (err instanceof PivotaCommerceError && err.detail?.reason === 'lease_lost_after_op') throw err;
      if (ctx.sideEffectDone) {
        // P1-2: the irreversible upstream side effect happened but op() then failed. Do NOT delete —
        // mark ambiguous so a retry cannot re-charge. compareAndSet keeps it owner-scoped.
        // The kernel's own unknown-outcome answer is kept beside it ({ reason, order_id, answered? }, nothing else), so a
        // same-key retry is given that answer again.
        const unknown = kernelOutcomeUnknownOf(err);
        await this._store.compareAndSet(key, 'owner', owner, { fp, status: 'ambiguous', error: String(err?.message || 'op_failed'), ...(unknown ? { outcome_unknown: unknown } : {}) }, { ttlMs: DONE_TTL_MS });
        throw err;
      }
      // No irreversible side effect → safe to release OUR claim (only ours) so a real retry proceeds.
      await this._store.compareAndDelete(key, 'owner', owner);
      throw err;
    }
  }
}

// A stored `{ reason, order_id, answered? }` read back as the answer it was made from (null for anything else), so a record that
// was not written by this ledger can never name a reason or an order the kernel did not.
function kernelOutcomeUnknownRecord(stored) {
  if (!stored || typeof stored !== 'object') return null;
  try {
    return kernelOutcomeUnknown(stored.reason, stored.order_id, { answered: stored.answered });
  } catch {
    return null;
  }
}
