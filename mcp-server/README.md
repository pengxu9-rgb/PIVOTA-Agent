# Pivota MCP Server

Stdio MCP adapter for the Pivota Shopping Agent tool set. It exposes five tools:

- `pivota_search`
- `pivota_quote`
- `pivota_create_order`
- `pivota_pay`
- `pivota_orders`

Every tool call is forwarded to the canonical rail:

```text
POST {PIVOTA_GATEWAY_URL}/agent/shop/v1/invoke
body: { "operation": "...", "payload": { ... } }
```

The adapter never calls `/agent/gateway` or `/api/gateway`.

## Configuration

Required environment variables:

- `PIVOTA_GATEWAY_URL`: Gateway base URL, for example `https://gateway.example.com`. If the full `/agent/shop/v1/invoke` URL is provided, it is used as-is.
- `PIVOTA_AGENT_KEY`: Agent key used as `Authorization: Bearer ...`.

Optional:

- `PIVOTA_MCP_DEBUG=1`: Prints redacted request/response diagnostics to stderr. Payment bodies, `ap2_state`, `confirmation_token`, and token-like fields are redacted.

## Run

```sh
npm start
```

Offline guard tests:

```sh
npm test
```

The tests only import `src/safety.js` and `src/operationMap.js`; they do not require the MCP SDK or network access.

## Claude Desktop

Add a server entry to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "pivota": {
      "command": "node",
      "args": [
        "/Users/pengchydan/dev/PIVOTA-Agent/mcp-server/src/server.js"
      ],
      "env": {
        "PIVOTA_GATEWAY_URL": "https://gateway.example.com",
        "PIVOTA_AGENT_KEY": "ak_..."
      }
    }
  }
}
```

## Claude Code

Use the same command, args, and environment values in your Claude Code MCP server configuration. Example JSON shape:

```json
{
  "pivota": {
    "command": "node",
    "args": [
      "/Users/pengchydan/dev/PIVOTA-Agent/mcp-server/src/server.js"
    ],
    "env": {
      "PIVOTA_GATEWAY_URL": "https://gateway.example.com",
      "PIVOTA_AGENT_KEY": "ak_..."
    }
  }
}
```

## Adapter Safety Behavior

- Rejects a tool call when `operation` is not allowed for that tool.
- Generates `payload.idempotency_key` for `create_order`, `submit_payment`, and `request_after_sales` when omitted, then sends the same value as the `Idempotency-Key` header.
- Refuses `submit_payment` unless `confirmation_token` and `payment.order_id` are present.
- Treats `payment.expected_amount` only as a verification echo and forwards it to the backend; the adapter does not derive charge amounts from it.
- Returns backend responses as JSON text so `requires_action` fields such as `redirect_url`, `qr_code`, and `instructions` are surfaced verbatim.
