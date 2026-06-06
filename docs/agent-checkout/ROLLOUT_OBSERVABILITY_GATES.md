# Agent-Checkout Rollout and Observability Gates

This is the rollout gate for agent-mediated checkout. It is intentionally limited to CI, docs, and
operator checks; it does not require runtime-code changes.

## Required Gates

| Gate | Required evidence | Owner |
|---|---|---|
| Money-path CI | `agent-checkout-money-path-gate.yml` green: `safety-kernel`, `mcp-adapters`, `merchant-connectors`, `gateway-strict-route`, dependent `test-count-floor`, and `rollout-observability-gates`. | Gateway / CI |
| Backend checkout-payment-safety | `pivota-backend/.github/workflows/agent-reliability-suite.yml` green on the `checkout-payment-safety` pytest lane. | Backend |
| Wire-format no-charge probe | `agent-checkout-wire-format-probe.yml` green for read-only + optional `create_order` only. It must not pass `--charge` or set `PROBE_ALLOW_CHARGE`. | Gateway / Ops |
| No automated paid charge | Paid `submit_payment` probes stay manual per `PROBE_RUNBOOK.md` Phase 3, with Stripe dashboard verification and immediate refund if live mode is used. | Ops |
| Observability export | Money-path audit events are exported to the gateway-governance raw-log path before production pay is enabled. | Ops |
| Rollback | `AGENT_CHECKOUT_STRICT=0` must be the documented rollback, and `submit_payment` must be enabled last. | Ops |

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

The CI guard for this document is `.github/scripts/check-agent-checkout-rollout-gates.mjs`. It verifies
that the rollout gates remain documented, the money-path workflow has the expected split jobs, and the
wire-format probe cannot run a paid charge from GitHub Actions.

## Rollout Order

1. Keep `AGENT_CHECKOUT_STRICT=0`; verify CI and docs gates are green.
2. Run the no-charge wire-format probe against the target environment: read-only first, then
   `create_order`.
3. Confirm observability export captures quote/order/audit events from that environment.
4. Enable strict checkout in staging and run `staging-validation-runbook.md`.
5. Enable production quote/order canary.
6. Run the paid charge probe manually only after the no-charge probe confirms minor-unit semantics and
   the backend checkout-payment-safety lane is green.
7. Enable production `submit_payment` last.

## Rollback

Set `AGENT_CHECKOUT_STRICT=0`. Treat this as the first rollback lever for any money-path anomaly,
including missing observability, price-lock violations, confirmation-bypass alerts, double-charge
signals, or backend checkout-payment-safety regressions.
