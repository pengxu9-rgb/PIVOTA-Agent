# `start_purchase`: buying through a payment rail on the native MCP door

`start_purchase` opens one purchase for the signed-in buyer through the backend's rail-neutral create,
`POST /agent/v2/commerce/purchases` (pivota-backend `routes/agent_commerce_purchases.py`). The backend picks
the payment rail (Reap, or the A2A token rail) and the rail's own checkout agent places the order on the
merchant's checkout with the buyer's own card. Pivota never holds or moves the buyer's money and never sees
card data.

Code: `mcp-server/src/orchestratedPurchaseTool.js`, `src/services/agentPurchaseCreateClient.js`, wired into
`mcp-server/src/commerceToolSurface.js` and `src/server.js`.

## Switches (all default off)

| Switch | What it does |
|---|---|
| `ORCHESTRATED_PURCHASE_TOOL_ENABLED` (gateway, read per call) | Lists and serves `start_purchase` on the native MCP door (`/mcp`). Off: not listed, and a call is an unknown tool. The UCP door never lists it. |
| `AGENT_PURCHASE_ORDER_READ_ENABLED` (gateway) | Lets `get_order` read the purchase back. **Required**: `start_purchase` stays dark unless this is on too, because a purchase it opened must be one the agent can poll. |
| `PAYMENT_ORCHESTRATOR_ENABLED`, `AGENT_PURCHASE_LEDGER_ENABLED` (backend) | The backend's create and read doors. Off: the create answers 404, which this tool reports as an unknown outcome. |
| Backend rail dials (`A2A_RAIL_*`, `REAP_AGENTIC_*`) | Which rail may take the purchase; see the backend router. |

## The call

Required: `idempotency_key`, `merchant_id`, `product_id`, `quantity` (1–10), `expected_unit_price_minor` and
`expected_currency` (the price SHOWN to the buyer), `consent_version` (the terms the buyer accepted),
`shipping_address` (`name`, `phone`, `address_line1`, `city`, `country`; optional `address_line2`, `state`,
`postal_code`). Optional: `variant_id` (required when the product has more than one variant),
`customer_email` (ignored when the verified credential attests one), `payment_preference.rail`.

It needs the verified buyer and session (as every user-scoped op), and the caller's agent API key plus the
buyer's `X-Agent-User-JWT` for the backend (the internal key is never substituted).

What the tool derives itself, never from the caller: the storefront host, the catalog key and the variant
key, from OUR catalog row (the Reap lane's cart-link row rules, `resolveCartLinkPurchaseRow`). The shown price
is sent as given and judged by the BACKEND, after its idempotency lookup: a retry of an unknown outcome
replays the original purchase even if our price moved in between, and only a new attempt is refused
(`PRICE_CHANGED`). The tool deliberately does not refuse a price itself: that would answer the retry
"price changed" without asking, and an agent would re-quote and buy twice.

## The answer

Exactly the shape `get_order` returns for a purchase (`order_id` = the `pp_` id, `status`, `rail`,
`next_action.action_url`, …), so the agent polls with `get_order`. When `next_action.action_url` is present, the
buyer must open it (add a card, or approve the purchase). If the purchase was opened but could not be read back
yet, the answer carries the rail id with `status: "accepted"` and `read_pending: true`; poll it with get_order.

## Errors

| Error | Meaning |
|---|---|
| `OPERATION_NOT_ALLOWED` / `purchase_not_available` + `refusal_code` | Our catalog row cannot be bought this way (e.g. `variant_required`, `variant_unresolvable`, `native_row`). Nothing was sent for THIS call; its `recovery` warns that if it retries an earlier call whose outcome was unknown, that purchase may still exist. |
| `PRICE_CHANGED` / `purchase_price_changed` | The backend: the price is no longer the one shown, for a new attempt. |
| `OPERATION_NOT_ALLOWED` / `purchase_refused` + `refusal_code` | The backend definitely opened nothing (e.g. `merchant_not_eligible`, `consent_required`, `amount_over_limit`). |
| `OPERATION_NOT_ALLOWED` / `purchase_idempotency_conflict` | This key already opened a purchase, for details that no longer match the call. The details this tool sends include facts it fills from OUR catalog row, so a retry of an unknown outcome conflicts when that row changed in between: the purchase may exist. When the backend names that purchase, `detail.purchase_id` carries it (the caller's own; read it with get_order). Check it before starting another; a new key only for a different purchase. (Deliberately not the kernel's IDEMPOTENCY_CONFLICT, whose wording says to start fresh.) |
| `OPERATION_NOT_ALLOWED` / `purchase_unavailable` + `refusal_code` | The backend door is dark (`not_available`) or an explicit rail choice cannot be honoured (`not_available_on_this_rail`). Repeating the call cannot help; an earlier unknown-outcome purchase may still exist. |
| `OPERATION_NOT_ALLOWED` / `agent_api_key_required` | This door has no agent key + buyer token to send. |
| `OPERATION_NOT_ALLOWED` / `caller_credentials_rejected` | The backend refused the caller's credentials (401), before any write. |
| `CHECKOUT_OUTCOME_UNKNOWN` / `purchase_outcome_unknown` | Anything else (timeout, 5xx, a malformed answer). The purchase MAY exist: retry the exact call with the same `idempotency_key` (it replays the original on its original rail); never start another. |

The tool's backend idempotency keys are namespaced (`mcp-purchase-v1-…`), so a key used on another tool or door
is a different attempt. For the same reason the backend's `409 opened_on_another_rail` (the Reap route's answer
for a key that opened a purchase on another rail) cannot reach the UCP Reap lane through this tool; if it ever
did, the Reap client reads it as an unknown outcome, which never opens a second purchase.

Parity note: a Shopify row goes as `item_source: "cart_link"` (the backend's cart-link lane accepts Shopify and
external-seed rows), while the UCP Reap lane sends a Shopify row through Reap's variant lane by default.
