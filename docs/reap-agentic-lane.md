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
description mentions the Reap route.

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
  expiry.
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

`meta["idempotency-key"]` is required as on every state-changing call. **Retry with the same key**:
the backend key is derived from it (hashed, namespaced — never random, never the raw key), so a
retried `create_checkout` replays the same purchase instead of opening a second one.

### 5.2 What comes back

`create_checkout` → `status: "incomplete"`, `id: "reap_rp_<24 hex>.<opaque>"`. Treat the id as
opaque; it carries the backend purchase id and a snapshot of the line (product id, quantity,
currency, unit price) so a failed read can still answer a well-formed checkout. It carries **no
buyer data**.

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
  `reap.approval_deadline` message. Show the buyer the link at once, and read a `canceled` with
  `Reason: approval_window_lapsed` as "the buyer did not approve in time — create a new checkout".
- **Done**: `completed` carries `code: "reap.order_reference"` whose `content` is the merchant's
  order reference, verbatim.
- **Not done**: `canceled` carries `reap.purchase_refused` / `reap.purchase_failed` /
  `reap.purchase_expired` with the reason when there is a safe one. Create a new checkout to try
  again.

### 5.3 Refusal codes

| where | code / reason | meaning | what to do |
|---|---|---|---|
| `create_checkout` | `QUOTE_REQUIRED` / `ucp_consent_version_invalid` | `consent_version` is not a string, or longer than 32 characters | fix the value |
| `update_checkout` | `OPERATION_NOT_ALLOWED` / `ucp_reap_update_refused` | a Reap checkout cannot be changed | create a new checkout |
| `complete_checkout` | `OPERATION_NOT_ALLOWED` / `ucp_reap_complete_refused` | completion is on Reap's page | poll `get_checkout`, open `continue_url` |
| `get_checkout` | `QUOTE_NOT_FOUND` | unknown id (or another buyer's) | — |

There is **no Reap refusal on create.** A backend refusal of any kind (`consent_required`,
`merchant_not_eligible`, `row_not_found`, `row_unpriced`, `merchant_not_purchasable`,
`not_available_on_this_rail`, `idempotency_conflict`, `currency_unsupported`, …) is **not** surfaced as
an error. When the buyer block was short, the storefront answer carries one `info` message with
`code: "reap.available_with_consent"` — read it as "resend with `consent_version`, a last name and a
phone if the user wants the Reap route". Otherwise the door falls through to the storefront escalation
(or the kernel path) and logs the code.

## 6. Budgets and failure modes

| call | backend requests | budget | on failure |
|---|---|---|---|
| `create_checkout` | one `POST /agent/v2/commerce/reap/purchases` | ≤ 2 s | falls through to the next lane. **On a timeout the purchase may exist**: the backend poller carries it on to `needs_enrollment` (or, for an enrolled buyer, `awaiting_approval`) — a Reap page nobody was shown — and the backend sweep expires it. Nothing is charged: every charge needs the buyer's approval on that page. A retry of `create_checkout` with the same `idempotency-key` replays that purchase (answering its `reap_` checkout) instead of opening a second one |
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
