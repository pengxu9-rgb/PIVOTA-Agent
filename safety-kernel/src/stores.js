// C-stores (Wave 3) — the durable-store seam.
//
// Every stateful piece of the kernel (quote registry, idempotency ledger, order registry,
// consumed-token set, token vault) is currently backed by an in-memory Map/Set. That is correct
// for a reference skeleton and WRONG for production: a process restart or a second instance loses
// or double-spends state. This module defines the minimal async interface those components must use
// so a durable backend (Postgres, Redis) can be swapped in without touching kernel logic.
//
// The reference InMemoryKvStore implements it so the current tests keep passing; a production
// adapter implements the same shape over a real store with the noted guarantees.

/**
 * KvStore — the contract. All methods are async (durable backends are I/O).
 *
 * Required production guarantees per method (documented, enforced by the backend, not here):
 *  - putIfAbsent: ATOMIC compare-and-set. Returns true iff the key was absent and is now set.
 *      This is what makes the idempotency ledger and single-use token consume safe across instances.
 *  - get/set/delete: standard.
 *  - withTtl: entries expire after ttlMs (quotes, confirmation jtis). May be emulated by storing
 *      an expiry and filtering on read; durable backends should use native TTL.
 *
 * @typedef {Object} KvStore
 * @property {(key:string)=>Promise<any|undefined>} get
 * @property {(key:string, value:any, opts?:{ttlMs?:number})=>Promise<void>} set
 * @property {(key:string, value:any, opts?:{ttlMs?:number})=>Promise<boolean>} putIfAbsent  // ATOMIC
 * @property {(key:string)=>Promise<boolean>} delete
 * @property {(key:string)=>Promise<boolean>} has
 */

/**
 * Reference in-memory KvStore. Single-process only. Implements the same async contract so the
 * kernel code is identical whether backed by this or by a durable adapter.
 */
export class InMemoryKvStore {
  /** @param {{now?: ()=>number}} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    /** @type {Map<string,{value:any, expiresAt?:number}>} */
    this._m = new Map();
  }

  // Process-local: state is NOT shared across instances and is lost on restart. The production composition
  // root (productionWiring) refuses to use this on the strict money path (charge-once needs shared state) —
  // durable backends mark `durable = true`.
  get durable() { return false; }

  _live(rec) {
    if (!rec) return false;
    if (rec.expiresAt != null && this._now() > rec.expiresAt) return false;
    return true;
  }

  async get(key) {
    const rec = this._m.get(key);
    if (!this._live(rec)) { this._m.delete(key); return undefined; }
    return rec.value;
  }

  async has(key) {
    return (await this.get(key)) !== undefined;
  }

  async set(key, value, { ttlMs } = {}) {
    this._m.set(key, { value, expiresAt: ttlMs != null ? this._now() + ttlMs : undefined });
  }

  /** ATOMIC in a single-threaded JS process: check-and-set with no await in between. */
  async putIfAbsent(key, value, { ttlMs } = {}) {
    const rec = this._m.get(key);
    if (this._live(rec)) return false;
    this._m.set(key, { value, expiresAt: ttlMs != null ? this._now() + ttlMs : undefined });
    return true;
  }

  /**
   * ATOMIC compare-and-set keyed on a token field: overwrite ONLY if the live record's
   * `value[matchField]` strict-equals `matchValue`. Returns true iff it set. Lets a claim owner
   * finalize/extend its OWN record without clobbering a different owner's reclaim.
   */
  async compareAndSet(key, matchField, matchValue, value, { ttlMs } = {}) {
    const rec = this._m.get(key);
    if (!this._live(rec)) return false;
    if (rec.value?.[matchField] !== matchValue) return false;
    this._m.set(key, { value, expiresAt: ttlMs != null ? this._now() + ttlMs : undefined });
    return true;
  }

  /** ATOMIC compare-and-delete: delete ONLY if the live record's `value[matchField]` matches. */
  async compareAndDelete(key, matchField, matchValue) {
    const rec = this._m.get(key);
    if (!this._live(rec)) return false;
    if (rec.value?.[matchField] !== matchValue) return false;
    return this._m.delete(key);
  }

  async delete(key) {
    return this._m.delete(key);
  }
}

/**
 * Production adapter checklist (documented here so the seam is unambiguous):
 *
 * Postgres:
 *  - putIfAbsent => INSERT ... ON CONFLICT DO NOTHING; RETURNING to detect the win.
 *  - TTL        => an expires_at column + a sweeper / partial index; filter on read.
 *  - idempotency ledger key => UNIQUE constraint so a duplicate write is rejected by the DB.
 *
 * Redis:
 *  - putIfAbsent => SET key val NX PX ttl (atomic).
 *  - TTL         => native PX/EX.
 *  - single-use token consume => the same SET NX is the consume.
 *
 * The kernel must treat putIfAbsent===false as "already happened" (replay / already-consumed),
 * never as an error to retry blindly.
 */
export const STORE_BACKEND_NOTES = Object.freeze({
  postgres: 'INSERT ON CONFLICT DO NOTHING for putIfAbsent; UNIQUE on idempotency_key; expires_at sweeper.',
  redis: 'SET NX PX for putIfAbsent + single-use consume; native TTL.',
});
