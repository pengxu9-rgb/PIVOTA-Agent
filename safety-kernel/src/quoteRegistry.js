// C2 — Quote registry. Implements INV-1 (quote-first), INV-5 (price/tax/ship & MoR lock).
// Backed by a KvStore (safety-kernel/src/stores.js): InMemoryKvStore by default, PostgresKvStore in
// production via the mount's storeFactory. All methods are async (durable backends are I/O).

import { randomUUID } from 'node:crypto';
import { PivotaCommerceError } from './errors.js';
import { InMemoryKvStore } from './stores.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Store records past their logical expiry briefly so resolveForOrder can return the precise
// QUOTE_EXPIRED (vs QUOTE_NOT_FOUND) error before the row is swept.
const EXPIRY_GRACE_MS = 5 * 60 * 1000;

export class QuoteRegistry {
  /** @param {{store?: object, ttlMs?: number, now?: () => number}} [opts] */
  constructor({ store, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this._ttlMs = ttlMs;
    this._now = now;
    this._store = store || new InMemoryKvStore({ now });
  }

  /**
   * Persist a quote returned by the upstream pricing call as an immutable snapshot.
   * The snapshot — NOT the model — is the source of truth for the charge.
   */
  async issue(input) {
    const quote_id = `q_${randomUUID()}`;
    const issued_at = this._now();
    const snapshot = {
      quote_id,
      user_ref: input.user_ref,
      acp_session_id: input.acp_session_id,
      merchant_of_record: input.merchant_of_record,
      currency: input.currency,
      upstream_quote_id: input.upstream_quote_id,
      locked_totals: { ...input.locked_totals },
      line_items: (input.line_items || []).map((i) => ({ ...i })),
      issued_at,
      expires_at: issued_at + this._ttlMs,
    };
    await this._store.set(quote_id, snapshot, { ttlMs: this._ttlMs + EXPIRY_GRACE_MS });
    return Object.freeze(snapshot);
  }

  /**
   * Resolve a quote for an order, enforcing existence, expiry, and linkage (INV-1 + §6).
   * @returns {Promise<object>} the snapshot
   */
  async resolveForOrder(quote_id, ctx) {
    if (!quote_id) throw new PivotaCommerceError('QUOTE_REQUIRED');
    const q = await this._store.get(quote_id);
    if (!q) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { quote_id });
    // Logical expiry is checked against the snapshot (precise error) even though the store row may
    // still be within its grace window.
    if (this._now() > q.expires_at) throw new PivotaCommerceError('QUOTE_EXPIRED', { quote_id });
    // Linkage: a quote belongs to one user and one ACP session. No cross-mixing.
    if (q.user_ref !== ctx.user_ref || q.acp_session_id !== ctx.acp_session_id) {
      throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { quote_id });
    }
    return q;
  }
}
