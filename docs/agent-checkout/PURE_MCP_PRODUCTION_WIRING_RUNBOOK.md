# Pure MCP Production Wiring Runbook

Status: operator-ready contract, no secrets embedded.

This is the production contract for letting Claude, ChatGPT MCP/App surfaces, Gemini host apps, or other agents use Pivota through `/mcp` without giving the model a commerce API key.

## 1. Boundary

- External agents connect to `POST /mcp`.
- The model calls MCP tools only. It does not call `/agent/shop/v1/invoke` directly for checkout.
- The MCP channel credential authenticates the platform/connector.
- Spending authority comes from a verified per-user token, not from the model and not from `X-Buyer-Ref`.
- Payment authority comes from a signed delegated payment grant bound to the exact checkout session, merchant, amount, currency, user, and expiry.
- REST invoke remains the private executor rail behind MCP/ACP/UCP adapters.

## 2. Production Flags

Keep production fail-closed until the pure-MCP paid canary is ready:

```text
AGENT_CHECKOUT_STRICT=1
AGENT_CHECKOUT_ALLOW_TEST_IDENTITY=0
AGENT_CHECKOUT_TEST_IDENTITY_WINDOW=0
AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=0
AGENT_CHECKOUT_MCP_ENABLE_AP2_MANDATE=0
```

`AGENT_CHECKOUT_MCP_ENABLE_AP2_MANDATE` must stay off until the reviewed AP2 checkout-hash verifier is wired. ACP/UCP signed grants are supported through `PAYMENT_ISSUERS_JSON`.

## 3. Identity Issuer Env

Set exactly one of:

```text
IDENTITY_ISSUERS_JSON
AGENT_CHECKOUT_IDENTITY_ISSUERS_JSON
PIVOTA_IDENTITY_ISSUERS_JSON
```

Shape:

```json
[
  {
    "iss": "https://idp.example.com",
    "aud": "pivota-agent-mcp",
    "jwksUri": "https://idp.example.com/.well-known/jwks.json",
    "algs": ["ES256"],
    "azp": "optional-approved-oauth-client-id",
    "requiredScopes": ["optional-checkout-scope"]
  }
]
```

Rules:

- `jwksUri` must be HTTPS, or use static public `jwks`. Never put private keys in Railway env.
- `algs` must be asymmetric only: `RS*`, `PS*`, `ES*`, or `EdDSA`.
- Tokens must carry `iss`, `aud`, `sub`, `exp`, and `iat`.
- Tokens must also carry a verified checkout/session claim: `acp_session_id`, `pivota_session_id`, `session_id`, or `sid`.
- Optional max age env: `AGENT_CHECKOUT_IDENTITY_MAX_TOKEN_AGE=1h`.

The gateway accepts the user token in:

```text
X-Agent-User-JWT: Bearer <signed-user-token>
```

If this header is present and verification fails or no identity issuer is configured, buyer context is stripped and money/user-scoped MCP tools fail closed.

## 4. Payment Issuer Env

Set exactly one of:

```text
PAYMENT_ISSUERS_JSON
AGENT_CHECKOUT_PAYMENT_ISSUERS_JSON
PIVOTA_PAYMENT_ISSUERS_JSON
```

Shape:

```json
[
  {
    "iss": "https://payments.example.com",
    "aud": "pivota-agent-mcp",
    "jwksUri": "https://payments.example.com/.well-known/jwks.json",
    "algs": ["ES256"]
  }
]
```

Supported MCP payment authorization methods while AP2 remains disabled:

```json
{
  "method": "acp_delegated_token",
  "token": "<signed-grant-jwt>"
}
```

or:

```json
{
  "method": "ucp_handler",
  "token": "<signed-grant-jwt>"
}
```

Signed grant payload must include either a nested `allowance` object or equivalent top-level fields:

```json
{
  "iss": "https://payments.example.com",
  "aud": "pivota-agent-mcp",
  "sub": "<same-human-subject-when-available>",
  "exp": 1780928400,
  "jti": "grant-unique-id",
  "allowance": {
    "max_amount": 169,
    "currency": "USD",
    "merchant_id": "merch_efbc46b4619cfbdf",
    "checkout_session_id": "<MCP create_checkout_session result.session_id>"
  }
}
```

Rules:

- `max_amount` is minor units. The kernel still charges from the locked quote/order amount, not this value.
- `checkout_session_id` must equal the public checkout session id for that protocol.
- For MCP, this is the `session_id` returned by `create_checkout_session`.
- For ACP REST, this is the ACP checkout session id; the ACP adapter maps it to the locked quote internally.
- A grant bound only to the broad ACP/MCP connection session is rejected.
- A missing verifier or unconfigured payment issuer rejects `complete_checkout_session` before order/payment side effects.

## 5. Pure MCP Sequence

1. Client initializes MCP and lists tools.
2. Client calls `search_catalog` / `get_product`.
3. Client calls `create_checkout_session` with verified `X-Agent-User-JWT`.
4. Host UI obtains explicit user confirmation/payment authorization and signs a grant for the returned `session_id`.
5. Client calls `complete_checkout_session` with:

```json
{
  "session_id": "<returned-session-id>",
  "idempotency_key": "<unique-key>",
  "payment_authorization": {
    "method": "acp_delegated_token",
    "token": "<signed-grant-jwt>"
  }
}
```

6. If the PSP returns `requires_action`, surface the returned action URL/QR/instructions verbatim to the user. Do not fabricate links.
7. Signed PSP webhook or reconcile finalizes `charge_pending -> paid`.

## 6. Before Live MCP Paid Canary

Required:

- Deploy code with `jose` available in root dependencies.
- Set identity/payment issuer envs on Pivota Agent production.
- Confirm `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=0` before the smoke.
- Run no-charge MCP smoke: initialize, list tools, search/get product, create checkout session, confirm no `complete_checkout_session` call.
- Run the manual no-charge paid-canary preparation script to prove signed identity and signed payment grant shape without calling pay:

```bash
node scripts/probe_pure_mcp_paid_canary.mjs --json
```

- Open `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=1` only for the controlled paid canary.
- Run one MCP-only `complete_checkout_session` canary:

```bash
MCP_PAID_ALLOW_CHARGE=1 \
MCP_PAID_CHARGE_CONFIRM=yes \
MCP_PAID_PSP_MODE=test \
node scripts/probe_pure_mcp_paid_canary.mjs --charge --replay --json
```

- Replay the same idempotency key and prove no duplicate charge.
- Close `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=0` immediately after.

Do not switch normal traffic to live paid MCP until paid evidence, webhook proof, refund cap/replay proof, redaction scan, and operator compliance signoff are green.
