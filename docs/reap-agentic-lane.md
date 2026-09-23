# The Reap agentic lane of the UCP checkout door

`mcp-server/src/ucpReapAgenticLane.js` (the lane), `src/services/reapAgenticPurchaseClient.js` (the
backend client), `mcp-server/src/commerceToolSurface.js` (where the lane sits in the door),
`tests/reap_agentic_lane.node.test.cjs` and `mcp-server/test/ucpReapAgenticLane.test.js` (the pins).

The backend half is pivota-backend's `docs/reap_agentic_routes.md` (the wire, byte-exact) and
`docs/runbooks/reap_agentic_purchase.md` (the state machine, the poller, the dials). This page is the
door, and the contract for the buyer agent (Minds).

**It ships dark.** `REAP_AGENTIC_LANE_ENABLED` is unset by default and the backend rail
(`REAP_AGENTIC_ENABLED`) is off in production. With the gateway switch off the UCP door is
byte-identical to the door without this lane and makes no backend call (pinned by snapshot).

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
  an `X-Agent-User-JWT` (the backend rail's two credentials — an MCP-OAuth caller has neither, so
  it never enters the lane);
- the cart has **exactly one line**, quantity 1–10;
- the row is **not native** (§2 step 1), carries our catalog `product_key`, is a **Shopify** row
  (explicit `platform`, else the `prod::<merchant>::shopify::<id>` key), has **at most one real
  variant** (a UCP line item cannot name a variant, and the backend refuses a multi-variant product
  without one), is priced, and has a merchant domain (an explicit field, else the storefront host;
  never a Pivota host);
- the merchant-purchasability gate did not decline it — consulted **exactly as the escalation lane
  consults it**: same switch (`MERCHANT_PURCHASABILITY_GATE_ENABLED`), same singleton client, same
  fail-open rule, same market source (`checkout.context.address_country`), same budget clamp;
- then **consent** (§5.1 — the one refusal on create), a buyer email (attested wins), and a
  complete Reap address (first and last name, phone, street, city, country).

The backend is authoritative for everything it checks again (eligibility allowlist per market,
Shopify, the price from our catalog and the merchant's own offer, the market's currency, the
purchasability fact). Its refusal falls through.

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

- A buyer-action state whose page is absent, expired, not on Reap's hosts (`prava.space`,
  `reap.global`; https; default port; no userinfo), or would not survive the money filter intact is
  answered `incomplete` with `messages[].code = "reap.hosted_page_not_ready"` — never
  `requires_escalation` without a link, and **a link is never forwarded for any other state**.
- Backend **unreachable / 5xx / timeout / malformed** body → `incomplete` with
  `reap.purchase_state_unavailable` and a retry hint. Never a terminal status on a transport error.
- Backend **404** (unknown, another buyer's purchase, or the rail dark) → exactly the answer any
  unknown checkout id gets (`QUOTE_NOT_FOUND`), because the kernel path gives it.

Every lane answer is the same UCP checkout object the escalation lane builds
(`buildUcpCheckoutEnvelope`): `ucp.payment_handlers: {}`, one `li_1` line item, one `subtotal` and one
`total`, the legal `links`, `expires_at`. Amounts are ISO minor units. The subtotal is at Pivota's
catalog price; the total is the quoted total once the merchant has priced it and the charged total on
`completed`.

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

1. **`checkout.buyer.consent_version`** — NEW, optional on the wire, **required for this lane**. The
   version tag of the Pivota terms the buyer accepted for a purchase fulfilled through Reap: 1–32
   printable ASCII characters. Show the buyer the terms first. There was no consent field on the
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
  A link is valid until the checkout's `expires_at`; do not reuse one after it.
- **Done**: `completed` carries `code: "reap.order_reference"` whose `content` is the merchant's
  order reference, verbatim.
- **Not done**: `canceled` carries `reap.purchase_refused` / `reap.purchase_failed` /
  `reap.purchase_expired` with the reason when there is a safe one. Create a new checkout to try
  again.

### 5.3 Refusal codes

| where | code / reason | meaning | what to do |
|---|---|---|---|
| `create_checkout` | `QUOTE_REQUIRED` / `reap_consent_required` (`detail.required_fields: ["checkout.buyer.consent_version"]`) | the item can be bought through Reap, but no usable consent tag was sent | show the buyer the terms; resend with the tag |
| `update_checkout` | `OPERATION_NOT_ALLOWED` / `ucp_reap_update_refused` | a Reap checkout cannot be changed | create a new checkout |
| `complete_checkout` | `OPERATION_NOT_ALLOWED` / `ucp_reap_complete_refused` | completion is on Reap's page | poll `get_checkout`, open `continue_url` |
| `get_checkout` | `QUOTE_NOT_FOUND` | unknown id (or another buyer's) | — |

Backend refusals on create (`merchant_not_eligible`, `row_not_found`, `row_unpriced`,
`merchant_not_purchasable`, `not_available_on_this_rail`, `idempotency_conflict`, …) are **not**
surfaced: the door falls through to the storefront escalation (or the kernel path) and logs the code.

## 6. Budgets and failure modes

| call | backend requests | budget | on failure |
|---|---|---|---|
| `create_checkout` | one `POST /agent/v2/commerce/reap/purchases` | ≤ 2 s | falls through to the next lane; a timed-out purchase may exist, sits at `resolving` with no card and expires on the backend clock, and a retry with the same idempotency-key replays it |
| `get_checkout` | one `GET …/purchases/{id}` | ≤ 2 s | `incomplete` + retry hint (5xx, transport, timeout, malformed); unknown id (4xx) |

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

1. **Backend**: `REAP_AGENTIC_ENABLED=1` with Reap **production** credentials configured (the rail
   answers 404 `not_available_on_this_rail` while either is missing — which this lane already treats
   as "fall through"), and the `reap_agentic_eligibility` rows for the first merchants × markets
   (runbook "Before arming" §2). If the purchasability gate is enforcing, those merchants need a
   fresh positive fact (`docs/merchant-purchasability-gate.md` §6).
2. **Verify on arming day** that `get_product` for an eligible row serves an `external_redirect_url`
   (so the door classifies it non-native), a `product_key` of the form
   `prod::<merchant>::shopify::<id>`, and a single variant — otherwise the lane is never entered for
   it and the door keeps answering the storefront escalation.
3. **Check the buyer token reaches the backend.** One `GET /agent/v2/commerce/reap/purchases`
   with Minds' API key and a real Minds `X-Agent-User-JWT` must answer `200` (an empty list), not
   `401`: the gateway verifies that token through its own issuer registry, but the rail verifies it
   again on the backend, and a `401` there makes every create fall through silently.
4. **Deploy the gateway.** It does **not** deploy on merge:
   `infra/gcp/deploy_gateway.sh prod <sha>` (run from the pivota-backend repo), then
   `npm run deploy:verify:production`.
5. **`REAP_AGENTIC_LANE_ENABLED=1`** on the gateway (an env change on Cloud Run = a new revision).
   The UCP door itself must be on (`AGENT_CHECKOUT_STRICT=1`,
   `AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED=1`).
6. **Minds** sends `checkout.buyer.consent_version` (§5.1). Until it does, every eligible create is
   refused `reap_consent_required` — which looks like a broken rail, so confirm it first.

**Rolling back**: unset `REAP_AGENTIC_LANE_ENABLED` first — the door returns to the storefront
escalation / kernel answers at once. Purchases already open keep progressing on the backend; with the
gateway switch off, `get_checkout` on a `reap_` id answers as an unknown id, so tell the partner
before switching off mid-purchase.
