# `get_order` for rail purchases (`pp_…` / `rp_…`)

`get_order` answers two kinds of id:

- **Kernel orders** minted by this gateway: unchanged, ownership-gated by `kernel._requireOrder`.
- **Rail purchases**: a backend rail-neutral id `pp_<24 hex>`, or a Reap id `rp_<24 hex>`. These are answered
  by one owner-scoped backend read, `GET /agent/v2/commerce/purchases/{id}` (pivota-backend
  `docs/agent_purchases_routes.md`), made with the CALLER's `X-API-Key` and `X-Agent-User-JWT`. The
  internal key is never used.

Code: `src/services/agentPurchaseReadClient.js` (the read), `safety-kernel/src/protocol/canonicalExecutor.js`
(`get_order`, `agentPurchaseOrder`), `src/server.js` (`buildReadAgentPurchase`: dial and identity check).

## Result

The backend's unified purchase body, plus:

- `order_id`: always the `pp_` id, even when the caller asked with an `rp_` id.
- `status`: **the unified purchase state**, not a kernel order status. The values are `routing`,
  `needs_payment_method`, `locking`, `awaiting_buyer_authorization`, `placing`, `completed`, `failed`,
  `refused`, `expired`. A completed rail purchase is `completed`, never `paid`. `state` carries the same
  word.
- `source: 'agent_purchase'`.
- `next_action.action_url`: the rail-hosted page the buyer must open (card binding or approval), when there
  is one. It is preserved verbatim through the result sanitizer, as checkout handoffs are.

## Errors

| Situation | Error |
|---|---|
| Not this buyer's, or does not exist | `QUOTE_NOT_FOUND` / `order_not_found` (same as an unknown kernel order) |
| Backend unreachable, dial off, timeout, unmapped state | `MERCHANT_UNAVAILABLE` (retriable). Says nothing about the purchase; never start a second purchase on it. |
| The door has no agent API key (MCP OAuth, checkout token) | `OPERATION_NOT_ALLOWED` / `agent_api_key_required` |
| The request's agent differs from the session's | `STATE_LINKAGE_MISMATCH` / `agent_mismatch` |

## Rollout

1. Merge and deploy the backend ledger (pivota-backend#2552). Set `AGENT_PURCHASE_LEDGER_ENABLED=1` there
   and run `scripts/backfill_agent_purchases.py`.
2. Deploy this gateway (it does not deploy on merge).
3. Set `AGENT_PURCHASE_ORDER_READ_ENABLED=1` on the gateway. The dial is read per call.

To roll back, unset the gateway dial: `pp_`/`rp_` ids then take the kernel path again and fail closed with
`QUOTE_NOT_FOUND`.
