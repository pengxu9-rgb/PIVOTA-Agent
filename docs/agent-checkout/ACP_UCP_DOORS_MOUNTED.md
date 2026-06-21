# ACP REST + UCP discovery doors — now mounted on the live server

**Status (2026-06-21):** the OpenAI **ACP REST** checkout doors and **UCP discovery** doors are wired into the
live gateway (`src/server.js`), additive and **fail-closed/default-OFF**. They share the SAME kernel/executor
as the `/mcp` door (no second kernel), so charge-once / idempotency / ownership hold across all three surfaces.

This is the *shared-kernel additive* realization of the protocol edge described in
[`GO_LIVE_protocol_edge.md`](./GO_LIVE_protocol_edge.md). We reuse the building blocks
`composeProductionCommerce` assembles (`createAcpRestAdapter`, `buildUcpProfile`, `createUcpRouteHandlers`) but
bind them to the existing executor rather than calling `composeProductionCommerce` (which builds its own kernel
— the two-kernel hazard the runbook warns against).

## What was mounted

| Surface | Routes | Gate |
|---|---|---|
| UCP discovery | `GET /.well-known/ucp`, `GET\|POST /ucp/capabilities` | `AGENT_CHECKOUT_STRICT=1` **and** `AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED=1` |
| ACP REST | `POST\|GET /acp/checkout_sessions[...]`, `GET /acp/feed` | `AGENT_CHECKOUT_STRICT=1` **and** `AGENT_CHECKOUT_ACP_REST_ENABLED=1` |
| ACP complete (charge) | `POST /acp/checkout_sessions/:id/complete` | the above **and** `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=1` |

- ACP is mounted under **`/acp`** (not bare `/checkout_sessions`) to avoid colliding with the existing
  `src/lookReplicator/index.js` routes.
- Each route returns **404** unless its flags are on; the complete endpoint returns **405 OPERATION_NOT_ALLOWED**
  while `submit_payment` is disabled (same kill-switch as `/mcp`).

## Auth model (per surface)

- **UCP discovery** — read-only; no auth, no money.
- **ACP REST** — platform authenticity is the adapter's **HMAC `Signature`/`Timestamp`** over the exact request
  bytes (`verifyAcpSignature`), so ACP routes do **not** run `requireExternalInvokeAuth`. The backend
  `/agent/shop/v1/invoke` call uses the **internal service credential** (`buildInvokeUpstreamAuthHeaders`
  `forceInternalFallback`), so ACP reaches the backend without a Pivota agent key. The rawBody needed for the
  HMAC is captured in the global `express.json` `verify` hook **only for `/acp/` paths**.
- **Per-buyer identity (ACP)** — ACP defines no stable buyer id; the verified credential arrives as a Bearer in
  `x-buyer-authorization` and is verified by the `IDENTITY_ISSUERS_JSON` token verifier → `user_ref`. Never the
  body, never the platform channel.

## Config to enable (operator)

```
AGENT_CHECKOUT_STRICT=1                       # master gate (already on in prod)
AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED=1        # turn on /.well-known/ucp
UCP_BASE_URL=https://<this-gateway-origin>    # https origin; falls back to MCP_OAUTH_RESOURCE origin

AGENT_CHECKOUT_ACP_REST_ENABLED=1             # turn on /acp/* checkout doors
ACP_SIGNING_SECRET=<>=16 chars>               # HMAC secret OpenAI/ACP signs requests with
IDENTITY_ISSUERS_JSON=[{"iss":"…","aud":"…","jwks":{…}|"jwksUri":"https://…","algs":["ES256"]}]
# aud is REQUIRED on each identity issuer entry (the verifier refuses an issuer with no aud).

# charge stays OFF until the staged canary (standing rule):
# AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=1
DATABASE_URL=…                                # durable ACP session store (acp_sessions namespace) in strict
```

## Verified

`tests/integration/agent_checkout_acp_ucp_doors.node.test.cjs` (boots the real app): 404 gating when flags off;
UCP profile + capability intersection; ACP unsigned create → 401; ACP complete → 405 while pay disabled; a
fully-signed create passing HMAC + buyer-identity and reaching the backend (→ 503 with no backend in test). The
existing `/mcp` flow is unregressed (`mcp_oauth_front_door` 5/5, `commerce_mcp_oauth` 7/7).

## Residual before serving real ACP traffic (staged rollout, per GO_LIVE_protocol_edge.md §5)

1. Confirm the **ACP request-signing canonicalization** matches OpenAI's onboarding scheme (the HMAC string is
   `${timestamp}.${rawBody}`; swap `verifyAcpSignature` if onboarding differs).
2. Wire **per-buyer identity issuers** for the real ACP buyer credential (`IDENTITY_ISSUERS_JSON` with `aud`).
3. Product **feed** source confirmation (`getProducts` → backend `find_products`).
4. Keep `submit_payment` **OFF** until B1/B2/B3 + the test-mode charge canary are green; the PSP **webhook** is
   already mounted (`/agent/shop/v1/payment-webhook`) on the same kernel.
5. **Rollback is instant, no deploy:** unset `AGENT_CHECKOUT_ACP_REST_ENABLED` / `AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED`
   (or `AGENT_CHECKOUT_STRICT=0`).
