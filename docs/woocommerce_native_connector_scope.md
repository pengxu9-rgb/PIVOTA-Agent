# Native WooCommerce Connector — Build Scope

**Status:** proposed / not started.
**Relationship to crawl path:** this is the *transactional* upgrade over `woocommerce_merchant_onboarding_via_crawl_runbook.md`. Do the crawl path first for coverage; build this only when live checkout/attribution on WooCommerce stores is a committed goal.
**Date:** 2026-07-08.

---

## Goal

Let a WooCommerce merchant connect their store and be a **live commerce rail** — discoverable *and* transactable (quote → order → refund → webhook status) — the same way Shopify is, via the `connectors/` abstraction.

## Reality check before scoping

Two structural facts shape all the effort estimates:

1. **The `connectors/` layer is not wired into the running server.** `MerchantConnector` / `ShopifyConnector` / `getConnector` are imported nowhere outside `connectors/` and its tests. Even Shopify's native money path is reference scaffolding today. **A WooCommerce connector inherits this blocker: the abstraction must be wired into `src/server.js` first, or in parallel.** This is shared infra work, not WooCommerce-specific.
2. **The merchant connect/OAuth flow + `merchant_stores` write live in a separate service**, not this repo. There is no OAuth callback and no `INSERT INTO merchant_stores` here. WooCommerce onboarding (key grant + store row) has to be built in that external app regardless of how good the connector is.
3. **The live payment rail is gated off in prod** (`SUBMIT_PAYMENT` off, `AGENT_CHECKOUT_STRICT` staging). A WooCommerce connector doesn't change that; it ships behind the same kill-switches.

So the connector class itself is the *smallest* piece. Budget accordingly.

---

## Interface to satisfy

`connectors/MerchantConnector.js` — implement `WooCommerceConnector extends MerchantConnector`, register in `connectors/registry.js` (`registerConnectorFactory('woocommerce', …)` or add to the factories map). Reference implementation to mirror: `connectors/shopify/ShopifyConnector.js`.

### Method-by-method mapping (Shopify → WooCommerce)

| Method | Shopify (reference) | WooCommerce equivalent | Difficulty |
| --- | --- | --- | --- |
| `syncCatalog` | Admin GraphQL `products` | REST `GET /wp-json/wc/v3/products` (paginate) or public Store API `/wc/store/v1/products` | **Low** — straightforward, catalog can be stale |
| `getProduct` | Admin REST product read | `GET /wp-json/wc/v3/products/{id}` | **Low** |
| `previewQuote` (INV-5 live lock) | Storefront `cartCreate` returns locked subtotal/tax/shipping/total | **No clean equivalent.** See below. | **High — the crux** |
| `createOrder` | Admin draft-order | `POST /wp-json/wc/v3/orders` (status `pending`/`on-hold`) | **Medium** |
| `createCheckout` | cart `checkoutUrl` | Store API cart → checkout URL, or order-pay URL `?pay_for_order` | **Medium** |
| `getOrderStatus` | Admin order read | `GET /wp-json/wc/v3/orders/{id}` (status + shipment tracking meta) | **Low–Medium** (tracking is plugin-dependent) |
| `refund` | Admin refunds | `POST /wp-json/wc/v3/orders/{id}/refunds` | **Low–Medium** |
| `verifyWebhook` | HMAC-SHA256 `x-shopify-hmac-sha256` | HMAC-SHA256 **base64** in `x-wc-webhook-signature` over raw body with webhook secret | **Low** (near-identical to Shopify) |
| `parseWebhook` | Shopify JSON → normalized event | WC webhook JSON → normalized event | **Low** |

### The hard part: `previewQuote` (INV-5)

`previewQuote` is the authoritative live price lock — it **must** hit the live merchant rail and return `locked_totals {subtotal, tax, shipping, total}`, `currency`, `merchant_of_record`, `line_items`, and an opaque `quoteRef` (see `connectors/shopify/ShopifyConnector.js:100-219`). WooCommerce has **no stateless server-to-server "create cart, give me computed tax+shipping" call** the way Shopify Storefront `cartCreate` does. Options, worst-to-best:

- **A. Store API cart** (`/wp-json/wc/store/v1/cart`): computes tax/shipping, but it's **session/nonce/cookie-based** — designed for a browser, awkward and fragile server-to-server. Nonce + cart-token handling per request.
- **B. Draft order with `calculate_totals`** via REST: create an order, read back computed totals, use as the lock; carry the order id in `quoteRef` so `createOrder` promotes it rather than re-creating. Cleaner for a headless agent, but leaves draft orders in the merchant's admin (needs a reaper for abandoned quotes).
- **Recommendation: B**, with the order left in a `checkout-draft`/`pending` state and promoted on `createOrder`. Document that tax/shipping accuracy depends on the store's tax + shipping **plugins** being configured — which is the deeper WooCommerce risk (below).

---

## WooCommerce-specific risks (why this is *not* "just another Shopify")

- **Self-hosted heterogeneity.** WooCommerce is a WordPress plugin. Version, PHP host, and third-party plugins (tax: TaxJar/Avalara/native; shipping: dozens of plugins; checkout: custom) vary per store. Shopify's uniformity does not hold. Totals correctness and webhook payload shape can differ store to store. This is the biggest reason to keep `previewQuote` strict and fail closed (`LIVE_QUOTE_INCOMPLETE`) rather than approximate.
- **Auth is not app-OAuth.** WooCommerce REST uses **consumer key/secret** (Basic auth over HTTPS). The redirect-based grant is `GET /wc-auth/v1/authorize` (store owner approves, WC posts keys back to a callback). This is the closest analog to Shopify's OAuth and is what the *external onboarding service* must implement — not the connector. Store keys + webhook secret land in `merchant_stores.config` / equivalent.
- **No app-store distribution / review.** Unlike the Shopify App Store, there's no central review gate — but also no central install. Each merchant runs the `/wc-auth` grant against their own site. Simpler in one sense, more support burden in another (merchants on outdated WC, HTTP-only sites, security plugins blocking REST).
- **Tracking/after-sales** (`getOrderStatus` tracking, returns/exchanges) are plugin-dependent; scope them as `NOT_SUPPORTED` initially (same as Shopify's return/exchange today) rather than promising them.

---

## Work breakdown

**In this repo (the connector — smallest piece):**
1. `WooCommerceConnector` implementing the 9 interface methods above. Money path fails closed on incomplete totals. (~est. medium; `previewQuote` dominates.)
2. Register in `connectors/registry.js`; add tests mirroring `connectors/test/connector.test.js` with injected `fetchImpl`.
3. **Wire the connector layer into `src/server.js`** (shared with Shopify — currently unwired): resolve `getConnector(merchant)` on the money path, route the live payment webhook (`src/server.js:29280`) through `verifyWebhook`/`parseWebhook`. Add `woocommerce` to the catalog-sync platform allow-list (`src/server.js:10558`) and confirm `buildCatalogSyncProductsUrl` (`src/server.js:10880`) routes it via the generic `?platform=` seam.

**Outside this repo (the actual blockers — larger):**
4. **Onboarding/OAuth in the external portal service:** implement the `/wc-auth/v1/authorize` redirect grant, capture consumer key/secret + register webhooks (`POST /wp-json/wc/v3/webhooks`) for orders/refunds, and write the `merchant_stores` row (`platform='woocommerce'`, domain, encrypted keys).
5. **Live product-fetch sync** in the `PIVOTA_API_BASE` service behind `/agent/internal/platform/products/sync/{merchant}?platform=woocommerce`.
6. **Billing / redirect attribution:** largely platform-neutral today (keyed off verified PDP/merchant URL), so minimal — confirm the WooCommerce PDP/order URLs flow through the existing attribution path.

**Sequencing:** 4 (onboarding) and 1–3 (connector) can go in parallel; nothing is live until both land *and* the `SUBMIT_PAYMENT` / `AGENT_CHECKOUT_STRICT` kill-switches are flipped for a controlled pilot.

---

## Recommendation

- **Do not start here.** Run the crawl runbook first — it captures the WooCommerce merchant coverage that most of the product (audit, discovery, index citability) actually needs, at ~zero integration cost.
- **Green-light the native connector only when a concrete WooCommerce merchant needs live agent checkout.** When you do, the connector class is the easy 20%; the onboarding/OAuth service + wiring the connector layer into the server are the real 80%, and both are shared prerequisites Shopify hasn't fully paid down either.
- Pilot with **one** cooperative WooCommerce store (known plugin stack) behind the kill-switches before generalizing — self-hosted heterogeneity means "works on store A" ≠ "works on all WooCommerce."
