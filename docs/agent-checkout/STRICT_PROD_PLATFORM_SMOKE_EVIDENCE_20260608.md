# Strict Checkout Production Platform Smoke Evidence, 2026-06-08

This records the no-charge platform evidence captured after the production confirmation signing secret
rotation. It authorizes only the current posture: strict checkout on, `submit_payment` off, and
agent/platform surfaces allowed for no-charge checkout-session and confirmation-token smoke. It does
not authorize production pay traffic.

## Runtime Evidence Captured

Docs-only merges and environment-only redeploys can advance Railway deployment ids without changing the
checkout runtime code. Re-check `/version` and the non-secret checkout flags before any pay promotion.

| Surface | Evidence |
|---|---|
| Gateway production commit | PIVOTA-Agent `8d7ffaefe110ccc8bf831f4ad6881447577c3686` |
| Confirmation-secret rotation deploy | Railway deployment `05d9b3fb-22bb-4407-b4c5-70eff83e4e78`, started `2026-06-08T06:51:25.220Z` |
| Open test-identity window deploy | Railway deployment `9f56173d-c47c-491d-8ae5-74e65af4f4b0`, started `2026-06-08T06:52:42.696Z` |
| Closed test-identity window deploy | Railway deployment `1427b4a4-1291-4ddd-be29-2c6cba3aa936`, started `2026-06-08T06:56:02.120Z` |
| Final production flags | `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=0`, `AGENT_CHECKOUT_ALLOW_TEST_IDENTITY=0`, `AGENT_CHECKOUT_TEST_IDENTITY_WINDOW=0` |
| Confirmation signing secret | `CONFIRMATION_SECRET` rotated in Railway production and matched to GitHub environment `Production` secret `AGENT_CHECKOUT_CONFIRMATION_SECRET`; value was never printed |

## Green No-Charge Gates

| Gate | Result |
|---|---|
| Strict create-order canary | GitHub Actions run `27121007998`, job `Strict Create-Order Canary`, passed. It used pinned Shopify merchant/product/variant `merch_efbc46b4619cfbdf` / `10064562258217` / `53012664942889`. It created quote `q_c6fe0377-0813-4689-a016-b122d5d7e2c8` and unpaid order `ORD_918269F734DA457B` for `2824 USD`; `submit_payment=false`. |
| Remote MCP + confirmation smoke | GitHub Actions run `27121055177`, job `Platform Smoke`, passed. `/mcp` initialized and listed required commerce tools, write without verified identity failed closed, verified checkout-session creation worked, unsigned `/checkout/confirm` was rejected, signed `/checkout/confirm` minted a token, and `validate_platform_smoke_evidence.mjs` passed. |
| No paid operations | Platform smoke evidence showed `complete_checkout_session_called=false`, `submit_payment_called=false`, and `paid_charge_attempted=false`. |
| Final strict identity close proof | GitHub Actions run `27121136725`, job `Strict Identity Gate`, passed after the test-identity window closed. A strict money op with only the platform probe key returned HTTP `401` and code `USER_AUTH_REQUIRED`. |

## Not Green For Production Pay

Keep `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=0` until all of these are green:

| Gate | Required proof |
|---|---|
| Backend checkout-payment-safety | Backend CI lane `checkout-payment-safety` green on the deployed backend commit. |
| Paid terminal completion | One manual Stripe test-mode canary reaches paid/authorized state, verified in the PSP dashboard. |
| Payment replay | Same idempotency key returns the original result and creates zero additional PSP charges. |
| Webhook/status | Signed webhook is observed and canonical order status reaches paid through the status-only verifier `scripts/b4_verify.mjs`. |
| Refund cap/replay | Refund cannot exceed remaining refundable balance, and refund replay is idempotent. |
| Observability export | Gateway-governance raw logs show quote/order/payment/audit events and zero double-charge, price-lock, and confirmation-bypass signals for the canary. |
| PSP-native webhook routing decision | Gateway mount currently exposes normalized `/agent/shop/v1/payment-webhook`; native Stripe/Adyen handlers are tested in protocol-edge composition but are not separately mounted on the gateway path. Decide whether production PSP webhooks are normalized upstream or mount native handlers before calling B4 green. |
| Credential hygiene | Rotate PSP/merchant credentials if any raw artifact or secret-bearing dashboard data leaves the local/operator environment. |

## Rollback

Set `AGENT_CHECKOUT_STRICT=0` for the affected environment. Do not enable
`AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED` as a workaround.
