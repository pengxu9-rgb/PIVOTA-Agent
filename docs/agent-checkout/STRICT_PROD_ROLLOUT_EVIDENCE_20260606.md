# Strict Checkout Production Rollout Evidence, 2026-06-06

This records the non-charge evidence for enabling strict checkout enforcement in production while keeping
`submit_payment` disabled.

## Runtime Evidence Captured

Docs-only merges can advance Railway deployment ids without changing checkout runtime code. Treat the
deployment ids below as evidence points, not as a durable claim about the currently serving deployment.
Before enabling `submit_payment`, re-check `/version` and repeat the no-charge kill-switch probe.

| Surface | Evidence |
|---|---|
| Gateway production deploy | Strict/pay-disabled posture verified on `a9559910968d772d0d8e88a2b27034a431bd04e4`, Railway deployment `515dd022-0d39-49cc-88ba-cb98b1e34e46`, started `2026-06-06T11:15:29Z`; rechecked after PR `#1622` deployed `def6fab8bf677f8c325206e17114da70ea4931df` to production deployment `81ef41e4-2e48-433e-8031-42a3f889f83d`. |
| Gateway staging deploy | Strict/pay-disabled posture verified on `a9559910968d772d0d8e88a2b27034a431bd04e4`, Railway deployment `c26e36d8-30ef-416a-afec-9b2c6d0f3020`, started `2026-06-06T11:15:32Z`; rechecked after PR `#1622` deployed `def6fab8bf677f8c325206e17114da70ea4931df` to staging deployment `30adb64b-4050-4e77-8f7e-16e6145872d5`. |
| Backend production deploy | `17e0a1db428bc1c7c602f7136f8bcb896b86a5d4`, Railway deployment `994ac61b-751b-4b2a-8f0d-bec5308674df` |
| Production strict flag | `AGENT_CHECKOUT_STRICT=1` |
| Production payment enable flag | `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED` unset/off |
| Production durable state | `DATABASE_URL` set; `CONFIRMATION_SECRET` set |

## Green Non-Charge Gates

| Gate | Result |
|---|---|
| Production pay kill switch | Fake unauthenticated `submit_payment` returned HTTP `405`, `OPERATION_NOT_ALLOWED`, `submit_payment is disabled in strict checkout mode.` Rechecked after the docs-only production deployments `515dd022-0d39-49cc-88ba-cb98b1e34e46` and `81ef41e4-2e48-433e-8031-42a3f889f83d`. |
| Staging pay kill switch | Fake unauthenticated `submit_payment` returned HTTP `405`, `OPERATION_NOT_ALLOWED`. |
| Production strict identity | GitHub Actions run `27060426512`, job `Strict Identity Gate`, passed. A money operation with only the platform probe key failed with `USER_AUTH_REQUIRED`. |
| Production no-charge wire-format | GitHub Actions run `27059885995`, job `probe`, passed for read-only plus `create_order`; no charge path was present in the workflow. |
| Live create-order units | Probe verdict: `MAJOR confirmed for create_order`; backend v2 returned quote/order totals as major-unit decimal strings, with currency present. |
| Gateway health | `/healthz` green on production deployment `81ef41e4-2e48-433e-8031-42a3f889f83d`. |
| Backend health | `https://api.pivota.cc/health` green, `db_ok=true`, `missing_columns={}`. |
| Readiness smoke | `/private/tmp/pivota-readiness-test-psp-probe-20260606T104229Z` showed checkout/order sync ready and PSP session created in `requires_action`; no terminal payment was completed. |
| Artifact hygiene | Local readiness bundle value-scan passed after redaction; no Stripe session IDs, checkout URLs, secret keys, Shopify tokens, or admin order URLs remained. |

## Evidence Artifacts

Use these local artifacts as private operator evidence only. Do not paste raw JSON into shared channels
without a fresh redaction scan.

| Artifact | Safe use |
|---|---|
| `report.json` | Readiness summary and capability status. |
| `export_ucp.json` | UCP export evidence. |
| `checkout.json` | Canary checkout creation evidence. |
| `order_sync.json` / `order_sync_replay.json` | Order writeback and replay evidence. |
| `order_sync_audit.json` | Merchant writeback evidence. |
| `smoke.stdout.log` | Redacted smoke transcript excerpts only. |
| `payment_intent.json` | Reference only after redaction; never paste raw payment action URLs, client secrets, or PSP identifiers. |

## Still Manual-Only

These gates are not green and must remain manual. Keep
`AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED` off until they pass.

| Gate | Required proof |
|---|---|
| Credential rotation | Rotate Stripe test and Shopify credentials if the pre-redaction artifact bundle was shared or copied outside the local workspace. |
| Paid terminal completion | A single Stripe test-mode canary reaches paid/authorized state, verified in the PSP dashboard. |
| Payment status sync | Backend and gateway state bridge from `requires_action`/`awaiting_payment` to paid/authorized. |
| Idempotent replay after payment | Replaying the paid operation returns the original result and creates zero extra PSP charges. |
| Refund cap | Refund cannot exceed remaining refundable balance, and refund replay is idempotent. |
| Shopify webhook observation | Real webhook signature is verified and order status updates are observed. |
| Cancellation sync | Controlled Shopify cancellation updates canonical order status. |
| Return/RMA | Return flow is implemented and observed, or tool-visible return/RMA actions remain fenced. |

## Rollback

Set `AGENT_CHECKOUT_STRICT=0` for the affected environment. Do not enable
`AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED` as a rollback workaround.
