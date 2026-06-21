# Pivota MCP Server

> **Read this first — there are two surfaces, and they are not the same.**
>
> | | **Production surface (use this)** | **Legacy local adapter** |
> |---|---|---|
> | What | Remote HTTP `POST /mcp` mounted by the gateway (`src/server.js`) over `mcp-server/src/commerceToolSurface.js` + the Safety Kernel canonical executor | Stdio server `mcp-server/src/server.js` (this package's `npm start`) |
> | Tools | `search_catalog`, `get_product`, `get_alternatives`, `get_offers`, `get_intel`, `create_checkout_session`, `update_checkout_session`, `get_checkout_session`, `complete_checkout_session`, `create_payment_link`, `cancel_checkout_session`, `get_order`, `request_after_sales` | the 5 legacy `pivota_*` tools |
> | Identity | OAuth 2.1 access token = channel credential **and** verified `user_ref` (no API key) | pre-shared `PIVOTA_AGENT_KEY`; **no per-user identity over stdio** |
> | Writes / checkout | supported (kernel-enforced, ownership-scoped) | **refused** — stdio carries no session identity, so every money op fails `USER_AUTH_REQUIRED` |
>
> Native frontier MCP clients (Claude, ChatGPT, Gemini) connect to a remote MCP server **only via OAuth** —
> they never use a pre-shared key. **Point real integrations at the remote `/mcp` surface, not the stdio
> server below.** The stdio adapter is retained for local development and read-only smoke tests.

---

## Production surface — remote `/mcp` (OAuth)

The production HTTP surface is mounted by the **gateway**, not this package's stdio entrypoint. In strict mode,
`POST /mcp` loads `src/remoteMcpAdapter.js` over `src/commerceToolSurface.js` and the Safety Kernel canonical
executor. The host authenticates the request and passes verified session identity as
`sessionContext.user_ref` and `sessionContext.acp_session_id`; **model-supplied identity fields are ignored.**

Frontier clients connect keyless via the OAuth front door (`MCP_OAUTH_ENABLED`): the access token is both the
channel credential and the user identity. The client discovers the authorization server from
`GET /.well-known/oauth-protected-resource`, runs Dynamic Client Registration + consent, gets a token, and can
then call the catalog/checkout tools. See [`docs/agent-checkout/MCP_OAUTH_FRONT_DOOR.md`](../docs/agent-checkout/MCP_OAUTH_FRONT_DOOR.md)
for the exact env wiring and enablement steps.

Relevant gates (fail-closed):

- `AGENT_CHECKOUT_STRICT=1` — required, or `POST /mcp` returns `404`.
- `MCP_OAUTH_ENABLED=1` — keyless OAuth connection; when off, the api-key channel is used instead.
- `complete_checkout_session` (the actual charge) is additionally gated by
  `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED`; with it unset, the charge op returns `OPERATION_NOT_ALLOWED`.
- `create_payment_link` requires `AGENT_CHECKOUT_HOSTED_LINK_ENABLED`.

### What authorizes a charge — two consent models

There are **two** charge-consent flows, for two different surfaces. They are not substitutes. See
[`docs/agent-checkout/CHECKOUT_CONSENT_MODEL.md`](../docs/agent-checkout/CHECKOUT_CONSENT_MODEL.md) for the full
treatment.

- **Model A — `complete_checkout_session` (autonomous, ACP/AP2-native).** The one-shot flow a native frontier
  client drives. Consent **is the verified delegated `payment_authorization`** (ACP delegated token / AP2
  Checkout Mandate), bound to the order's amount/currency/buyer/session before any charge. The confirmation
  token is minted **internally** by the kernel — the caller never supplies one, and **there is no Pivota-side
  human-confirm click on this path** (the buyer already confirmed upstream in ChatGPT / by signing the mandate).
- **Model B — `POST /checkout/confirm` → `submit_payment` (host-rendered card).** For surfaces where Pivota's
  own host renders the checkout card. Consent is a **verified human UI action** (`/checkout/confirm` uses
  `src/confirmationAction.js` + a real HMAC-signed action envelope) that mints a `confirmation_token`, which a
  separate `submit_payment` op then consumes. `/checkout/confirm` is host-only — **do not expose it as a
  generic model-callable MCP tool.**

> **Do not assume `/checkout/confirm` gates `complete_checkout_session` — it does not.** Model A self-mints its
> confirmation from the delegated authorization. Both flows share the kernel's invariants (amount-from-quote,
> single-use confirmation, charge-once, ownership/session binding) and are both gated off-charge until
> `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=1`.

### Connecting Claude / ChatGPT / Gemini

Add the **hosted `/mcp` URL** as a remote MCP server in the client (Claude/ChatGPT connector settings); the
client performs the OAuth handshake automatically. Example resource value:

```
https://pivota-agent-production.up.railway.app/mcp
```

(There is no `node` command and no API key for the production surface — the URL + OAuth is the entire config.)

---

## Legacy local adapter (stdio) — development / read-only only

This package's `npm start` runs the stdio server in `src/server.js`. It exposes five legacy tools:

- `pivota_search`
- `pivota_quote`
- `pivota_create_order`
- `pivota_pay`
- `pivota_orders`

Each call is forwarded to the canonical rail:

```text
POST {PIVOTA_GATEWAY_URL}/agent/shop/v1/invoke
body: { "operation": "...", "payload": { ... } }
```

The adapter never calls `/agent/gateway` or `/api/gateway`.

> **Limitations — read before using.**
> - The MCP SDK dependency is declared but may not be installed; run `npm install` in `mcp-server/` first or
>   `npm start` fails on `import @modelcontextprotocol/sdk`.
> - The stdio transport carries **no OAuth/session identity**, so `resolveSessionIdentity` resolves empty and
>   every write (`pivota_create_order`, `pivota_pay`, after-sales) is refused with `USER_AUTH_REQUIRED`. Only
>   reads work. For checkout, use the remote `/mcp` surface above.

### Configuration (stdio adapter)

Required:

- `PIVOTA_GATEWAY_URL`: Gateway base URL, e.g. `https://gateway.example.com`. If the full
  `/agent/shop/v1/invoke` URL is provided, it is used as-is.
- `PIVOTA_AGENT_KEY`: Agent key used as `Authorization: Bearer ...`.

Optional:

- `PIVOTA_MCP_DEBUG=1`: Prints redacted request/response diagnostics to stderr. Payment bodies, `ap2_state`,
  `confirmation_token`, and token-like fields are redacted.

### Run (stdio adapter)

```sh
npm install   # required once — installs the MCP SDK
npm start
```

Offline guard tests (no network needed):

```sh
npm test
```

### Local dev in Claude Desktop / Claude Code (reads only)

Only for local read-only development against the legacy tools. **Not the production integration path** — for
checkout, connect to the remote `/mcp` URL above instead.

```json
{
  "mcpServers": {
    "pivota-local": {
      "command": "node",
      "args": ["/Users/pengchydan/dev/PIVOTA-Agent/mcp-server/src/server.js"],
      "env": {
        "PIVOTA_GATEWAY_URL": "https://gateway.example.com",
        "PIVOTA_AGENT_KEY": "ak_..."
      }
    }
  }
}
```

## Unwired reference adapters

`mcp-server/unwired/` holds reference scaffolding that **no production code imports** — the ChatGPT Apps-SDK
mappers (`unwired/chatgpt/`) and the Gemini function-calling adapter (`unwired/gemini/`). They are quarantined
so they can't be wired by mistake; the ChatGPT mapper has a known secret-passthrough gap (H2) that must be
fixed before any future wiring. The reference OAuth flow (`auth/oauth.js`, `auth/sessionStore.js`) is similarly
reference-only (production OAuth is the gateway resource server). See [`unwired/README.md`](unwired/README.md)
and [`auth/README.md`](auth/README.md).

## Adapter Safety Behavior (stdio adapter)

- Rejects a tool call when `operation` is not allowed for that tool.
- Generates `payload.idempotency_key` for `create_order`, `submit_payment`, and `request_after_sales` when omitted, then sends the same value as the `Idempotency-Key` header.
- Refuses `submit_payment` unless `confirmation_token` and `payment.order_id` are present.
- Treats `payment.expected_amount` only as a verification echo and forwards it to the backend; the adapter does not derive charge amounts from it.
- Returns backend responses as JSON text so `requires_action` fields such as `redirect_url`, `qr_code`, and `instructions` are surfaced verbatim.
