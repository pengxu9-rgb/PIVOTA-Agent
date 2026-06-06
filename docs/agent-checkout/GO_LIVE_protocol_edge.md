# Go-Live Runbook — Merchant-side Protocol Edge (MCP + ACP)

Go-live for the **protocol-edge composition root** (`safety-kernel/src/protocol/productionWiring.js` →
`composeProductionCommerce`) that serves ChatGPT (ACP REST) and Gemini/Claude (MCP) against one
kernel/executor. This is the *kernel-direct* agentic surface — **distinct from** the gateway-mount path in
[`GO_LIVE_CHECKLIST.md`](./GO_LIVE_CHECKLIST.md) (`createCommerceMount` behind the existing
`/agent/shop/v1/invoke`). **Pick ONE path per deployment** — they each run a kernel; running both against the
same backend means two independent kernels (don't, unless they share one durable store + one webhook).

Everything is gated by `AGENT_CHECKOUT_STRICT`. With it **off**, nothing here is reachable. With it **on**,
`composeProductionCommerce` refuses to boot unless every seam below is supplied (fail-closed).

Status legend: ✅ done (code, reviewed) · 🟡 needs a backend/ops confirmation · ⛔ operator-supplied · ⚠️ gap to close before pay.

---

## 0. What's already done (code, Codex-reviewed to SHIP)

| | Item | Evidence |
|---|---|---|
| ✅ | Canonical contract + executor (one money-path for all protocols) | `canonicalExecutor.js`, `REVIEW_by_codex_of_CanonicalExecutor.md` |
| ✅ | MCP commerce tool surface | `mcp-server/src/commerceToolSurface.js`, `REVIEW_by_codex_of_CommerceToolSurface.md` |
| ✅ | ACP REST adapter + product feed (HMAC `Signature`/`Timestamp`, 5 checkout endpoints) | `acpRestAdapter.js`, `REVIEW_by_codex_of_AcpRestAdapter.md` |
| ✅ | Unified payment-authorization verifier (ACP delegated token / UCP handler / AP2 SD-JWT mandate) | `paymentAuthorizationVerifier.js` + `protocolPaymentVerifiers.js`, `REVIEW_by_codex_of_PaymentAuthVerifier.md` |
| ✅ | Cross-protocol conformance capstone (both doors → identical money path) | `mcp-server/test/crossProtocolConformance.test.js`, `REVIEW_by_codex_of_CrossProtocolConformance.md` |
| ✅ | Composition root, fail-closed boot | `productionWiring.js`, `REVIEW_by_codex_of_ProductionWiring.md` |

369 tests (safety-kernel 287 + mcp-server 82); money-path floor gate (`assert-money-path-test-floors.mjs`) green.

---

## 1. Config seams → who supplies what

`composeProductionCommerce(config)` fields. In **strict**, every ⛔ row is required or boot throws `WiringConfigError`.

| Config field | Source / env | Owner | Notes |
|---|---|---|---|
| `merchantId` | deploy config | ⛔ ops | merchant-of-record; payment grants must carry the same `merchant_id`. |
| `confirmationSecret` | `CONFIRMATION_SECRET` | ⛔ ops | ≥16 chars. Same secret family as the mount path — if both ran, they'd need to agree. |
| `backend.baseUrl` | deploy config | ⛔ ops | **https only** (loopback http only with `allowInsecureHttp`, forbidden in strict). The real backend, e.g. the Railway prod URL. |
| `backend.authToken` | secret (e.g. `COMMERCE_CORE_PROD_AUTH_TOKEN`) | ⛔ ops | Bearer to the backend `/agent/shop/v1/invoke`. Never logged. |
| `paymentIssuers[]` | `{iss, aud, jwksUri (https) \| jwks, algs}` | ⛔ ops + platform | Pinned JWKS for the PSP/platform that signs delegated tokens / UCP handler grants. Asymmetric algs only. |
| `identityIssuers[]` | `{iss, aud, jwksUri (https) \| jwks, algs}` | ⛔ ops + IdP | Pinned JWKS for the per-buyer identity token issuer. |
| `acpSigningSecret` | `ACP_SIGNING_SECRET` | ⛔ ops | ≥16 chars in strict. The HMAC shared secret OpenAI/ACP signs requests with. |
| `storeFactory` | a `PostgresKvStore` factory | ⛔ ops | **must be `durable===true`** in strict (in-memory is rejected by marker). Kernel quote/order/idempotency/confirmation/charge-lock state. |
| `sessionStore` | a durable `PostgresKvStore` | ⛔ ops | **`durable===true`**; ACP checkout-session ownership + create-dedup. |
| `enableAp2` + `verifyCheckoutHash` | flag + TCB fn | ⛔ ops | only if accepting AP2 mandates; `verifyCheckoutHash` MUST prove `checkout_hash` against the merchant's own Checkout JWT (trusted compute base). |
| `extractBuyerToken` | default `x-buyer-authorization` header, or a fn | ⛔ ops | how the verified per-buyer credential arrives on an ACP request. NEVER the platform Bearer, never the body. |
| `getProducts` | default backend `find_products` | 🟡 | ACP feed source. |
| `createMcpSurface` | inject `createCommerceToolSurface` | ✅ | builds the MCP door (mcp-server is jose-free; injected so safety-kernel never imports it). |
| `allowEphemeralState` | flag | ⛔ ops | explicit opt-out of durable-store requirement — **only** for an audited single-instance/dev run. |
| `strict` | `AGENT_CHECKOUT_STRICT==='1'` | ⛔ ops | the master gate. |

---

## 2. Shared backend confirmations (same kernel ⇒ same answers as the mount checklist)

These are kernel-level facts the protocol edge inherits. If the mount checklist already closed them, they're done; otherwise confirm via [`PROBE_RUNBOOK.md`](./PROBE_RUNBOOK.md):

- 🟡 **B1** `submit_payment` wire amount is **minor units** (repo's `submit_payment_contract.test.js` already sends minor; confirm against the live backend).
- 🟡 **B2** `create_order.amounts.total` is a **MAJOR-decimal string** carrying a **currency** — confirmed by the 2026-06-02 probe; `wrapUpstream`/`normalizeCreateOrder` parses major→minor and the kernel cross-checks amount+currency (fail-closed). `requireBackendAmount` is auto-on whenever a backend is wired.
- 🟡 **B3** per-order **PSP idempotency key** — `createHttpBackendUpstream` forwards the kernel's `Idempotency-Key` to the backend; confirm the backend honors it for the charge.
- 🟡 **B4** payment **webhook** PSP + signing secret/header + order/payment-id correlation (see §4 — this path needs it wired).

> ⛔ **Do not enable `submit_payment` against the real backend until B1, B2, B3 are confirmed.** (standing rule)

---

## 3. The entrypoint (code — safe to build now if not present)

`composeProductionCommerce` is a library; a deployment needs a small entrypoint that builds the config from
env/secrets and serves the two doors:

```js
const wired = composeProductionCommerce({
  merchantId: process.env.MERCHANT_ID,
  // confirmationSecret + acpSigningSecret default from env; strict from AGENT_CHECKOUT_STRICT
  backend: { baseUrl: process.env.COMMERCE_BACKEND_URL, authToken: process.env.COMMERCE_CORE_PROD_AUTH_TOKEN },
  paymentIssuers: JSON.parse(process.env.PAYMENT_ISSUERS_JSON),   // [{iss,aud,jwksUri,algs}]
  identityIssuers: JSON.parse(process.env.IDENTITY_ISSUERS_JSON),
  storeFactory: (ns) => new PostgresKvStore({ db, namespace: ns }),
  sessionStore: new PostgresKvStore({ db, namespace: 'acp_sessions' }),
  createMcpSurface,                                               // from mcp-server
  // enableAp2 + verifyCheckoutHash only if accepting AP2
});
// ACP: mount wired.acp on the 5 routes (rawBody-capturing middleware — see acpRestServer.example.js)
// MCP: serve wired.mcp via the stdio/HTTP MCP server, resolving identity with wired.resolveSessionIdentity
```

`acpRestServer.example.js` shows the ACP route mounting (**capture `rawBody` before JSON parse** — the HMAC
signature is over the exact bytes). `commerceServer.example.js` shows the MCP mounting.

---

## 4. ✅ Payment webhook + reconcile — now wired into THIS kernel

The composition root now returns **`paymentWebhook`** and **`reconcile`**, both bound to the same protocol-edge
kernel (they share the durable order store), so an async charge's completion finalizes `charge_pending → paid`.
The live backend is a checkout-session / client-confirmation model: `submit_payment` can return `charge_pending`
+ a `requires_action` redirect, and completion arrives via a **signed webhook**.

- `wired.paymentWebhook({ headers, rawBody })` — HMAC-over-rawBody verified **before** parse; finalizes via the
  kernel's payment_id-correlated path. **In strict, `paymentWebhookSecret` (≥16, env `PAYMENT_WEBHOOK_SECRET`)
  is REQUIRED** unless the operator sets `syncChargesOnly: true` (exact boolean — an audited synchronous-only
  PSP). Mount it on a route with a **raw-body parser** (before any global JSON parser).
- `wired.reconcile()` — cron backstop; built only when `listPendingOrders` + an **authoritative**
  `queryPaymentStatus` are supplied. Never charges; only resolves against the real PSP status, attempt-matched
  by `payment_id`.

> **Contract:** the webhook event's `order_id` MUST be the **kernel** order id (from `create_order`), NOT an
> ACP/PSP session id — a wrong-namespace id returns a retryable 404 and never finalizes. `queryPaymentStatus`
> may return a scalar status string or `{ status, payment_id? }`; a returned `payment_id` must match the pending
> attempt or the row is held back. Still confirm **B4** (PSP, signing header, correlation id).

### 4a. PSP-native webhooks (Stripe / Adyen) — `wired.stripeWebhook` / `wired.adyenWebhook`

For ingesting **raw** Stripe/Adyen test webhooks (their signatures differ from the normalized one), configure
`stripeWebhookSecret` (`whsec_…`) and/or `adyenHmacKey` (32-byte hex). Each is bound to the same kernel and
finalizes `charge_pending → paid`. **Backend-config requirement for them to correlate:**
- **Stripe:** the PaymentIntent must carry `metadata.order_id` = the **kernel** order id, and the PaymentIntent
  `id` (`pi_…`) must be the **same** id the backend returned as `payment_id` at `submit_payment`. The default
  mapper finalizes ONLY `payment_intent.succeeded` (a Checkout-Session flow needs a custom `stripeMapEvent`).
- **Adyen:** `merchantReference` = the kernel order id; `pspReference` = the submit `payment_id`.
- ⚠️ **Pre-go-live:** validate the Adyen HMAC against one **real** Adyen dashboard test-notification (the scheme
  is implemented to spec + round-trip/escaping-tested, but no real vector is in-repo).

To test each PSP via the probe, the selector is `PROBE_PAYMENT_HANDLER_TYPE=stripe|adyen` (or `…_ID`).

(If a deployment only ever uses synchronous `succeeded` charges, set `syncChargesOnly: true` — but confirm with the PSP first.)

---

## 5. Strict-flip sequence (staged, reversible)

1. **Deploy with `AGENT_CHECKOUT_STRICT=0`.** Nothing here is reachable; verify the new code path is dormant and the legacy behavior is unchanged.
2. **Wire all §1 seams + the §4 webhook** in config. Boot once in a non-prod env with `strict:true` to prove the fail-closed config passes (it throws `WiringConfigError` listing anything missing).
3. **Dry-run, no charge:** point `backend` at the real backend, run discovery + `create_checkout_session` + `get_checkout_session` (reads + quote only — no order, no charge). Confirm quotes normalize (major→minor) and identity resolves.
4. **Test-mode charge (Stripe TEST):** complete one checkout with a real signed grant against a **test-mode** PSP. Verify in the PSP dashboard: charged once, correct amount/currency. Confirm the webhook finalizes `charge_pending → paid`.
5. **Flip `AGENT_CHECKOUT_STRICT=1` in staging;** run an end-to-end through both ACP and MCP. Watch the audit log + charge-once.
6. **Production:** flip strict on; start with a low-traffic merchant; monitor charge-once, idempotency replays, and `MERCHANT_UNAVAILABLE` rates.

**Rollback (instant, no deploy):** set `AGENT_CHECKOUT_STRICT=0`. The protocol edge is additive — the flag fully gates it.

---

## 6. Residual risks carried into prod (accept or close)

- **TCB:** `verifyCheckoutHash` (AP2) is trusted to prove the checkout binding; a wrong implementation reopens the session-binding bypass. Only enable AP2 with a reviewed `verifyCheckoutHash`.
- **TCB:** a custom `backend` function or a custom store that lies about `durable` is operator-controlled — use the first-party `createHttpBackendUpstream` + `PostgresKvStore`.
- **SD-JWT completeness:** KB-JWT holder-binding and nested-`_sd`/array disclosures are not yet implemented (they fail closed, never authorize) — fine for the current grant/mandate shapes; revisit if the AP2 profile requires holder proof.
- **Two-kernel hazard:** if both this edge and the gateway mount run against the same backend, they are independent kernels — charge-once holds per-kernel, not across. Pick one path, or share one durable store + webhook.

---

## 7. Detail docs

Composition root `productionWiring.js` · ACP wire-in `acpRestServer.example.js` · MCP wire-in
`commerceServer.example.js` · payment verifier `protocolPaymentVerifiers.js` · gateway-mount go-live
`GO_LIVE_CHECKLIST.md` · probe `PROBE_RUNBOOK.md` · money units `FINAL_REVIEW_MoneyUnits.md` (+`_Round2`) ·
the six `REVIEW_by_codex_of_*.md` SHIP verdicts.
