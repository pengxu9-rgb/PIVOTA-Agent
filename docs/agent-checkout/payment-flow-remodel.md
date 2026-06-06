# Payment-flow re-model — scoped follow-up (submit_payment vs the real backend)

The normalization adapter (`upstreamAdapter.js`) makes `preview_quote` → `create_order` work against the
real backend contract. `submit_payment` is deliberately NOT normalized there, because the real payment
response isn't just a different shape — it's a different **flow**, and naively mapping it would create a
**double-charge window**. This doc scopes the re-model. **Do not enable `submit_payment` against the real
backend until this lands.**

## What the real backend actually does (from `tests/integration/submit_payment_contract.test.js`)
`submit_payment` returns a **checkout-session / client-confirmation** model, not a synchronous result:
- `payment_status`: `processing` | `requires_action` | `payment_failed` | `unknown` | (rarely sync `succeeded`)
- `confirmation_owner`: `backend` | `client` — WHO finishes the charge
- `requires_client_confirmation`: boolean — if true, the browser/app must complete it with `client_secret`
- `payment_action`: `{ type: 'redirect_url'|'stripe_client_secret'|'checkout_session', url, client_secret, submit_owner, component_kind, supported_in_shopping_ui }`
- `checkout_session_id`, `payment_intent_id`, `psp`
- Actual success typically arrives **later, via webhook** — not in the submit response.

## What our kernel assumes today (the mismatch)
`SafetyKernel.submitPayment` reads `r.payment_id / payment_status / redirect_url / qr_code / instructions /
ap2_state` and:
- marks the order `paid` ONLY on a synchronous `payment_status === 'succeeded'`;
- **releases the per-order charge lock on ANY non-succeeded status** (incl. `processing`/`requires_action`).

## The danger (why this is P0 if shipped naively)
Real submit returns `processing`/`requires_action` (charge in flight, completes via webhook). Our kernel
treats that as "not succeeded" → **releases the charge lock** → a second `submit_payment` for the same
order can claim the lock and charge again while the first is still pending. **Double charge.** Plus the
user gets a broken `requires_action` with `redirect_url: undefined` (the URL is under `payment_action.url`).

## The re-model (scoped)
1. **Normalize the submit response** (extend `upstreamAdapter.js`):
   - `payment_id` ← `payment_intent_id` ?? `checkout_session_id`
   - `redirect_url` ← `payment_action.url` when `payment_action.type === 'redirect_url'`
   - `client_secret` ← `payment_action.client_secret` (pass through for client-side confirm; NEVER log)
   - carry `confirmation_owner`, `requires_client_confirmation`, `payment_status`
2. **Order state machine**: `created → charge_pending → (paid | failed)` instead of `created → paid`.
   - `processing`/`requires_action` ⇒ `charge_pending`.
3. **Charge guard — DURABLE STATUS FIRST (the safety-critical fix, per Codex review)**:
   - Acquire the per-order lock, then read the order + status guard UNDER the lock (closes the
     read-before-lock TOCTOU). The lock's only job is to serialize the brief read→write-`charge_pending`
     window — it is NOT the durable guard, and it is released in `finally`.
   - **Write `charge_pending` (with this attempt's id) BEFORE the upstream charge call.** This is what
     makes a slow charge (outliving the lock TTL) or an ambiguous timeout (PSP accepted, socket died)
     unable to re-charge: any retry sees the durable `charge_pending` and is rejected, regardless of the
     lock. If the charge THROWS, the order STAYS `charge_pending` (fail closed — reconciliation may be
     needed) rather than reopening.
   - On terminal **failure** ⇒ `failed` (legit retry allowed). On terminal **success** (sync or webhook)
     ⇒ `paid` (sticky, never re-charge). In-flight ⇒ stays `charge_pending`, record `payment_id`.
   - A second `submit_payment` while `paid`/`charge_pending` ⇒ rejected (`IDEMPOTENCY_CONFLICT`).
4. **Webhook ingestion** (new): `kernel.onPaymentWebhook({ order_id, status, ... }, verify)` — verifies the
   PSP/backend webhook signature, idempotently transitions the order to `paid`/`failed`, and finalizes
   the charge lock. Must be idempotent (webhooks retry) and ordering-tolerant.
5. **Client-confirmation hand-off**: when `confirmation_owner === 'client'`, surface `client_secret` +
   `payment_action` to the adapter UI (Apps SDK component / MCP-UI / Gemini surface) so the user completes
   the charge client-side; the kernel waits for the webhook, it does NOT mark paid on submit.

## Adversarial review
This is the charge path and it changes the charge-once invariant under concurrency + async — run the
Claude↔Codex review loop on it (both directions), with regression tests for: pending-doesn't-release-lock,
second-submit-during-pending-rejected, webhook-marks-paid-idempotently, webhook-after-failure-vs-success
ordering.

## STATUS: IMPLEMENTED (2026-06-01) — pending adversarial review
- Adapter: `normalizeSubmitPayment` maps `payment_action`/`payment_intent_id`/`checkout_session_id` →
  `redirect_url`/`client_secret`/`payment_id`, carries `confirmation_owner`/`requires_client_confirmation`.
- Kernel: `classifyPaymentStatus` + order state machine (`created → charge_pending → paid|failed`);
  **lock-first** submitPayment (status guard under the lock, closes the TOCTOU); a `charge_pending`
  order rejects a new submit; lock released in `finally` (durable status is the guard).
- Kernel: `onPaymentWebhook({order_id,status})` — verified-event-in, idempotent, ordering-tolerant,
  paid is sticky. Caller MUST verify the webhook signature first.
- Tests: `test/paymentRemodel.test.js` — pending-doesn't-double-charge, second-submit-during-pending
  rejected, webhook success/failure/idempotent/sticky/unknown, concurrent-charges-once, sync-success
  backward compat.
- Redaction: `client_secret` added to the sensitive-key set.

## Status of the remaining pay-enablement items
- [x] **Adversarial Codex review of the kernel charge-path change** — done; 3 P0s found + fixed
  (`FINAL_REVIEW_PaymentRemodel.md`).
- [x] **Webhook endpoint** — `webhookHandler.js` (`createPaymentWebhookHandler`): verifies the HMAC
  signature over the RAW body BEFORE parsing/calling the kernel (forged/missing → 401, kernel not
  called), parses the event (default + injectable PSP parser), drives `onPaymentWebhook`. Wire it to a
  raw-body route at `/agent/shop/v1/payment-webhook`. Tested (`webhookHandler.test.js`).
- [x] **Reconciliation sweeper** — `reconcile.js` (`reconcilePendingOrders`): finds orders pending past
  `maxAgeMs`, queries the PSP for the true status, drives `onPaymentWebhook` to resolve. Store-agnostic
  (inject `listPending` + `queryStatus`); in-memory reference + documented Postgres query. The kernel
  now stamps `charge_pending_at` for age filtering. Tested (`reconcile.test.js`). Run from a cron.
- [x] **Webhook/reconcile adversarial review** — in progress.

### Still genuinely open (need backend/ops input, not code)
- **Money-units decision** (preview_quote major-unit strings vs create_order minor-unit ints) — confirm
  with the backend + standardize (ideally minor-unit integers end to end).
- **Lock-TTL vs charge-call timeout**: confirm the synchronous submit call returns well within
  `CHARGE_LOCK_TTL_MS` (2 min) in production.
- **Wire-in**: mount the webhook route + schedule the reconcile cron in `src/server.js`; set
  `PAYMENT_WEBHOOK_SECRET`; provide the PSP `queryStatus` client.
