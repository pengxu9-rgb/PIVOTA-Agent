> Current policy: [Reap primary checkout](reap-primary-route-policy.md). The 2026-10-03 policy supersedes historical automatic cart retries and storefront/kernel fall-through descriptions below.

# The Reap agentic lane of the UCP checkout door

`mcp-server/src/ucpReapAgenticLane.js` (the lane), `src/services/reapAgenticPurchaseClient.js` (the
backend client), `mcp-server/src/commerceToolSurface.js` (where the lane sits in the door),
`tests/reap_agentic_lane.node.test.cjs` and `mcp-server/test/ucpReapAgenticLane.test.js` (the pins).

The backend half is pivota-backend's `docs/reap_agentic_routes.md` (the wire, byte-exact) and
`docs/runbooks/reap_agentic_purchase.md` (the state machine, the poller, the dials). This page is the
door, and the contract for the buyer agent (Minds).

**It ships dark.** `REAP_AGENTIC_LANE_ENABLED` is unset by default and the backend rail
(`REAP_AGENTIC_ENABLED`) is off in production. With the gateway switch off, every UCP **tool
response** is byte-identical to the door without this lane and no backend call is made (pinned by
snapshot) — **EXCEPT** that a malformed `checkout.buyer.consent_version` (not a string, or longer than
32 characters) is refused `ucp_consent_version_invalid` at the argument adapter, whatever the switch
says. **`tools/list` is not byte-identical either:** the `create_checkout` / `update_checkout` `buyer`
schema carries the optional `consent_version` member (`maxLength: 32`), and the `create_checkout`
description mentions the Reap route. The seller contract (§5.4) adds nothing while the switch is off:
`checkout.reap` is neither advertised nor accepted (refused `ucp_unknown_field`, as before it existed),
the vendor capability `cc.pivota.reap_seller` is not in `/.well-known/ucp`, and no answer carries a
seller message.

---

## 1. What it is

Some products Pivota does not sell itself (no contract, no PSP — the rows the door would otherwise
answer with a storefront `requires_escalation` link) can be bought FOR the buyer through Reap's
agentic rail: Pivota's backend opens a purchase, its poller matches the item at Reap and has the
merchant price it, and the buyer enters a card and approves the total on **Reap's own hosted
pages**. Reap places the order with the merchant. Pivota never receives card details and does not
hold or move money.

The buyer agent uses the UCP tools it already has. There is **no new tool and no new operation**:

| tool | on a Reap checkout |
|---|---|
| `create_checkout` | opens the purchase and returns **at once** an `incomplete` checkout whose `id` starts `reap_` |
| `get_checkout` | the purchase's current state, mapped to UCP statuses (§4); carries `continue_url` whenever the buyer has something to do |
| `update_checkout` | **refused** — `OPERATION_NOT_ALLOWED`, reason `ucp_reap_update_refused` |
| `complete_checkout` | **refused** — `OPERATION_NOT_ALLOWED`, reason `ucp_reap_complete_refused`. Completion happens on Reap's page |

## 2. The lane order

For a `create_checkout`, in this order (`mcp-server/src/commerceToolSurface.js`, step 3a):

1. **Native (kernel)** — a row Pivota transacts itself (no storefront target:
   `escalationTargetOf(row) === null`, i.e. a contracted merchant, or a row declaring
   `purchase_route: 'internal_checkout'`) never enters the Reap lane. The decision is the door's
   existing typed classification, taken inside the lane before anything else.
2. **Reap** — a non-native row that is eligible (§3).
3. **Storefront escalation** — `ucpCheckoutEscalation.js`, unchanged, whenever the Reap lane
   declines: not eligible, declined by the merchant-purchasability gate, or **refused by the
   backend**. A backend refusal is a fall-through, never an error, so the buyer still gets an answer.
4. **The kernel path's own answer** — when escalation is off or declines too. (This door has no
   separate "referral" lane; the buyer's other route is the offer link discovery already served.)

Why this order: a contracted merchant is paid in chat through Pivota's own kernel, so a partner card
page would be a detour; and for a merchant Pivota cannot charge, Reap completes the purchase at our
catalog price with a card-only rail and an order reference, where the storefront link is a
recommendation the buyer finishes alone.

## 3. When the lane is entered (create)

All of these, otherwise the lane is skipped silently (logged with a code) and the next lane answers:

- the gateway switch `REAP_AGENTIC_LANE_ENABLED` is on;
- the call is on the **UCP** dialect (`/ucp/mcp`) with a verified buyer + session (the door's
  existing `USER_AUTH_REQUIRED` rule runs first), and the request carries BOTH an agent API key and
  an `X-Agent-User-JWT` (the backend rail's two credentials). A caller without them — an MCP-OAuth
  caller, or one sending no user token — skips the lane silently (logged once per process as
  `no_caller_credentials`) and gets exactly today's answer;
- the cart has **exactly one line**, quantity 1–10;
- the row is **not native** (§2 step 1), carries our catalog `product_key`, is a **Shopify** row
  (explicit `platform`, else the `prod::<merchant>::shopify::<id>` key), has **at most one real
  variant** (a UCP line item cannot name a variant, and the backend refuses a multi-variant product
  without one), is priced, and has a merchant domain (an explicit field, else the storefront host;
  never a Pivota host — sent **as observed, lowercased only**: no `www.` is stripped, because the
  backend canonicalises both sides at lookup);
- when the create carries `checkout.reap.expected_merchant_domain`, the DOOR has already checked it
  against every line before any lane ran, and refused a difference (§5.4); the lane checks it once
  more (belt and braces) and opens nothing on a difference;
- the checkout id it would mint decodes back to the same values (checked **before** the POST; an
  item id or key the id cannot carry is skipped as `id_unencodable`, never minted undecodable);
- the merchant-purchasability gate did not decline it — consulted **exactly as the escalation lane
  consults it**: same switch (`MERCHANT_PURCHASABILITY_GATE_ENABLED`), same singleton client, same
  fail-open rule, same market source (`checkout.context.address_country`), same budget clamp;
- then the lane **POSTs, with whatever consent and buyer details the call carried** (attested email
  wins over the body's). **The lane never refuses a create.** A backend 400 proves nothing about
  eligibility — the backend checks consent and the address BEFORE it checks the merchant, so a
  non-eligible row answers `consent_required` too — so the only thing a short buyer block can earn is
  one informational message on today's answer.

What the backend answers decides:

| backend answer | the door |
|---|---|
| `202` | `incomplete` checkout, id `reap_…` |
| `400 consent_required`, or `400 invalid_request` / `invalid_address` **with a buyer field actually missing** (email, or destination first/last name, phone, street, city, country) | fall through to today's storefront answer, byte for byte, **plus ONE constant info message** `reap.available_with_consent` naming `checkout.buyer.consent_version` and the destination `last_name` / `phone_number`. With storefront escalation off, the kernel path answers as today and the message has nowhere to ride (code logged) |
| every other `400` (`invalid_return_url`, `invalid_request` with complete details, malformed ids, catalog defects, `currency_unsupported`), `404 not_available_on_this_rail`, `409` (eligibility, `row_*`, `idempotency_conflict`), `401`, `5xx`, timeout | fall through with NO message (code logged) |

The message is a constant: no backend text and no request value can reach it, and no backend body is
ever read beyond its `detail.error` code.

The backend is authoritative for everything it checks again (eligibility allowlist per market,
Shopify, the price from our catalog and the merchant's own offer, the market's currency, the
purchasability fact).

## 4. Status mapping (`get_checkout`)

| backend `state` | UCP `status` | `continue_url` |
|---|---|---|
| `resolving` | `incomplete` | — |
| `needs_enrollment` | `requires_escalation` | Reap's **card-entry** page |
| `quoting` | `incomplete` | — |
| `awaiting_approval` | `requires_escalation` | Reap's **approval** page |
| `processing` | `complete_in_progress` | — |
| `completed` | `completed` | — (order reference in `messages`) |
| `refused` / `failed` / `expired` | `canceled` | — (named reason in `messages`) |

| a state this door does not know yet | `incomplete` | — (`reap.state_unrecognised`; logged once) |

- A link is forwarded ONLY with a **present, future deadline** — `approval_deadline` when the backend
  sends it (on `awaiting_approval`: the earlier of the quote's expiry and the page's), else
  `hosted_url_expires_at` — on Reap's hosts (`prava.space`, `reap.global`; https; default port; no
  userinfo), intact through the money filter. That deadline is the checkout's `expires_at`, and on
  `awaiting_approval` it is also published bare as `messages[].code = "reap.approval_deadline"`.
  A present but unreadable `approval_deadline` is refused, never skipped over for the longer page
  expiry. An `awaiting_approval` row whose `approval_deadline` has already **passed** (the backend
  keeps the field after the link is dropped, until its poller closes the row) is answered
  `incomplete` with `messages[].code = "reap.approval_deadline_passed"` — not
  `reap.hosted_page_not_ready` — and never `canceled`: this door does not invent a terminal state.
  A buyer-action state without one is answered `incomplete` with
  `messages[].code = "reap.hosted_page_not_ready"` — never `requires_escalation` without a link —
  and **a link is never forwarded for any other state**.
- **Only a 404 whose `detail.error` is `purchase_not_found`** (unknown, or another buyer's — the
  backend answers both alike) is an unknown id: exactly the answer any unknown checkout id gets
  (`QUOTE_NOT_FOUND`), because the kernel path gives it (it is handed `reap_<purchase id>`, not the
  line snapshot).
- **Everything else that is not a 2xx view** — transport error, timeout, 5xx, 401/403/429/400,
  404 `not_available_on_this_rail` (the dial turned off mid-purchase), a malformed body → `incomplete`
  with `reap.view_unavailable` and a retry hint. Never terminal and never "unknown": either would
  invite a re-create, i.e. a second purchase.

Every lane answer is the same UCP checkout object the escalation lane builds
(`buildUcpCheckoutEnvelope`): `ucp.payment_handlers: {}`, one `li_1` line item, one `subtotal` and one
`total`, the legal `links`, `expires_at`. Amounts are ISO minor units. The subtotal is at Pivota's
catalog price; the total is the quoted total once the merchant has priced it and the charged total on
`completed`.

**Where each displayed field comes from.** On a successful read, EVERY one — `line_items[0].item.id`
(our catalog `product_key`), title, quantity, currency, unit price, totals — comes from the backend's
view; a view missing any of them is treated as a failed read. The checkout id's snapshot is used only
to check the view is for this purchase: the id travels through the caller, so it is not trusted. On a
failed read the snapshot is the only source, and the answer says so (`reap.view_unavailable`).

**The title is plain text, except for right-to-left halves.** `line_items[0].item.title` is
`<product name> — <variant title>`, or the product name alone (the variant is omitted when it is missing,
only invisible characters, or the same visible text as the name). A half with no right-to-left text is
exactly the merchant text, trimmed: an all-Latin (or CJK) title is byte-for-byte what it always was. A half
that carries right-to-left text (a Hebrew/Arabic/Syriac/Thaana/NKo/... letter, or an RLM/ALM) is wrapped in
FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE (U+2068 … U+2069), with any line or paragraph break inside it
folded to a space, so it cannot reorder the dash, the variant's digits, or whatever a consumer prints after
the title. Render such a title as-is (browsers and most text stacks honour isolates), or delete U+2068/U+2069
for a plain-text copy. A name that is only invisible characters counts as absent, and the line shows the item
id, which is also the title on a failed read. The checkout id never includes the title.

## 5. The contract for Minds

### 5.1 What to send

Same tools, same headers as today: the agent API key plus `X-Agent-User-JWT` carrying a session
claim (`sid` / `session_id`). The Reap lane needs three things a storefront checkout does not:

```json
{
  "meta": { "ucp-agent": { "profile": "https://…/.well-known/ucp-agent" }, "idempotency-key": "minds-7f3a-0001" },
  "checkout": {
    "line_items": [{ "item": { "id": "sig_…" }, "quantity": 1 }],
    "buyer": { "email": "ada@example.com", "consent_version": "reap-agentic-v1" },
    "context": { "address_country": "US" },
    "fulfillment": { "methods": [{ "type": "shipping", "destinations": [{
      "first_name": "Ada", "last_name": "Lovelace", "phone_number": "+15550100",
      "street_address": "900 Brannan St", "extended_address": "Suite 400",
      "address_locality": "San Francisco", "address_region": "CA", "postal_code": "94103",
      "address_country": "US" }] }] }
  }
}
```

1. **`checkout.buyer.consent_version`** — NEW, optional on the wire, **required by the rail**. The
   version tag of the Pivota terms the buyer accepted for a purchase fulfilled through Reap: a string
   of at most 32 characters (the argument adapter refuses anything else as
   `ucp_consent_version_invalid`), **forwarded verbatim** — the backend's single consent validator
   judges its content. Show the buyer the terms first. There was no consent field on the
   wire before this; it rides in the UCP `buyer` object (which the spec leaves open), not in a new
   argument. It is **not** the spec's `dev.ucp.shopping.buyer_consent` extension (privacy booleans,
   which Pivota does not advertise). The backend stores it against the purchase for ever.
2. **A shipping destination with a last name and a phone** (`phone_number` on the destination, or
   `checkout.buyer.phone_number`). Reap's rail requires both; the lane never invents either.
3. **`checkout.context.address_country`** — the market the purchasability gate asks about. Without
   it the gate cannot ask and keeps its previous behaviour (the backend still enforces its own fact
   against the destination country).

4. **`checkout.discounts.codes`** — NEW, optional, and **only while offer codes are armed**
   (`REAP_AGENTIC_LANE_ENABLED` AND `REAP_AGENTIC_CART_LINK_LANE_ENABLED`): the buyer's ONE offer (coupon)
   code, as UCP's discount extension (`dev.ucp.shopping.discount`, advertised in `/.well-known/ucp` only while
   armed) spells it: `{ "codes": ["PEACHIE20"] }`, create_checkout only. Unarmed, `checkout.discounts` is not
   in the schema and is refused as an unknown field, exactly as before. Armed, the adapter enforces the shape
   (at most one string of 1–128 code points, `ucp_offer_code_invalid` otherwise) and the lane forwards it
   **verbatim** as the backend's `offer_code` — never trimmed or case-folded; the backend's one offer-code
   rule judges its content (`400 invalid_offer_code` → a `discount_code_invalid` warning, no Reap purchase).
   If the merchant refuses the code, the purchase is re-quoted **without it** and `get_checkout` says so
   (below). A code sent on a create whose answer is **not** a Reap checkout is **not applied**: that answer
   carries a `discount_code_invalid` warning at `$.discounts.codes[0]`.

5. **`checkout.reap.expected_merchant_domain`** — optional, create_checkout only, and only while
   `REAP_AGENTIC_LANE_ENABLED` is on: the seller the buyer was shown. See §5.4.

`meta["idempotency-key"]` is required as on every state-changing call. **Retry with the same key**:
the backend key is derived from it (hashed, namespaced — never random, never the raw key), so a
retried `create_checkout` replays the same purchase instead of opening a second one.

### 5.2 What comes back

`create_checkout` → `status: "incomplete"`, `id: "reap_rp_<24 hex>.<opaque>"`. Treat the id as
opaque; it carries the backend purchase id and a snapshot of the line (product id, quantity,
currency, unit price) so a failed read can still answer a well-formed checkout. It carries **no buyer
data**. **Do not decode it**: its format is not a contract and may change. The seller is published in
`messages` (§5.4).

Then poll `get_checkout { meta, id }`:

- **Cadence**: the message with `code: "reap.poll_after_seconds"` has the seconds to wait as its
  bare `content` (e.g. `"30"`); it is present on every non-terminal answer and absent on a terminal
  one. Stop polling on `completed` or `canceled`.
- **The two links the user must open** — both arrive as `continue_url` on a `requires_escalation`
  answer; hand the URL to the user as a link to open in their browser:
  1. `needs_enrollment` — **add a card** on Reap's secure page (first purchase, or after a
     re-link). Pivota never sees the card.
  2. `awaiting_approval` — **review the total and approve**. Nothing is charged until they do.
  A link is valid until the checkout's `expires_at`; do not reuse one after it. **On
  `awaiting_approval` that is the quote's TTL — about five minutes from the quote, NOT the fifteen
  the hosted page itself claims.** Measured 2026-09-25 in the Reap sandbox (two checkouts, neither
  approved): the checkout flips to `FAILED` — not `EXPIRED` — 1–10 s after the quote's `expiresAt`
  and never reaches `PROCESSING`. The backend publishes the earlier of the two expiries as
  `approval_deadline`; this door forwards it as `expires_at` and as the bare
  `reap.approval_deadline` message. When the backend does not send the field (older backend, or
  `needs_enrollment`), `expires_at` is the page's own expiry — read the value, not the prose. Show
  the buyer the link at once; read an `incomplete` carrying `reap.approval_deadline_passed` as
  "too late, poll once more for the final state", and a `canceled` with
  `Reason: approval_window_lapsed` as "the buyer did not approve in time — create a new checkout".
- **Offer code**: `discounts.codes` echoes the code while the purchase is in flight. Once priced, one
  message says what it came to — `reap.offer_code_applied` (info; `discounts.applied` carries it and
  `totals` gains a NEGATIVE `discount` row), `reap.offer_code_no_discount` (info), or the UCP discount
  rejection warnings `discount_code_invalid` / `discount_code_expired` at `$.discounts.codes[0]` (the
  purchase continued without the code, so the total has no discount — tell the buyer before they approve).
  A `canceled` with `Reason: offer_code_rejected` means: create a NEW checkout without the code, with a
  NEW idempotency key. The total is always the payment partner's own; this door computes no discount.
- **Totals**: once priced, `fulfillment` (shipping), `tax` (only when NOT already in the prices — the
  total's text says "tax is included in the prices" otherwise) and `discount` rows appear between
  `subtotal` and `total`, and ONLY when they add up to the total.
- **Done**: `completed` carries `code: "reap.order_reference"` whose `content` is the merchant's
  order reference, verbatim.
- **Not done**: `canceled` carries `reap.purchase_refused` / `reap.purchase_failed` /
  `reap.purchase_expired` with the reason when there is a safe one. Create a new checkout to try
  again.

- **Seller**: `create_checkout` and every good `get_checkout` carry `reap.merchant_domain` and
  `reap.merchant_id` (§5.4); a `reap.view_unavailable` answer carries neither.

### 5.3 Refusal codes

| where | code / reason | meaning | what to do |
|---|---|---|---|
| `create_checkout` | `QUOTE_REQUIRED` / `ucp_consent_version_invalid` | `consent_version` is not a string, or longer than 32 characters | fix the value |
| `create_checkout` | `QUOTE_REQUIRED` / `ucp_offer_code_invalid` | (armed) `checkout.discounts` is not `{ codes: [one string of 1..128 code points] }` | fix the value, or send no code |
| `create_checkout` | `QUOTE_REQUIRED` / `ucp_unknown_field` | (not armed) `checkout.discounts` was sent | send no code |
| `create_checkout` | `QUOTE_REQUIRED` / `ucp_seller_mismatch` | (lane on) an item resolves to a seller other than `checkout.reap.expected_merchant_domain`, or to one Pivota cannot confirm | §5.4 — show the buyer "Visit <the seller you showed>" only |
| `create_checkout` | `QUOTE_REQUIRED` / `ucp_expected_merchant_domain_invalid` | (lane on) `checkout.reap` is not `{ expected_merchant_domain: <bare ASCII host> }` — a URL, port, path, single label, non-ASCII character, a Pivota host, not a string, or > 253 characters | send the bare host (`brand.com`) |
| `create_checkout` | `QUOTE_REQUIRED` / `ucp_unknown_field` | (lane off) `checkout.reap` was sent, or any member other than `expected_merchant_domain` inside it | send no `reap` member while the lane is off |
| `update_checkout` | `OPERATION_NOT_ALLOWED` / `ucp_reap_update_refused` | a Reap checkout cannot be changed | create a new checkout |
| `complete_checkout` | `OPERATION_NOT_ALLOWED` / `ucp_reap_complete_refused` | completion is on Reap's page | poll `get_checkout`, open `continue_url` |
| `get_checkout` | `QUOTE_NOT_FOUND` | unknown id (or another buyer's) | — |

There is **no Reap refusal on create.** (The one create refusal the seller contract adds,
`ucp_seller_mismatch`, is the door's, taken before any route runs; see §5.4.) A backend refusal of any kind (`consent_required`,
`merchant_not_eligible`, `row_not_found`, `row_unpriced`, `merchant_not_purchasable`,
`not_available_on_this_rail`, `idempotency_conflict`, `currency_unsupported`, …) is **not** surfaced as
an error. When the buyer block was short, the storefront answer carries one `info` message with
`code: "reap.available_with_consent"` — read it as "resend with `consent_version`, a last name and a
phone if the user wants the Reap route". Otherwise the door falls through to the storefront escalation
(or the kernel path) and logs the code.

**Tier B (cart-link) retry.** With `REAP_AGENTIC_CART_LINK_LANE_ENABLED` on (default OFF; read per call,
only while the lane itself is on), a `409 merchant_not_eligible` from the backend's variant lane — the
merchant is not on the operator allowlist — is POSTed ONCE more with `item_source: "cart_link"` and its own
derived idempotency key (`pivota-ucp-reap-lane:cart_link:v1:` namespace), same buyer and code. It is never
retried on `merchant_disabled` (an operator turned the merchant off — the backend refuses both lanes), nor
on the cart-link POST's own answer. A client retry of the same create replays: the backend remembers the
variant refusal against the variant key, and the cart-link key is deterministic.

**Tier B DIRECT for external-seed rows.** An external-seed / mirror row cannot be bought on the variant lane: the
backend's variant rail reads Shopify catalog rows only. Examples are judydoll.com (platform `external`, key
`prod::external_seed::external_seed::ext_…`, its link a Pivota `/r` hop) and jsmbeauty.sg (platform
`external_seed`, key `ext:…::<hash>`, SGD — see below: that key is sent only with the enrichment dial on).

While BOTH dials are on (`REAP_AGENTIC_LANE_ENABLED` and `REAP_AGENTIC_CART_LINK_LANE_ENABLED`), such a row is
POSTed ONCE with `item_source: "cart_link"` and the cart-link idempotency key. This is exactly the body the Tier B
retry sends, not a variant attempt first. The body carries:
- `merchant_domain`: the merchant's host as observed, lowercased. It is the explicit merchant field, else the
  host of the `/r` hop's token `dest`, else `destination_url`. The backend's cart-link catalog read compares
  `lower(source_domain)` to it byte for byte.
- `product_key`: the row's key, as is.
- quantity, buyer, and offer code, as on the variant lane.
- **no variant**. pivota-backend `_load_cart_link_item` accepts no caller variant; it proves the sole Shopify
  variant from the seed's storefront evidence.

**Only a key the backend's cart-link lane resolves is sent.**
- `_load_cart_link_item` resolves an external-seed row only when it is the seed **mirror**: key
  `prod::external_seed::external_seed::<external_product_id>`, `source_system external_product_seeds_mirror_v1`.
- An enrichment-agent `ext:<canonical>::<hash>` key IS a `catalog_products` key, but its source system is the
  agent's, which that function refuses (`row_variant_unverified`). The live jsmbeauty.sg rows carry such keys,
  e.g. `ext:jungsaemmool-essential-mool-toner::4b4c3cfe`.
- The mirror writes no `prod::external_seed::…` row for a seed attached to an `ext:` product, so there is no
  mirror key to map these rows to.
- So they are skipped `row_key_unsupported`, with no POST, as is any `platform: external` row that is not a mirror
  (an affiliate-feed row), and any mirror-shaped key whose read names another source system.
- The jsmbeauty.sg demo therefore needs a mirror row, or a backend change, before this lane can buy it.

**Enrichment rows (option 2, PR D), behind `REAP_AGENTIC_CART_LINK_ENRICHMENT_ENABLED`.** Default OFF, read per call,
consulted only while the lane AND the cart-link dial are on. Off, everything above holds byte for byte. On, an
enrichment-agent row is POSTed as `item_source: "cart_link"` like a mirror row, for the backend's option 2 branch
of `_load_cart_link_item` (PR C) to resolve against its variant proof table. Arm it only after PR C is live.
- **Key shape.** Exactly what pivota-backend `services/catalog_enrichment_agent/ingestion.py` mints:
  `ext:<slug>::<8 lowercase hex>` (`derive_product_key`: the slug is lowercase alnum and `-`, starts with an alnum,
  at most 200 chars) or `ext:retailer:<32 lowercase hex>` (a retailer listing). Any other `ext:` shape
  (`ext:foo`, 31 or 33 hex, uppercase hex, an empty slug) stays `row_key_unsupported`.
- **Not `ext:unknown::<hash>`.** The generator gives that one key to EVERY brand + name with no ASCII letter or
  digit, so its row is whichever product was written last. It is `row_key_unsupported`.
- **Source system.** Absent on the read, or `catalog_enrichment_agent_v1`. Any other (the mirror's included) is
  `row_key_unsupported`. (Live reads carry none.)
- **What the read carries.** Live get_product reads of enrichment rows (tarte, stila, MAC, bluemercury,
  2026-09-29) have NO `source_domain`, `source_system` or `platform`, and their `canonical_url` / `url` is Pivota's
  own PDP (`https://agent.pivota.cc/products/sig_…`). The merchant's page is `external_redirect_url`, with
  `destination_url` and `source_url` beside it.
- **Host sent.** The host of the storefront target (`external_redirect_url`), as observed and lowercased. That is
  the field the door's expected-seller check already judges. The shape is checked on the field AS THE ROW CARRIES
  IT, not on the parsed form the door sees, because parsing drops a `:443` and resolves `/a/../`. It must be exactly
  `https://<host>/products/<handle>`, the shape pivota-backend `storefront_page` accepts:
  - no userinfo, no port, no query or fragment;
  - no Pivota host or `/r` hop, no redirector;
  - the handle not `.js` / `.json`.

  Otherwise the row is skipped `no_merchant_domain`. `canonical_url` and `url` are never read.
- **Every other merchant field must agree.** When present, `source_url`, `destination_url`, `source_domain` and
  `merchant_domain` must each name the same merchant, compared as the door compares (lowercase, one leading `www.`
  folded). Live reads do differ by `www.` (stila's and MAC's `source_url`), and that is accepted. Anything else is
  skipped `merchant_domain_conflict`: an affiliate `destination_url`, another seller's host, a sibling subdomain, or
  an unreadable value.
- **Seller.** The door check is unchanged, and the host POSTed is one of its destinations. The host is settled
  before the lane's own seller re-check, so a row with no host logs `no_merchant_domain`, not `seller_mismatch`.
- **Variants.** Two kinds of row are sent with no variant:
  - a canonical-only row: no variants, or only the product-level placeholder. An entry is the placeholder only when
    every id it carries (`variant_id` / `id`, `sku_id`, `source_variant_id`) is EXACTLY the product key,
    `<product_key>::canonical`, the source product id or the product id. The producer's canonical sku and
    pdpBuilder's variant-less entry are both that shape. A prefix is not enough: `<product_key>::v:<id>` and
    pdpBuilder's `<product_id>-1`, `<product_id>-2` are real variants. A numeric id makes the entry real, and so does
    an entry with no id;
  - a row with one variant.

  The backend proves the variant itself, either the store's sole live variant or one its proof table names. Two or
  more entries, counted with or without ids, are `multi_variant` until a line item can carry a variant. Mirror rows
  keep `realVariantCount` and the `variant_unresolvable` rule below.

**Which host is sent.** The backend matches `lower(catalog_products.source_domain)` byte for byte, so an explicit
`merchant_domain` / `source_domain` on the read is sent as observed, lowercased. It wins over the URL's host even
when the two differ only by `www.`. Without one, the host of the hop's `dest` (then `destination_url`) is sent.

A row is still skipped before any POST (`variant_unresolvable`) unless ONE variant can be named. Any of these counts:
- a Shopify numeric `source_variant_id`, on the row or on its single variant;
- the read's own sole variant id: `variants[0].variant_id` when the row has exactly one variant, and/or
  `default_variant_id` when it has at most one. Every one present must be a Shopify variant id (digits, or
  `gid://shopify/ProductVariant/N`), and they must agree. A `default_variant_id` beside two or more variants names
  nothing. This is the live KraveBeauty shape: `default_variant_id "41596313010251"`, one variant with that
  `variant_id`, and no `variant=` on any URL.
- a single numeric `variant=` on the merchant's own URL on the merchant's host.

This is a pre-filter only, to avoid wasted POSTs. The variant is never sent; the backend proves it from the seed's
storefront evidence and is the authority. Whether the merchant IS a Tier B cart-link merchant is the backend's daily verdict in the buyer's market.
Any refusal (`merchant_not_eligible`, `row_not_found`, `row_variant_unverified`, `row_currency_mismatch`, …) falls
through with no second POST.

With the cart-link dial off, an external-seed row is skipped `not_shopify` exactly as before. Shopify rows keep
the variant lane and its one retry, unchanged. The expected-seller check (§5.4) runs at the door first, as for
every create. On these rows `reap.merchant_id` is omitted: their key's merchant segment is the shared
external-seed sentinel, which is a supply bucket, not a seller.

**After a merchant is ENABLED on the variant lane, use a NEW idempotency key for 24 hours.** The backend
remembers a variant-lane `merchant_not_eligible` against the key for the key's whole 24 h window (so a retry
replays the cart-link purchase instead of opening a second one). A create re-sent with the SAME key after the
operator enabled the merchant is therefore still refused on the variant lane — and answered on the cart-link
lane, or by the storefront. To be bought on the newly enabled variant lane within those 24 hours, send a new
`meta["idempotency-key"]`. After 24 hours the key is forgotten and replaced by the next request's purchase.

**Offer codes are set at creation only.** `checkout.discounts` is accepted on `update_checkout` while armed
(the discount capability is advertised), but an update never applies a code: on a Reap checkout the update
refusal says so, and on any other checkout the answer carries `discount_code_invalid` at
`$.discounts.codes[0]`.

**Totals rounding.** The backend accepts a quote whose total is within one minor unit of its components. Such
a residual is shown as its own `Rounding` row (`fee` when positive, `discount` when negative), so the rows
always add up; a larger residual shows no breakdown at all and is logged `breakdown_unreconciled`. The backend checks its daily Tier B verdict and its own
`REAP_AGENTIC_CART_LINK_ENABLED`; any refusal of that second POST falls through exactly as above. No other
refusal is retried. The multi-variant skip still applies (this door sends no `variant_key`).

### 5.4 The seller contract (stable) — vendor extension `cc.pivota.reap_seller`

A `sig_` product id can have several sellers. The door resolves it to ONE served row (the lowest
`product_key`), and **every** route — the kernel, Reap, the storefront link — sells from, or sends the
buyer to, **that row's** merchant, which can differ from the seller a platform showed the buyer. This
contract guarantees the buyer is never sent to a seller other than the one the platform asserts, and
lets a platform see who a Reap purchase is with. It is **stable**: the field, reason and code names
below do not change without a new name beside them.

**In — `checkout.reap.expected_merchant_domain`** on `create_checkout` only. It is advertised in
`tools/list` and accepted only while `REAP_AGENTIC_LANE_ENABLED` is on. With the lane off it is
refused `ucp_unknown_field`, as on main.

```json
{ "checkout": { "line_items": [{ "item": { "id": "sig_…" }, "quantity": 1 }],
                "reap": { "expected_merchant_domain": "brand.com" }, "…": "…" } }
```

- A bare ASCII host. `www.` and case do not matter: `brand.com`, `www.brand.com` and `BRAND.com` are
  one seller, and `shop.brand.com` is another. The comparison uses the backend's canonical rule:
  lowercase, then ONE leading `www.` removed. Non-ASCII is refused **before** any case fold, so a
  lookalike such as U+212A KELVIN SIGN cannot become `k`. A value that could never match (a URL,
  port, path, single label, Pivota host or non-ASCII) is refused `ucp_expected_merchant_domain_invalid`
  (§5.3).
- **The door checks it ONCE, before any route.** The Reap lane, the storefront escalation and the kernel
  all run after this check. The door reads every line's row, using the same memoized read the routes
  use: a match costs no second read, pinned at exactly one `get_product` per product. **Every**
  destination the row can sell from or send the buyer to must then be the expected seller
  (`mcp-server/src/ucpExpectedSeller.js`):
  - the row's explicit merchant fields, `merchant_domain` and `source_domain`. These are what the Reap
    lane buys from.
  - the storefront target, `external_redirect_url` of a non-native row. This is the storefront
    answer's `continue_url`.
  - for a **native** row (no storefront target), the merchant's **registered store** destinations the
    read carries: `online_store_url` and `external_redirect_url`. The backend derives both from the
    merchant's verified connected store.
    - A native row with none of these and no explicit field is `seller_unconfirmed`.
    - Its `canonical_url` / `url` is a catalog page, not the merchant of record the kernel sells for,
      so it is never used.
  - A **Pivota attribution hop** (`https://api.pivota.cc/r?token=…` or the same on
    `agent.pivota.cc`, path exactly `/r`) is judged by the `dest` in its token payload, under the same
    rules. The token is the backend's own two-segment format, not a JWT: `<b64url(payload
    JSON)>.<b64url(HMAC-SHA256)>`, payload first, no header, padding stripped (pivota-backend
    `make_redirect_token`; every `/r` minter on main uses it). The payload carries `v`, `t`, `market`,
    `dest`, `ctx`, `iat` and `exp`. The live demo rows carry exactly this: judydoll's `external_redirect_url` is such a hop to
    `https://judydoll.com/products/…`. So a hop to the expected seller passes, the attributed link is
    handed out unchanged, and a hop to another seller is refused.
    - The token is **decoded, not verified**. Every URL judged here comes from Pivota's own backend row;
      the caller supplies only the expected host. If a caller-supplied URL ever reaches this check, the
      token must be verified first.
    - The hop is unconfirmed if: the token is malformed (not exactly two non-empty base64url
      segments, or the first is not base64url JSON of an object); `dest` is missing, not https, carries userinfo, or is itself a
      hop; or there is more than one `token`.
  - Any other destination is **unconfirmed** (fail closed, whatever its host) when it:
    - is any other Pivota host or path;
    - carries another URL in its query or path, i.e. an affiliate or redirector hop, even one that ends
      at the same seller. The values of `ref` and `utm_*` are tracking context and are ignored. A path
      whose encoding does not decode is unconfirmed.
    - is not https, carries userinfo, or does not parse.

  The storefront lane re-checks the one link it hands out, as belt and braces: a `continue_url` whose
  host is not the expected seller is refused, never returned.
- **Every line is the expected seller** → nothing changes. Each route answers exactly as it would
  without the member: Reap sends the same backend request and returns the same answer, a native row
  reaches the kernel, a storefront row gets its storefront link.
- **Any line is another seller, or cannot be confirmed** (the read fails, the row is absent, or it has
  no readable merchant) → the create is **REFUSED**. Nothing is opened, nothing is charged, no
  `continue_url` or any other link is returned, and **no other route is offered**. This holds whatever
  the caller's credentials and whatever `AGENT_CHECKOUT_UCP_ESCALATION_ENABLED` says:

  ```json
  { "error": { "code": "QUOTE_REQUIRED", "message": "The item at checkout.line_items[0] is sold by www.other.com, …",
      "detail": { "reason": "ucp_seller_mismatch", "dialect": "ucp",
                  "rejected_field": "checkout.reap.expected_merchant_domain",
                  "cause": "different_seller", "line_item": "$.line_items[0]",
                  "merchant_domain": "www.other.com", "merchant_id": "m_other" } } }
  ```

  - `cause` is `different_seller`, or `seller_unconfirmed` when Pivota could not confirm a seller (see
    above).
  - `line_item` names the first offending line. It is absent when the read itself failed.
  - `merchant_domain` is the host that is **not** the expected seller, present on `different_seller`.
  - `merchant_id` is the row's catalog merchant id, when known.
  - Both come from Pivota's catalog; neither is ever a request value.
- **What the UI does on `ucp_seller_mismatch`:** tell the buyer this item is not available here from
  the seller they were shown, and offer only **"Visit <the seller you showed>"**, built from the
  platform's own record of that seller. **Never follow, show or prefetch any link from the gateway for
  this item**, including any URL of a previous answer. The detail's `merchant_domain` is for logging
  and diagnostics, not a link.
- **Absent** → nothing changes.

**Out — on a Reap checkout answer read from a server-side source**: `create_checkout`, and
`get_checkout` when the backend read succeeds. Two `info` messages at `path: "$.line_items[0]"`, each
with the bare value as `content` (read `content`, not prose, like `reap.poll_after_seconds` and
`reap.order_reference`):

| `code` | `content` | source |
|---|---|---|
| `reap.merchant_domain` | The merchant's host, **lowercase, as observed**. `www.` is kept when the row carries it (`www.brand.com`); this is exactly the host the purchase was opened for. Compare it with **`www.` folded** (lowercase, remove ONE leading `www.`). | create: the host the lane POSTed; get: the backend view's `merchant_domain` |
| `reap.merchant_id` | Pivota's catalog merchant id: the `<merchant>` segment of the catalog key the purchase was opened for (`prod::<merchant>::<platform>::<id>`) | create: that key; get: the view's key, checked equal to the checkout's |

Either message is omitted when its value is unknown; a message is never a guess. **The degraded
`get_checkout` (`reap.view_unavailable`) carries neither.** Its only source is the checkout id, which
travels through the caller, so a crafted id must not be able to make Pivota name a seller. Keep the
seller from the last good answer.

**Where these live in UCP, and why.**
- UCP 2026-04-08 has no seller member on the checkout, the line item or the item. Its only `seller` is
  the catalog *variant*'s display `name` and `links`.
- **Inbound**, the member is added by a **vendor extension**, as the spec's extension model provides
  (overview, "Extensions" / "Extension Schema Pattern"):
  - Capability `cc.pivota.reap_seller`: reverse-DNS of pivota.cc, `extends: ["dev.ucp.shopping.checkout"]`.
  - It has a self-describing schema composed with `allOf` onto checkout, keyed in `$defs` by the
    parent's full name, with `requires`. That schema is `docs/ucp/reap_seller.json`, generated from the
    member the door advertises and pinned equal to it by a test.
  - `context` is ruled out because the spec defines it as non-authoritative hints a business MAY
    ignore, and this is a guard the door must honour.
- **Outbound**, `messages[]` with a freeform `code` is the spec's carrier for business-specific
  checkout state (`info_code`: "freeform codes are permitted").

**Advertising the capability.** `/.well-known/ucp` lists `cc.pivota.reap_seller` only while the Reap
lane is on **and** its documents are hosted. Both URLs must be on the namespace authority, pivota.cc.
The profile builder withholds a vendor capability without them, as it does `cc.pivota.insights`. To
publish it:
1. Host `docs/ucp/reap_seller.json` byte for byte at its `$id`,
   `https://pivota.cc/ucp/schemas/reap_seller.json`.
2. Host this section as the spec page.
3. Set `UCP_REAP_SELLER_SCHEMA_URL` and `UCP_REAP_SELLER_SPEC_URL` on the gateway.

Until then the member still works on `/ucp/mcp` (it is in `tools/list`); it is simply not in the
profile.

**Accepted before negotiation, deliberately.** `checkout.reap` is accepted on `/ucp/mcp` whether or not
the platform negotiated `cc.pivota.reap_seller`, exactly as `cc.pivota.insights`' tools are callable
without being negotiated. The member can only make a create **stricter**: it opens nothing and it never
changes a matching answer. **Hosting the documents is a prerequisite for arming the lane in
production.** A spec-following platform only learns the member from the profile.

**Kernel path (native rows): what pins the seller, and the gap.** Checked read-only against
pivota-backend `origin/main` `75b6f3cd6` and this gateway.
- A UCP create for a native row goes to `kernel.previewQuote` →
  `invokeCommerceKernelRawUpstream('preview_quote')` (`src/server.js`) →
  `POST /agent/v2/quotes/preview`.
- The gateway sends `merchant_id` only from `quote.merchant_id` (or an offer id), and the UCP quote
  carries **none** (`ucpArgumentAdapter.js` `mapQuote`).
- The backend's `QuotePreviewBody.merchant_id` is **required** (`routes/agent_v2.py`), and the quote is
  bound to it. The item's `variant_id` does **not** choose the seller; it is looked up inside that
  merchant.
- The kernel then takes `merchant_of_record` from the request's `merchant_id` (`upstreamAdapter.js`)
  and refuses a quote without one (`kernel.js` `previewQuote`).
- So **today a UCP create cannot open a kernel checkout with any merchant**: there is no seller for the
  kernel to drift to after the door's check.
- **The gap:** if a later change fills `quote.merchant_id` for UCP carts, it must use the merchant of
  the row the door checked (the same memoized read). Otherwise a multi-seller `sig_` could be quoted
  against a merchant the check never saw. This PR does not pass `merchant_id` itself. Doing so would
  newly enable native UCP checkouts, and the backend's per-merchant catalog cannot resolve a `sig_` id
  anyway.

## 6. Budgets and failure modes

| call | backend requests | budget | on failure |
|---|---|---|---|
| `create_checkout` | one `POST /agent/v2/commerce/reap/purchases`; **two** when the Tier B retry fires (`REAP_AGENTIC_CART_LINK_LANE_ENABLED` on and the first answers `409 merchant_not_eligible`) | ≤ 2 s each, so **≤ ~4 s** worst case — still well under the ~13 s edge | falls through to the next lane. **On a timeout the purchase may exist**: the backend poller carries it on to `needs_enrollment` (or, for an enrolled buyer, `awaiting_approval`) — a Reap page nobody was shown — and the backend sweep expires it. Nothing is charged: every charge needs the buyer's approval on that page. A retry of `create_checkout` with the same `idempotency-key` replays that purchase (answering its `reap_` checkout) instead of opening a second one |
| `get_checkout` | one `GET …/purchases/{id}` | ≤ 2 s | unknown id ONLY for 404 `purchase_not_found`; everything else (5xx, transport, timeout, other 4xx, malformed) → `incomplete` + retry hint |

The slow work (resolve + quote, 30–45 s; one quoting step up to ~170 s) is the backend poller's,
off the request path — the edge resets a response whose first byte is later than ~13 s.

**Auth — not a new credential.** The client sends the caller's `X-API-Key` and the forwarded
`X-Agent-User-JWT`, built by `server.js::buildInvokeUpstreamAuthHeaders` exactly as the strict money
ops build them, with `allowInternalFallback: false`: a request with no caller key or no user token is
not sent at all (the internal key would open the purchase under Pivota's own agent id).

**PII.** The buyer's email and address go to the backend in the POST body and nowhere else: not in
the checkout id, not in any response, not in any log line. Log events are
`reap_agentic_lane {op, outcome, code}` and `reap_agentic_backend_call {route, outcome, code,
http_status}` — codes only.

## 7. Arming order — across both repos

**Offer codes and Tier B (pivota-backend #2425 + this door's #2323).** DEPLOY ORDER MATTERS: an older
backend's request model ignores unknown fields, so a code forwarded to a backend without #2425 would be
dropped silently. Therefore: (1) deploy backend #2425 (migration 247 via the schema_guard heal); (2) arm the
backend's `REAP_AGENTIC_CART_LINK_ENABLED` for the Tier B lane; (3) only then set this door's
`REAP_AGENTIC_CART_LINK_LANE_ENABLED=1` — which is also what arms offer codes here (advertised schema,
`dev.ucp.shopping.discount` in the profile, forwarding). Rolling back: turn this door's dial off first.

Each step is runnable; do them in order. The same order is appended to
`docs/merchant-purchasability-gate.md` §6 (steps 10–14).

1. **Backend**, on the `web` service (and the poller on the `worker`). The deployed backend MUST carry
   `fix/reap-merchant-domain-canonical` (pivota-backend #2258 — canonicalises `lowercase + one leading
   www.` on both sides of the merchant-domain lookup) BEFORE this lane is switched on: the gateway sends
   the host as observed (`www.brand.com`), and a backend without #2258 answers `row_not_found` /
   `merchant_not_eligible` for every such row, silently. Check with
   `git -C pivota-backend merge-base --is-ancestor <#2258 merge sha> <deployed sha>`. Then `REAP_AGENTIC_ENABLED=1` with
   Reap **production** credentials, and the `reap_agentic_eligibility` merchant rows for the first
   merchants × markets — pivota-backend `docs/runbooks/reap_agentic_purchase.md`, "Before arming"
   (the `INSERT INTO reap_agentic_eligibility …` block there). If the purchasability gate is
   enforcing, those merchants also need a fresh `purchase` fact (`merchant-purchasability-gate.md`
   §6). Until this step the rail answers 404 `not_available_on_this_rail`, which the lane treats as a
   fall-through.
2. **Pick the products to test and check the door will enter the lane for them.**
   a. List candidate products (run from pivota-backend; the prod DB is VPC-only, so this goes through
      the one-off job):
      ```bash
      bash scripts/ops/run_oneoff_job.sh -c "$(cat <<'PY'
      import asyncio, os, asyncpg
      async def main():
          c = await asyncpg.connect(os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://"))
          rows = await c.fetch("""
            SELECT e.merchant_domain, e.market_country, p.source_domain, p.product_key, p.pivota_signature_id
              FROM reap_agentic_eligibility e
              JOIN catalog_products p
                ON regexp_replace(lower(p.source_domain), '^www[.]', '') = regexp_replace(e.merchant_domain, '^www[.]', '')
             WHERE e.enabled AND e.product_key = '' AND p.platform = 'shopify'
               AND p.suppressed_at IS NULL AND p.pivota_signature_id IS NOT NULL
             ORDER BY e.merchant_domain LIMIT 20""")
          for r in rows: print(dict(r))
      asyncio.run(main())
      PY
      )"
      ```
   b. For each `pivota_signature_id` (`sig_…`) printed, read it the way the door reads it — the
      gateway's own unscoped detail lane — with a Pivota test agent key (`ak_live_…`; the same key
      `scripts/probe_strict_checkout_canary.mjs` reads as `PROBE_KEY`):
      ```bash
      curl -sS https://gateway.pivota.cc/agent/shop/v1/invoke \
        -H "X-API-Key: $PROBE_KEY" -H 'Content-Type: application/json' \
        -d '{"operation":"get_pdp_v2","payload":{"product_ref":{"product_id":"sig_REPLACE_ME"},"include":["product_overview"]}}' \
      | jq '.modules[] | select(.type=="canonical") | .data.pdp_payload.product
            | {product_id, external_redirect_url, purchase_route, product_key, purchase_grain, variants: (.variants | length)}'
      ```
      **Pass** = `external_redirect_url` is an `https://` storefront URL, `purchase_route` is not
      `internal_checkout`, `product_key` is the row's `prod::<merchant>::shopify::<id>`, and
      `variants` is ≤ 1 (or `purchase_grain` is `product`). **Any fail** = the door never enters the
      lane for that product and keeps answering the storefront escalation; do not arm for it.
3. **Check the buyer token reaches the backend.** Minds runs (or hands over one Minds test user JWT
   for) this call, with Minds' own agent API key:
   ```bash
   curl -sS -o /dev/stdout -w '\nHTTP %{http_code}\n' 'https://api.pivota.cc/agent/v2/commerce/reap/purchases?limit=1' \
     -H "X-API-Key: $MINDS_AGENT_API_KEY" -H "X-Agent-User-JWT: $MINDS_TEST_USER_JWT"
   ```
   **Pass** = `HTTP 200` with `{"purchases": [...], "limit": 1}`. `401` means the backend does not
   accept Minds' user token (the gateway verifies it through its own issuer registry; the rail
   verifies it again) — every create would fall through silently; fix before continuing. `404
   not_available_on_this_rail` means step 1 is not done.
4. **Deploy the gateway.** It does **not** deploy on merge: from the pivota-backend repo,
   `infra/gcp/deploy_gateway.sh prod <sha>`, then `npm run deploy:verify:production` here. The UCP
   door itself must be on (`AGENT_CHECKOUT_STRICT=1`, `AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED=1`).
5. **Minds sends `checkout.buyer.consent_version`** (§5.1) — BEFORE the switch. With the switch off
   the door accepts and ignores it (≤ 32 characters), so this ships on Minds' side with no effect.
   Confirm with one of Minds' `create_checkout` request bodies. (With the switch on and no consent,
   the buyer gets today's storefront answer plus a `reap.available_with_consent` message — never a
   refusal — so a missing consent costs the Reap route, not the purchase.)
6. **`REAP_AGENTIC_LANE_ENABLED=1`** on the gateway (an env change on Cloud Run = a new revision).
7. **Verify the first purchase** carried consent — the runbook's census:
   `SELECT consent_version, COUNT(*), MAX(consented_at) FROM reap_agentic_purchases GROUP BY 1;`
   (via `run_oneoff_job.sh` as in step 2a). A `NULL` group after arming is a defect.

**Rolling back**: unset `REAP_AGENTIC_LANE_ENABLED` first — the door returns to the storefront
escalation / kernel answers at once. Purchases already open keep progressing on the backend; with the
gateway switch off, `get_checkout` on a `reap_` id answers as an unknown id, so tell the partner
before switching off mid-purchase.
