# ADR: Authorization Server for the MCP OAuth front door

**Status:** Proposed — decision owner sign-off pending.
**Date:** 2026-06-16.
**Context docs:** [`agent-checkout/MCP_OAUTH_FRONT_DOOR.md`](agent-checkout/MCP_OAUTH_FRONT_DOOR.md) (resource-server side, built + tested), [`mcp_citation_connector_runbook.md`](mcp_citation_connector_runbook.md) (turn-up), [`agent-checkout/PURE_MCP_PRODUCTION_WIRING_RUNBOOK.md`](agent-checkout/PURE_MCP_PRODUCTION_WIRING_RUNBOOK.md) (paid path).

## Context

Pivota is the OAuth **Resource Server** for `/mcp` — that code exists, is flag-gated (`MCP_OAUTH_ENABLED`),
and is unit/e2e tested. It does **not** issue tokens. To let native frontier MCP clients (Claude /
ChatGPT / Gemini) connect **keyless**, we need an external **Authorization Server (AS)** that issues the
access tokens our resource server verifies. This ADR picks that AS.

The choice is the single remaining decision in Task **C** (MCP/agent-read hardening). It gates publishing
a connector — the *fast* citation path that doesn't wait on organic crawl/index.

### Hard requirements (from the resource-server contract)

1. **Dynamic Client Registration — RFC 7591.** This is the make-or-break feature. Frontier MCP clients
   self-register at connect time; without open DCR they cannot connect. Many traditional IdPs disable or
   gate DCR for security, so it must be explicitly supported for public/MCP clients.
2. **Authorization Code + PKCE** (`/authorize`, `/token`) and a **user-consent login** — the buyer
   authenticates and consents; this is who ultimately pays on the checkout path.
3. **Resource indicators — RFC 8707.** Tokens must carry `aud` === our `MCP_OAUTH_RESOURCE`
   (`https://…/mcp`) so a token minted for us can't be replayed at another resource. Our verifier enforces
   audience; the AS must let us pin it.
4. **Asymmetric signing + JWKS.** Tokens signed `ES256`/`RS256`/etc., published at an HTTPS `jwksUri`.
   Tokens carry `iss`, `sub`, `exp`, `iat`.
5. **(Checkout path, later) a stable per-session claim** (`acp_session_id` / `session_id` / `sid`) so
   money ops bind to a single checkout session. **Not required for the read-only citation connector** —
   discovery tools need no `user_ref` — so the AS can ship for citations first and add the session claim
   before the paid canary.

### Selection criteria (weighted for *our* situation: pre-prod, a few K-beauty pilots, want fastest +
lowest auth-risk + cheap, read-only citations first, checkout later)

| Criterion | Weight | Why |
|---|---|---|
| Native MCP / open DCR support | ★★★ | Hard requirement #1; the differentiator between vendors |
| Time-to-integrate (issuer + JWKS + consent shipped) | ★★★ | We want a connector demoable, not an auth project |
| Auth-risk / maturity (we're not auth experts) | ★★★ | Money is downstream; a token bug is existential |
| Free / cheap at pilot scale | ★★ | Pre-prod, handful of users |
| Custom claims (session binding) for checkout | ★★ | Needed before paid canary, not before citations |
| Lock-in / exit cost | ★ | Standard OIDC ⇒ swappable; our verifier is issuer-agnostic |

## Options

We will **not** self-host. Building DCR + authorize + token + consent + key signing is auth-critical code,
meaningfully more work, and needs an adversarial review loop — wrong trade for a pre-prod pilot whose
value is citations, not auth. (Revisit only if a managed AS proves a hard blocker.)

Managed candidates (all speak OIDC; differ mainly on MCP/DCR-nativeness, consent UX, price, maturity):

| AS | MCP/DCR posture | Consent UX | Pilot pricing | Maturity / risk | Notes |
|---|---|---|---|---|---|
| **Stytch** | Most explicitly MCP-native (purpose-built "Connected Apps"/MCP-auth product, DCR for agent clients) | Hosted consent + login | Free dev tier, generous early MAU | Newer than Auth0 but auth-focused, strong agent/MCP docs | Lowest friction for *exactly* this use case |
| **WorkOS AuthKit** | Added MCP auth support; AuthKit acts as AS with DCR | Polished hosted AuthKit UI | AuthKit free to a high MAU ceiling | Mature, strong docs, used widely for B2B | Best "value + maturity" balance; near-tie with Stytch |
| **Descope** | Inbound-apps / MCP auth, agentic focus, DCR | Flow-builder consent | Free tier | Mid-maturity | Flexible flows; slightly more config surface |
| **Clerk** | OAuth/MCP provider support added, DCR | Strong prebuilt UI | Free tier | Mature on B2C auth | Great UX; verify MCP-DCR maturity at spike |
| **Auth0 (Okta)** | DCR exists but historically gated; "Auth for GenAI" program | Universal Login | Free tier small; scales expensive | Most mature | Heaviest integration; enterprise-leaning; possible overkill |

> ⚠️ The MCP-auth feature surface across these vendors is **moving fast** and post-dates this author's
> knowledge cutoff. Treat the "MCP/DCR posture" column as *direction*, not gospel — **confirm current
> open-DCR + resource-indicator support during the validation spike below** before committing.

## Decision

**Adopt a managed AS; primary recommendation: Stytch, with WorkOS AuthKit as the co-leading fallback.**

Rationale: Stytch is the most explicitly MCP/agent-native (open DCR + hosted consent purpose-built for
this), which directly de-risks hard requirement #1 and minimizes time-to-connector. WorkOS AuthKit is a
near-tie — pick it if its free-tier ceiling, B2B maturity, or consent UX fit better after the spike. Both
are standard OIDC, so our issuer-agnostic verifier (`MCP_OAUTH_ISSUERS_JSON`) makes switching cheap if one
disappoints. Auth0 is the safe-but-heavy option to fall back to only if both leaders lack a needed
feature; Descope/Clerk are viable if their consent/flow UX is preferred.

## Validation spike (½–1 day, before final sign-off)

Run against the **two** leaders, pick the winner on evidence:

1. Create a dev tenant; enable **open Dynamic Client Registration** for public clients.
2. Configure a resource/audience === `https://pivota-agent-production.up.railway.app/mcp` (RFC 8707).
3. Set `MCP_OAUTH_ENABLED=1` + `MCP_OAUTH_ISSUERS_JSON` pointing at the tenant's issuer + JWKS on a
   **staging** Agent; confirm `GET /.well-known/oauth-protected-resource` → 200 and unauthenticated
   `/mcp` → 401 + `WWW-Authenticate`.
4. Connect a **real** Claude/ChatGPT MCP client to `/mcp`; confirm it auto-registers (DCR), shows the
   consent screen, gets a token, and `tools/list` succeeds — then `get_intel` on the pilot returns the
   grade-A PubMed claims (end-to-end citation proof).
5. Decode the issued token: assert `aud` === our resource, asymmetric alg, `iss/sub/exp/iat` present.
6. (Checkout readiness, not blocking citations) confirm a **stable per-session claim** can be minted —
   the open review item #1 in the OAuth front-door doc.

## Consequences

- **Positive:** keyless frontier connection unblocked; connector publishable; fastest citation path live;
  auth-critical code stays outside our codebase; issuer-agnostic verifier keeps exit cheap.
- **Negative / risks:** a third-party in the trust path (consent + token issuance); vendor MCP-auth
  features are young and may shift; per-MAU cost appears at scale (acceptable pre-prod). Mitigation: the
  verifier already enforces audience + alg + exp fail-closed regardless of vendor.
- **Follow-ups:** before the *paid* canary, resolve the `acp_session_id` binding review item, keep
  `complete_checkout_session` gated by `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED`, and track removal of
  the legacy `X-Checkout-Token` channel bypass.

## Open questions for the decision owner

1. Stytch vs WorkOS AuthKit — any existing vendor relationship, compliance (SOC2/region), or pricing
   ceiling that tips it? Otherwise the spike decides.
2. Is the citation connector shipping **read-only first** (recommended — no session-claim dependency), or
   do we want checkout live in the same connector launch (adds the session-binding review to the critical
   path)?
