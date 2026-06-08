# Agent-Checkout Rollout and Observability Gates

This is the rollout gate for agent-mediated checkout. It is intentionally limited to CI, docs, and
operator checks; it does not require runtime-code changes.

## Required Gates

| Gate | Required evidence | Owner |
|---|---|---|
| Gateway money-path gate | No-cost local operator run of the same suites defined by `agent-checkout-money-path-gate.yml`: `safety-kernel`, `mcp-adapters`, `merchant-connectors`, `gateway-strict-route`, and `rollout-observability-gates`. Record the pass in the operator release evidence packet. | Gateway / Ops |
| Backend checkout-payment-safety | No-cost operator release evidence validates the exact backend `checkout-payment-safety` pytest lane and payment aftercare gate from a clean SHA-pinned backend worktree. Evidence must pass `node scripts/validate_operator_release_evidence.mjs --input operator-release-evidence.json --json`. | Backend / Ops |
| Wire-format no-charge probe | `agent-checkout-wire-format-probe.yml` green for read-only + optional `create_order` only. It must not pass `--charge` or set `PROBE_ALLOW_CHARGE`. | Gateway / Ops |
| Strict identity fail-closed | `agent-checkout-wire-format-probe.yml` strict identity gate green: strict money op with only the platform probe key returns `USER_AUTH_REQUIRED`. | Gateway / Ops |
| Strict create-order canary | `agent-checkout-wire-format-probe.yml` strict create-order canary green in a controlled `AGENT_CHECKOUT_ALLOW_TEST_IDENTITY=1` window. It must create only an unpaid order and must not pass `--charge`. | Gateway / Ops |
| Remote MCP and confirmation UI smoke | Deployed strict `/mcp` can create a checkout session through the canonical executor, and deployed `/checkout/confirm` mints a token only after a verified signed user action. Do not call `complete_checkout_session` or `submit_payment` in this smoke. Evidence must pass `node scripts/validate_platform_smoke_evidence.mjs --input platform-smoke-evidence.json --json`. | Gateway / Platform |
| No automated paid charge | Paid `submit_payment` probes stay manual per `PROBE_RUNBOOK.md` Phase 3, with Stripe dashboard verification and immediate refund if live mode is used. | Ops |
| B4 status verifier | After a manual Stripe TEST-mode completion, `node scripts/b4_verify.mjs` confirms the order reaches paid status through `get_order_status` only. It must remain status-only and must not call Stripe, `submit_payment`, or payment completion. | Ops |
| Manual paid evidence validator | The signed-off paid canary packet passes `node scripts/validate_paid_canary_evidence.mjs --input paid-canary-evidence.json --json`. | Ops |
| Observability export | Money-path audit events are exported to the gateway-governance raw-log path before production pay is enabled. | Ops |
| Rollback | `AGENT_CHECKOUT_STRICT=0` must be the documented rollback, and `submit_payment` must be enabled last. | Ops |

## Current Non-Charge Evidence, 2026-06-08

| Gate | Evidence |
|---|---|
| Current production deployment re-check | PIVOTA-Agent Railway production deployment `d893f24a-5041-4c14-a96e-a305352f8a7f` is live on `2bea62395fff745514c4effa8e4faf998179f327`; `/version.full_sha` matches, and the non-secret checkout flags remain closed: `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=0`, `AGENT_CHECKOUT_ALLOW_TEST_IDENTITY=0`, `AGENT_CHECKOUT_TEST_IDENTITY_WINDOW=0`. |
| Production strict mode | `AGENT_CHECKOUT_STRICT=1`; the post-smoke closed deployment evidence point was PIVOTA-Agent `8d7ffaefe110ccc8bf831f4ad6881447577c3686`, Railway deployment `1427b4a4-1291-4ddd-be29-2c6cba3aa936`, with `AGENT_CHECKOUT_ALLOW_TEST_IDENTITY=0` and `AGENT_CHECKOUT_TEST_IDENTITY_WINDOW=0`. Re-check `/version` before every pay promotion because later deploys can advance Railway deployment ids. |
| Production pay disabled | `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=0`; final non-secret flag check showed `strict_submit_payment_enabled=0`, `allow_test_identity=0`, `test_identity_window=0`. |
| Staging pay disabled | Fake `submit_payment` returned HTTP `405 OPERATION_NOT_ALLOWED`. |
| Gateway money-path local evidence | Clean local PIVOTA-Agent gate passed without GitHub Actions: safety-kernel `324 passed`; MCP server `91 passed`; merchant connectors `18 passed`; route/mount node tests `17 passed`; gateway strict-route Jest `72 passed`. |
| Strict identity | GitHub Actions run `27121136725`, job `Strict Identity Gate`, passed after the controlled test-identity window was closed. A strict money op with only the platform probe key returned HTTP `401 USER_AUTH_REQUIRED`. |
| No-charge wire-format | GitHub Actions run `27059885995`, job `probe`, passed for read-only plus `create_order`; workflow has no paid charge input. |
| Strict create-order canary | Green. GitHub Actions run `27121007998` used the approved short `AGENT_CHECKOUT_ALLOW_TEST_IDENTITY=1` window and pinned Shopify merchant/product `merch_efbc46b4619cfbdf` / `10064562258217` / variant `53012664942889`. It created unpaid order `ORD_918269F734DA457B` from quote `q_c6fe0377-0813-4689-a016-b122d5d7e2c8` for `2824 USD`; no `submit_payment` was called. |
| Remote MCP / confirmation route | Green. GitHub Actions run `27121055177` passed the deployed no-charge platform smoke: `/mcp` initialized and listed tools, write without verified identity failed closed, verified checkout-session creation worked, unsigned `/checkout/confirm` was rejected, signed `/checkout/confirm` minted a token, and `complete_checkout_session_called=false`, `submit_payment_called=false`, `paid_charge_attempted=false`. |
| Backend health | Production backend `3bdf59d861d6026771209156684aaf86db2fa37a`, `db_ok=true`, no missing columns. |
| Backend payment-safety local evidence | Clean worktree on `pivota-backend` `694e883c50b523502b6cb0f36c353bd5b17a0bda` passed the workflow pytest list locally: `147 passed`; `scripts/run_payment_aftercare_gate.sh` passed locally: `76 passed`. Because paid GitHub Actions is not part of the release process, record this with `NO_COST_OPERATOR_RELEASE_GATE.md` and validate the packet with `scripts/validate_operator_release_evidence.mjs`. |
| Artifact redaction | Local readiness bundle `/private/tmp/pivota-readiness-test-psp-probe-20260606T104229Z` passed a value scan after redaction. |
| Confirmation signing secret hygiene | `CONFIRMATION_SECRET` was rotated in Railway production and matched to GitHub environment `Production` secret `AGENT_CHECKOUT_CONFIRMATION_SECRET`; no secret value was printed. The first platform smoke failed with `403 CONFIRMATION_ACTION_REQUIRED`, then passed after rotation. |

These gates do not authorize production pay. They authorize the current posture only: strict quote/order
enforcement on, `submit_payment` off. Backend code-level no-charge payment safety has local release-source
evidence, but the accepted no-cost gate is a validated operator packet, not a paid GitHub Actions run.
Production pay still requires the manual Stripe test-mode paid canary, replay, webhook/status, refund,
and observability gates.

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

## Platform Smoke Evidence

Before enabling platform traffic from ChatGPT, Claude, Gemini, or another agent host, record a deployed
no-charge smoke packet and validate it:

GitHub Actions path (preferred, no token pasted locally):

1. Open **Agent Checkout Platform Smoke**.
2. Keep `run_full_smoke=true`.
3. Provide `merchant_id`, `product_id`, optional `variant_id`, and `order_id` from the strict create-order
   canary.
4. Run it only during a controlled target window with `AGENT_CHECKOUT_ALLOW_TEST_IDENTITY=1` and
   `AGENT_CHECKOUT_TEST_IDENTITY_WINDOW=1`; close the window immediately after.

Manual fallback:

```bash
PROBE_BASE=https://pivota-agent-production.up.railway.app \
PROBE_KEY=... \
MCP_SMOKE_ALLOW_VERIFIED_SESSION=1 \
MCP_SMOKE_MERCHANT_ID=merch_... \
MCP_SMOKE_PRODUCT_ID=... \
MCP_SMOKE_ORDER_ID=ORD_... \
CONFIRMATION_SECRET=... \
node scripts/smoke_protocol_edge_remote_mcp.mjs --full --json > platform-smoke-evidence.json

node scripts/validate_platform_smoke_evidence.mjs --input platform-smoke-evidence.json --json
```

`MCP_SMOKE_ORDER_ID` must be an unpaid order id from the strict create-order canary. The smoke script
intentionally never calls `complete_checkout_session`, `submit_payment`, or a paid operation.

The packet must prove:

| Field | Required value |
|---|---|
| Remote MCP | HTTPS `/mcp` initializes, lists required commerce tools, and routes through the canonical surface. |
| Identity fail-closed | A write tool without verified user/session returns `USER_AUTH_REQUIRED`. |
| Verified session | A verified OAuth/session context can create a checkout session. |
| Confused-deputy defense | Model/body-supplied identity is ignored or rejected. |
| Confirmation action | Unsigned action is rejected; signed user action mints the token. |
| No money ops | `complete_checkout_session`, `submit_payment`, and paid charge attempts are all false. |
| Hygiene | Redaction scan passed, and credential rotation is either not needed or completed. |

Current accepted packet: GitHub Actions run `27121055177`, artifact `platform-smoke-evidence`, with
validation green and no paid operation attempted.

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
| B4 status verifier | `scripts/b4_verify.mjs` confirms the order is paid through `get_order_status` only. |
| Artifact hygiene | Redaction scan passed before any evidence is shared. |
| Credential hygiene | Rotate PSP/merchant credentials if any raw artifact or secret-bearing dashboard data left the local/operator environment. |

The evidence packet must pass the repository validator:

```bash
node scripts/validate_paid_canary_evidence.mjs --input paid-canary-evidence.json --json
```

Use `scripts/b4_verify.mjs` as the status-only post-charge verifier before filling the
`webhook_status.canonical_payment_status` field. It is intentionally covered by
`tests/b4_verify_script.test.js` and must never grow a Stripe or payment-completion call.

The validator is deliberately stricter than prose: it refuses live-mode evidence unless an explicit
live-refund override is used, compares PSP dashboard amount/currency against the locked order amount,
requires same-key replay proof, requires signed webhook plus paid canonical status, requires refund-cap
and refund-replay proof, and scans the evidence file for raw PSP/API/token/card-looking secrets.

The local guard for this document is `.github/scripts/check-agent-checkout-rollout-gates.mjs`. It verifies
that the rollout gates remain documented, the manual money-path workflow has the expected split jobs, and
the wire-format probe cannot run a paid charge from GitHub Actions. The validator/status scripts are covered
by `tests/b4_verify_script.test.js`, `tests/operator_release_evidence_script.test.js`,
`tests/paid_canary_evidence_script.test.js`, and
`tests/platform_smoke_evidence_script.test.js` in the money-path gate.

## Rollout Order

1. Keep `AGENT_CHECKOUT_STRICT=1` in staging and production for the current strict quote/order posture.
2. Keep `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED` unset/off.
3. Create no-cost backend operator release evidence from a clean SHA-pinned backend worktree and validate it with `scripts/validate_operator_release_evidence.mjs`.
4. Smoke the deployed remote MCP `/mcp` create-session path and the host-only `/checkout/confirm` signed user-action path without calling `complete_checkout_session` or `submit_payment`; validate the evidence packet with `scripts/validate_platform_smoke_evidence.mjs`.
5. Re-run the no-charge wire-format probe against the target environment before each promotion window.
6. Run the strict create-order canary in a controlled test-identity window, pinned when possible or auto-selected from `PROBE_QUERY`; then close the window.
7. Confirm observability export captures quote/order/audit events from that environment, using `GATEWAY_GOVERNANCE_RAILWAY_DEPLOYMENT` when the canary ran on a prior deployment.
8. Run the paid charge probe manually in Stripe test mode only after no-charge probes and backend
   operator release evidence are green.
9. Validate replay, refund, webhook/status sync, cancellation, and return/RMA fencing.
10. Enable production `submit_payment` last.

## Rollback

Set `AGENT_CHECKOUT_STRICT=0`. Treat this as the first rollback lever for any money-path anomaly,
including missing observability, price-lock violations, confirmation-bypass alerts, double-charge
signals, or backend checkout-payment-safety regressions.
