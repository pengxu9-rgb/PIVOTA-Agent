# Server mount + durable store — integration guide

Two production-green unblockers, delivered as self-contained, tested modules. The live
`src/server.js` now imports the mount dynamically on the strict checkout route, while strict-off
traffic still falls through to the legacy path.

## 1. The mount in src/server.js

```js
const { createCommerceMount } = await import('../safety-kernel/src/mount.js');
const db = require('./src/db'); // the repo's pool wrapper — exposes query()

// upstream(op, payload, headers) = the gateway's existing canonical forwarder.
const commerce = createCommerceMount({
  upstream,
  db,                                   // omit → in-memory stores (dev); present → Postgres
  secret: process.env.CONFIRMATION_SECRET,
  // strict defaults to AGENT_CHECKOUT_STRICT === '1'
  auditSink: (entry) => governanceLog.write(entry), // feeds the raw-log export path (Obs gate)
});

// On the strict /agent/shop/v1/invoke route, BEFORE the legacy path:
if (commerce.handles(operation)) {                 // only true in strict mode, money ops only
  const ctx = deriveStrictCommerceCtx(req);        // verified user_ref + acp_session_id only
  const out = await commerce.handle(operation, payload, ctx);
  return res.status(out.ok ? 200 : 422).json(out);
}
// ...otherwise fall through to the existing behavior, unchanged.
```

`commerce.mintConfirmation({ order_id }, ctx)` is the host-only call to make after the user acts on
the quote/confirmation UI; its result is the `confirmation_token` the pay step requires.

## 2. The flag

- `AGENT_CHECKOUT_STRICT=1` turns the safe path on. **Off (default): `handles()` returns false for
  every op, so the existing gateway behavior is byte-for-byte unchanged.** This is the safe rollout
  switch from `C3-reconciliation.md`.
- `CONFIRMATION_SECRET` (≥16 chars) is required in strict mode; the mount refuses to start without it.

## 3. The durable store

- `safety-kernel/src/stores/postgresKvStore.js` implements the `KvStore` contract over Postgres:
  - `putIfAbsent` is **atomic** via `INSERT … ON CONFLICT DO NOTHING RETURNING` (+ an expired-row
    claim `UPDATE`). This is the cross-instance guarantee the in-memory ref impl could only fake.
  - TTL via an `expires_at` column; reads filter it, `purgeExpired()` sweeps it.
  - One namespaced table backs quotes / idempotency / confirmations / orders / vault.
- Apply the migration through the repo runner: `src/db/migrations/052_commerce_kv.sql` via
  `node src/db/cli.js migrate`. The same SQL is also kept at
  `safety-kernel/migrations/050_commerce_kv.sql` for standalone kernel deployments.
- The store takes an injected `db` with `query(text, params)` — exactly what `src/db/index.js`
  exports — so the kernel never imports `pg` and stays unit-testable. Verified by
  `postgresKvStore.test.js` against a SQL-semantics fake (6 tests, incl. the atomic + reclaim paths).

## 4. Honest scope — what is and isn't deployed yet

**Delivered & tested now:**
- The Postgres `KvStore` adapter (atomic putIfAbsent + TTL) — 6 tests.
- The mount factory (assembles kernel + handler + audit, strict gating, identity, audit sink) is wired
  into `src/server.js` for strict money ops and tested.
- The kernel registries (`QuoteRegistry`, `IdempotencyLedger`, `ConfirmationTokenService`), order
  store, and quote-claim store consume the store factory. With `db` present, quote-first,
  confirmation, idempotency, and charge locks are durable across gateway instances.
- The raw-body payment webhook route is mounted before global `express.json()`.

**Still operationally gated:**
- Staging must run `node src/db/cli.js migrate` and then
  `DATABASE_URL=<staging postgres> node safety-kernel/scripts/validate-commerce-kv-staging.mjs`.
- `AGENT_CHECKOUT_STRICT=1`, `DATABASE_URL`, `CONFIRMATION_SECRET`, webhook secret, upstream auth,
  and invoke auth must be present in the deployed environment.
- The audit sink currently emits `agent_checkout_audit` log events; ops must prove those events reach
  the gateway-governance raw-log export before production `submit_payment` is enabled.

## 5. Definition-of-done progress (from readiness-to-green.md)
- [x] durable `KvStore` adapter implemented (Postgres) + atomicity tested
- [x] mount behind `/agent/shop/v1/invoke` available + strict-flag gated + tested
- [x] audit sink hook for the gateway-governance raw-log path
- [x] kernel registries/orders/quote claims use the durable store when `db` is present
- [ ] validate staging `commerce_kv` with real Postgres
- [ ] flip `AGENT_CHECKOUT_STRICT` on in staging, then production quote/order canary
- [ ] KMS-backed vault keys
- [ ] prove gateway-governance raw-log export contains redacted audit events
