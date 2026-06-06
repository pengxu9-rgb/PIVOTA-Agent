# Agent-Checkout Rollout and Observability Gates

This is the rollout gate for agent-mediated checkout. It is intentionally limited to CI, docs, and
operator checks; it does not require runtime-code changes.

## Required Gates

| Gate | Required evidence | Owner |
|---|---|---|
| Money-path CI | `agent-checkout-money-path-gate.yml` green: `safety-kernel`, `mcp-adapters`, `merchant-connectors`, `gateway-strict-route`, dependent `test-count-floor`, and `rollout-observability-gates`. | Gateway / CI |
| Backend checkout-payment-safety | `pivota-backend/.github/workflows/agent-reliability-suite.yml` green on the `checkout-payment-safety` pytest lane. | Backend |
| Wire-format no-charge probe | `agent-checkout-wire-format-probe.yml` green for read-only + optional `create_order` only. It must not pass `--charge` or set `PROBE_ALLOW_CHARGE`. | Gateway / Ops |
| Strict identity fail-closed | `agent-checkout-wire-format-probe.yml` strict identity gate green: strict money op with only the platform probe key returns `USER_AUTH_REQUIRED`. | Gateway / Ops |
| Strict create-order canary | `agent-checkout-wire-format-probe.yml` strict create-order canary green in a controlled `AGENT_CHECKOUT_ALLOW_TEST_IDENTITY=1` window. It must create only an unpaid order and must not pass `--charge`. | Gateway / Ops |
| No automated paid charge | Paid `submit_payment` probes stay manual per `PROBE_RUNBOOK.md` Phase 3, with Stripe dashboard verification and immediate refund if live mode is used. | Ops |
| Observability export | Money-path audit events are exported to the gateway-governance raw-log path before production pay is enabled. | Ops |
| Rollback | `AGENT_CHECKOUT_STRICT=0` must be the documented rollback, and `submit_payment` must be enabled last. | Ops |

## Current Non-Charge Evidence, 2026-06-06

| Gate | Evidence |
|---|---|
| Production strict mode | `AGENT_CHECKOUT_STRICT=1`; strict/pay-disabled posture has been verified on production after docs-only deployments. Re-check `/version` before every pay promotion because docs-only merges can advance Railway deployment ids. |
| Production pay disabled | `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED` unset/off; fake `submit_payment` returned HTTP `405 OPERATION_NOT_ALLOWED`. |
| Staging pay disabled | Fake `submit_payment` returned HTTP `405 OPERATION_NOT_ALLOWED`. |
| Strict identity | GitHub Actions run `27060426512`, job `Strict Identity Gate`, passed. |
| No-charge wire-format | GitHub Actions run `27059885995`, job `probe`, passed for read-only plus `create_order`; workflow has no paid charge input. |
| Strict create-order canary | Pending on the target-gateway test-identity window. GitHub Actions run `27066147463` proved product auto-selection reaches strict `preview_quote`, then fails with `401 USER_AUTH_REQUIRED`; no `create_order` was attempted. Open a short `AGENT_CHECKOUT_ALLOW_TEST_IDENTITY=1` window, rerun, then close it immediately after the job. |
| Backend health | Production backend `17e0a1db428bc1c7c602f7136f8bcb896b86a5d4`, `db_ok=true`, no missing columns. |
| Artifact redaction | Local readiness bundle `/private/tmp/pivota-readiness-test-psp-probe-20260606T104229Z` passed a value scan after redaction. |

These gates do not authorize production pay. They authorize the current posture only: strict quote/order
enforcement on, `submit_payment` off.

## Observability Export

Before enabling production `submit_payment`, confirm the raw-log export path can answer these checks from
the deployed environment:

| Signal | Green threshold |
|---|---|
| quote to order | Quote/order events are visible for each canary request id. |
| order to payment | Payment attempts are visible only after a quote-bound order exists. |
| double charge | `double_charge` stays zero. |
| price lock | `price_lock_violation` stays zero. |
| confirmation integrity | `confirmation_bypass` stays zero. |
| route fallback | `GOVERNANCE_UNAVAILABLE` is visible when governance blocks a money operation; there is no silent fallback. |
| orphan cleanup | Any order-unit mismatch emits an orphan/cancel follow-up event or an explicit accepted-risk entry. |

## Manual Paid-Canary Evidence

Before enabling `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED`, record one signed-off packet with:

| Field | Required value |
|---|---|
| Approver | Named operator who ran the canary. |
| Environment | Stripe test mode preferred; live mode requires immediate refund evidence. |
| Gateway deployment | `/version.full_sha` and deployment id. |
| Backend deployment | `/version.full_sha` and deployment id. |
| Order | Internal order id and quote id, redacted for public sharing. |
| PSP dashboard | Amount, currency, status, and PaymentIntent/Checkout Session reference redacted in shared logs. |
| Replay | Same idempotency key returns the original result; zero additional PSP charge. |
| Refund | Refund cap enforced and replay idempotent. |
| Webhook/status | Signed webhook observed and canonical order status updated. |
| Artifact hygiene | Redaction scan passed before any evidence is shared. |
| Credential hygiene | Rotate PSP/merchant credentials if any raw artifact or secret-bearing dashboard data left the local/operator environment. |

The CI guard for this document is `.github/scripts/check-agent-checkout-rollout-gates.mjs`. It verifies
that the rollout gates remain documented, the money-path workflow has the expected split jobs, and the
wire-format probe cannot run a paid charge from GitHub Actions.

## Rollout Order

1. Keep `AGENT_CHECKOUT_STRICT=1` in staging and production for the current strict quote/order posture.
2. Keep `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED` unset/off.
3. Re-run the no-charge wire-format probe against the target environment before each promotion window.
4. Run the strict create-order canary in a controlled test-identity window, pinned when possible or auto-selected from `PROBE_QUERY`; then close the window.
5. Confirm observability export captures quote/order/audit events from that environment.
6. Run the paid charge probe manually in Stripe test mode only after no-charge probes and backend
   checkout-payment-safety are green.
7. Validate replay, refund, webhook/status sync, cancellation, and return/RMA fencing.
8. Enable production `submit_payment` last.

## Rollback

Set `AGENT_CHECKOUT_STRICT=0`. Treat this as the first rollback lever for any money-path anomaly,
including missing observability, price-lock violations, confirmation-bypass alerts, double-charge
signals, or backend checkout-payment-safety regressions.
