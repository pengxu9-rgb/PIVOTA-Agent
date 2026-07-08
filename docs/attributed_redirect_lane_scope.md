# Attributed-Redirect Lane — Build Scope

**Goal:** protocol-originated traffic (ACP feed, MCP tools, agent PDP) emits **signed attributed redirect links to the merchant's own checkout**, so clicks → attribution edges → GMV → take, with **zero PSP connection required from the merchant**. This is the majority-merchant monetization lane, aligned with the post-Instant-Checkout-pullout direction (redirect to merchant-controlled checkout).

**Status:** scoped 2026-07-08, grounded in code traces of both repos. Not started.
**Companion docs:** `woocommerce_merchant_onboarding_via_crawl_runbook.md` (supply side), `woocommerce_native_connector_scope.md` (minority PSP-connected lane).

---

## 1. What already exists (verified, with state)

The downstream machinery is built in **pivota-backend**; the gap is almost entirely at the *emission* end and the *non-Shopify closure* end.

| Piece | Where | State |
|---|---|---|
| Signed redirect handler `GET /r?token=` | `routes/outbound_links.py:109` | **LIVE** (public, 302 to dest) |
| Token mint (HMAC-SHA256, `payload_b64.sig_b64`, TTL 7d) | `services/outbound_links_service.py:238` (`make_redirect_token`), secret `OUTBOUND_LINKS_SIGNING_SECRET` | **LIVE** |
| Seller-keyed mint w/ full ctx (`pvt_click_id`, `pvt_surface`, `merchant_id`, `pvt_product_id`, `pvt_variant_id`, `join_mode`, `seller_ref`, `seed_kind`) | `agent_shop_gateway.py:6439` `_make_external_redirect_url` | **LIVE** (T2-1 probe passed) |
| Click logging → `surface_click_events` (ctx JSONB; **no edge, no cookie at click**) | `outbound_links_service.py:586` | **LIVE** |
| Conversion closure (external): Shopify `orders/paid` webhook → `close_external_order_conversion` → `commerce_attribution_edges` w/ `gross_attributed_gmv_cents`; join key = `pivota_click_id` round-tripped through Shopify cart-permalink `note_attributes` | `webhook_routes.py:2295`, `commerce_attribution_service.py:655` | **LIVE** (but see Shopify webhook-registration bug) |
| Shopify order **poller** fallback (T2-2b) | `external_conversion_poller.py` | Registered, **gated OFF** (`EXTERNAL_CONVERSION_POLLER_ENABLED` unset) |
| Internal (PSP-order) edge + GMV stamp + T9 reaper | `commerce_attribution_service.py:312`, `psp_payment_finalizer.py`, `jobs/stamp_attribution_reaper_job.py` | **LIVE** |
| T6 daily GMV rollup → `gmv_attribution_daily` (take = net × `take_rate_bp`; 500bp promo / 1000bp std) | `gmv_aggregation_service.py` | **LIVE** (02:00 UTC) |
| T7 monthly invoice (Stripe Billing on merchant `stripe_customer_id`) | `invoice_generation_service.py`; scheduler `audit_scheduler.py` | **PAUSED** (`next_run_time=None`; enable = `resume_job`, no deploy) |
| Woo/BigCommerce **product-sync** adapters (NOT conversions) | `adapters/woocommerce_adapter.py`, `adapters/bigcommerce_adapter.py`, `routes/universal_product_sync.py` | Built (sync-only) |
| **Non-Shopify conversion closure** | — | **DOES NOT EXIST** |
| **Attribution on ACP/MCP/PDP link emission** | — | **DOES NOT EXIST** (all links bare) |

Gateway emission points (PIVOTA-Agent), all currently bare:
- **ACP feed:** `safety-kernel/src/protocol/acpRestAdapter.js:345` (`link: o.link ?? o.url` in `defaultFeedItem`); products come straight from backend `find_products`.
- **MCP tools:** single funnel `mcp-server/src/commerceToolSurface.js:99-104` (`callTool` → `sanitizeResult`); `get_offers` URL via `src/agentSignals/offerToSignal.js:29`.
- **Consumer PDP + offer metadata:** single resolver `src/pdpBuilder.js:258` `resolveProductExternalRedirectUrl` → PDP `:5235` and `buildOfferPurchaseMetadataFromProduct` (`src/server.js:9375-9392`, already emits `purchase_route:'affiliate_outbound'` shapes — bare).

## 2. Design decision: stamp at the source (backend), not in the gateway

**Chosen: Option 1 — pivota-backend stamps attributed URLs into the product/offer payloads it already serves** (`find_products`, `get_product_detail`, `offers.resolve` render points), reusing `_make_external_redirect_url` with new `pvt_surface` values (`acp_feed`, `mcp_tool`, `agent_pdp`). Backend already does exactly this on other render paths (`agent_api.py:3689`, `agent_sdk_fixed.py:289`) — this extends an existing pattern to the surfaces the gateway consumes.

Why not gateway-side minting (Option 2): it requires sharing `OUTBOUND_LINKS_SIGNING_SECRET` across services and duplicating the ctx contract + `click_id` semantics in JS — drift risk on the exact fields order-closure depends on. Gateway keeps a thin role: **stop dropping fields** and (optionally later) a defense-in-depth assert that outbound URLs are attributed.

Key consequence: because `resolveProductExternalRedirectUrl` already prefers explicit `external_redirect_url`/`affiliate_url` fields, **backend-stamped URLs propagate to the consumer PDP and offer metadata automatically** — no consumer-pipeline change needed beyond verification.

## 3. Work breakdown

### Phase 0 — Emit attributed links on protocol surfaces (the wiring; small)
**pivota-backend:**
1. At the serializers behind `find_products` / `get_product_detail` / `offers.resolve` consumed by the gateway (`/agent/v1/products/search`, `/agent/shop/v1/invoke` rails): populate `link`/`url`/`external_redirect_url` with `_make_external_redirect_url(...)` output when the product has an external destination. New `pvt_surface` enums; thread `seller_ref`/`seed_kind` exactly as the T2-1 path does. `join_mode`: `cart_permalink` for Shopify-destination products, `referral_only` otherwise (today).
2. Config: confirm `OUTBOUND_LINKS_SIGNING_SECRET` set in prod (currently falls back to `ADMIN_API_KEY`/`JWT_SECRET_KEY` — set the dedicated secret).
3. **Token TTL vs caching:** feed links live in agent-platform caches longer than 7 days. Either raise `exp` for `pvt_surface=acp_feed` (30–90d) or accept expiry → the `/r` handler should degrade to a 302-to-dest-without-logging rather than an error page (verify current expiry behavior; a hard failure on expired tokens breaks cached feeds).

**PIVOTA-Agent (gateway):**
4. `defaultFeedItem` (`acpRestAdapter.js:338`): keep `link` passthrough (now attributed from source); plumb `offer_id`/`seller_ref` if the feed schema wants them; add feed-item test asserting `/r?token=` shape.
5. `offerToSignal.js:29`: stop dropping `checkout_url`/`affiliate_url` — surface the attributed URL.
6. Verification tests: ACP feed + MCP `search_catalog`/`get_product`/`get_offers` + PDP all emit `/r?token=` URLs; token round-trips through backend `parse_and_verify_redirect_token`.

**Exit criteria:** ≥95% of feed/MCP/PDP outbound links attributed; click on a protocol-surface link → `surface_click_events` row with correct `pvt_surface`.

### Phase 1 — Make conversion closure real for Shopify-destination traffic (mostly ops + one bug)
The closure path exists but has two known holes:
1. **Shopify webhook registration never succeeds on any auto-install path** (App A lacks `write_webhooks` → 403; `/connect` never registers — see `shopify-app-config-audit`). Fix registration for connected stores **or** flip `EXTERNAL_CONVERSION_POLLER_ENABLED=1` (T2-2b poller already handles `read_orders`-only merchants). Poller flip is the fast path; webhook fix is the durable one. Do both, poller first.
2. Also fix in passing: the **unauthenticated** `/webhooks/register/shopify` and the **unauthenticated** `POST /api/links/resolve` (mints tokens with caller-chosen ctx — at minimum rate-limit + auth before this lane raises its value).

**Exit criteria:** a live click → Shopify order with `pivota_click_id` note-attribute → `commerce_attribution_edges` row with `gross_attributed_gmv_cents` stamped, for at least one real merchant.

### Phase 2 — Non-Shopify conversion closure (the genuinely new build; medium)
Today `referral_only` links get click attribution but GMV stays NULL. Per-platform closure, tiered by merchant connection level:

| Tier | Merchant gives us | Closure mechanism | Fidelity |
|---|---|---|---|
| W1 WooCommerce (connected keys) | wc/v3 consumer key (read_orders) | Stamp `utm_source=pivota&utm_medium=agent&utm_content={click_id}` on dest; **WooCommerce 8.5+ core Order Attribution** persists UTM/session onto the order (`_wc_order_attribution_*` meta); extend the existing `woocommerce_adapter` sync to poll orders + join `utm_content→click_id` → `close_external_order_conversion` (generalize its Shopify-specific parsing) | Exact join |
| B1 BigCommerce (connected keys) | API token (orders read) | Orders webhook or poll; join via UTM/analytics params on the storefront session where preserved, else coupon-code fallback | Exact-to-good |
| X0 No connection (any platform) | Nothing | Click-only attribution; **no GMV closure** — do not fake it. Optionally later: merchant-reported conversions API or statement-based reconciliation | Click-only |

Backend work: generalize `close_external_order_conversion`'s order-shape parsing (it currently assumes Shopify `note_attributes` + Shopify totals) behind a small per-platform adapter; add `(merchant_id, external_order_id)` closure for Woo/BC order ids (unique index already supports it).

**Honesty rule:** GMV/take are only billed on closed conversions. Tier X0 merchants see click/traffic value, not invoices — this is also the upsell path to Tier W1/B1 ("connect read-only order access to see and monetize conversions").

### Phase 3 — Turn on the money (ops/business, no code)
1. `resume_job('invoice_generation_monthly')` (T7) — designed for no-deploy promotion.
2. Merchant billing enrollment: billable = `merchants.stripe_customer_id` via `subscription_id` join — enrollment flow per `redirect-commission-loop` track.
3. First billing run on a canary merchant with closed conversions; verify invoice idempotency (`invoice:{run}:{merchant}`).

## 4. Open decisions

- **D1 — ACP feed `link`: attributed `/r` URL vs Pivota canonical PDP URL.** Agent platforms may prefer/require a product landing page over a redirect URL in feeds (and may strip trackers). Alternative: feed `link` → `agent.pivota.cc` canonical PDP (already live, JSON-LD, citable) whose *outbound* buttons are attributed — keeps feed spec-clean AND keeps Pivota in the loop. Recommendation: **PDP for `acp_feed`, direct `/r` for MCP tool outputs** (agents follow tool URLs programmatically). Decide at Phase 0.
- **D2 — Double-attribution guard.** If an agent creates an in-protocol order after ALSO clicking an attributed link, internal + external closure could compete. The unique `order_id` / `(merchant_id, external_order_id)` indexes make this idempotent per-order; confirm precedence rule (internal PSP edge wins; external closure no-ops) with a test.
- **D3 — Feed token TTL** (Phase 0 item 3): long-TTL vs expired-token-degrade. Recommendation: degrade gracefully + 30d TTL for feed surface.

## 5. Risks

- **Agent platforms rewriting/stripping links** — mitigated by D1 (PDP-as-link) and by the fact `/r` is a first-party domain redirect, not a third-party affiliate wrapper.
- **T7 was paused for a reason** — billing enrollment + statement trust must be ready before invoices go out (see channel-partner-onboarding-readiness for the adjacent partner-side gaps).
- **Woo closure depends on WC ≥8.5 Order Attribution** being enabled on the store; older stores fall back to Tier X0 or a coupon-join.
- **`/api/links/resolve` unauthenticated** — becomes a real abuse surface once these links carry money significance (Phase 1 item 2).

## 6. Sizing (rough)

- Phase 0: ~3–5 eng-days across both repos (render-point wiring + field plumbing + tests).
- Phase 1: ~2–4 days (poller flip = hours; webhook registration fix = the bulk; auth fixes small).
- Phase 2: ~1.5–2 wks (Woo first; BC after), dominated by per-platform order parsing + E2E verification against a real store.
- Phase 3: ops + business enrollment, not eng-bound.

**Sequenced value:** Phase 0+1 alone light up the loop for every Shopify-destination product discovered via ACP/MCP with zero merchant asks. Phase 2 extends the same economics to WooCommerce/BigCommerce with only a read-only order-key ask (no PSP, no checkout change) — the compliance-light offer the majority can say yes to.
