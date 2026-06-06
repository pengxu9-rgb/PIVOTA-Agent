# Backend ask — unblock one TEST-MODE Phase-3 charge (agent-checkout)

**To:** v2 backend / infra (`web-production-fedb`, the service behind gateway `pivota-agent-production`)
**From:** agent-checkout (the merchant-side protocol edge)
**Date:** 2026-06-03
**Priority:** blocks the final go-live confirmations (B1/B3/B4); does NOT block any code.

## Where we are

The merchant-side checkout edge (kernel + MCP/ACP surfaces + payment-auth verifier + normalized/Stripe/Adyen
webhooks) is code-complete, adversarially reviewed (10 Codex SHIP), ~398 tests green. Money units are confirmed
live: `preview_quote.pricing.total` and `create_order.amounts.total` are MAJOR decimal strings (e.g. `"28.24"`),
currency present — the kernel parses major→minor and cross-checks (probe run **26887266507**, green).

We need exactly **one test-mode end-to-end charge** to confirm the last three facts:
- **B1** — `submit_payment` charge wire is minor units.
- **B3** — a repeated `submit_payment` (same body) does NOT create a second charge (per-order PSP idempotency).
- **B4** — the PSP webhook finalizes the order (`charge_pending → paid`).

## The blocker (from the corrected Phase-3 runs)

With `preferred_psp` now sent on `create_order`, routing reaches the merchant PSP and fails with:
- Stripe (run **26889841816**): `409 PREFERRED_PSP_UNAVAILABLE` — *"Processor is configured for test, not live"* + *"Processor validation has not been run"*.
- Adyen (run **26889736245**): `409 PREFERRED_PSP_UNAVAILABLE` — *"Processor is configured for test, not live"*.

i.e. the **production** gateway's live-readiness policy correctly **refuses test-mode processors**. Merchant
`merch_efbc46b4619cfbdf` has Stripe + Adyen **test** accounts set, but the live route won't use them.

## The ask (pick the safest available; do NOT switch the merchant to live to test)

1. **Preferred — a test/staging backend env** that permits test-mode processors for `merch_efbc46b4619cfbdf`.
   Point the probe `PROBE_BASE` at it. This is what "test mode" actually requires.
2. **Run the Stripe processor validation** for the merchant (clears the *"validation has not been run"* blocker)
   — needed regardless of env.
3. **Only if 1 is impossible — a scoped, audited test-mode override** for this merchant/route. It MUST be
   probe-only (not live buyer traffic), explicit, default-off. ⚠️ An override that lets a test processor serve
   **live** buyers means orders get marked paid with no real charge → goods shipped unpaid. Do not put this on
   the live gateway with real traffic.

## What the webhook needs (so finalization works first try, once a charge goes through)

The edge's PSP webhook adapters are ready; for them to finalize the order, the backend/PSP config must set:
- **Stripe:** PaymentIntent `metadata.order_id` = the **kernel order id**; in Checkout-Session mode also set
  `payment_intent_data.metadata.order_id`. Webhook header `stripe-signature`; secret = merchant
  `provider_config.webhook_endpoint_secret` (fallback global `stripe_webhook_secret`). Finalization listens to
  `payment_intent.succeeded` (NOT `checkout.session.completed`, which can be `unpaid`).
- **Adyen:** `merchantReference` = the kernel order id; `pspReference` = the `payment_id` returned at
  `submit_payment`. Endpoint Basic Auth (user/pass) + per-item `additionalData.hmacSignature` (`adyen_webhook_secret`).

## Done =

A test-mode charge that returns `payment_status` + `payment_intent_id`/`pspReference`; a repeat `submit_payment`
that does NOT double-charge (B3); and the PSP **test** webhook flipping the order to paid (B4). Send those
results back and the edge side is confirmed end to end.

## Independent items (not blocked on the above)

- ⚠️ **Rotate the committed `ak_live_…` key** in `PAYMENT_TESTING_COORDINATION.md` and scrub it from git history.
- ⚠️ **Validate the Adyen HMAC** against one real Adyen dashboard test-notification before go-live (the adapter
  is implemented to spec + tested, but no real vector is in-repo).
