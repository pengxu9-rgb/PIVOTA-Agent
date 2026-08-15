# MCP OAuth Front Door — keyless frontier-model connection to `/mcp`

**Status (2026-06-09):** resource-server side **built + tested** (28 unit + 5 e2e green), additive and
flag-gated (`MCP_OAUTH_ENABLED`). Not yet enabled in prod. The remaining external dependency is the
**authorization server** (decision below).

## Why this exists

Native frontier MCP clients (Claude, ChatGPT, Gemini) connect to a remote MCP server **only via
OAuth 2.1** — they never use a pre-shared API key. The deployed `/mcp` previously had **no OAuth**
(no discovery metadata, no `WWW-Authenticate` challenge, no token verification), so a real model could
not connect keyless. Codex's prior "MCP without API key" success was the in-process test harness
(`NODE_ENV=test` bypasses channel auth) + an operator **test-identity window** + a **surrogate probe**
— Codex itself filed a `frontier_model_account_level_e2e` *exception* recording that real Claude/
ChatGPT/Gemini account-level connection was not testable. This closes that gap on Pivota's side.

## What was built (this branch: `feat/mcp-oauth-resource-server`)

We are the **OAuth Resource Server**. We do NOT issue tokens.

- `safety-kernel/src/identity/mcpOAuthResourceServer.js`
  - `buildProtectedResourceMetadata()` — RFC 9728 document.
  - `buildWwwAuthenticate()` — RFC 6750 challenge carrying `resource_metadata` (+ injection-safe).
  - `createMcpAccessTokenVerifier()` — verifies the inbound access token against a **pinned JWKS**,
    **audience === this resource** (RFC 8707, blocks token replay across resources), asymmetric-alg
    allowlist, exp/iat/maxAge, optional required scopes → derives `user_ref` (parity with
    `userTokenVerifier`). Fail-closed on every error.
- `src/commerceMcpOAuth.js` (server glue) — discovery routes, the challenge, and
  `resolveMcpOAuthIdentity(req)` returning `disabled | apikey | oauth | challenge`.
- `src/server.js` wire-in (tiny, additive):
  - `GET /.well-known/oauth-protected-resource` (+ `/mcp` suffix variant).
  - `POST /mcp`: when `MCP_OAUTH_ENABLED`, an OAuth Bearer token is **both** the channel credential
    **and** the user identity — no API key, no `X-Agent-User-JWT`. Missing/invalid → 401 + challenge.
    When the flag is off, behavior is **byte-identical** to today (api-key channel).
- Tests: `safety-kernel/test/mcpOAuthResourceServer.test.js` (10),
  `tests/commerce_mcp_oauth.node.test.cjs` (7),
  `tests/integration/mcp_oauth_front_door.node.test.cjs` (5, boots the real app: keyless connect +
  tools/list + discovery + challenge + wrong-aud reject). Existing `safety_kernel_mount` suite still
  green (no regression).

## The decision you still own: the Authorization Server

The resource server points at an AS that must support **Dynamic Client Registration** (RFC 7591),
`/authorize` (code + PKCE), `/token`, and a **user-consent login** (this is who pays). Options:

- **Managed (recommended):** Stytch / WorkOS AuthKit / Auth0 / Descope / Scalekit / Clerk — they ship
  MCP-auth + DCR + consent + JWKS. Fastest, lowest auth-risk. You create an account; we set its issuer
  + JWKS in env. ← recommended
- **Self-hosted:** we build DCR + authorize + token + consent + key signing. No third party, but it is
  auth-critical code and meaningfully more work; needs the adversarial review loop.

## Enabling it (after the AS exists)

Set on the prod Agent (Railway → Pivota Agent):

```
MCP_OAUTH_ENABLED=1
MCP_OAUTH_RESOURCE=https://commerce.mcp.pivota.cc/mcp
MCP_OAUTH_AUTHORIZATION_SERVERS=https://<your-AS-issuer>
MCP_OAUTH_ISSUERS_JSON=[{"iss":"https://<your-AS-issuer>","jwksUri":"https://<your-AS>/.well-known/jwks.json","algs":["ES256"]}]
# optional: MCP_OAUTH_SCOPES=pivota.checkout   MCP_OAUTH_RESOURCE_NAME="Pivota Commerce"
```

`MCP_OAUTH_RESOURCE` is an IDENTITY, not just a reachable address — it is the `aud` every token is bound
to, matched byte-exact. It moved from `https://pivota-agent-production.up.railway.app/mcp` to the branded
host above on 2026-08-13 (verified live 2026-08-14). Before changing it again: the AS gates minting on a
byte-exact `MCP_OAUTH_AS_ALLOWED_RESOURCES` allowlist in a separate deployment (update it FIRST), refresh
grants pin the old value permanently, and this variable is also the last link in the UCP buyer-agent
profile-URL derivation chain — which since #1992 refuses a PaaS-generated host.

Then: redeploy → `GET /.well-known/oauth-protected-resource` returns 200 → connect Claude/ChatGPT to
`https://…/mcp` (it discovers the AS, runs DCR + consent, gets a token) → it can `search_catalog`,
`create_checkout_session`, and (when `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=1`)
`complete_checkout_session` — all with no API key.

## Open review items (before enabling on real traffic)

1. **acp_session_id binding under OAuth.** `buildOAuthCommerceCtx` uses a token session claim if
   present, else the `Mcp-Session-Id` transport header; if neither, money ops fail closed
   (USER_AUTH_REQUIRED). Confirm the chosen AS/transport always yields a stable per-session id, or the
   kernel's single-use/charge-once isolation degrades. **Needs the adversarial review.**
2. **Audience/resource value** must exactly match what the AS mints (`MCP_OAUTH_RESOURCE`).
3. Keep `complete_checkout_session` gated by `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED` until the
   keyless paid canary is run (reuse the test-mode canary already proven by Codex).
4. Rotate/scope the live PSP key; the `X-Checkout-Token` legacy channel bypass (`requireExternalInvokeAuth`)
   is still present — track its removal separately.
