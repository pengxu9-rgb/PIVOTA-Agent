# ADR: Authorization Server for the MCP OAuth front door

**Status:** **Accepted** — use Pivota's own `pb-oauth-as`. No external vendor.
**Date:** 2026-06-16.
**Context docs:** [`agent-checkout/MCP_OAUTH_FRONT_DOOR.md`](agent-checkout/MCP_OAUTH_FRONT_DOOR.md) (resource-server side, built + tested), [`mcp_citation_connector_runbook.md`](mcp_citation_connector_runbook.md) (turn-up), [`agent-checkout/PURE_MCP_PRODUCTION_WIRING_RUNBOOK.md`](agent-checkout/PURE_MCP_PRODUCTION_WIRING_RUNBOOK.md) (paid path).

## Decision

**Pivota already owns a purpose-built MCP Authorization Server: `pb-oauth-as`** (sibling repo,
Python/FastAPI). It was built for *this exact front door* — its env vars are named `MCP_OAUTH_AS_*` and
its tests pin the resource to `https://pivota-agent-production.up.railway.app/mcp`. There is **no
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
MCP_OAUTH_RESOURCE=https://pivota-agent-production.up.railway.app/mcp
MCP_OAUTH_AUTHORIZATION_SERVERS=https://api.pivota.cc
MCP_OAUTH_ISSUERS_JSON=[{"iss":"https://api.pivota.cc","jwksUri":"https://api.pivota.cc/.well-known/jwks.json","algs":["RS256"]}]
```

`MCP_OAUTH_RESOURCE` must **exactly** equal the `resource`/`aud` the AS mints (the value its tests already
pin), or audience verification fails closed.

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
