# Protocol-door flag manifest

**Authoritative per-environment snapshot of every env flag that gates a
protocol door or a money path**, across PIVOTA-Agent (the gateway — all public
doors, ADR-021) and pivota-backend (money execution). Production readiness is a
config question: the doors are code-complete and env-gated, so *this page* is
what "what is live?" means.

**Snapshot date: 2026-08-11** (read from Railway service env, not from
defaults). Update this table in the same PR as any flag flip — a stale manifest
is worse than none.

> Environment-detection caveat: **prod sets `RAILWAY_ENVIRONMENT=production`
> but NOT `NODE_ENV`** (either service). Any `NODE_ENV`-only production guard
> is inert in prod; guards must check `RAILWAY_ENVIRONMENT`/`VERCEL_ENV` too
> (pattern: `isProductionLikeAuroraBffEnv`).

## Gateway — PIVOTA-Agent (`pivota-agent-production`)

| Flag | Prod value | Gates | Notes |
|---|---|---|---|
| `AGENT_CHECKOUT_STRICT` | `1` | Master door: `/mcp` commerce surface + strict lanes | ON — the commerce MCP door is live |
| `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED` | `1` | The actual charge op (`complete_checkout_session` / `submit_payment`) | **ON — charges are enabled in prod** |
| `MCP_OAUTH_ENABLED` | `1` | Keyless OAuth front door for frontier MCP clients | ON; pairs with backend `MCP_OAUTH_AS_ENABLED=1` — the AS↔RS seam is in production use |
| `PUBLIC_READ_MCP_ENABLED` | `1` | Auth-none public read tier (`mcp.pivota.cc`) | ON |
| `AGENT_CHECKOUT_ACP_REST_ENABLED` | absent (off) | OpenAI-ACP REST checkout doors under `/acp` | **OFF** — the five session endpoints 404; flip requires `ACP_SIGNING_SECRET` (set, len 64) |
| `AGENT_CHECKOUT_ACP_FEED_ENABLED` | `1` | Read-only ACP product feed (`GET /acp/feed`) | ON |
| `ACP_PUBLIC_FEED` | `1` | Feed served without HMAC | ON (rate-limited) |
| `AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED` | `1` | `/.well-known/ucp` business profile | ON — **but see JWK gap below** |
| `UCP_BUSINESS_SIGNING_PUBLIC_JWK` | **absent** | Signing keys published in the UCP profile | ⚠️ Discovery is ON with no signing key configured — the profile publishes without `signing_keys`, so platforms cannot verify our outbound signatures. Set before any UCP transact work |
| `UCP_ORDER_WEBHOOK_RECEIVER_ENABLED` | absent (off) | Inbound UCP order-webhook door | OFF |
| `AGENT_CHECKOUT_HOSTED_LINK_ENABLED` | `1` | `create_payment_link` tool | ON |
| `AURORA_BFF_USE_MOCK` | `false` | Aurora mock mode | OFF (also triple-gated non-prod in code) |
| `PROMOTIONS_MODE` | `remote` | Gateway promotions source | Remote (backend `/agent/internal/promotions`); `local`/`none` semantics per PR #1948 |

## Backend — pivota-backend (`web`, Pivota Infra)

| Flag | Prod value | Gates | Notes |
|---|---|---|---|
| `AGENT_ACP_TEST_CAPTURE` | `false` | Test-mode off-session capture lane | OFF |
| `AGENT_ACP_ALLOW_LIVE_CAPTURE` | `false` | LIVE-money capture master switch | **OFF** |
| `AGENT_ACP_LIVE_CAPTURE_MERCHANTS` | `["merch_efbc46b4619cfbdf"]` | Per-merchant live allowlist (empty ⇒ nobody) | ⚠️ Holds one **stale retired-rig entry** (ADR-021). Inert while the master switch is off — **scrub before ever flipping live capture on** |
| `AGENT_ACP_TEST_MAX_CENTS` / `AGENT_ACP_LIVE_MAX_CENTS` | `2000` / `500` | Amount caps per lane | $20 test / $5 live |
| `ENABLE_AP2_ROUTES` | `true` | AP2 protocol routes | ON |
| `MCP_OAUTH_AS_ENABLED` | `1` | MCP OAuth Authorization Server (discovery/DCR/token/JWKS) | ON — serves the gateway's OAuth front door |

## Reading this table before a launch decision

- **What is actually live today:** MCP discovery + commerce tools (OAuth or
  API-key), public read tier, ACP product feed, UCP discovery (unsigned), AP2
  routes, hosted payment links, and in-chat charges through the kill-switch
  chain (test/live capture lanes themselves OFF).
- **What flips for OpenAI-ACP checkout:** `AGENT_CHECKOUT_ACP_REST_ENABLED=1`
  (secret already present). Run the sandbox conformance script first
  (`scripts/acp_spt_sandbox_conformance.py`, backend).
- **What flips for live money:** backend `AGENT_ACP_ALLOW_LIVE_CAPTURE=true`
  **after** scrubbing the stale allowlist entry and adding the real merchants.
  The caps stay.
- **What must be fixed before UCP transact:** the missing
  `UCP_BUSINESS_SIGNING_PUBLIC_JWK` (the retired ucp-worker's placeholder-JWK
  failure is the cautionary tale — ADR-021 Context).
