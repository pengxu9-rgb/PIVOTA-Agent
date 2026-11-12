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
| `AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET` | absent (off) | `/ucp/mcp` storefront checkout (`create_checkout` / `get_checkout` for a seller Pivota is not connected to): the answer's currency is the buyer market's currency, or there is no priced answer | OFF. Read per call; only matters while `AGENT_CHECKOUT_UCP_ESCALATION_ENABLED` is on. On for `1`, `true`, `yes`, `on`, `enabled` (any letter case, surrounding whitespace ignored); every other value is off, including `enforce` and any other number. Market -> currency comes from the gateway's one source (`resolveServingCurrency`, `src/services/buyerMarket.js`, over `BUYER_REGION_CURRENCY`). **The product read does not change:** on or off, in every market, the checkout reads each product once with no market on the read, so the flag starts no live store read, no live-price overlay and no market-keyed gate call behind that read. The rule is applied in the door, to the request's market, on what the read returned: a line whose row is labelled with another currency (its price, the chosen variant's price, the row's currency, or the currencies the read says it withheld money in) is refused `NO_MERCHANT_OFFER` / `seller_not_priced_in_market_currency` (no seller cart, no price, nothing converted; the seller's own page is named in `storefront_urls`); the seller's cart answer must be in the market's currency or it is not shown (and when there is no catalog price in the market's currency to answer with instead, the same refusal names the currency the storefront answered in); neither answer can be built in another currency; a market with no currency in the source is refused `market_not_priced` (a value that is not a two-letter code: `ucp_market_invalid`), never answered as US; `get_checkout` applies the same rule with the market the id carries, and an id that carries none is refused `ucp_escalation_reread_unconfirmed`. A create that names no market is still answered as US, labelled `market_assumed`, in USD or not at all. **New store calls with the flag on** (none of these is made with it off, where such a row is answered as unpriced): a seller whose money the read withheld in the market's OWN currency is asked to price the cart, exactly as a US checkout of a USD seller is today. That is: SG x an SGD seller, GB x a GBP seller, GB x a GBP seller whose storefront then answers in USD (the cart is asked for, its answer is not shown, the refusal is the named one), FR x an EUR seller, and the same for any other priced market x a seller in that market's currency. Each such create makes (a) one `/.well-known/ucp` profile read of the seller's host, once per host per process, and (b) one `create_cart`; a `get_checkout` on the id such a create minted (a v2 id, which carries the seller's cart) makes one `get_cart`. No other market or row gains a store call: a seller priced in another currency than the market's, DE, ZZ and a value that is not a country code are refused with no store call at all, and a US checkout of a USD seller sends exactly what it sends today. With the flag on, an unpriced row the rule can say nothing about (no price, no currency, no withheld note) logs one `ucp_merchant_door_pricing` line with `outcome: unlabelled`, `reason: row_currency_unknown`: a rise in that line means the withheld note is being lost between the read and the door. Off: every door answers as before. **Before on (prod-flip precondition):** (1) **a preview revision must show the real `get_pdp_v2`, read with NO market (the read this checkout makes: `include: ['product_overview']`, no `market`), emitting `metadata.serving_currency_guard.withheld_currencies` for a seller priced outside the deployment currency. This cannot be shown offline (the tests emulate the page) and the flag must not go on in prod before it is shown.** A seller for which the page reports nothing is answered as an unpriced row, as today, so without that report the flag refuses USD sellers for non-US markets and prices nobody new; (2) count from the `ucp_merchant_door_pricing` log how many creates per day name a market other than US, and which of those markets have no currency in the source (they will be refused by name); (3) tell partners the two refusal reasons and that pre-rule checkout ids with no market stop re-reading. |
| `AGENT_CHECKOUT_HOSTED_LINK_ENABLED` | `1` | `create_payment_link` tool | ON |
| `AURORA_BFF_USE_MOCK` | `false` | Aurora mock mode | OFF (also triple-gated non-prod in code) |
| `PROMOTIONS_MODE` | `remote` | Gateway promotions source | Remote (backend `/agent/internal/promotions`); `local`/`none` semantics per PR #1948 |
| `AGENT_SIGNATURE_VERIFY_MODE` | absent (`off`) | Inbound agent-signature verification on `/mcp`, `/ucp/*`, `/acp/*` (Visa TAP, IETF Web Bot Auth) | `observe` verifies and logs (`event: agent_signature`, access-log `agent_sig_*`) and never changes a response. `enforce` = observe plus the two scope variables below: a TAP claim that does not verify gets 401 in scope, and a verified TAP identity is recorded on `orders.metadata.agent_signature`. `enforce` with neither scope variable set behaves like observe. `delegate_payment` is never inspected |
| `AGENT_SIGNATURE_ENFORCE_ROUTE_GROUPS` | absent (none) | Enforce-mode route groups: `merchant_doors`, `checkout` (comma list) | `checkout` = `/acp/checkout_sessions*` plus MCP/UCP tools/call of a canonical checkout operation; `merchant_doors` = every other door request. Unsigned requests always pass. A TAP claim that could not be checked (key source down, timeout) passes as unverified |
| `AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON` | absent (none) | Per-merchant opt-in: `{"<merchant_id>": "enforce" \| "tap_only"}` | `enforce`: that merchant's forged TAP claims get 401 on any door. `tap_only`: that merchant's requests need a verified TAP signature (401 otherwise; 503 + Retry-After if it could not be checked). Applies only to requests that name the merchant (MCP `merchant_id` argument). Per-instance nonce store: wait for a shared store before using `tap_only` in prod |
| `AGENT_SIGNATURE_TRUSTED_KEY_SOURCES_JSON` | absent (default: Visa TAP JWKS `https://mcp.visa.com/.well-known/jwks`) | Which agent key sources are ever fetched | Allowlist of `{id, profile: web-bot-auth\|visa-tap, url}`; any other Signature-Agent is logged as an unresolved claim and never fetched (no SSRF) |
| `AGENT_SIGNATURE_EXPECTED_AUTHORITIES` | absent (default `commerce.mcp.pivota.cc,mcp.pivota.cc,gateway.pivota.cc,ucp.pivota.cc`) | Hosts a signature may name in `@authority` | A signature made for any other host (e.g. captured at another merchant and replayed here) is `authority_mismatch`. Set this if a door is served on another custom domain |
| `AGENT_SIGNATURE_VERIFY_BUDGET_MS` | absent (`1500`, clamped to ≤ `5000`) | Max time a signed door request waits for verification | On timeout the result is `verification_timeout` and the request proceeds. Key-source fetches time out at 1s, below this budget |
| `PARTNER_DOOR_ONE_PRODUCT_ID` | absent (off) | `/mcp` door only: one product id on the read tools | OFF. On: a group id passed to `get_product`/`get_offers` resolves to its product or is refused by name; read refusals are split (`PRODUCT_NOT_SERVABLE`, `UNKNOWN_PRODUCT_ID`); a `merchant_id` that is not the product's seller is refused; rows and product answers lose the group id fields; `get_offers` no longer declares `product_group_id`. `/ucp/mcp`, `/public/mcp` and the invoke route are unchanged by it. Lookup budget: `PARTNER_DOOR_LOOKUP_BUDGET_MS` (default `1500`). Before flipping: the prod counts listed in the PR. |

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
