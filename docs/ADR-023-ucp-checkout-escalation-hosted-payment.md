# ADR-023: UCP checkout on the seller door completes by ESCALATION to a hosted payment session — Pivota never holds the payment credential

**Status:** Proposed — for the Minds / Antom meeting. Every item under *Decisions we cannot make alone* is a question for that meeting, not a placeholder.
**Date:** 2026-08-17
**Deciders:** Peng (product/eng); Minds (buyer agent, frontend); Antom (acquirer / hosted payment); pivota-backend owner (hosted-checkout provider + PSP webhook live there).
**Builds on:** the UCP seller door as shipped (`/.well-known/ucp` → `/ucp/mcp`, kill-switch keyed on the canonical operation), `safety-kernel/src/protocol/canonicalContract.js` (`create_payment_link` = `create_order + create_hosted_checkout`, non-charging), `docs/adr_mcp_oauth_authorization_server.md` (Minds authenticates to the door via `api.pivota.cc`). Numbered in the shared `pivota-backend/docs/adr/` sequence (next free after ADR-022); lives here because the door code does.

---

## Context — measured on 2026-08-17, not recalled

**Roles.** Pivota is the commerce index + decision layer. **Minds** is the frontend shopping agent = the UCP *buyer*. **Antom** is the payment acquirer for the merchants (AliExpress cohort; catalog synced, PSP-ready). The user pays Antom **inside Minds' UI**. So Pivota is the UCP **seller door** Minds talks to, and Antom is the PSP behind it. Pivota is not the merchant of record and must not be the payer.

**What the seller door is today (live):**

| surface | state |
|---|---|
| `/.well-known/ucp` (both hosts) | 200, version `2026-04-08`, service `mcp → https://commerce.mcp.pivota.cc/ucp/mcp`, capabilities `catalog.lookup / checkout / identity_linking / fulfillment`, **`payment_handlers: []`**, 1 signing key |
| RFC 9728 doc for `/ucp/mcp` | resource `https://commerce.mcp.pivota.cc/ucp/mcp`, AS `https://api.pivota.cc` |
| AS `api.pivota.cc` | dynamic registration endpoint present; grants `authorization_code` + `refresh_token` (no `client_credentials`); auth methods `none / client_secret_basic / client_secret_post`; scopes `pivota.checkout`, `pivota.account`; resource indicators supported |
| door flags (prod) | `AGENT_CHECKOUT_STRICT=1`, **`STRICT_SUBMIT_PAYMENT_ENABLED=1` (charges ON)**, `UCP_TOOL_DOOR_ENABLED=1`, `HOSTED_LINK_ENABLED=1`, `ALLOW_TEST_PSP=0`, `ALLOW_TEST_IDENTITY=0`, `AP2_MANDATE=0` |
| UCP tools on `/ucp/mcp` | `get_product`, `create_checkout` (= `preview_quote`), `update_checkout`, `get_checkout`, `complete_checkout` (= `create_order + mint_confirmation + submit_payment`, requires payment authorization) |
| hosted payment path | `create_payment_link` (= `create_order + create_hosted_checkout`; **non-charging**, the PSP webhook finalizes) exists — but is a **native `/mcp` tool only**, not on the UCP dialect; its page is **Stripe**, minted by pivota-backend **order-first** (`create_checkout_session_v2` requires an order in `awaiting_checkout`) |
| `create_checkout` response on the UCP door | Pivota's **canonical** session `{ session_id, status: 'ready_for_payment', currency, merchant_of_record, totals, line_items, expires_at }` — there is **no outbound UCP resource shaper**; `mcp-server/src/ucpArgumentAdapter.js` maps *arguments* only. `continue_url` / `requires_escalation` do not exist on the seller side |
| buyer lane (`ucpBuyerAgentClient`, warm handoff) | **not on this path** — that is Pivota shopping *other* merchants; hardened and latent (0 invocations in 14 days) |

**The two ways to complete a UCP checkout, and what each costs Pivota:**

- **Model A — in-band `complete_checkout`.** Minds sends a payment credential (e.g. a Visa VIC agent token) in `checkout.payment`; Pivota advertises an Antom payment handler in `payment_handlers` and charges server-to-server. One-tap in chat. Pivota becomes party to the charge: handler advertisement, the `checkout.payment` envelope shape for VIC (a signed payment-authorization contract exists today, built for a different handler), Antom's server API, compliance surface, and the credential transits Pivota.
- **Model B — escalation to a hosted payment session.** The checkout escalates to a `continue_url` that is an **Antom payment session**; Minds renders it; the user pays Antom directly (a VIC credential lives in Antom's sheet / Minds' wallet, never with Pivota); Antom notifies Pivota by webhook; Pivota completes the order. This *is* how the buyer client already reads Shopify's live UCP: `status: 'requires_escalation'` + `continue_url` = "the storefront still needs payment entered".

## Decision (proposed)

**Model B for launch. Model A only if the meeting establishes Minds needs one-tap in chat, and then as its own ADR.**

Concretely, on the UCP seller door:

1. **`create_checkout` and `get_checkout` return a UCP checkout resource, not the canonical session.** A new outbound shaper (`toUcpCheckout(session)`) — the mirror of the existing argument adapter — emits `{ id, status, currency, line_items, totals, continue_url?, messages? }` in UCP vocabulary. `id` = `session_id`. This is a conformance change independent of payment and is the first thing to build; **the exact status vocabulary and field set are a meeting item** (see below), and the shaper is where a decision lands as one function with one test file.
2. **`continue_url` is a stable Pivota-hosted URL keyed on the checkout id** — `https://<checkout-host>/c/{session_id}` — **not** the PSP page itself. Opening it is what mints the order + the Antom (today: Stripe) hosted session, then redirects. Why lazy: the backend mints hosted checkouts **order-first**, and minting at `create_checkout` time would create a pending order for every quote Minds shows a user, most of which are abandoned. Lazy minting keeps "one order per buyer who actually proceeded", makes `continue_url` idempotent and cacheable, and — the point for the meeting — **makes the PSP swappable behind a URL Pivota controls**: Stripe today, Antom when the provider lands, with no change to what Minds sees.
3. **`status` on that resource is `requires_escalation` while payment is due, `completed` after the PSP webhook finalizes**, and `get_checkout` is how Minds polls. Whether Minds instead wants a callback is a meeting item.
4. **`payment_handlers` stays `[]`** unless Antom publishes a UCP payment handler. We advertise nothing we won't honor. `complete_checkout` **stays dark to Minds** (the kill-switch already keys on the canonical op) until Model A is built deliberately.
5. **On the backend: an Antom hosted-checkout provider + Antom result webhook** where Stripe sits today. The webhook receiver copies `ucpOrderWebhookReceiver`'s discipline: verify the signature over the *exact* raw body bytes, dedup, fail closed to "not finalized", refuse a redirected profile / userinfo in configured URLs, log the fetch cause. Antom's API shape decides the rest and is unknown to us today.
6. **Minds is OAuth client #1** on `api.pivota.cc` via dynamic registration, `authorization_code` (correct for a per-user agent), token minted for `resource=https://commerce.mcp.pivota.cc/ucp/mcp`. **Test-mint one before launch** — the door and the AS live in different repos/Railway projects and an audience mismatch fails every conforming call with `invalid_target`.

## Decisions we cannot make alone — the meeting agenda

| # | question | why it gates the build |
|---|---|---|
| Q1 | **Antom's API shape:** a hosted payment session / cashier URL we redirect to (→ Model B, this ADR), or a credential-accepting charge API (→ Model A)? | decides item 5 entirely; decides whether Pivota touches a credential |
| Q2 | **Does Minds need one-tap in chat at launch,** or is a rendered payment sheet inside Minds acceptable? | Model A vs B; B is weeks less and keeps Pivota out of PCI scope |
| Q3 | **What checkout resource shape does Minds' UCP client parse?** UCP `2026-04-08` vocabulary as Shopify emits it (`requires_escalation` / `continue_url` / `line_items` / `totals`), or does Minds tolerate Pivota's canonical session? | item 1 — the shaper's contract; today we return a shape no conforming buyer expects |
| Q4 | **Poll or push:** does Minds poll `get_checkout` for `completed`, or need a callback when the Antom webhook lands? | item 3 |
| Q5 | **Where does the VIC credential get presented** — to Antom's sheet, or by Minds' wallet into `checkout.payment`? | Model B keeps it out of Pivota either way; Model A requires the envelope |
| Q6 | **Which host serves `continue_url`** (`checkout.pivota.cc`? agent-ui? backend?) — a small web surface, new | item 2 |

## Consequences

- **Pivota never holds a payment credential** under Model B. That matches every posture already in the repo: `delegatedPaymentRefusal` (raw PAN refused, permanently), the per-operation kill-switches, "withhold, don't half-publish".
- The **six buyer-lane hardening PRs** (#1989 #1994 #1997 #1999 #2000 #2002) are correct and stay merged; none is on this path. Do not spend launch time there.
- The **first code PR** after the meeting is item 1 (the outbound UCP shaper) — PSP-agnostic, testable against a recorded Shopify checkout resource, and the mutant to kill is "shaper returns the canonical session unchanged".
- The **second** is item 2 + 5 together (lazy `continue_url` + Antom provider + webhook), split across gateway and backend, backend first (memory: paired PRs, backend-first).
- **Rollback** is a flag: the shaper and the `continue_url` ship behind `UCP_CHECKOUT_ESCALATION_ENABLED` (default OFF) so the door's live shape does not change until Minds is ready to consume the new one.

## Rejected

- **Model A first.** Puts a credential through Pivota and needs Antom's charge API, the VIC envelope, and a handler advertisement before a single order can flow. Right as a later addition; wrong as the launch dependency.
- **Mint the hosted session at `create_checkout` time.** Order-first backend ⇒ a pending order per abandoned quote; also welds Minds' `continue_url` to a specific PSP's page URL.
- **Advertise a payment handler now "for later".** A profile advertising a handler the door refuses is exactly the half-published shape the seller-profile work removed.
