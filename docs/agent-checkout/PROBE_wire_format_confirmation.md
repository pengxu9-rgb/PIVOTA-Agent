# Wire-format confirmation probe — money units (for the backend team)

**Goal:** empirically confirm, against the LIVE backend, the money-unit conventions the Safety Kernel
depends on before we enable kernel-mediated `submit_payment`. This is a staged probe: first run quote and
order with no charge, then run payment only as a manual Stripe test-mode canary.

**Current live evidence, 2026-06-06:** GitHub Actions run `27059885995` confirmed production v2 and
`create_order` as **major-unit decimal strings** with currency present. Keep production `submit_payment`
disabled until Phase 3 proves PSP forwarding, replay, refund, webhook/status sync, and redaction.

---

## What the repo already tells us (so this is a confirmation, not a discovery)

The Node gateway's own integration tests encode the historical mock contract. The live backend must still
be probed because its deployed wire shape can differ from mocks:

| Field | Endpoint | Unit per repo contract tests | Evidence |
|---|---|---|---|
| `preview_quote` → `pricing.total` | `/agent/v2/quotes/preview` | **major-unit string** `"95.00"` | `tests/integration/preview_quote.test.js:22-27` |
| `create_order` → `order.amounts.total` | `/agent/v2/orders` | Live 2026-06-06: **major-unit decimal string**; older mocks used minor-unit int `1000` | `27059885995`; historical mock `tests/integration/create_order_quote_id_passthrough.test.js:34,74` |
| `submit_payment` → `expected_amount` on the wire | `/agent/v2/payments/checkout-sessions` | **minor-unit int** `2900` (for €29.00), required + quote-bound | `tests/integration/submit_payment_contract.test.js:35,68` |

The gateway must parse the live `create_order` total according to the probe verdict, then separately verify
the payment wire and PSP dashboard ground truth before pay is enabled.

> Note: there is also an older Python path (`routes/agent_shop_gateway.py`, `/agent/v1/payments`) where
> `expected_amount` is a major-unit float and **explicitly ignored by the charge layer** ("仅用于前端自检 …
> Agent Payments 会根据订单记录金额", lines 1956-1957). If THAT is what's live, the answer changes — which is
> exactly why we need you to confirm which backend version serves production.

---

## Safety rules for running the probe
- **Prefer Stripe TEST mode** (test API keys + card `4242 4242 4242 4242`, any future expiry, any CVC).
  Zero real money, no minimum, full dashboard visibility. This answers everything.
- If you must run LIVE: **Stripe's live minimum is ~$0.50 USD** — a 1-cent live charge is rejected. Use a
  ~$0.50 item, then **refund immediately**. (A 1-cent figure still works conceptually; just respect the min.)
- Never paste API keys, card numbers, or `client_secret` values into shared logs/tickets.
- Use a throwaway test product if possible; otherwise the cheapest real item + refund.

---

## The probe (run against the LIVE shop gateway entrypoint)

Replace `<<BASE>>` with the deployed gateway base URL and `<<KEY>>` with a valid agent/session credential.
All four calls go to `POST <<BASE>>/agent/shop/v1/invoke` with `{ operation, payload }`.

### Step 1 — find a cheap product (get a real `product_id` + `merchant_id`)
```bash
curl -s -X POST "<<BASE>>/agent/shop/v1/invoke" \
  -H "Authorization: Bearer <<KEY>>" -H "Content-Type: application/json" \
  -d '{"operation":"find_products","payload":{"search":{"query":"<<cheap item>>"}}}' | jq '.products[0] | {merchant_id, product_id, price, currency}'
```
**Record:** `MERCHANT_ID`, `PRODUCT_ID`, the displayed `PRICE` (e.g. `0.50`) and `CURRENCY`.

### Step 2 — preview_quote  →  read the quote pricing unit
```bash
curl -s -X POST "<<BASE>>/agent/shop/v1/invoke" \
  -H "Authorization: Bearer <<KEY>>" -H "Content-Type: application/json" \
  -d '{"operation":"preview_quote","payload":{"quote":{"merchant_id":"<<MERCHANT_ID>>","items":[{"product_id":"<<PRODUCT_ID>>","quantity":1}]}}}' \
  | jq '{quote_id, currency, pricing}'
```
**Record `Q1`:** `quote_id`, and `pricing.total`.
**Check:** is `pricing.total` a **major-unit string** like `"0.50"` (expected) or a minor-unit int `50`?

### Step 3 — create_order  →  read the order amount unit  (THE one our cross-check depends on)
```bash
curl -s -X POST "<<BASE>>/agent/shop/v1/invoke" \
  -H "Authorization: Bearer <<KEY>>" -H "Content-Type: application/json" \
  -d '{"operation":"create_order","payload":{"order":{"quote_id":"<<Q1.quote_id>>","customer_email":"probe@pivota.test","items":[{"merchant_id":"<<MERCHANT_ID>>","product_id":"<<PRODUCT_ID>>","product_title":"probe","quantity":1,"unit_price":<<PRICE>>}],"shipping_address":{"name":"Probe","address_line1":"1 Test St","city":"SF","country":"US","postal_code":"94102"}}}}' \
  | jq '{order_id: .order.order_id, amounts: .order.amounts}'
```
**Record `O1`:** `order.order_id`, `order.amounts.total`, `order.amounts.currency`.
**THE KEY CHECK — for a $0.50 order:**
- `amounts.total == 50` → **MINOR units**.
- `amounts.total == 0.5` or `"0.50"` → **MAJOR units**. This is the current production evidence from
  2026-06-06.
- `amounts.currency` present and uppercase `"USD"`? (we require currency to be present; lowercase is fine)

### Step 4 — submit_payment  →  observe the wire amount + the async contract
```bash
curl -s -X POST "<<BASE>>/agent/shop/v1/invoke" \
  -H "Authorization: Bearer <<KEY>>" -H "Content-Type: application/json" \
  -d '{"operation":"submit_payment","payload":{"payment":{"order_id":"<<O1.order_id>>","quote_id":"<<Q1.quote_id>>","expected_amount":<<MINOR>>,"currency":"<<CURRENCY>>","payment_method_hint":"card"}}}' \
  | jq '{status, payment_status, confirmation_owner, requires_client_confirmation, payment_intent_id, redirect_url, client_secret: (.client_secret|type)}'
```
where `<<MINOR>>` = the intended amount in **minor units** (e.g. `50` for $0.50).
**Record `P1`:** `payment_status`, `confirmation_owner`, `requires_client_confirmation`,
`payment_intent_id`/`checkout_session_id`. (Then complete the client confirmation if `requires_action`,
using the test card, to drive a real charge.)

### Step 5 — Stripe dashboard ground truth (the authoritative answer)
Open the Stripe dashboard (test or live, matching what you ran) → Payments → find the PaymentIntent from
Step 4.
**Record `S1`:** the **Amount** Stripe actually charged, and its currency.
**Check:** does the Stripe amount equal the intended `$0.50` (NOT `$50.00`, NOT `$0.005`)?

---

## Results to send back (fill in)

```
Which backend serves prod?   v2 (/agent/v2/*, Node)  |  v1 (/agent/v1/*, Python)  |  other: ______
Step2  pricing.total      = __________   (string "0.50" / int 50 / other)
Step3  amounts.total      = __________   (50 = minor / 0.50 or "0.50" = major / other)
Step3  amounts.currency   = __________   (present? case?)
Step4  payment_status     = __________   confirmation_owner = ________  requires_client_confirmation = ____
Step4  the wire field carrying the amount to the PSP, and its unit = __________
Step5  Stripe charged     = __________   currency = ______   (== intended $0.50 ? yes/no)
Refunded/voided?           = yes / n/a (test mode)
```

## What each outcome means for us
- **All minor (Step3 = 50, Stripe = $0.50):** keep minor-unit order cross-checking.
- **`amounts.total` is major (0.50 or "0.50"):** parse backend order amount as major before comparing
  against the quote-derived charge amount. This is the current 2026-06-06 live result.
- **`expected_amount` is required & used as the charge basis (v2):** good — matches our minor forwarding.
- **`expected_amount` is ignored / charge is purely order-derived (v1):** also fine for safety (charge can't
  be steered by the agent), but confirms we should treat our echo as advisory only.
- **Currency absent on `create_order`:** we currently fail-close on that (can't verify the charge currency);
  if the live backend legitimately omits it, tell us and we'll relax to "verify when present."

## Two more confirmations while you're in there (no extra calls needed)
1. **Per-order PSP idempotency:** does the charge to Stripe carry an idempotency key derived from the
   ORDER (so a retried submit can't create a second PaymentIntent for the same order)? This closes our last
   residual double-charge risk (we can't close it from the gateway alone).
2. **Webhook:** which PSP/back-end webhook fires on async completion, what's its signing secret header, and
   what's the order/payment-id correlation field? We need this to wire the completion webhook + reconcile.
