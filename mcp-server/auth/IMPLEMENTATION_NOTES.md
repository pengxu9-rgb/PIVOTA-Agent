# Auth Implementation Notes

## Built

- `oauth.js`: OAuth 2.1 Authorization Code + PKCE helpers. Network calls accept an
  injectable `fetchImpl` so tests can run offline.
- `userRef.js`: stable `user_ref` derivation from verified `{ iss, sub }` claims and
  canonical envelope binding.
- `sessionStore.js`: small in-memory session/token store keyed by session id.
- `README.md`: remote MCP OAuth flow and canonical envelope binding notes.
- `test/auth.test.js`: offline `node --test` coverage for PKCE, user_ref derivation,
  envelope immutability/rejection, and token exchange.

## Reference-only vs production-grade

Reference-only:

- `sessionStore.js` keeps tokens in process memory. It is not durable, encrypted,
  shared across workers, or safe for production restarts.
- Token verification is intentionally not implemented here because each OAuth
  provider has different issuer, JWKS, userinfo, or introspection requirements.
- Refresh scheduling, state storage, CSRF replay defense, and connector-specific
  callback routing still need to be wired by the MCP host.

Production-grade expectations:

- Verify ID token or userinfo/introspection claims before calling `deriveUserRef`.
- Store tokens encrypted at rest in durable storage with revocation and retention
  policy support.
- Persist PKCE verifier/state separately from tokens, expire it quickly, and enforce
  one-time callback use.
- Redact access tokens, refresh tokens, authorization codes, AP2 state, and payment
  mandate data from all logs and errors.

## Adapter wiring location

Do not change `mcp-server/src/server.js` in this task. The future wiring belongs in
the existing `CallToolRequestSchema` handler after:

```js
const prepared = prepareToolCall(name, toolArgs);
```

and before:

```js
const response = await invokePivota(prepared);
```

The adapter should:

1. Resolve the current OAuth session from connector request metadata or transport
   context.
2. If claims are freshly verified in the request, call `deriveUserRef(claims)`.
   Otherwise use the `user_ref` stored at OAuth callback time.
3. Bind authority with:

   ```js
   const canonical = attachUserRef(
     { operation: prepared.operation, payload: prepared.payload },
     session.user_ref
   );
   ```

4. Preserve idempotency metadata when invoking Pivota:

   ```js
   const response = await invokePivota({
     ...canonical,
     idempotencyKey: prepared.idempotencyKey
   });
   ```

This ensures the shared `PIVOTA_AGENT_KEY` authenticates only the channel, while
OAuth-derived `user_ref` authenticates the human for money-path calls.
