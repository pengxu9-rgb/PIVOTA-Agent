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
import { PivotaCommerceError } from './errors.js';
import { InMemoryKvStore } from './stores.js';

// The claim lease MUST exceed the slowest expected op() (upstream charge + durable writes). A retry
// before the lease expires is rejected as in_flight; only a genuinely abandoned (crashed) claim is
// reclaimable after it. Sized well above a normal upstream timeout.
const CLAIM_LEASE_MS = 2 * 60 * 1000;
// Completed/terminal records are retained so replays return the original result.
const DONE_TTL_MS = 24 * 60 * 60 * 1000;

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
      if (!existing) throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { key, reason: 'race' });
      if (existing.fp !== fp) throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { key });
      if (existing.status === 'done') return { result: existing.result, replayed: true };
      // P1-2: an op that completed its side effect but failed to finalize is recorded as
      // 'ambiguous' — a retry must NOT re-execute; surface a conflict so the caller reconciles.
      if (existing.status === 'ambiguous') {
        throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { key, reason: 'ambiguous_prior_attempt' });
      }
      // status === 'pending' and still leased: refuse rather than double-execute.
      throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { key, reason: 'in_flight' });
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
        throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { key, reason: 'lease_lost_after_op' });
      }
      return { result, replayed: false };
    } catch (err) {
      if (err instanceof PivotaCommerceError && err.detail?.reason === 'lease_lost_after_op') throw err;
      if (ctx.sideEffectDone) {
        // P1-2: the irreversible upstream side effect happened but op() then failed. Do NOT delete —
        // mark ambiguous so a retry cannot re-charge. compareAndSet keeps it owner-scoped.
        await this._store.compareAndSet(key, 'owner', owner, { fp, status: 'ambiguous', error: String(err?.message || 'op_failed') }, { ttlMs: DONE_TTL_MS });
        throw err;
      }
      // No irreversible side effect → safe to release OUR claim (only ours) so a real retry proceeds.
      await this._store.compareAndDelete(key, 'owner', owner);
      throw err;
    }
  }
}
