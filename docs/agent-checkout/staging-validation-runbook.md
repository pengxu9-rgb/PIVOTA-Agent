# Agent Checkout — Staging Validation Runbook

The "staging first" path before any prod money op. Retires the only real risk left — the durable
store + kernel money path have never run against a real Postgres — without touching real money.

## Why this exists
- `PostgresKvStore` was tested only against a SQL-semantics fake. Real `pg`/pool behavior (esp. JSONB
  decoding, `to_timestamp` epoch math, `ON CONFLICT` atomicity) must be confirmed against real SQL.
- The store now **defensively decodes JSONB** (`decodeJsonb` in `postgresKvStore.js`) so a pool that
  returns jsonb as a string can't corrupt the idempotency ledger → no double-charge from that trap.
  Staging confirms it against the actual pool.

## Step 1 — store + money path against a real (staging) Postgres  [no money, no merchant, no PSP]
```bash
DATABASE_URL=postgres://user:pass@STAGING-host:5432/db \
  node safety-kernel/scripts/validate-commerce-kv-staging.mjs
```
What it does (every row it writes is under a unique throwaway `validate_<ts>%` namespace — incl. the
mount's quote/order/idempotency/confirmation rows via `namespacePrefix` — and the `finally` cleanup
deletes exactly that prefix, so it never touches real data even on early failure; STUB upstream):
- applies migration `052_commerce_kv.sql` through the repo runner, or
  `safety-kernel/migrations/050_commerce_kv.sql` in standalone kernel validation;
- verifies JSONB round-trips as an OBJECT on the real pool (the trap);
- verifies atomic `putIfAbsent` (first wins / second loses), owner-scoped `compareAndSet/Delete`, TTL;
- runs a full `quote → order → confirm → pay` through `createCommerceMount({ db })` against real SQL.

It REFUSES a `DATABASE_URL` matching `prod`/`production`/`prd` unless `ALLOW_PROD_VALIDATION=1` (defense
in depth — the namespace isolation above is the real safety). Expect:
`VALIDATION PASSED — durable store + money path verified against real Postgres.`

## Step 2 — staging end-to-end with a TEST merchant + PSP test mode
- Apply repo migration 052 to the staging DB the gateway actually uses.
- Wire `createCommerceMount({ upstream, db, secret, auditSink })` into the staging
  `/agent/shop/v1/invoke` handler (one block — `server-mount-and-durable-store.md`).
- Set `CONFIRMATION_SECRET`; for the vault, a `StaticKeyProvider` is fine in staging (KMS in prod).
- Use a **dedicated test merchant** and **PSP test mode** (`MODE=test`, test card numbers) — the
  readiness runbook already mandates this "to avoid real transactions."
- Flip `AGENT_CHECKOUT_STRICT=1` on staging only.
- Drive the real flow from a Claude/ChatGPT/Gemini adapter (or curl the canonical envelope): search →
  preview_quote → create_order → (confirm) → submit_payment → get_order_status. Confirm:
  - amounts come from the quote (try tampering `expected_amount` → `PRICE_CHANGED`);
  - pay without a confirmation token is refused;
  - a replayed idempotency key does not double-create / double-charge;
  - the audit trail lands (redacted) and the readiness scorecard is green.

## Step 3 — read-only prod canary
Point ONLY the non-mutating ops (`find_products`, `get_product_detail`, `preview_quote`) at real prod
(this repo already has `probe:commerce-core:prod-canary`, read-only). Validates real upstream + real
identity wiring with zero money risk. Do NOT enable create_order/submit_payment in prod yet.

## Step 4 — prod money path, test merchant first
Only after 1–3 are green: enable the money path in prod scoped to a **test merchant + PSP test mode**.
Watch the audit log + scorecard. Then, and only then, open it to real merchants.

## Rollback
`AGENT_CHECKOUT_STRICT=0` instantly reverts to the legacy pass-through path (byte-for-byte unchanged) —
the mount's `handles()` returns false for everything, so no money op routes through the kernel.

## Gate before each promotion
`node .github/scripts/assert-money-path-test-floors.mjs` (or the CI workflow) must be green:
safety-kernel ≥107, mcp-server ≥45, connectors ≥15.
