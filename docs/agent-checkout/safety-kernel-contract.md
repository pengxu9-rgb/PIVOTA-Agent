# Pivota Commerce Safety Kernel — Contract (v1)

This document specifies the enforced invariants that sit between the platform adapters
(Claude MCP, ChatGPT Apps SDK, Gemini function-calling) and the existing Celestial
commerce core. These are **invariants enforced server-side**, not prompt conventions.
The companion machine contract is `docs/agent-checkout/tool-schema.v2.json`.

The driving principle: an AI model may *propose* commerce actions, but it can never
*commit money* on its own. Every charge must be backed by (a) a server-locked quote,
(b) an explicit user confirmation, and (c) an idempotency key.

---

## 1. Where the kernel sits

```
adapters (Claude/ChatGPT/Gemini)
   |  canonical: POST /agent/shop/v1/invoke  { operation, payload }  + Idempotency-Key
   v
Commerce Safety Kernel   <-- THIS CONTRACT
   |  validated, amount-from-quote, confirmed, idempotent
   v
existing Celestial core (ingress -> ... -> infra)  [unchanged]
```

The kernel owns four pieces of state the gateway previously did not:
1. **Quote registry** — issued quotes with locked totals and expiry.
2. **Confirmation tokens** — single-use proofs that a user acted on a quote card.
3. **Idempotency ledger** — request key -> first result, for replay-safe writes.
4. **Audit log (v3)** — append-only record of every money-path transition.

ACP/AP2 remain opaque to the kernel's *content*, but their *linkage* is validated
(see §6).

---

## 2. Identity & authority

- **Adapter auth** (`Authorization: Bearer ak_...`) proves the *channel* is trusted.
- **User authority** (`user_ref`) proves a *consenting human* is behind the spend.
  `user_ref` is derived from the platform OAuth subject by the adapter and attached
  to every envelope. Writes (`create_order`, `submit_payment`, after-sales) **must**
  carry a `user_ref`; the kernel rejects money-path calls authenticated only by the
  shared agent key.

This closes the current gap where a single `ak_live_...` key carried all spending
authority with no per-user attribution.

---

## 3. The five enforced invariants (money path)

### INV-1 Quote-first
`create_order` is refused unless `order.quote_id` references a quote that is
(a) present in the registry, (b) not expired, (c) bound to the same `user_ref` and
ACP session. Error: `QUOTE_REQUIRED` / `QUOTE_NOT_FOUND` / `QUOTE_EXPIRED`.

### INV-2 Amount-from-quote (model never sets price)
The charged amount and currency are read from the quote snapshot, server-side.
`payment.expected_amount` is treated as a client assertion: if it differs from the
snapshot (beyond zero tolerance), the call hard-fails with `PRICE_CHANGED`. The model
cannot move the price.

### INV-3 Explicit confirmation
`submit_payment` requires a `confirmation_token` minted by the kernel only after the
user acts on the quote/confirmation card in the channel UI (MCP-UI resource, Apps SDK
component, or Gemini-surface card). Tokens are single-use, bound to `(order_id,
user_ref, amount)`, and short-lived. Missing/invalid/reused => `CONFIRMATION_REQUIRED`
/ `CONFIRMATION_INVALID`. The model cannot generate a valid token.

### INV-4 Idempotency
`create_order`, `submit_payment`, and `request_after_sales` require `idempotency_key`.
The kernel stores `key -> first result`; a replayed key returns the original result and
never produces a duplicate order or a second charge. Error on body-mismatch reuse:
`IDEMPOTENCY_CONFLICT`.

### INV-5 Price/tax/shipping & merchant-of-record lock
The quote snapshots line items, tax, shipping, currency, and merchant-of-record (MoR).
Order and payment use the snapshot; underlying catalog/price drift after quote issuance
cannot change what the user is charged. MoR is recorded on the quote and propagated to
order, receipt, and refund routing — never re-inferred per channel.

---

## 4. Canonical safe sequence

```
pivota_search        (optional) discover / inspect
pivota_quote         -> { quote_id, expires_at, locked_totals, merchant_of_record }
   [adapter renders quote card; user confirms in UI]
   [kernel mints confirmation_token bound to (order-to-be, user_ref, amount)]
pivota_create_order  { order.quote_id, idempotency_key }      -> { order_id, amount_total }
pivota_pay           { order_id, confirmation_token, idempotency_key, expected_amount }
   -> succeeded | failed | requires_action(redirect_url|qr_code|instructions)
pivota_orders        get_order_status / request_after_sales
```

Note the confirmation token is minted around the quote→order boundary; the exact
mint point (pre- or post-create_order) is an implementation choice as long as `pay`
cannot succeed without a token bound to the final amount.

---

## 5. Error taxonomy (adapter -> user recovery)

| Code | Meaning | Adapter recovery |
|---|---|---|
| `QUOTE_REQUIRED` | order without quote_id | call pivota_quote first |
| `QUOTE_EXPIRED` | quote past expires_at | a new quote and a new confirmation, only if there is no order for this purchase yet; if there may be one, read it first |
| `PRICE_CHANGED` | expected_amount != snapshot | show the buyer the new price and confirm again; if an order was already placed, read it instead of starting another |
| `OUT_OF_STOCK` | item unavailable at quote/order | a new quote for the items still available, only if there is no order for this purchase yet; if there may be one, read it first |
| `CONFIRMATION_REQUIRED` | pay without token | render confirmation card |
| `CONFIRMATION_INVALID` | token reused/expired/mismatch | re-confirm |
| `IDEMPOTENCY_CONFLICT` | same key, different body | new key for a genuinely new request |
| `IDEMPOTENT_REPLAY` | same key, same body | return original result; tell user "already placed" |
| `PAYMENT_REQUIRES_ACTION` | 3DS/redirect/qr | surface verbatim; never fabricate URLs |
| `MERCHANT_UNAVAILABLE` | connector down | no silent fallback (rail rule); say so |
| `MERCHANT_NOT_ACCEPTING_ORDERS` | the order call: the seller's store is not taking orders (a backend 403 its order route names), answered only when the quote-claim release rule proves it came before any order write; otherwise the same answer is `CHECKOUT_OUTCOME_UNKNOWN` | do not retry this checkout; nothing was ordered; offer the buyer another seller |
| `USER_AUTH_REQUIRED` | missing user_ref on write | trigger OAuth |
| `STATE_LINKAGE_MISMATCH` | another user, session or agent than the checkout's or order's own (one answer for all, no id, no state) | read it from the session or agent that started it; do not start another order for this purchase without the buyer |
| `PRODUCT_NOT_SERVABLE` | `/mcp` door, `PARTNER_DOOR_ONE_PRODUCT_ID` on: the product id is known and a serving gate withholds it; `detail.reason` carries the gate's reason | do not retry; offer alternatives |
| `PRODUCT_GROUP_ID_NOT_PRODUCT_ID` | `/mcp` door, flag on: the id is a product group id (`sig_` + 24 hex) with no servable member, or `product_group_id` was passed to `get_offers` | do not retry; pass the `product_id` of a search row |
| `MERCHANT_PRODUCT_MISMATCH` | `/mcp` door, flag on: the `merchant_id` named beside the product is not one of the product's sellers | do not retry as sent; omit `merchant_id` or pass the one returned with the product |

### The buyer market: reasons a call is refused or answered empty

A market is the buyer's country as ISO 3166-1 alpha-2: exactly two letters (`US`, `sg`, ` GB ` are read as US, SG,
GB). It is never guessed, never inferred from a currency, and never answered as another market. A market counts as
not named only when it is absent, `null` or blank; any other value (`false`, `0`, an empty list) was sent and is read
as a market, or refused as one.

A call that names no market at all: on the `/mcp` and `/ucp/mcp` tools it is answered for a US buyer and says so in
`market_assumed`. The `offers.resolve` operation does not label it yet: with no market it is answered without a buyer
market, so its offers are not limited to one currency. Send the market whenever you know it.

| Reason | Where it appears | Meaning | Caller recovery |
|---|---|---|---|
| `market_invalid` | `/mcp` `get_offers`: an empty answer, `metadata.reason`. The `offers.resolve` operation: `status: "error"`, `error.code: MARKET_INVALID`, `error.reason`. Checkout quotes on any door: `QUOTE_REQUIRED`, `detail.reason`, `detail.rejected_field: "market"`. ACP checkout (the fulfillment address `country`): `QUOTE_REQUIRED`, `detail.reason`, `detail.rejected_field: "fulfillment_address.country"` | a market was sent but is not two letters (`USA`, `en-US`, a number, a list, a look-alike character); the value is not repeated back; nothing was looked up or priced | resend with the buyer's two-letter country; do not retry the same value; never substitute a market |
| `ucp_market_invalid` | `/ucp/mcp`, a string that is not two letters in any market argument: `catalog.context.address_country`, `insights.market`, `checkout.context.address_country`. Code `OPERATION_NOT_ALLOWED` on the catalog and insights tools, `QUOTE_REQUIRED` on checkout; `detail.rejected_field` names the field | the same fact on the UCP door; nothing was read | resend with the buyer's two-letter country in the named field |
| `ucp_country_string_required` | `/ucp/mcp` `search_catalog` and `get_product`: a `catalog.context.address_country` that is not a string (`false`, `0`, a list, an object). Code `OPERATION_NOT_ALLOWED`; `detail.rejected_field: "catalog.context.address_country"` | the country must be a string when it is supplied; nothing was read | send the buyer's two-letter country as a string, or leave the field out |
| `market_not_priced` | `/mcp` and `/ucp/mcp` `get_offers`: an empty answer, `metadata.reason`. The `offers.resolve` operation: `status: "error"`, `error.code: MARKET_NOT_PRICED`, the code in `market`. Checkout: `NO_MERCHANT_OFFER`, `detail.reason` | a well-formed country code Pivota prices nothing in (for example `DE`); no offer or price is shown for it, and none in another market's currency | do not retry; tell the buyer no price can be offered for that country; do not resend as another market |
| `buyer_market_has_no_pricing_currency` | Search (`search_catalog`, the `find_products_multi` operation): a successful, empty page, named either in `metadata.search_decision.decision_lock_reason` or, when rows were withheld, by `metadata.serving_currency_guard.serving_currency: null` | the market sent is unreadable (including a list with any unreadable entry, such as `SG,USA`), names several markets, or is one Pivota prices nothing in; no product can be shown as priced for that buyer | do not retry the same value; send the buyer's one two-letter country |

On `/mcp`, a checkout argument whose `market` is not two letters is refused as `INVALID_ARGUMENTS` before anything is
priced; there is no separate reason token for it.

**Hard rule:** the model must never auto-retry a money operation on ambiguous failure.
Retries are safe only via the same `idempotency_key`, which the kernel dedupes.

---

## 6. ACP/AP2 handling

- Contents stay **opaque** (preserves the pass-through design in `acp-spec-bridge.md`
  / `ap2-spec-bridge.md`).
- Linkage is **validated**: the kernel verifies `quote_id`'s ACP session matches the
  inbound `acp_state` session and `user_ref`, preventing cross-user/cross-session
  state mixing.
- `ap2_state` is classified **sensitive** (may carry tokens/mandates): never logged,
  redacted everywhere.

---

## 7. Logging & audit (no sensitive payment data)

- **Redaction allow-list** (pino): PANs, full `ap2_state`, payment tokens, and
  amount-as-PII are never written to logs.
- **v3 audit log** records one append-only entry per transition: quote_issued,
  quote_confirmed, order_created, payment_outcome, after_sales — keyed by
  `(user_ref, idempotency_key)`, with amounts stored in the audit store (not app logs).
- Release gate: `test_audit_v3_end_to_end.py` must pass in CI before any v3 audit
  change merges (standing project rule). Extend it to assert INV-1..INV-5.

---

## 8. Rail compliance

The kernel runs entirely on the authoritative `POST /agent/shop/v1/invoke` rail. It must
never call the forbidden `/agent/gateway` or the public-observability-only `/api/gateway`.
Money-path calls must fail (not silently degrade) when the primary path degrades
(`primary_path_degraded=true`) or any `*_fallback` resolver fires, per
`commerce_invoke_rail_matrix.md`.

---

## 9. What the adapter must NOT do

- Must not let the model fill the charged amount (INV-2).
- Must not synthesize a confirmation_token (INV-3).
- Must not call upstream `/agent/v1/*` directly — only the canonical invoke.
- Must not invent payment URLs/QabR codes/statuses — surface backend `requires_action`
  payloads verbatim.
- Must not promise after-sales actions the connector cannot fulfill (return/exchange
  may be unsupported; only `refund` is wired today).
