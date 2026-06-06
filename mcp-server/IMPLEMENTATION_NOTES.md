# Implementation Notes

## Files Created

- `package.json`: ESM package metadata, Node 18+ engine, `start` and `test` scripts, MCP SDK dependency declaration.
- `src/operationMap.js`: The five MCP tool definitions and operation allow-lists from `tool-schema.v2.json`.
- `src/safety.js`: Adapter-side guard functions for operation allow-listing, write idempotency, quote/order/payment shape checks, and redaction.
- `src/invokeClient.js`: Thin canonical invoke client for `POST /agent/shop/v1/invoke` with auth and `Idempotency-Key` injection.
- `src/server.js`: Stdio MCP server that lists the five tools and dispatches tool calls through the safety layer and invoke client.
- `test/safety.test.js`: Offline `node:test` coverage for guard behavior and operation maps.
- `README.md`: Environment, run, test, and Claude Desktop / Claude Code configuration notes.

## Safety Invariant Support

### INV-1 Quote-first

Adapter support:
- `pivota_create_order` only allows `operation = "create_order"`.
- `src/safety.js` rejects `create_order` unless `payload.order.quote_id` is present.
- The tool schema exposed by `src/operationMap.js` also marks `order.quote_id` as required.

Kernel enforcement still required:
- The adapter cannot verify that the quote exists, is unexpired, belongs to the current `user_ref`, or matches the inbound ACP session. The Safety Kernel must enforce those checks.

### INV-2 Amount-from-quote

Adapter support:
- `pivota_pay` only allows `operation = "submit_payment"`.
- The adapter does not compute, alter, or trust a charge amount from the model.
- `payment.expected_amount` is forwarded only as part of the canonical payload.

Kernel enforcement still required:
- The Safety Kernel must read the authoritative amount and currency from the locked quote/order snapshot and hard-fail mismatches with `PRICE_CHANGED`.

### INV-3 Explicit confirmation

Adapter support:
- `src/safety.js` rejects `submit_payment` unless `payload.confirmation_token` is present.
- The adapter never mints or fabricates confirmation tokens.

Kernel enforcement still required:
- The Safety Kernel must mint, bind, expire, and single-use-check confirmation tokens against `(order_id, user_ref, amount)`.

### INV-4 Idempotency

Adapter support:
- `src/safety.js` requires an idempotency key for `create_order`, `submit_payment`, and `request_after_sales`.
- If the caller omits the key, the adapter generates a UUID with `crypto.randomUUID()`.
- `src/invokeClient.js` sends the same key in `payload.idempotency_key` and the `Idempotency-Key` header.

Kernel enforcement still required:
- The Safety Kernel must own the idempotency ledger, return first results on replay, and reject body-mismatch reuse with `IDEMPOTENCY_CONFLICT`.

### INV-5 Price/tax/shipping and merchant-of-record lock

Adapter support:
- `pivota_quote` exposes `preview_quote` as the quote-first path.
- `create_order` requires a `quote_id`, and the adapter does not accept model-supplied line-item prices on the order path.

Kernel enforcement still required:
- The Safety Kernel must snapshot and lock line items, tax, shipping, currency, and merchant-of-record, then propagate them to order, receipt, payment, and refund routing.

## Other Contract Support

- Operation/tool mismatches are rejected before forwarding.
- The invoke client only builds `/agent/shop/v1/invoke` endpoints and rejects configured URLs containing `/agent/gateway` or `/api/gateway`.
- Debug logging uses `redact()` so `ap2_state`, full `payment` bodies, `confirmation_token`, and token-like fields are not logged.
- Backend response bodies are returned directly as JSON text. `requires_action` fields such as `redirect_url`, `qr_code`, and `instructions` are not fabricated or transformed.

## Assumptions

- `PIVOTA_GATEWAY_URL` is normally a gateway base URL. If it already ends with `/agent/shop/v1/invoke`, the adapter uses it directly.
- Any `user_ref` required by the kernel is supplied by the host/backend auth context or included in the operation payload by an upstream integration layer. The published tool schema does not define a top-level `user_ref` field.
- Full JSON Schema validation is expected from the MCP host/model tooling and backend kernel. The adapter implements the explicit safety guards required by this task rather than duplicating every schema constraint.
