# Shopify App Configuration Audit — Gap Report + Fix Plan

**Date:** 2026-07-07
**Audited against:** `pivota-backend` `origin/main` @ `c93e59fc` (NOT the stale local branch; local checkout was on `w3a-llm-json-parser` and missing ADR-009 / the poller entirely).
**Required reading completed:** `docs/IDENTITY_REFERENCE.md`, ADR-006/007/008/009 (Accepted), `config/settings.py:86-140`.
**Founder directive applied throughout:** a capability that only exists via a fallback is reported as a **mainline gap**, never as "covered".
All `file:line` references below are into `pivota-backend` @ `c93e59fc` unless prefixed otherwise.

---

## Executive verdict (the orders/paid question, answered first)

**`orders/paid` IS in every registration topic list** — OAuth mainline (`routes/merchant_store_connections.py:38-47`, used at `:1007`), verify (`services/shopify_integration_verify.py:380`), manual/ops (`routes/webhook_routes.py:2457`, `routes/ops_shopify_integration_routes.py:116`). The topics list is not the problem.

**The registration never actually succeeds on any automatic install path.** This is the hidden fallback-as-mainline the directive forbids, one layer down from where C1 pointed:

1. **ALL OAuth installs → App A** (`routes/merchant_store_connections.py:150-174` — `_APPSTORE_INSTALL_SOURCES = {app_store, merchant_portal, public_install_link}`, and the fallthrough uses headless creds but the comment at `:148-154` states App B "is never used for OAuth"). App A's scope set is `read_products,read_orders,read_fulfillments,read_discounts` — **no `write_webhooks`** (`config/settings.py:104-107`, deliberate per the comment). So the post-OAuth `register_webhooks_best_effort` call (`merchant_store_connections.py:1002-1010`) **403s on every topic** for App-A installs. Best-effort: the failure is stored in `webhooks_report` and logged, nothing retries.
2. **The custom-token connect path (`POST /integrations/shopify/connect`, `merchant_store_connections.py:1255`) — the path the internal write-tier App B actually uses — never calls webhook registration at all.** Registration for these stores happens only if someone manually runs `POST /integrations/shopify/verify` (`:1567` → `verify_shopify_integration`) or the ops resubscribe endpoint.
3. **The public app's `shopify.app.toml` declares NO order-webhook subscriptions** — only the three compliance topics (toml found parked, untracked, at `/Users/pengchydan/dev/tmp/pivota-backend-parked-untracked-2026-07-03/shopify.app.toml`; `[[webhooks.subscriptions]]` lists `compliance_topics` only). App-owned toml subscriptions are the ONE mechanism that delivers webhooks to a public app without `write_webhooks` — and it is unused.
4. The polling floor (`services/external_conversion_poller.py`) is **default OFF** (`_POLLER_ENABLED_ENV`, `:72-82`, "OFF unless explicitly enabled").

**Net effect:** for any store connected via OAuth or custom-token paste without a manual verify step, T2-2's webhook mainline never fires and nothing else runs. Conversion closure currently works only on stores where verify/resubscribe was manually run **with a write_webhooks-capable token** (custom-app tokens). This is a mainline gap, not a poller-covers-it situation.

---

## (a) Requirement × capability matrix

Columns: **Internal/custom app** (App B, custom-token connect, `shopify_headless_scopes` = `read_products,read_orders,read_fulfillments,read_discounts,write_webhooks,write_orders`, `settings.py:132-135`) and **App Store app** (App A, `shopify_appstore_scopes`, `settings.py:104-107`).

| Req | Internal / custom app | App Store app | Evidence |
|---|---|---|---|
| **R1** Catalog sync, numeric variant ids | **OK** | **OK** | `read_products` in both sets; consumers `jobs/catalog_import_worker.py:259`, `adapters/product_adapters.py:397`. Cart permalink refuses to fabricate variant ids — numeric-only guard `services/outbound_links_service.py:200-212`, `build_shopify_cart_permalink:215-224` returns `None` on non-numeric (honest failure, correct) |
| **R2** Conversion webhook (`orders/paid` registered + handler) | **GAP (conditional)** — handler exists and is correct (`routes/webhook_routes.py:1942-2000`, closure gated to `orders/paid` at `:1968`), scope `write_webhooks` present, but the custom-token connect path (`merchant_store_connections.py:1255`) never registers; only manual verify (`shopify_integration_verify.py:377-394`) does | **GAP (structural)** — no `write_webhooks` in scope set (`settings.py:104-107`), post-OAuth registration 403s (`merchant_store_connections.py:1002`), no toml `[[webhooks.subscriptions]]` for order topics | See executive verdict |
| **R3** Polling floor (`read_orders`) | **OK as floor** — `read_orders` present; poller `services/external_conversion_poller.py`, PII-free `_ORDER_FIELDS` (`:66-70`), default OFF (`:72-82`) by design | **OK as floor** — same | Poller is deliberately the floor, not the mainline — do not count it as R2 coverage |
| **R4** Seller-mismatch guard (converting shop domain) | **OK** | **OK** (same handler) | Webhook: passes HMAC-verified, allowlist-checked `got_canon` (`webhook_routes.py:1992`, gate at `:1701-1754`); poller: polled store-of-record forwarded (`external_conversion_poller.py:197-223`, `:308`); exclusion semantics per `IDENTITY_REFERENCE.md` §4 (A9-1, shipped in the audited commit) |
| **R5** Cart attributes → `note_attributes` | **VERIFY (store-side)** | **VERIFY (store-side)** | Code side correct: `attributes[pivota_click_id]` appended (`outbound_links_service.py`, permalink at `:215-224`); extraction reads only that key (poller `:202`, webhook `:1970`). Whether a checkout customization strips attributes is a store/dashboard check → **D5a** below |
| **R6** Read-minimal, no forbidden writes | **OK with 3 flags** — `write_orders` is genuinely consumed (see (d)); `write_webhooks` consumed (registration). Flags: dead `write_checkouts`-dependent fallback, unscoped fulfillment-create call, BYO metafield write — details in C3 | **OK** — set is pure-read, matches toml `[access_scopes]` exactly | `settings.py:104-107` comment vs toml `scopes = "read_discounts,read_fulfillments,read_orders,read_products"` — match confirmed |

---

## Code-check findings (C1–C6)

### C1 — Webhook topic registration
Answered above. Additional finding: **the three compliance topics are wrongly included in every REST self-registration list** (`shopify_integration_verify.py:391-393`, `webhook_routes.py:2482-2484`, `ops_shopify_integration_routes.py:127-129`). Shopify rejects compliance-topic subscription via the REST webhooks API (they are app-config-managed) — these three permanently land in `failed`, polluting every verify report and masking real registration failures. Remove them from the REST lists; they are correctly declared in the toml.

Also: "idempotent re-registration for already-connected stores" exists only as manual ops tooling (`ops_shopify_integration_routes.py:90-148`); there is no sweep.

### C2 — Compliance webhooks (public-app blocker)
- Endpoints exist and are HMAC-gated: static `POST /webhooks/shopify/gdpr` (`webhook_routes.py:1506-1588`, HMAC at `:1524-1533`) — matches the toml's declared uri — plus the per-merchant handler branch (`:2389-2395`).
- **Both handlers are log-and-200.** They record topic + payload key names into `order_events` and take no action: no data-request export, no purge, no redaction (`:1576-1588`, `:2389-2395`).
- **The "we hold nothing to purge" defense does not hold.** Pivota stores merchant-customer PII in at least: `pcs_shopify_webhook_events.payload_json` (full raw order webhook payloads incl. customer object/email/addresses — persisted at `webhook_routes.py:1770-1778` via `services/shopify_webhook_ingest.py`, schema `db/migrations/032_pcs_v0_1.sql`), Pivota-side `orders` (`db/orders.py:35-37`: `customer_name`, `customer_email`, `shipping_address` — these include orders created **into merchant Shopify stores** via `write_orders`), `platform_orders.data` (imports, `db/migrations/029_platform_orders.sql`), and `pcs_order_facts`/`pcs_evidence_packs` (`db/migrations/034`).
- **Dual-app HMAC gap:** the GDPR endpoint verifies only `settings.shopify_client_secret` (`webhook_routes.py:1524`). Once `SHOPIFY_APPSTORE_CLIENT_SECRET` diverges from the legacy env (App A repointed), App A's compliance webhooks will 401 → automated review fails. Must accept both app secrets.

### C3 — Scope minimization per install type
Full consumer trace (per-scope):

| Scope | Consumers on main | Verdict |
|---|---|---|
| `read_products` | `jobs/catalog_import_worker.py:259`, `adapters/product_adapters.py:397,230`, `routes/order_routes.py:1829` | Keep (all sets) |
| `read_orders` | poller `:158`, `readiness/service.py:2301`, `routes/merchant_api_extensions.py:285`, `routes/order_routes.py:2704` | Keep (all sets) |
| `read_discounts` | `services/shopify_promotions_sync.py:233` (price_rules sync) | Keep |
| `read_fulfillments` | **No direct REST/GraphQL consumer found.** Fulfillment data arrives only via webhooks (`fulfillments/create|update`, handler ~`webhook_routes.py:1860-1940`) | Conditional drop — see (d) |
| `write_orders` | **Consumed**: order create `routes/order_routes.py:6606` (POST /orders.json); order update / manual sale transaction / refunds `routes/merchant_api_extensions.py:251,321,390`; cancels `routes/refund_api.py:485`, `order_routes.py:2982`; fulfillment create `adapters/shopify_real_adapter.py:306` | Keep on headless only (already excluded from App Store set — correct) |
| `write_webhooks` | `shopify_integration_verify.py:47,96-153`, `webhook_routes.py:2502` | Keep on headless only |

**R6 flags (write-dependent code beyond the declared sets):**
1. **Dead fallback (founder-directive violation):** `services/shopify_pricing_service.py:125` POSTs Admin `/checkouts.json`, which requires `write_checkouts` — a scope we deliberately rejected. `services/quote_service.py:184` wires it as the fallback lane after Storefront Cart pricing. Since no install type ever holds `write_checkouts`, this lane can only 403 (the code's own hint at `~:155` admits it). It is a fallback that cannot succeed — remove it; Storefront Cart is the mainline.
2. **BYO metafield writeback:** `services/shopify_content_writeback.py:150` calls `metafieldsSet` (needs `write_products`) using whatever Admin token the merchant connected (`:121-128` "auth-agnostic"). Honest when missing (`needs_write_products`, `:159`). Not a scope-set bug, but note: E1 writeback works ONLY on BYO tokens whose custom app granted `write_products`; neither Pivota app can ever perform it. Keep documented as a BYO-tier capability, not an app capability.
3. **Unscoped fulfillment write:** `adapters/shopify_real_adapter.py:306` POSTs `orders/{id}/fulfillments.json`. No `write_fulfillments`-class scope exists in any set, and the order-scoped REST fulfillment-create is deprecated. Either this path is dead in production or it survives on legacy custom-app tokens — verify and either scope it deliberately or delete it.
4. **Third OAuth path:** legacy `routes/shopify_routes.py:187` still builds authorize URLs from the full `shopify_scopes` (with `write_orders`+`write_webhooks`). If reachable, it requests write scopes under App A's client id → Shopify 400s (undeclared scopes) or, worse, grants writes under legacy single-app envs. Consolidate onto `resolve_shopify_app`.

### C4 — HMAC/secrets
- **Production is strict:** missing shop-domain header → 401; domain not in the merchant's connected-store allowlist → 403; no secret → 500; missing/invalid HMAC → 401 (`webhook_routes.py:1701-1754`). Secret resolution: per-store `webhook_secret` persisted at OAuth as the **owning app's** secret (`merchant_store_connections.py:986-989` — dual-app correct) → fallback env app secret; any-match accept (`:1669-1673`, documented migration behavior).
- **Off-production accepts unsigned webhooks** (`is_production` gate) — acceptable for dev, but note it.
- **FINDING (security, P0): `POST /webhooks/register/shopify/{merchant_id}` is unauthenticated** (`webhook_routes.py:2410-2413`; router has no auth dependency, `webhook_routes.py:63`; mounted plain at `main.py:1053`). It takes a caller-supplied `callback_base_url` and uses the merchant's **stored admin token** to register webhooks pointing at `{callback_base_url}/webhooks/shopify/{merchant_id}`. Anyone who knows/guesses a merchant_id can re-point that store's order webhooks (full-PII payloads) to an attacker-controlled host. The authenticated ops equivalent already exists (`ops_shopify_integration_routes.py:90`, `Depends(get_current_employee)`) — the open endpoint should be deleted or locked to the same dependency.

### C5 — Token model
`services/shopify_access_token_service.py:135` `resolve_shopify_admin_access_token`:
- **OAuth installs (App A):** per-store offline `access_token` persisted at callback (`merchant_store_connections.py:980-990`); returned as-is (no expiry).
- **Custom-token connects (App B / BYO):** static pasted token; if the merchant also supplied `client_id`+`client_secret`, the service auto-refreshes via the **client-credentials grant** with expiry metadata + 5-min skew (`:54-73`), persisting rotated creds (`:189-198`).
- **Refresh failure is silently absorbed:** errors land in the returned `meta` dict (`:176`), but every call site discards it (`access_token, _ = ...` — `shopify_integration_verify.py:332`, `ops_shopify_integration_routes.py:104`, `webhook_routes.py:2439`, `shopify_pricing_service.py:106`). A dead refresh degrades to a stale token and surfaces only as downstream Shopify 401s with no signal pointing at token refresh. Add a metric/log on `meta["refresh_error"]` at the resolver (one place), not per-caller.

### C6 — Protected customer data minimization
**Attribution reads ZERO PII — target met on the compute path:**
- Poller `_ORDER_FIELDS` (`external_conversion_poller.py:66-70`): id/name/order_number/financial_status/note_attributes/price-set fields/currency/timestamps — no customer, email, phone, address. Keep as is.
- Closure persists only 4 non-PII order fields into edge metadata (`services/commerce_attribution_service.py:711-715`).
- Webhook closure reads only `note_attributes` + totals (`webhook_routes.py:1970-1974`).

**But PII enters and persists elsewhere:**
| Location | PII | Consumer / justification |
|---|---|---|
| `pcs_shopify_webhook_events.payload_json` (`webhook_routes.py:1770`, migration 032) | Full raw order webhook payloads (customer object, email, addresses) | Tamper-evident audit trail — but stores far more than any consumer reads. Trim or redact (fix plan #6) |
| Pivota `orders` table (`db/orders.py:35-37`) | `customer_name`, `customer_email`, `shipping_address` | Pivota checkout stack (order creation via `write_orders` needs ship-to). Legitimate consumer; must be covered by redact handlers |
| `services/shopify_pricing_service.py:125` payload | Sends `customer_email` + `shipping_address` **to** Shopify | Quote pricing; lane is dead anyway (C3 flag 1) — removing it removes this flow |
| `platform_orders.data`, `pcs_order_facts` | Depends on import source | Review at import boundary |

**D2 consequence:** the code audit supports requesting the ORDERS object with **no PII field-level access** for the public app — provided fix #6 (payload trimming) lands first, because today the raw webhook store would receive PII even if we never read it.

---

## (b) Prioritized fix plan

1. **P0 — Close the registration gap on the internal mainline (the answer to "orders/paid first").** Make webhook registration a mandatory, verified step of `POST /integrations/shopify/connect` (custom-token path): call `register_webhooks_best_effort` with the OAuth topic list and **fail the connect response visibly** (not best-effort-silent) if `orders/paid` isn't created/already-present. Add a one-shot idempotent re-registration sweep over already-connected Shopify stores (the ops resubscribe endpoint per merchant, batched). Effort: small PR + one ops run.
2. **P0 — Lock down `POST /webhooks/register/shopify/{merchant_id}`** (`webhook_routes.py:2410`): add `Depends(get_current_employee)` or delete in favor of the ops route. Webhook-repointing = order-PII exfiltration primitive.
3. **P0 (public app) — Give App A a webhook path that can exist.** App A can never self-register (no `write_webhooks`, correctly). Add app-owned `[[webhooks.subscriptions]]` to `shopify.app.toml` for at least `orders/paid` and `app/uninstalled`. Constraint: toml subscriptions deliver to ONE static uri — the per-merchant `/webhooks/shopify/{merchant_id}` address doesn't fit. Build a static `POST /webhooks/shopify/orders` endpoint that resolves merchant by `X-Shopify-Shop-Domain` (the `/gdpr` handler at `webhook_routes.py:1535-1564` already implements exactly this lookup) and dispatches into the existing handler logic, HMAC-verified against **App A's** secret. Until this ships, the App Store listing has no conversion loop at all — and the poller must NOT be flipped on to paper over it.
4. **P1 (public-app blocker) — Make compliance handlers fulfill obligations.** `customers/redact`: purge/anonymize matching rows in `orders` (customer_name/email/shipping_address) and matching `pcs_shopify_webhook_events` payloads; `shop/redact`: same by shop domain + drop synced store data; `customers/data_request`: export or explicitly record "no data held" per store after fix #6. Also: accept **both** app secrets on the `/gdpr` endpoint (`webhook_routes.py:1524`) using the same candidate pattern as the main handler.
5. **P1 — Remove compliance topics from all three REST registration lists** (`shopify_integration_verify.py:391-393`, `webhook_routes.py:2482-2484`, `ops_shopify_integration_routes.py:127-129`). They can never register and bury real failures. (This is the one candidate "one-line-class" code fix; everything else above is plan-only per session scope.)
6. **P1 — PII-trim the webhook audit store.** Strip/redact `customer`, `email`, `phone`, `billing_address`, `shipping_address` from order-topic payloads before persisting to `pcs_shopify_webhook_events.payload_json` (no consumer reads them; C6). Precondition for the D2 "no PII fields" request.
7. **P2 — Delete the dead Admin-Checkout pricing fallback** (`shopify_pricing_service.py` lane in `quote_service.py:184+`): requires the rejected `write_checkouts`, can only 403, and ships customer PII in its request payload. Storefront Cart is the mainline; a failing Storefront quote should fail honestly.
8. **P2 — Consolidate the legacy OAuth path** (`routes/shopify_routes.py:187`) onto `resolve_shopify_app` so no path can request write scopes under App A.
9. **P2 — Token-refresh observability:** log/metric on `meta["refresh_error"]` inside `resolve_shopify_admin_access_token` (`shopify_access_token_service.py:176`).
10. **P2 — Decide the unscoped fulfillment write** (`adapters/shopify_real_adapter.py:306`): verify whether any live path reaches it; scope it deliberately or delete.

---

## (c) Founder / Partner-dashboard checklist (code cannot verify these)

- **D1 — Scopes in Partner dashboard for BOTH apps.** App A ("Pivota", client_id `7c972475…`): dashboard + toml must be exactly `read_discounts,read_fulfillments,read_orders,read_products` (= `shopify_appstore_scopes`; drop `read_fulfillments` from both if (d)-1 is accepted). App B ("Pivota Merchant", custom): confirm the custom-app token scopes match `shopify_headless_scopes` incl. `write_orders,write_webhooks`. **Also: commit `shopify.app.toml` into `pivota-backend`** — it currently lives untracked at `~/dev/tmp/pivota-backend-parked-untracked-2026-07-03/shopify.app.toml`, so the settings comment "MUST exactly match shopify.app.toml" is unenforceable and the config-as-code discipline (deploy `--allow-updates`, never `--allow-deletes`) has no source of truth in-repo.
- **D2 — Protected customer data access (public app):** request the **ORDERS object with NO PII field-level access** (email/name/address/phone all unneeded — C6 verdict), after fix #6 lands so the stored-payload reality matches the request.
- **D3 — Webhook API version + compliance URLs.** Toml pins webhooks `api_version = "2026-01"` while all code registers/calls `2024-07` (`shopify_integration_verify.py:22`, `webhook_routes.py:2502`) — pick one and pin both. Confirm compliance webhook URL `https://api.pivota.cc/webhooks/shopify/gdpr` is set in the Partner dashboard for App A (toml already declares it) and decide the App-B equivalent (custom apps get compliance topics via dashboard config too).
- **D4 — OAuth redirect allowlist.** Toml declares `https://api.pivota.cc/integrations/shopify/oauth/callback`, which matches the real route (`/integrations` prefix + `/shopify/oauth/callback`, `merchant_store_connections.py:33,866`). Verify the Partner-dashboard allowlist for BOTH apps includes exactly this (and any staging host); note `/integrations/shopify/install` (`:814`) is a landing route, not a redirect URI.
- **D5 — Distribution + store-side checks.**
  - (a) On `92sfrj-bi.myshopify.com` / `pivota-review-demo`: place a test order through a cart permalink and confirm `attributes[pivota_click_id]` survives into order `note_attributes` (R5 — verifies no checkout customization strips attributes).
  - (b) Confirm the internal install links for house/test stores still route through the custom-token `/integrations/shopify/connect` path (App B) and that those stores' webhooks were registered (run `/integrations/shopify/verify` per store; expect the three compliance topics in `failed` until fix #5).
  - (c) Public-listing blockers beyond D2/D3, in order: compliance handlers that actually purge (fix #4), an App-A webhook delivery path (fix #3), App A still under review (per Shopify-app-config memory: dev-store install gated while App A is in review; `use_legacy_install_flow = true` in the toml — Shopify now pushes managed install; expect review feedback).

---

## (d) Scopes to REMOVE (minimization), with consuming-code evidence

1. **`read_fulfillments` — drop from all three sets, with one decision attached.** No REST/GraphQL consumer exists on main (verified sweep; fulfillment data arrives only via `fulfillments/*` webhooks, handler ~`webhook_routes.py:1860-1940` feeding shipped-status + review invitations). Caveat that makes this a decision rather than a mechanical drop: Shopify gates *subscribing* to `fulfillments/*` topics on fulfillment access — if we keep those topics (shipped-status → review-invitation flow), the scope stays and its justification is "webhook subscription authorization", which should be written into the `settings.py` comment. If the public app doesn't need shipped-status (it currently gets no webhooks at all), drop the scope from `shopify_appstore_scopes` + toml before review — every scope is review surface.
2. **`write_orders` — KEEP on headless, keep excluded from App Store.** It is genuinely consumed, not vestigial: order create `order_routes.py:6606`, manual sale transaction `merchant_api_extensions.py:321-366`, refunds `:390`, order update `:251`, cancels `refund_api.py:485` + `order_routes.py:2982`. The settings comment ("manual sale/refund records") undersells it — it's the whole Pivota-checkout write path. Correctly absent from `shopify_appstore_scopes`.
3. **`write_checkouts` / `write_payments` / `read_customer_payment_methods` — confirmed absent from all sets** (R6 posture holds). The only code that wanted `write_checkouts` is the dead pricing fallback (fix #7) — delete the code, not add the scope.
4. **Legacy `shopify_scopes` env default (`settings.py:90-93`) — retire after fix #8**, leaving `appstore` and `headless` as the only two sets, so no path can accidentally request the union.

---

*Method note: two independent code-sweep agents (scope-consumer trace; order-data/PII enumeration) + direct reads of every file named in the brief, all against `origin/main`. Prod dashboard state (D1-D5) was not accessed in this session.*
