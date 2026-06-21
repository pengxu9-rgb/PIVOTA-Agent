# Pivota MCP Auth Reference

> **Status: mostly QUARANTINED reference.** `oauth.js` and `sessionStore.js` are **not production-wired**
> (only `auth.test.js` imports them) and carry quarantine headers. The **only live file here is
> `userRef.js`** (`deriveUserRef`/`attachUserRef`/`WRITE_OPERATIONS`), imported by the production
> `src/commerceToolSurface.js` and the legacy `src/secureInvoke.js`. Production frontier-agent OAuth on the
> live `/mcp` surface is the gateway's resource server (`safety-kernel/src/identity/mcpOAuthResourceServer.js`
> + `src/commerceMcpOAuth.js`), **not** the `oauth.js` flow described below. See
> [`../unwired/README.md`](../unwired/README.md) for the full unwired-scaffolding registry.

This directory contains additive OAuth 2.1 helpers for the MCP adapter. The goal is
to bind every money-path call to a stable `user_ref` derived from the platform OAuth
subject, while the existing Pivota agent key continues to authenticate only the
trusted channel.

## Environment

Expected adapter configuration:

- `PIVOTA_OAUTH_AUTHORIZE_ENDPOINT`: OAuth authorization endpoint.
- `PIVOTA_OAUTH_TOKEN_ENDPOINT`: OAuth token endpoint.
- `PIVOTA_OAUTH_CLIENT_ID`: public OAuth client id for the MCP connector.
- `PIVOTA_OAUTH_REDIRECT_URI`: callback URL registered with the OAuth provider.
- `PIVOTA_OAUTH_SCOPE`: space-delimited scopes, usually including `openid`.

Do not log access tokens, refresh tokens, authorization codes, AP2 state, or payment
mandates.

## Claude remote MCP OAuth flow

1. When the remote MCP connector needs user authority, call `createPkcePair()` and
   store the verifier with an unguessable session/state id.
2. Call `buildAuthorizeUrl(...)` with the configured authorize endpoint, client id,
   redirect URI, scope, state, and PKCE code challenge.
3. Redirect the user to the returned URL through the connector's OAuth start flow.
4. On callback, validate `state`, retrieve the stored verifier, and call
   `exchangeCodeForTokens(...)` with the authorization code and verifier.
5. Verify the provider claims server-side. Use an ID token verification library,
   userinfo endpoint, or introspection endpoint appropriate for the provider. Do
   not derive authority from unverified token text.
6. Call `deriveUserRef({ iss, sub })` from verified claims and store the resulting
   `user_ref` with tokens in the session store.
7. Refresh with `refreshTokens(...)` when needed, then update the stored tokens.

`sessionStore.js` is a reference-only in-memory store. Production needs encrypted,
durable storage with explicit token retention and revocation handling.

## Canonical envelope binding

The existing adapter prepares Pivota calls as:

```js
const prepared = prepareToolCall(name, toolArgs);
```

Before calling `invokePivota`, load the current OAuth session, obtain the trusted
`user_ref`, and bind it to the canonical envelope:

```js
const canonical = attachUserRef(
  { operation: prepared.operation, payload: prepared.payload },
  session.user_ref
);

const response = await invokePivota({
  ...canonical,
  idempotencyKey: prepared.idempotencyKey
});
```

`attachUserRef` overwrites any model-supplied `payload.user_ref`; user authority must
come from verified OAuth claims. It refuses `create_order`, `submit_payment`, and
`request_after_sales` when no trusted `user_ref` is available.
