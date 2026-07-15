# Shopify App Store Review — Submission Checklist (App A "Pivota")

**Target submission date:** 2026-07-14 (earliest the app can be re-submitted).
**App:** App A "Pivota" — public / App Store distribution, **read-only merchant tool**.
- client_id `7c97247555f2ca1330705c230832b070`
- Partner org: Carvanaut Limited · dashboard app `313209552897` (org `201778642`)
- Active config version at time of writing: **`pivota-8`** (managed install + `orders/paid`/`app/uninstalled` app-owned webhooks + `api_version=2024-07`).
- Config-as-code source of truth: `shopify.app.toml` at `pivota-backend` repo root (on `main`).

**Scope discipline (do NOT change for review):** App A stays `read_discounts,read_fulfillments,read_orders,read_products`. Never add `write_orders`/`write_webhooks` to the public app — write access belongs only to App B (`3978…`), a **custom single-org app that is never submitted for public review**. Attribution runs entirely on App A read-only (verified — see §2).

Status legend: ✅ done & verified this session · ⬜ founder action before submit · 🔁 day-of verify.

---

## 1. Automated review checks (Shopify runs these on submit)

These are the checks that auto-fail a submission. Current state:

- ✅ **App authenticates immediately after install.** Managed install (`use_legacy_install_flow=false`) auto-grants the declared scopes; OAuth completes to a working token. Verified end-to-end on dev stores `pivota-review-demo-3` (2026-07-07) and `pivota-review-demo` (2026-07-15, the current reviewer store — §5.3): `auth_ok: true`, 4 read scopes, no write.
- ✅ **OAuth requests only declared scopes.** Authorize URL scopes exactly match toml `[access_scopes]`. Requesting an undeclared scope 400s the authorize request (that check is why the set must match) — confirmed the consent screen renders the correct read-only permission set.
- ✅ **Install redirects to a real UI, not raw JSON.** Callback 302-redirects to `merchant.pivota.cc/app/install/success?...` (verified — landed with `status=success`). This satisfies the 2.1.1 "no display errors" check; a raw JSON body on the callback is a known auto-flag.
- ✅ **Latest-supported API version.** `api_version=2024-07` pinned in toml and matched by all backend code (`DEFAULT_API_VERSION`, `/admin/api/2024-07/...`). 🔁 **Day-of: confirm 2024-07 is still within Shopify's supported window on 2026-07-14**; if Shopify has advanced the floor past it, bump toml + code together (they must stay in lockstep) and re-`deploy`.
- ✅ **HTTPS everywhere.** App URL `https://api.pivota.cc/integrations/shopify/app`; all webhook/callback endpoints HTTPS.
- ✅ **Mandatory compliance webhooks present** (see §3).
- 🔁 **Install on a clean store succeeds without errors.** Proven on `pivota-review-demo-3` and re-verified on `pivota-review-demo` (2026-07-15). Day-of, ideally test a **fresh** dev store (no prior Pivota connection) to mirror a first-time reviewer install.

---

## 2. Protected customer data — THE key manual gate

App A's `read_orders` access = **protected customer data (order data)**. This is the single most scrutinized part of review. Our position is strong because attribution needs no PII.

> **🔴 BLOCKER — live PCD declaration contradicts the scope (found 2026-07-15, verified in Partner Dashboard → Distribution → App Store review → preliminary steps).** The listing currently declares **"Doesn't need access to protected customer data."** That contradicts (a) the `read_orders` scope (orders carry customer PII) and (b) this section's own analysis. A human reviewer cross-checking scopes against the PCD declaration is a likely rejection path — and this is the gate we ourselves call the most-scrutinized. **Fix before submitting:** change the declaration to *needs PCD access for order data* and complete the data-protection questionnaire with the truthful facts below (reads only `note_attributes` + totals, strips/doesn't store PII, real GDPR fulfillment). **Do NOT hit "Submit fixes" with this mismatch in place.** Note: Shopify's *automated* check passed, so this will be a *manual*-reviewer catch — exactly where §2 warned the scrutiny lands.

- ⬜ **Request the ORDERS protected-data scope with NO PII field-level access** (no email, name, address, phone). Our code audit (C6) confirmed attribution reads only `note_attributes` + order totals — never customer PII.
- ⬜ **Data protection questionnaire — answer truthfully with these facts:**
  - *What customer data do you access?* Order data (`read_orders`) — only order id, financial status, totals, and `note_attributes` (for the `pivota_click_id` attribution key). No customer PII fields are read or required.
  - *Why?* Conversion attribution: matching a Pivota-referred click to a completed order via `note_attributes.pivota_click_id`.
  - *Do you store customer PII?* No. The webhook ingest **sanitizer strips** `customer`, `email`, `phone`, `billing_address`, `shipping_address`, `customer_locale`, etc. before any persistence (`services/shopify_webhook_ingest.py`, stamped `pii_stripped:true`). Attribution edges store only 4 non-PII order fields.
  - *Data retention / deletion?* Real GDPR fulfillment (see §3).
  - *Data encrypted in transit + at rest?* Confirm hosting/DB encryption statements.
- ✅ **Evidence backing the "no PII" claim** (already shipped, PR #1193): ingest sanitizer + attribution reads note_attributes/totals only. Reference in the questionnaire if asked for specifics.

---

## 3. Mandatory compliance webhooks (GDPR)

- ✅ **All three declared** in `shopify.app.toml` `[[webhooks.subscriptions]] compliance_topics` → `https://api.pivota.cc/webhooks/shopify/gdpr`: `customers/data_request`, `customers/redact`, `shop/redact`.
- ✅ **Handlers actually fulfill obligations** (not log-and-200): `customers/redact` purges/anonymizes order PII columns + scrubs stored webhook payloads; `shop/redact` same by shop; `customers/data_request` produces an export artifact; audit-trailed in `shopify_gdpr_requests` (migration 170). Errors → `needs_review`, still 200.
- ✅ **HMAC-verified** against the app secret(s); unsigned → 401 (smoke-tested in production).
- 🔁 **Day-of: confirm the compliance webhook URL is set** in the Partner dashboard / toml deploy and reachable (it is in `pivota-8`).

---

## 4. Webhooks (functional delivery)

- ✅ **`orders/paid` + `app/uninstalled` delivered via app-owned subscriptions** (App A has no `write_webhooks`, so app-owned toml subscriptions are the delivery mechanism, not per-shop self-registration).
- ✅ **Delivery proven live:** dev-store test order → Shopify webhook monitoring showed `orders/paid` delivered to `/webhooks/shopify/orders` at **0% failure**, ~673 ms. `app/uninstalled`, `orders/create`, `orders/updated`, `shop/redact` also 0% failure.
- ✅ **Endpoint hardened:** unsigned webhook → 401; dual-secret HMAC (`shopify_appstore_client_secret` + `shopify_client_secret`).

---

## 5. App listing & functional review (founder to complete in Partner dashboard)

These are content/UX items reviewers check manually — not verifiable from code:

- ⬜ **App listing content:** name, tagline, description, category, search terms.
- ⬜ **Screenshots / demo:** show the actual merchant-facing value (AI-readiness / attribution measurement).
- ⬜ **App icon** (the Pivota "P" mark already shows on the consent screen).
- ⬜ **Privacy policy URL** — must describe the order-data usage + no-PII-storage posture consistent with §2.
- ✅ **Pricing — DECIDED: declare App A as FREE.** App A charges Shopify merchants nothing; no Shopify Billing API is required. See **§5.1** for the decision, evidence, and the compliance boundary that keeps it true.
- ⬜ **Support contact / email** reachable.
- 🔁 **Demo store / test credentials** for the reviewer — DONE (2026-07-15): fresh clean account `shopify-review-2@pivota.cc` on populated `pivota-review-demo` store. Founder: fill the password into §5.3 + Partner Dashboard.
- 🔁 **"Install" walkthrough note** for the reviewer — DRAFTED (ready-to-paste block in **§5.3**), read-only framing.

### 5.1 Billing model — DECISION: App A is **FREE** (no Shopify Billing API needed)

**Decision (2026-07-07):** In the Partner dashboard pricing section, declare App A **"Free."** Do **not** integrate the Shopify Billing API.

**Why "Free" is the correct and truthful declaration.** Shopify's manual review verifies that *if the app charges merchants, those charges go through Shopify's Billing API rather than an external charge.* App A does not charge merchants at all:

- **The Shopify app is a read-only connector, not a paid product.** Installing App A grants Pivota read-only order/product access (attribution + catalog measurement). Installation and use of the connector cost the merchant nothing. There is no install fee, no in-app subscription, and no usage charge presented within — or gated behind — the Shopify app.
- **No charge is ever initiated through the Shopify app surface.** App A is `embedded = false`; the install callback redirects to a plain `merchant.pivota.cc/app/install/success` page. No upgrade/checkout flow is presented as part of the app.

**Code evidence (verified this session, `pivota-backend` @ `main`):**

- **No Shopify Billing API integration exists anywhere.** Repo-wide grep for `appSubscriptionCreate`, `RecurringApplicationCharge`, `ApplicationCharge`, `appPurchaseOneTime`, `usageCharge` → **zero matches** (`.py`/`.js`/`.toml`).
- **No `[billing]` block in `shopify.app.toml`** — no Shopify managed pricing is declared, consistent with a Free listing.
- **All merchant charging runs through Stripe, on Pivota's own account relationship** — `checkout.sessions.create` + `customer.subscription.*` (`routes/billing_routes.py`), PaymentIntent credit top-ups (`services/merchant_credit_balance_service.py`, `services/metering_service.py`). This is Pivota's standalone SaaS billing on `merchant.pivota.cc`, not a charge made "as" or "through" the Shopify app.

**The compliance boundary — what makes this declaration stay true (guardrail):**

Pivota *does* sell a paid product — the AI-readiness audit (subscription tiers + audit credits) — but it is a **separate SaaS**, sold and billed by Pivota directly via Stripe under a merchant-to-Pivota relationship that exists independently of the Shopify install (merchants can and do sign up at `merchant.pivota.cc` without Shopify). The Shopify app is a free connector that *feeds* that product with read-only data; it is not the thing being charged for. This is the standard "external SaaS + free Shopify connector" pattern.

That distinction holds **only as long as no paid Pivota feature is charged for through the Shopify app itself.** Concretely, to keep the "Free" declaration honest and review-safe:

- **Do NOT** build an embedded/in-app "upgrade to paid" or checkout flow inside the Shopify app that bills the merchant via Stripe for App-A functionality. If Pivota ever wants to charge a Shopify-installed merchant *for the app* through the app, it **must** adopt the Shopify Billing API — declaring "Free" while charging through the app surface is exactly the mismatch review rejects.
- Keep the app's role as a read-only connector; keep all paid-product billing on the separate `merchant.pivota.cc` SaaS surface.
- **T7 TRIPWIRE — do NOT resume the paused `invoice_generation_monthly` cron while it includes Shopify-redirect GMV.** The commission-on-redirect loop is fully built and **one admin call from live** (no code change): T2 conversion closure already stamps attributed GMV onto App-A-observed Shopify orders (`close_external_order_conversion`, fed by the `orders/paid` webhook **and** the `read_orders` polling floor), and the **ACTIVE** daily T6 rollup already computes `take_amount_cents` (5% promo / 10% standard) on that GMV. The only thing keeping the "Free" declaration true is that the T7 collection cron is registered **PAUSED** (`next_run_time=None`, `services/audit_scheduler.py`). `POST /admin/scheduler/jobs/invoice_generation_monthly/resume` would start externally Stripe-invoicing Shopify merchants a commission on sales completed in **their own Shopify checkout**, measured via this app's `read_orders` — the exact external-charge pattern review rejects, and a retroactive violation of an approved "Free" listing. Before any resume that would sweep Shopify-channel merchants: (a) run the take through **Shopify Billing API usage charges**, or (b) obtain Shopify's **billing-exemption** approval (referral / sales-channel model), or (c) scope the T7 billing run to **exclude Shopify-redirect-attributed GMV**. Protocol-checkout GMV (ACP/UCP/MCP, Pivota-processed payment on Pivota's own surface) is NOT subject to this constraint — only sales transacted through the merchant's Shopify checkout are.

**Questionnaire / listing answer (use verbatim):** *"Pivota (App A) is free. The app is a read-only connector that grants Pivota read access to order and product data for AI-readiness and conversion-attribution measurement; installing and using it costs the merchant nothing and the app initiates no charge. Pivota's separate AI-readiness SaaS is billed directly by Pivota outside of Shopify and is not a charge made through this app; therefore the Shopify Billing API is not used."*

### 5.2 Rev-share rails — Shopify redirect vs. ACP/UCP protocol checkout (context for §5.1)

Pivota has **one** take-rate pipeline (`commerce_attribution_edges` → T6 daily rollup `gmv_attribution_daily.take_amount_cents` at 5% promo / 10% standard → T7 monthly Stripe invoice) fed by **two transaction rails** with very different Shopify-review exposure. Verified against `pivota-backend` `origin/main`, 2026-07-07:

**Rail 1 — Shopify storefront redirect (App A's world).** Agent/index → cart permalink stamped with `pivota_click_id` → buyer pays in the **merchant's own Shopify checkout** → App A's `orders/paid` webhook + `read_orders` polling floor close the conversion (`close_external_order_conversion`) and stamp attributed GMV. Merchant keeps 100% at point of sale; Pivota's take is computed by the live T6 rollup and would be collected by the paused T7 cron as an external Stripe invoice. **This is the rail the §5.1 T7 tripwire guards** — commissioning these sales without Shopify Billing API / exemption breaks the Free listing.

**Rail 2 — ACP/UCP/MCP protocol checkout (no Shopify exposure).** Agent checks out on **Pivota's own surface**: ACP delegated token / UCP handler / AP2 mandate (or grant-free hosted payment link); Pivota's kernel executes order + payment (`canonicalExecutor` → `submitPayment`), the merchant's connected Stripe account receives a **direct charge for the full amount** (merchant stays `merchant_of_record` — no `application_fee`/`transfer_data` split exists anywhere), edges are stamped by `psp_payment_finalizer`, and the same T6→T7 pipeline invoices the take out-of-band. The protocol itself carries no fee fields; the take is a business-layer arrangement. **Because the sale is not transacted through the merchant's Shopify checkout, Shopify's Billing API mandate does not apply — this rail is Free-listing-safe.**

| | Rail 1: Shopify redirect | Rail 2: ACP/UCP protocol checkout |
|---|---|---|
| Take machinery | built; T6 rollup ACTIVE | built; same pipeline |
| Distance to revenue | 1 switch (resume T7) + merchant billing enrollment | 3 switches (`SUBMIT_PAYMENT`/strict flip + ACP/UCP doors + resume T7) + enrollment |
| Shopify listing risk | **HIGH — Billing API / exemption / channel-exclusion required first** | **None** |
| Per-channel fee accounting | n/a | schema built (`gmv_channel`, `third_party_platform_fee_pct`) but `record_classification` has **zero callers** — wire at protocol adapters if take should differ by channel / net out platform fees |

**Implication for this submission:** monetization pressure before/after approval should route to **Rail 2** (plus the SaaS subscription); Rail 1 stays measurement-only until the Billing-API/exemption question is settled. Both rails also share the enrollment gap (`merchants.stripe_customer_id` required, else `MerchantNotEnrolledError`) and a contractual rev-share acceptance — an App A install alone creates neither.

**Buyer PSP is irrelevant (both directions).** Whether the buyer pays with Shop Pay, Shopify Payments, Stripe, Adyen, PayPal, or a local gateway: (a) *measurement* is unaffected — attribution reads the Shopify **order object** (`note_attributes` + totals), which lands identically regardless of gateway; (b) *compliance* is unaffected — Shopify's Billing rule governs **app→merchant** charges, not buyer→merchant payments. "The merchant uses Adyen" is not a loophole; what triggers the rule is charging the merchant a fee, measured by this app's data, on a sale transacted through their Shopify checkout.

**How Rail 1 CAN be monetized compliantly (post-approval roadmap):**

1. **Route A — "Free to install" + usage-based Billing API charges (the intended path).** Shopify distinguishes plain **"Free"** (no charges ever — what we declare 07-14) from **"Free to install"** (install $0, "additional charges may apply"). Post-approval, convert the listing and bill commission through Shopify: merchant approves `appSubscriptionCreate` with a **usage line item + capped amount** (e.g., 10% of Pivota-attributed order value, capped $X/mo; cap raises need merchant re-approval), then each attributed conversion posts `appUsageRecordCreate` for its `take_amount_cents`. T7's per-order math maps 1:1 onto usage records — upstream (T2 closure, T6 rollup) unchanged; only the collection leg swaps Stripe-invoice → usage records for Shopify-channel merchants. Economics: Shopify takes 0% of the first $1M/yr app revenue (register for the rev-share plan), 15% above. **Do NOT add billing before 07-14** — it changes the listing category and adds review surface; ship it as a post-approval pricing update.
2. **Route B — billing-exemption request (parallel long-shot).** Shopify grants case-by-case exemptions (partner support) for marketplace/referral-network models. If granted, the existing T7 Stripe-invoice rail becomes compliant as-is (zero engineering). Discretionary and slow — apply, don't plan on it.
3. **Collectable today with plain-Free App A:** Rail 2 protocol checkout; the SaaS subscription; and **non-Shopify storefronts in the redirect loop** (external Stripe commission invoicing is unconstrained there — the T7 tripwire is Shopify-channel-specific, not redirect-specific).

**Not a route:** keeping the plain-Free listing while Stripe-invoicing commissions on Shopify-checkout sales. Review wouldn't see the invoice on day one, but it violates the Partner Agreement and surfaces the first time a merchant disputes a charge — delisting risk against a just-approved app.

### 5.3 Reviewer test instructions (READY TO PASTE — updated 2026-07-15)

**Reviewer account + demo store (set up and verified this session):**
- Account: `shopify-review-2@pivota.cc` — a **fresh** account created via App Store install → claim (clean data, no stale artifacts). Password: set by founder; **fill it into the block below and the Partner Dashboard, keep it only in a password manager.**
- Connected store: `pivota-review-demo.myshopify.com` (17 synced products — the standard Shopify sample catalog). Dashboard is fully populated (catalog, catalog health "Ready", channel readiness, AI-readiness metrics).
- Billing shows the clean **free/exempt** state (no Stripe references) — verified live.

**Do NOT** put a `pivota-review-demo.myshopify.com/products/...` URL in the instructions: dev-store storefronts aren't publicly fetchable (429), so the AI-visibility URL check returns "no products resolved." Keep the reviewer on the pre-connected, populated views (section A below).

**Paste block for Partner Dashboard → App submission → Testing instructions:**

```
WHAT THIS APP DOES
Pivota's App Store app connects with READ-ONLY access — read_products,
read_orders, read_fulfillments, read_discounts (verifiable on the OAuth consent
screen). It reads your catalog to score how discoverable your products are to AI
shopping agents and to surface analytics. With these scopes it cannot create or
modify products, orders, or checkout.

PRE-CONNECTED TEST ACCOUNT (already populated — start here)
  Portal:   https://merchant.pivota.cc/login
  Email:    shopify-review-2@pivota.cc
  Password: <FILL IN THE PASSWORD YOU SET>
Already connected to a development store (pivota-review-demo.myshopify.com) with
a synced catalog, so the app is fully populated and ready to review.

A) SEE THE APP WORKING (pre-connected account)
   1. Sign in with the account above.
   2. Overview: one connected sales channel, synced catalog (17 products),
      catalog health, and channel-readiness signals.
   3. Catalog: browse the synced products and their AI-readiness/content signals.
   4. AI Visibility / Readiness audit: the app's core scoring features
      (deeper coverage is credit-based, as noted in the listing).

B) INSTALL / OAUTH FLOW (read-only connection)
   1. From the listing, install Pivota on one of your development stores.
   2. On Shopify's consent screen, note the requested scopes are READ-ONLY
      (view products, orders, fulfillments, discounts) — no write scopes.
   3. Approve. You are redirected to a "Pivota is connected" confirmation page,
      then to a short account-setup step (create an email + password, or reuse
      an existing Pivota login). No raw data or error pages appear at any step.

C) BILLING (free on the App Store)
   1. Open "Plan & billing".
   2. It shows "Pivota is free on the Shopify App Store — Included, no
      subscription to manage." App Store merchants are never billed
      off-platform; there are no Stripe/off-platform payment options.

NOTES
   • Read-only: this connection uses read-only scopes and cannot modify your
     products or orders.
   • Cross-platform: the AI-readiness engine is platform-agnostic (Shopify, Wix,
     WooCommerce, BigCommerce, PrestaShop); the Shopify integration is read-only
     catalog onboarding. Pivota complements Shopify — it is not a competing
     checkout or sales channel.
   • Support: support@pivota.cc
```

**Honesty note (deliberate):** the block describes only App A's read-only behaviour and makes no "never processes checkout" platform-wide claim — Pivota does support agent checkout via the **separate, merchant-created custom-app (`write_orders`) path**, which is NOT this App Store app. The install-success page copy was corrected to match (portal #166, deployed 2026-07-15). Whether the public listing should mention agent checkout at all — **DECISION (2026-07-15): keep App A positioned as read-only; do NOT feature agent checkout in the App A listing.** It runs via a separate merchant-created custom app (not this App Store app), and featuring it invites the "competing sales channel / parallel checkout" flag Shopify already raised — a real risk for a just-suspended app. Omitting a separate, merchant-controlled integration is not dishonest; a false "never checkout" claim would be (already removed, #166). **Consistency caveat:** hold this line across ALL surfaces (marketing included) — App A = read-only measurement; checkout = separate, merchant-controlled. Answer truthfully if a reviewer asks directly.

---

## 6. Day-of pre-submission verification (run in order on 2026-07-14)

- 🔁 Confirm the active config version is `pivota-8` (or later) in the dev dashboard → Versions, and `shopify.app.toml` on `main` matches (managed install, read-only scopes, 2024-07, app-owned + compliance webhooks).
- 🔁 Confirm all related PRs merged to `main`: #1193 (code fixes), #1195 (managed install), #1209 (api_version). ✅ all merged as of 2026-07-07.
- 🔁 Fresh-store install smoke test: install App A on a **clean** dev store (not one with a prior Pivota connection), confirm it lands on the success UI and `token/diagnostic` returns `auth_ok:true` with the 4 read scopes.
  - Command (employee JWT): `GET api.pivota.cc/integrations/shopify/token/diagnostic?merchant_id=<merch>`
- 🔁 Confirm `api.pivota.cc` is healthy (it has intermittent TLS resets — retry; Host-override via `180cw20c.up.railway.app` if needed). A reviewer hitting a TLS reset mid-install could fail the automated check — **verify stability before submitting.**
- 🔁 Re-confirm compliance webhook endpoint returns 401 on unsigned + processes a signed test.
- ⬜ Submit for review from the Partner dashboard.

---

## 7. Known risks / watch items

- **`api.pivota.cc` TLS resets** — the biggest submission risk. An automated reviewer install that hits a reset reads as an install failure. Stabilize / confirm before submitting. (Known workaround: Host-override via the Railway domain.)
- **Deprecated offline tokens advisory** (dev dashboard: "Fix by Jan 1"). Managed install should use **token exchange**, not the offline-token grant. Non-blocking for this review (deadline 2027-01-01) but is the natural post-approval follow-up. Don't let it surface as a warning that spooks a reviewer — verify the monitoring banner wording.
- **App under review = installs gated on production stores.** Expected; dev-store installs remain the test path (that's how everything above was verified). Once approved, production installs unlock and the App-A conversion loop goes live for real merchants.

---

## 8. What NOT to do (guardrails)

- **Do not add `write_orders` / `write_webhooks` to App A.** It would fail/complicate review and is unnecessary — attribution is 100% read-only (verified §2). Write access lives only in custom App B, which is never submitted publicly.
- **Do not switch webhook delivery to per-shop self-registration for App A** — it can't (no `write_webhooks`) and doesn't need to; app-owned subscriptions are the mechanism and are proven.
- **Do not `shopify app deploy --allow-deletes`** — updates only; deletes could drop dashboard config the toml doesn't declare.
- **Do not charge Shopify merchants through App A while declaring it "Free."** App A is a free read-only connector; all paid Pivota billing stays on the separate `merchant.pivota.cc` SaaS via Stripe (see §5.1). Never add an in-app upgrade/checkout flow that bills for App-A functionality — that would require the Shopify Billing API and contradict the "Free" listing.
- **Do not resume the paused T7 `invoice_generation_monthly` cron while its billing run includes Shopify-redirect-attributed GMV** (see §5.1 T7 tripwire). It is one admin call from externally invoicing Shopify merchants commissions on their own checkout sales — a Free-listing violation. Billing-API usage charges, an approved exemption, or a Shopify-channel exclusion must land first.

---

## 9. Final submission handoff — remaining founder actions (2026-07-15)

All engineering is done, deployed, and prod-verified (see the 2026-07-15 appendix addendum). Four items remain, and **all four are Partner Dashboard actions only the founder can do** — the dashboard's bot-detection blocks automated help on these pages. **Items 1 (PCD) and 2 (category) are hard blockers;** Items 3–4 are a verify and a paste. Do them in order, then submit.

### Item 1 — 🔴 PCD declaration (BLOCKER — see §2)
Gather 3 facts first (only you have them): (a) retention period for the non-PII attribution records, (b) is the DB/host encrypted **at rest** (e.g. Railway Postgres), (c) any sub-processors touching order data — or "none".
Then: Partner Dashboard → **Pivota** → **Distribution → Shopify App Store** → change **"Doesn't need access to protected customer data"** → **needs access (order data)** → complete the questionnaire:

```
Which protected customer data? Order data (read_orders). In practice reads only
order id, financial status, order totals, and note_attributes (pivota_click_id).
No customer PII fields (name/email/phone/address) are read or required.
Why? Conversion attribution via note_attributes.pivota_click_id. No PII needed.
Store customer PII? No — ingest sanitizer strips customer/email/phone/billing_
address/shipping_address/customer_locale before persistence
(services/shopify_webhook_ingest.py, pii_stripped:true); only 4 non-PII order
fields are stored.
Retention/deletion? GDPR webhooks implemented (customers/redact, shop/redact,
customers/data_request; shopify_gdpr_requests audit row).  [+ retention = FACT a]
Encryption? In transit: HTTPS all endpoints.  [At rest = FACT b]
Sub-processors? [FACT c]
```

### Item 2 — 🔴 App category + "sales channel" capability (BLOCKER — found 2026-07-15)
The listing's category is currently **"Sales channels › Marketplaces"** and the app declares the **"sales channel" capability**. Both contradict the read-only measurement positioning (§5.3 honesty note) and invite exactly the competing-channel scrutiny tied to the suspension — a reviewer who sees "Marketplaces sales channel" next to read-only scopes and a "not a competing checkout" testing note has a self-contradicting listing in front of them.
Fix: Partner Dashboard → **Edit listing** → change category to **Analytics** (or Marketing — Analytics matches the AI-readiness scoring product best) → and remove/uncheck the **sales channel capability**.
⚠️ **The category cannot be edited after submitting** — this must happen before "Submit fixes", not as a follow-up.

### Item 3 — ⬜ Privacy policy (verify the URL only — content is confirmed good)
Content verified live 2026-07-15 at `https://merchant.pivota.cc/privacy`: read-only scopes enumerated, order data "used only in aggregate… do not use this data to contact customers", explicitly "does not request or use protected customer fields (customer name, email, phone, or address)", all 3 GDPR webhooks described with the 48h shop/redact window, retention/deletion, sub-processors ("cloud hosting… under contractual obligations"), encryption in transit. This is consistent with the §2 PCD questionnaire answers. Remaining founder check: Distribution → App Store → **Edit listing** → confirm the **Privacy policy field points at that URL**.

### Item 4 — 🔴 Reviewer password (paste)
Paste the password for `shopify-review-2@pivota.cc` into the **Testing instructions** field (the ready block in **§5.3**, replacing `<FILL IN…>`). Keep it only here + a password manager — never in chat/marketing.

### Then — eyeball these on the submission form before hitting Submit
- Paste the §5.3 block into **App submission → Testing instructions**; reviewer **Username** field = `shopify-review-2@pivota.cc`, **Password** field filled.
- **"I have approval to charge merchants outside the Shopify Billing API" checkbox = UNCHECKED** — App A is a plain Free listing (§5.1); checking it contradicts the free declaration.
- The listing shows **"1 private plan"** — identify what it is; if it's a leftover Stripe/paid-plan artifact, remove it (a paid plan on a Free listing is another self-contradiction).
- **Search terms: drop "product sync"** — it implies write behaviour the read-only app doesn't have.
- Day-of (§6/§7): confirm `pivota-8` is Active; **confirm `api.pivota.cc` is stable** (intermittent TLS resets are the single biggest submission risk — a reset mid-install reads as an install failure); optional fresh-store smoke test; ignore the offline-tokens "Fix by Jan 1" advisory (non-blocking, 2027-01-01).
- **▶️ Submit fixes.**

---

## Appendix — verification evidence (this session, 2026-07-07)

- **Managed-install OAuth E2E:** dev store `pivota-review-demo-3` via `/integrations/shopify/app` → grant → callback `status=success` → `token/diagnostic auth_ok:true`, scopes = read_products/read_orders/read_discounts/read_fulfillments (no write).
- **Webhook delivery:** test order #1001 → `orders/paid` delivered to `/webhooks/shopify/orders`, 0% failure (Shopify Partner webhook monitoring).
- **Attribution = read-only (code trace):** `outbound_links_service.py` 0 Shopify calls (local permalink build); `commerce_attribution_service.py` closure writes to Pivota DB only; `external_conversion_poller.py:160` `GET orders.json` (read); 0 write calls in the path.
- **Scopes / config:** `shopify.app.toml` @ `main` — read-only, managed install, 2024-07, app-owned + compliance webhooks.
- Full audit + fix history: `docs/shopify_app_config_audit_2026-07-07.md`; fixes in `pivota-backend` PRs #1193 / #1195 / #1209.

### Re-verification addendum (2026-07-15)

Re-walked the full reviewer journey on the current reviewer store `pivota-review-demo` (App A install → OAuth consent → callback → success → claim → populated dashboard). Verified live in prod:
- OAuth callback success **and** every failure path 302-redirect to a clean page (no raw JSON) — the actual repeat-2.1.1 offender was the callback's JSON error paths; fixed backend #1402 + portal #161.
- Install-links flow removed (404 in prod); OAuth-first connect; beta OAuth allowlist removed.
- Billing shows clean free/exempt (no Stripe) — required two fixes: the `api_key_raw` parse bug (#1406) and the pending_verification gate for App Store shell merchants (#1408).
- GDPR compliance webhooks return 401 on bad/missing HMAC in prod (Shopify's automated test).
- Read-only payment-nag suppressed (#163); install-success copy scoped to read-only, no "never checkout" overclaim (#166).
- Fresh reviewer account `shopify-review-2@pivota.cc` (§5.3), 17-product catalog, `token/diagnostic auth_ok:true`, 4 read scopes, no write.

**Partner Dashboard pre-submission checks (2026-07-15):**
- ✅ **`shopify.app.toml` deployment** — active + released version **pivota-8** verified field-by-field: read-only scopes (no write), managed install, api 2024-07, callback URL, and all 3 GDPR compliance webhook URLs → `/webhooks/shopify/gdpr`. Session changes needed no new version.
- 🔴 **PCD declaration = BLOCKER** — listing declares "Doesn't need access to protected customer data" while holding `read_orders`. Contradicts the scope + §2. **Must fix before submit** (see §2 blocker). Founder-only Partner Dashboard change.
- 🔴 **App category = BLOCKER** — listing category is "Sales channels › Marketplaces" + the app declares the "sales channel" capability, contradicting the read-only positioning and re-inviting the competing-channel scrutiny behind the suspension. Change to **Analytics**, drop the capability (see §9 Item 2). ⚠️ Category is not editable after submit.
- ⬜ **Privacy policy URL** — policy **content verified good** at `https://merchant.pivota.cc/privacy` (order-data-in-aggregate, no protected customer fields, GDPR webhooks, retention, sub-processors — see §9 Item 3). Remaining: founder confirms the listing's Privacy-policy field points at that URL.
- ✅ **Agent-checkout disclosure** — DECIDED: keep App A read-only, don't feature checkout (see §5.3 honesty note).
- ℹ️ **Deprecated offline-tokens advisory** ("Fix by Jan 1") still shows on the app Overview — non-blocking (deadline 2027-01-01), matches §7. Don't let its wording spook a reviewer.

**Final prod re-probe (2026-07-15, pre-submit review session):**
- Callback failure paths: bare callback → 302 `…/app/install/error?reason=missing_shop`; forged hmac/state → 302 `…?reason=state_not_found`. No raw JSON on any callback error path.
- App entry `?shop=pivota-review-demo.myshopify.com` → 302 to Shopify authorize with exactly `read_discounts,read_fulfillments,read_orders,read_products`, correct client_id + callback URL.
- GDPR webhook POST with bad HMAC → **401** `UNAUTHORIZED`; missing HMAC → **401**.
- Portal `/app/install/error` and `/app/install/success` both 200.
- `api.pivota.cc` stability: **50/50 TLS handshakes succeeded, zero resets** (handshake 0.7–2.5s). Still re-check day-of.
- ℹ️ Residual (non-blocking): `/integrations/shopify/app` **without** a `shop` param (or with a malformed one) returns a raw JSON 400. Shopify always appends `shop` when launching the App URL, so no reviewer path hits this — but redirecting it to `/app/install/error` like the callback would close the last raw-JSON surface.

**Verdict:** two blockers before submit — the PCD declaration (§9 Item 1) and the app category / sales-channel capability (§9 Item 2). Everything else is confirmed, decided, or a quick founder verify.
