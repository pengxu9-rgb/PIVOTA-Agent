# Agent-Checkout — Go-Live Checklist (single source of truth)

**What this is:** the one executable, owner-assigned checklist to take agent-mediated checkout to
production safely. Supersedes the scattered status in `PROGRAM_SUMMARY.md` / `readiness-to-green.md` for
the GO-LIVE view (those remain for architecture + scorecard-dimension detail).

**One-line status (2026-06-06):** strict checkout is enabled in staging and production, production
`submit_payment` is still disabled, and the baseline non-charge rollout gates are green. Evidence is
recorded in `STRICT_PROD_ROLLOUT_EVIDENCE_20260606.md`. Everything left before production pay traffic is
**strict create-order canary, credential hygiene, manual Stripe test-mode paid canary,
refund/status/webhook validation, and final observability export proof**.

**Legend:** ✅ done · 🟡 ready, waiting on an external party · ⛔ blocked by a dependency

---

## A. Kernel safety — ✅ DONE (owner: Claude; verified)
| # | Gate | Evidence |
|---|---|---|
| A1 | INV-1..5 enforced (quote-first, server-side amount, host-minted confirmation, idempotency/single-use, price+MoR lock, charge-once) | `kernel.js`; Wave-1 review; `kernel.test.js` |
| A2 | Idempotency ledger + atomic per-order charge-lock (multi-instance safe) | `idempotencyLedger.js`, `multiInstance.test.js`, `raceFixes.test.js` |
| A3 | Async payment re-model (lock-first `charge_pending` BEFORE charge; webhook completion; reconcile sweeper; correlation required) | `payment-flow-remodel.md`, `paymentRemodel.test.js`, `webhookHandler.js`, `reconcile.js` |
| A4 | Durable Postgres stores (atomic putIfAbsent + CAS + TTL) + repo migration 052 | `stores/postgresKvStore.js`, `safety-kernel/migrations/050_commerce_kv.sql`, `src/db/migrations/052_commerce_kv.sql` |
| A5 | PCI SAQ-A token vault on KMS (envelope encryption, rotation, PAN guard) | `vault/`, `keyProvider.js`, `keyProvider.test.js` |
| A6 | Money = canonical **minor-unit integers**; cross-check on amount + currency + precision + divisibility; fail-closed | `money.js`, `upstreamAdapter.js`, FINAL_REVIEW_MoneyUnits(+_Round2) |
| A7 | Real-backend normalization adapter (pricing strings→minor, nested order_id, payment_action) | `upstreamAdapter.js`, `assembled.integration.test.js` |
| A8 | Money-path CI gate (3 suites + test-count floor, no silent deletion) | `.github/workflows/agent-checkout-money-path-gate.yml` |

---

## B. Confirmation gates — 🟡 PARTIAL GREEN; PAID CANARY STILL MANUAL
The no-charge executable probe `scripts/probe_wire_format.mjs` has run in GitHub Actions against
production (`27059885995`). It confirmed the live v2 backend and `create_order` totals as major-unit
decimal strings with currency present. `submit_payment` remains disabled, so terminal PSP behavior still
requires the manual Phase-3 canary in `PROBE_RUNBOOK.md`.
| # | Confirm | Why it blocks | Our default assumption |
|---|---|---|---|
| B1 | `submit_payment` remains structurally disabled until a manual canary proves PSP amount forwarding | the charge amount | pending manual test-mode canary |
| B2 | `create_order.amounts.total` unit and currency | kernel order cross-check | confirmed as major-unit decimal string with currency present |
| B3 | charge to PSP carries a per-order idempotency key | closes the residual double-charge-on-retry + `no_payment_id` crash-window risk | pending manual paid replay/dashboard proof |
| B4 | Webhook PSP + signing secret/header + order/payment-id correlation field | needed to wire completion webhook + reconcile | pending live webhook observation |
| B5 | Which backend version is live | changes B1/B2 answers | confirmed v2 |
| B6 | `CHARGE_LOCK_TTL_MS` (2 min) exceeds the real charge-call worst-case timeout | a too-short TTL could let a slow charge's lock expire | 2 min |

---

## C. Integration / wire-in — 🟡 GATEWAY OWNER / OPS
Reference details: `src/server.js`, `src/serverWireIn.example.js`, and
`server-mount-and-durable-store.md`.
| # | Step | Blocked on |
|---|---|---|
| C1 | Mount `createCommerceMount` behind `/agent/shop/v1/invoke` for money ops, `AGENT_CHECKOUT_STRICT`-gated; non-money ops fall through | ✅ done in `src/server.js` |
| C2 | Mount the signed payment-webhook route with a **raw-body** parser (before any global `express.json()`) | ✅ route mounted; still needs live PSP secret/header confirmation |
| C3 | Schedule the reconcile cron + provide the PSP `queryStatus` client (authoritative, null-on-unknown) | B4 |
| C4 | Wire a compensating upstream **cancel/void** for post-create cross-check failures (orphan cleanup) | backend cancel API |
| C5 | Derive `ctx` (`user_ref`, `acp_session_id`) from **verified auth only**, never the request body | ✅ done in strict route |

---

## D. Ops / secrets — 🟡 PARTIAL GREEN
| # | Step |
|---|---|
| D1 | Staging and production have durable gateway DB config; keep validating `commerce_kv` before each pay enablement. |
| D2 | `CONFIRMATION_SECRET` is set in production. `PAYMENT_WEBHOOK_SECRET` and KMS/PSP rotation evidence remain pay-gate prerequisites. |
| D3 | Export the audit sink → the `gateway-governance` raw-log path (the hook exists; point it) |
| D4 | Rotate Stripe test and Shopify credentials if the pre-redaction readiness artifact bundle was shared outside the local workspace. |

---

## E. Rollout — 🟡 STRICT ON; PAY DISABLED
| # | Step |
|---|---|
| E1 | `AGENT_CHECKOUT_STRICT=1` is enabled in staging and production. |
| E2 | Production `submit_payment` kill switch is green: fake pay probe returns HTTP `405 OPERATION_NOT_ALLOWED`. |
| E3 | Strict identity gate is green in GitHub Actions run `27060426512`. |
| E4 | No-charge wire-format probe is green in GitHub Actions run `27059885995`. |
| E5 | Strict create-order canary is pending on the target-gateway test-identity window. Run `agent-checkout-wire-format-probe.yml` with `run_strict_create_order_canary=true` during a short `AGENT_CHECKOUT_ALLOW_TEST_IDENTITY=1` window, then close the window. Latest run `27066147463` auto-selected products and failed at `preview_quote` with `401 USER_AUTH_REQUIRED`; no `create_order` was attempted. |
| E6 | Enable `submit_payment` **LAST**, only after manual paid canary, refund cap, webhook/status sync, replay, and observability export are green. |

---

## Critical path (who unblocks what)
```
B (backend probe)  ──►  D (ops/secrets)  ──►  E (staged rollout)
   confirms units/idempotency/webhook facts       secrets + DB + raw logs       pay enabled only
                                                  after B1+B2+B3
```
Gateway wire-in is no longer the long pole. Action now: keep `submit_payment` disabled, run the strict
create-order canary, rotate any exposed test credentials, complete the manual Stripe test-mode paid
canary, then validate refund/status/webhook behavior before enabling production pay.

## Safe-flip order (when B is green)
1. Keep production and staging `AGENT_CHECKOUT_STRICT=1`.
2. Keep `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED` unset/off.
3. Confirm rollout/observability gates are green for each canary window.
4. Run the strict create-order canary with target-gateway `AGENT_CHECKOUT_ALLOW_TEST_IDENTITY=1`, using pinned product IDs when available or auto-selection from `PROBE_QUERY`, then close that flag.
5. Run the paid canary manually in Stripe test mode and record dashboard evidence.
6. Validate replay, refund cap, payment status sync, webhook observation, cancellation, and return/RMA fencing.
7. Enable `submit_payment` through the kernel last.

## Rollback (instant, no deploy)
Set `AGENT_CHECKOUT_STRICT=0`. The kernel is purely additive (zero edits to the legacy path), so the flag
reverts every money op to existing behavior immediately. No data migration to undo (the `commerce_kv`
namespaces are kernel-only).

## Residual risks carried into prod (must be accepted or closed)
- **R1 (closed by paid replay proof):** retry-after-a-wrong-`failed` could double-charge without a per-order PSP idempotency key.
- **R2 (closed by C4):** a units/currency cross-check failure leaves an orphaned upstream order (safe/unpayable via kernel, but cruft) until a compensating cancel is wired. Currently surfaced via `order_units_mismatch_orphan` warn logs.
- **R3:** `submit_payment` against the real backend MUST stay off until the manual paid canary, replay, refund, status/webhook, and observability gates are green.

## Detail docs
Contract `safety-kernel-contract.md` · tools `tool-schema.v2.json` · wire-in `server-mount-and-durable-store.md` + `src/serverWireIn.example.js` · payments `payment-flow-remodel.md` · probe `PROBE_RUNBOOK.md` + `PROBE_wire_format_confirmation.md` · rollout evidence `STRICT_PROD_ROLLOUT_EVIDENCE_20260606.md` · rollout/observability `ROLLOUT_OBSERVABILITY_GATES.md` · money `FINAL_REVIEW_MoneyUnits.md` + `_Round2.md` · staging `staging-validation-runbook.md`.
