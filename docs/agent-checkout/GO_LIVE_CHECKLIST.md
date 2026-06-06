# Agent-Checkout — Go-Live Checklist (single source of truth)

**What this is:** the one executable, owner-assigned checklist to take agent-mediated checkout to
production safely. Supersedes the scattered status in `PROGRAM_SUMMARY.md` / `readiness-to-green.md` for
the GO-LIVE view (those remain for architecture + scorecard-dimension detail).

**One-line status (2026-06-06):** the Commerce Safety Kernel, strict gateway mount, raw webhook route,
schema promotion, and platform/merchant adapter tests are code-complete locally. Everything left before
production money traffic is **staging environment validation, backend wire-format confirmation,
observability export proof, and manual paid-charge approval**. The whole feature is gated by one env flag,
`AGENT_CHECKOUT_STRICT`; with it OFF, production behavior remains on the legacy path.

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

## B. Confirmation gates — 🟡 BACKEND TEAM (run the probe)
**This is the long pole. It gates everything below.** Run the executable probe `scripts/probe_wire_format.mjs`
(reviewed — `FINAL_REVIEW_ProbeScript.md`; manual curl version + decision rules in `PROBE_wire_format_confirmation.md`).
| # | Confirm | Why it blocks | Our default assumption |
|---|---|---|---|
| B1 | `submit_payment` wire amount is **minor units** | the charge amount | minor (repo's own `submit_payment_contract.test.js` already sends `2900` for €29) |
| B2 | `create_order.amounts.total` is **minor** AND carries a **currency** | our units cross-check; missing currency fails closed | minor (repo mock `1000` for a $10 item) |
| B3 | charge to PSP carries a **per-ORDER idempotency key** | closes the residual double-charge-on-retry + `no_payment_id` crash-window risk we CANNOT close in the gateway | assumed absent → must be added |
| B4 | Webhook **PSP + signing secret/header + order/payment-id correlation field** | needed to wire the completion webhook + reconcile | Stripe-like, `x-pivota-webhook-signature`, `payment_intent_id` |
| B5 | **Which backend version is live** (v2 Node `/agent/v2/*` minor, vs v1 Python `/agent/v1/*` major+ignored) | changes B1/B2 answers | v2 |
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

## D. Ops / secrets — ⛔ OPS (blocked on staging credentials and deployment)
| # | Step |
|---|---|
| D1 | Run `node src/db/cli.js migrate` against staging, then `DATABASE_URL=<staging postgres> node safety-kernel/scripts/validate-commerce-kv-staging.mjs` |
| D2 | Set `CONFIRMATION_SECRET`, `PAYMENT_WEBHOOK_SECRET`; register the prod KMS-wrapped DEK with `KmsKeyProvider` |
| D3 | Export the audit sink → the `gateway-governance` raw-log path (the hook exists; point it) |

---

## E. Rollout — ⛔ YOU / OPS (blocked on D)
| # | Step |
|---|---|
| E1 | Flip `AGENT_CHECKOUT_STRICT=1` in **staging**; run `staging-validation-runbook.md` |
| E2 | Canary in prod: enable **read-only + preview_quote + create_order FIRST** (these are real-contract-ready) |
| E3 | Confirm `ROLLOUT_OBSERVABILITY_GATES.md` is green: split CI, backend checkout-payment-safety, no-charge probe, raw-log export, rollback lever |
| E4 | Enable `submit_payment` **LAST**, only after B1 + B2 + B3 are confirmed green |

---

## Critical path (who unblocks what)
```
B (backend probe)  ──►  D (ops/secrets)  ──►  E (staged rollout)
   confirms units/idempotency/webhook facts       secrets + DB + raw logs       pay enabled only
                                                  after B1+B2+B3
```
Gateway wire-in is no longer the long pole. Action now: run read-only staging probe with
`PROBE_BASE`/`PROBE_KEY`, validate staging `commerce_kv`, and keep `submit_payment` disabled until
B1/B2/B3 are confirmed.

## Safe-flip order (when B is green)
1. Ship the wire-in with `AGENT_CHECKOUT_STRICT=0` → no behavior change; verify the code path is dormant.
2. Staging: flip to `1`, run the validation runbook (E1).
3. Prod: flip to `1` but keep `submit_payment` on the legacy path until B1+B2+B3 confirmed; quote/order go first.
4. Confirm rollout/observability gates are green.
5. Enable `submit_payment` through the kernel last.

## Rollback (instant, no deploy)
Set `AGENT_CHECKOUT_STRICT=0`. The kernel is purely additive (zero edits to the legacy path), so the flag
reverts every money op to existing behavior immediately. No data migration to undo (the `commerce_kv`
namespaces are kernel-only).

## Residual risks carried into prod (must be accepted or closed)
- **R1 (closed by B3):** retry-after-a-wrong-`failed` could double-charge without a per-order PSP idempotency key.
- **R2 (closed by C4):** a units/currency cross-check failure leaves an orphaned upstream order (safe/unpayable via kernel, but cruft) until a compensating cancel is wired. Currently surfaced via `order_units_mismatch_orphan` warn logs.
- **R3:** `submit_payment` against the real backend MUST stay off until B1+B2+B3 — enforced by E3, not by code.

## Detail docs
Contract `safety-kernel-contract.md` · tools `tool-schema.v2.json` · wire-in `server-mount-and-durable-store.md` + `src/serverWireIn.example.js` · payments `payment-flow-remodel.md` · probe `PROBE_wire_format_confirmation.md` · rollout/observability `ROLLOUT_OBSERVABILITY_GATES.md` · money `FINAL_REVIEW_MoneyUnits.md` + `_Round2.md` · staging `staging-validation-runbook.md`.
