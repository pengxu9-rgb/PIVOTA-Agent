// Durable KvStore — Postgres adapter. Implements the same async contract as InMemoryKvStore
// (safety-kernel/src/stores.js) with the production guarantees the in-memory ref impl can only fake:
//
//   - putIfAbsent  ATOMIC via `INSERT ... ON CONFLICT DO NOTHING RETURNING` — the row either did not
//                  exist (we win, returns true) or it did (returns false). This is what makes the
//                  idempotency ledger and single-use confirmation token safe across processes/instances.
//   - TTL          an `expires_at` column; reads filter on it and a sweeper deletes expired rows.
//   - get/set/del  standard upsert/delete.
//
// The kernel never imports `pg` directly — you inject a thin `db` with a `query(text, params)` method
// (the repo's src/db/index.js already exposes exactly that). This keeps the kernel pure and testable.
//
// One physical table backs all namespaces (quotes, idempotency, confirmations, orders, vault):
//
//   CREATE TABLE IF NOT EXISTS commerce_kv (
//     ns          text        NOT NULL,
//     k           text        NOT NULL,
//     v           jsonb       NOT NULL,
//     expires_at  timestamptz NULL,
//     created_at  timestamptz NOT NULL DEFAULT now(),
//     PRIMARY KEY (ns, k)
//   );
//   CREATE INDEX IF NOT EXISTS commerce_kv_expires_idx ON commerce_kv (expires_at)
//     WHERE expires_at IS NOT NULL;
//
// See safety-kernel/migrations/050_commerce_kv.sql.

const TABLE = 'commerce_kv';

// Defensive JSONB decode. Postgres JSONB columns SHOULD come back already parsed (node `pg` registers
// a default jsonb parser), but this org has been bitten 3× by drivers/pools that return JSONB as a
// STRING (no global JSON codec) — and on this money path that would corrupt the idempotency ledger
// (e.g. `existing.status` undefined) → double charge. So we decode regardless of pool config: a parsed
// object/number passes through; an un-parsed JSON string is parsed; a value that isn't JSON is returned
// as-is. Verified safe (Codex fact-check) for every value the stores persist today: quotes/orders/
// idempotency/charge-lock (objects), confirmation jti (number 1), and bare strings.
// CAVEAT: do NOT store a value that is itself a JSON-looking STRING (e.g. the literal `'{"a":1}'`) —
// a pg-parsed read returns that string and decodeJsonb would parse it into an object. No current
// money-path value does this; keep it that way (store objects/numbers, never JSON-as-a-string).
function decodeJsonb(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

export class PostgresKvStore {
  /**
   * @param {{ db: { query: (text:string, params:any[]) => Promise<{rows:any[]}> },
   *           namespace: string, now?: () => number }} opts
   */
  constructor({ db, namespace, now = () => Date.now() }) {
    if (!db || typeof db.query !== 'function') throw new Error('PostgresKvStore requires a db with query()');
    if (!namespace) throw new Error('PostgresKvStore requires a namespace');
    this._db = db;
    this._ns = namespace;
    this._now = now;
  }

  // Durable, cross-instance shared state (atomic putIfAbsent/CAS via Postgres). The production wiring
  // requires `durable === true` on the strict money path.
  get durable() { return true; }

  _expiresAt(ttlMs) {
    return ttlMs != null ? new Date(this._now() + ttlMs).toISOString() : null;
  }

  async get(key) {
    const { rows } = await this._db.query(
      `SELECT v FROM ${TABLE} WHERE ns = $1 AND k = $2 AND (expires_at IS NULL OR expires_at > to_timestamp($3))`,
      [this._ns, key, this._now() / 1000],
    );
    return rows[0] ? decodeJsonb(rows[0].v) : undefined;
  }

  async has(key) {
    return (await this.get(key)) !== undefined;
  }

  async set(key, value, { ttlMs } = {}) {
    await this._db.query(
      `INSERT INTO ${TABLE} (ns, k, v, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (ns, k) DO UPDATE SET v = EXCLUDED.v, expires_at = EXCLUDED.expires_at`,
      [this._ns, key, JSON.stringify(value), this._expiresAt(ttlMs)],
    );
  }

  /**
   * ATOMIC compare-and-set. Returns true iff the key was absent (or expired) and is now ours.
   * The single source of cross-instance idempotency + single-use safety.
   */
  async putIfAbsent(key, value, { ttlMs } = {}) {
    // First try a clean insert; if a LIVE row exists it conflicts and we lose.
    const insert = await this._db.query(
      `INSERT INTO ${TABLE} (ns, k, v, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (ns, k) DO NOTHING
       RETURNING k`,
      [this._ns, key, JSON.stringify(value), this._expiresAt(ttlMs)],
    );
    if (insert.rows.length > 0) return true;

    // A row exists. If it is EXPIRED, atomically claim it; otherwise we lose.
    const claim = await this._db.query(
      `UPDATE ${TABLE} SET v = $3, expires_at = $4, created_at = now()
       WHERE ns = $1 AND k = $2 AND expires_at IS NOT NULL AND expires_at <= to_timestamp($5)
       RETURNING k`,
      [this._ns, key, JSON.stringify(value), this._expiresAt(ttlMs), this._now() / 1000],
    );
    return claim.rows.length > 0;
  }

  /**
   * ATOMIC compare-and-set keyed on a JSON field. Overwrites only if the LIVE row's v->>matchField
   * equals matchValue. One UPDATE statement → Postgres row-locks and only one writer can win.
   */
  async compareAndSet(key, matchField, matchValue, value, { ttlMs } = {}) {
    const { rows } = await this._db.query(
      `UPDATE ${TABLE} SET v = $5, expires_at = $6
       WHERE ns = $1 AND k = $2 AND (v ->> $3) = $4
         AND (expires_at IS NULL OR expires_at > to_timestamp($7))
       RETURNING k`,
      [this._ns, key, matchField, String(matchValue), JSON.stringify(value), this._expiresAt(ttlMs), this._now() / 1000],
    );
    return rows.length > 0;
  }

  /** ATOMIC compare-and-delete on a JSON field. */
  async compareAndDelete(key, matchField, matchValue) {
    const { rows } = await this._db.query(
      `DELETE FROM ${TABLE} WHERE ns = $1 AND k = $2 AND (v ->> $3) = $4 RETURNING k`,
      [this._ns, key, matchField, String(matchValue)],
    );
    return rows.length > 0;
  }

  async delete(key) {
    const { rows } = await this._db.query(
      `DELETE FROM ${TABLE} WHERE ns = $1 AND k = $2 RETURNING k`,
      [this._ns, key],
    );
    return rows.length > 0;
  }

  /** Sweep expired rows for this namespace (call from a cron; reads already ignore expired rows). */
  async purgeExpired() {
    await this._db.query(
      `DELETE FROM ${TABLE} WHERE ns = $1 AND expires_at IS NOT NULL AND expires_at <= to_timestamp($2)`,
      [this._ns, this._now() / 1000],
    );
  }
}
