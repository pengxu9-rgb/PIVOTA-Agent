# Backend ask — unblock the TEST-mode MCP charge canary (B1/B3/B4)

**To:** pivota-backend / infra · **From:** agent-checkout (merchant-side protocol edge) · **Date:** 2026-06-21
**Blocks:** the final go-live confirmation before `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=1` on prod. Does NOT block code.

## Where we are
The checkout edge is code-complete; the **create-order canary is green** (strict quote → unpaid order,
`submit_payment=false`). Prod gateway posture verified: `AGENT_CHECKOUT_STRICT=1`,
`AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=0`, `IDENTITY_ISSUERS_JSON`/`PAYMENT_ISSUERS_JSON`/`DATABASE_URL`/
`CONFIRMATION_SECRET` set. The last gate is **one Stripe TEST-mode end-to-end charge** to confirm:
- **B1** — `submit_payment` charge wire is **minor units**
- **B3** — repeated `submit_payment` (same idempotency key) creates **no second charge**
- **B4** — the signed PSP webhook finalizes `charge_pending → paid`

## The blocker
The prod gateway correctly refuses test processors: `create_order` with `preferred_psp` → `409
PREFERRED_PSP_UNAVAILABLE` ("Processor is configured for test, not live" / "Processor validation has not been
run"). Merchant `merch_efbc46b4619cfbdf` has Stripe **test** accounts, but the live route won't use them.

## The ask (prefer the safest; do NOT switch the merchant to live)
1. **Preferred — a staging/test backend env** that permits test-mode processors for `merch_efbc46b4619cfbdf`.
   There is a `pivota-ap2-staging` Railway project — can the agentic-commerce gateway + backend run there
   against Stripe **test** keys? Point the canary `PROBE_BASE` at it → zero money risk.
2. **Run Stripe processor validation** for the merchant (clears "validation has not been run") — needed
   regardless of env. *(Stripe dashboard action — not settable via env.)*
3. **Only if 1 is impossible — a scoped, audited test-PSP override:** `ALLOW_TEST_PSP_PROBE=1` + **allowlist**
   `merch_efbc46b4619cfbdf`, **probe-only, default-off**. ⚠️ Never on the live gateway with real buyer traffic
   — a test processor serving live buyers marks orders paid with **no real charge** (goods shipped unpaid).
   *(The merchant allowlist is backend app logic, not just an env flag.)*

## Webhook config so B4 finalizes first try
- **Stripe:** PaymentIntent `metadata.order_id` = the **kernel** order id (Checkout-Session mode: also
  `payment_intent_data.metadata.order_id`); webhook secret = merchant `provider_config.webhook_endpoint_secret`
  (fallback global `stripe_webhook_secret`); finalize on `payment_intent.succeeded`.

## How we run it once unblocked (gateway side ready)
`scripts/probe_pure_mcp_paid_canary.mjs` drives `/mcp` create → complete with a signed identity JWT + payment
grant. Canary issuer keypairs are generated (`scripts/gen_mcp_canary_keys.mjs`); the public issuer objects get
appended to the **staging** gateway's `IDENTITY_ISSUERS_JSON`/`PAYMENT_ISSUERS_JSON` (not prod). Evidence is
validated by `scripts/validate_paid_canary_evidence.mjs` (template:
`docs/agent-checkout/paid-canary-evidence.template.json`) before any prod flag flip. Full procedure:
`docs/agent-checkout/MCP_CHARGE_CANARY_RUNBOOK.md`.

**Done =** a TEST-mode charge returning `payment_status` + `payment_intent_id`; a same-key replay that does NOT
double-charge; the webhook flipping the order to paid. Reply with the env to target (or confirm option 3).
