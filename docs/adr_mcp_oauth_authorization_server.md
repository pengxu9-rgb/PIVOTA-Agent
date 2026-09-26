# ADR: Authorization Server for the MCP OAuth front door

**Status:** **Accepted** — use Pivota's own `pb-oauth-as`. No external vendor.
**Date:** 2026-06-16.
**Context docs:** [`agent-checkout/MCP_OAUTH_FRONT_DOOR.md`](agent-checkout/MCP_OAUTH_FRONT_DOOR.md) (resource-server side, built + tested), [`mcp_citation_connector_runbook.md`](mcp_citation_connector_runbook.md) (turn-up), [`agent-checkout/PURE_MCP_PRODUCTION_WIRING_RUNBOOK.md`](agent-checkout/PURE_MCP_PRODUCTION_WIRING_RUNBOOK.md) (paid path).

## Decision

**Pivota already owns a purpose-built MCP Authorization Server: `pb-oauth-as`** (Python/FastAPI). It was
built for *this exact front door* — its env vars are named `MCP_OAUTH_AS_*` and
its tests pinned the resource to `https://pivota-agent-production.up.railway.app/mcp` (the value as of this
ADR's date — production has since moved to `https://commerce.mcp.pivota.cc/mcp`; see the update note under
"Resource Server" below). There is **no
build-vs-buy decision and no vendor selection** — we deploy `pb-oauth-as` and point PIVOTA-Agent's
resource-server verifier at it.

> An earlier revision of this ADR compared managed vendors (Stytch / WorkOS / Auth0 / …). That was a
> mistake — it overlooked the existing in-house AS. Superseded; kept only as the record that the
> question was raised and resolved to "we own it."

## Why `pb-oauth-as` is sufficient (verified against the code)

Pivota is the OAuth **Resource Server** for `/mcp` (built, tested, flag-gated by `MCP_OAUTH_ENABLED`) —
it verifies tokens but does not mint them. `pb-oauth-as` is the **Authorization Server** that mints them,
and it meets every MCP requirement:

| MCP requirement | `pb-oauth-as` | Evidence |
|---|---|---|
| Full AS (issues access tokens) | ✅ | `services/mcp_oauth_as.py` — RS256 access tokens |
| **Dynamic Client Registration (RFC 7591)** — the make-or-break MCP feature | ✅ | `POST /oauth/register`; public clients (`token_endpoint_auth_method:"none"`) + confidential |
| Authorization Code + **PKCE S256** | ✅ | `/oauth/authorize` + `/oauth/token`; S256 **mandatory**, plaintext rejected |
| **Resource indicators (RFC 8707)** — `aud` bound to our `/mcp` | ✅ | `resource` param **required**; minted into `aud`; test asserts `aud == https://…/mcp` |
| Asymmetric signing + JWKS | ✅ | **RS256** (not ES256); `/.well-known/jwks.json` |
| Discovery | ✅ | `/.well-known/oauth-authorization-server` (RFC 8414) |
| User login + consent | ✅ | reuses Pivota buyer accounts; HTML consent form + audited grants |
| Refresh tokens, single-use codes, scopes | ✅ | 30-day refresh; atomic code consume; scope preserved |

**Missing pieces are non-blocking for MCP** (token introspection RFC 7662, revocation RFC 7009, client
update/delete, DCR rate-limiting). Worth adding for ops hygiene later — DCR rate-limiting especially, to
blunt a registration-spam DoS — but none gate the citation connector.

> ⚠️ One correction vs the resource-server doc examples: `pb-oauth-as` signs **RS256**, so the verifier's
> `MCP_OAUTH_ISSUERS_JSON` must list `"algs":["RS256"]` (the front-door doc's `ES256` example is generic).

## Wiring (the entire remaining task)

**Authorization Server — deploy `pb-oauth-as`** (issuer `https://api.pivota.cc`):

```text
MCP_OAUTH_AS_ENABLED=1
MCP_OAUTH_AS_ISSUER=https://api.pivota.cc
MCP_OAUTH_AS_PRIVATE_KEY_PEM=<RSA-2048 private key, PEM>     # stable across instances/restarts
MCP_OAUTH_AS_REQUEST_SECRET=<32+ char secret>               # consent HMAC
MCP_OAUTH_AS_LOGIN_URL=<buyer login URL>                    # else unauthenticated → 401
# optional: MCP_OAUTH_AS_KEY_ID (default pivota-mcp-as-1), MCP_OAUTH_AS_STORE (default postgres)
```

**Resource Server — PIVOTA-Agent** (Railway "Pivota Agent" prod) points at that issuer:

```text
MCP_OAUTH_ENABLED=1
MCP_OAUTH_RESOURCE=https://commerce.mcp.pivota.cc/mcp
MCP_OAUTH_AUTHORIZATION_SERVERS=https://api.pivota.cc
MCP_OAUTH_ISSUERS_JSON=[{"iss":"https://api.pivota.cc","jwksUri":"https://api.pivota.cc/.well-known/jwks.json","algs":["RS256"]}]
```

`MCP_OAUTH_RESOURCE` must **exactly** equal the `resource`/`aud` the AS mints, or audience verification
fails closed.

> **Naming, 2026-08-14:** `pb-oauth-as` is the AS **module inside the `pivota-backend` repo**
> (`services/mcp_oauth_as.py`, `services/mcp_oauth_flow.py`, `routes/mcp_oauth_as.py`), deployed as part of
> that app on Railway service `web` in project *Pivota Infra*. It is **not** a separate repo and **not** its
> own service — verified 2026-08-14: no `pb-oauth-as` repo exists under the org and no such Railway service
> exists. Read "deploy `pb-oauth-as`" below as "set the `MCP_OAUTH_AS_*` env on `web` and deploy
> pivota-backend"; there is nothing separate to stand up.

> **Update 2026-08-13 — the resource identifier moved to a branded host.** This ADR was decided against
> `https://pivota-agent-production.up.railway.app/mcp` (still named at the top of this ADR as the value
> `pb-oauth-as`'s tests pinned at the time). Production now uses `https://commerce.mcp.pivota.cc/mcp` —
> verified live 2026-08-14: the door 401s with a `resource_metadata` pointer whose document names that exact
> resource back. The env block above has been corrected so it can be copied safely. Three consequences worth
> knowing before you change this value again:
>
> - **This variable defines TWO identifiers, not one.** The UCP door's is derived from this one's origin
>   as `${origin}/ucp/mcp` (`src/commerceMcpOAuth.js` `resourceFor`), and both are advertised — verified
>   live 2026-08-14, `/.well-known/oauth-protected-resource/mcp` names `…/mcp` and
>   `/.well-known/oauth-protected-resource/ucp/mcp` names `…/ucp/mcp`. Anything you do to the native
>   identifier must be done to the derived one too, or the charge-capable UCP door is left behind.
> - **The AS gates `/oauth/authorize` on a byte-exact allowlist — NOT minting.** The distinction is
>   load-bearing, see the next bullet. `MCP_OAUTH_AS_ALLOWED_RESOURCES` is read in the `pivota-backend`
>   repo (`services/mcp_oauth_as.py` `allowed_resources`, enforced in `services/mcp_oauth_flow.py`
>   `validate_authorization_request`), and **both** identifiers above must be listed there FIRST or conforming clients get
>   `invalid_target` at authorize. Matching is Python `in` over a `.split(",")`: no trailing-slash strip, no
>   case fold, no URL parsing — though each entry AND the incoming value are `.strip()`ed, so spaces around
>   the commas are fine. Unset allows NOTHING. Confirmed 2026-08-14 against that repo's `main` and against
>   the deployed value on Railway service `web` (project *Pivota Infra*), which already lists both. The
>   consent step does not re-check: `POST /oauth/authorize/decision` replays the signed request blob
>   (`_verify_request`) straight into `issue_authorization_code` without consulting the allowlist, so a
>   resource removed mid-consent still yields a code for the blob's TTL
>   (`routes/mcp_oauth_as.py` `CONSENT_REQUEST_TTL_SECONDS` = 600s).
> - **Removing an entry is NOT a kill switch, and the window is UNBOUNDED — not 30 days.** The allowlist is
>   checked only at authorize; `exchange_refresh_token` re-mints via `_mint_grant(...)` with the resource
>   stored on the grant and never re-checks it. Refresh is ROTATING, and `_mint_grant` writes
>   `expires_at = now + REFRESH_TTL_SECONDS` on every rotation, so the 30-day TTL SLIDES and there is no
>   absolute chain cap anywhere. A client that refreshes at least monthly holds a de-allowlisted audience
>   indefinitely; 30 days bounds only a chain that goes silent. Do not wait it out. The only stop is marking
>   that resource's rows revoked in `mcp_oauth_refresh` by hand (`get_refresh` filters
>   `revoked_at IS NULL`) — this ADR lists RFC 7009 revocation among the AS's MISSING pieces, so there is no
>   endpoint to do it with.
> - **Moving to a new HOST is a forced re-authorization, not an overlap.** There is no "run both hosts"
>   state to sit in: `MCP_OAUTH_RESOURCE` is single-valued (`src/commerceMcpOAuth.js` `nativeResource`), and
>   the resource SET the verifier accepts — built by `acceptedResourcesFor` in `src/commerceMcpOAuth.js`
>   and handed to the verifier in `safety-kernel/src/identity/mcpOAuthResourceServer.js`, which reads no env
>   of its own — is `{this door's identifier, the native one}` —
>   it exists so the UCP door still accepts tokens minted against `…/mcp`, NOT to span two hostnames. So:
>   allowlist the new value on the AS first (additive, inert), then flip `MCP_OAUTH_RESOURCE`. At the flip
>   every live token carries the old audience and is rejected — connected clients get 401, rediscover via
>   `resource_metadata`, and re-run OAuth, which may re-prompt for consent. Schedule it. The orphaned
>   refresh chains keep minting the old audience forever (previous bullet); they die by rejection, not by
>   expiry, and only hand-revocation clears them.
> - **This value can also feed the UCP buyer-agent profile URL, but does not today.** It is the third and
>   last of the three derivable origins, reached only when `UCP_AGENT_PROFILE_URL` is unset, the two
>   earlier origins are unset, and `UCP_BUYER_AGENT_PROFILE_ENABLED` is on (default off). Production sets
>   `UCP_AGENT_PROFILE_URL` explicitly, so the coupling is **latent, not active** — reverting this value
>   would not by itself omit `ucp.profile_url`. Should those preconditions ever hold, note that since
>   #1992 the chain refuses a PaaS-generated host, which omits the pointer and makes SIGNED-tier outbound
>   UCP calls throw.

## Validation (½ day, no vendor spike needed)

1. Deploy `pb-oauth-as` with the env above; confirm `GET https://api.pivota.cc/.well-known/oauth-authorization-server`
   → 200 and `/.well-known/jwks.json` → keys.
2. On PIVOTA-Agent (staging), set the resource-server env; confirm `GET /.well-known/oauth-protected-resource`
   → 200 and unauthenticated `/mcp` → 401 + `WWW-Authenticate`.
3. `curl -X POST https://api.pivota.cc/oauth/register -d '{"redirect_uris":["https://claude.ai/..."]}'`
   → 201 with a `client_id` (proves DCR works for a frontier client).
4. Connect a real Claude/ChatGPT MCP client to `/mcp`; it auto-registers (DCR) → consent → token →
   `tools/list` → `get_intel` on the pilot returns the grade-A PubMed claims (end-to-end citation proof).
5. Decode the token: `aud` === `MCP_OAUTH_RESOURCE`, `alg` RS256, `iss/sub/exp/iat` present.

## Consequences

- **Positive:** zero external dependency, zero vendor cost, no new trust party; the AS is already
  MCP-correct and shares Pivota's buyer accounts (consent reuses existing login). Remaining work is env +
  deploy, not an auth project.
- **Risks / follow-ups:** add DCR rate-limiting before broad exposure; for the *paid* path, confirm the
  token carries a stable per-session claim (open item #1 in the OAuth front-door doc) and keep
  `complete_checkout_session` gated until the paid canary. None block the read-only citation connector.

## Open questions for the decision owner

1. Is `pb-oauth-as` already deployed at `https://api.pivota.cc` (just needs the `MCP_OAUTH_AS_*` env), or
   does it need a deploy target stood up?
2. Citation connector **read-only first** (recommended — no session-claim dependency), or checkout in the
   same launch (adds the session-binding review to the critical path)?
