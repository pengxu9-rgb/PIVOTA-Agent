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

The tests import only local adapter modules; they do not require network access.

## Remote MCP Host

The production HTTP surface is mounted by the gateway, not the stdio entrypoint. In strict mode,
`POST /mcp` loads `src/remoteMcpAdapter.js` over `src/commerceToolSurface.js` and the Safety Kernel
canonical executor. The host must authenticate the request and pass verified session identity as
`sessionContext.user_ref` and `sessionContext.acp_session_id`; model-supplied identity fields are ignored.

The quote confirmation button is a separate host-only action at `POST /checkout/confirm`. It uses
`src/confirmationAction.js` and must be called only after a verified UI user action. It mints a
`confirmation_token` through the kernel for the verified buyer/session and order. Do not expose this as a
generic model-callable MCP tool.

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
