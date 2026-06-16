# MCP Citation Connector Runbook — the *fast* path to getting cited

**Goal:** let frontier agents (Claude / ChatGPT / Gemini) connect to Pivota's `/mcp` and **read
grounded, cited product claims directly** — no crawl/index wait. This is Task **C** in
`docs/HANDOFF.md` ("MCP / agent-read hardening"), the read-only sibling of the checkout runbooks.

This runbook is **read-only**. It deliberately uses **none** of the payment machinery
(`PAYMENT_ISSUERS_JSON`, AP2 mandate, `complete_checkout_session`) — the discovery tools
(`search_catalog`, `get_product`, `get_alternatives`, `get_intel`) require **no `user_ref`**, so the
citation connector is a much lower-risk turn-up than the paid-MCP path. For the paid path see
[`agent-checkout/PURE_MCP_PRODUCTION_WIRING_RUNBOOK.md`](agent-checkout/PURE_MCP_PRODUCTION_WIRING_RUNBOOK.md)
and [`agent-checkout/MCP_OAUTH_FRONT_DOOR.md`](agent-checkout/MCP_OAUTH_FRONT_DOOR.md).

## What "cited" requires (the data must carry citations)

A frontier agent can only *cite* Pivota if `get_intel` returns claims **with citation URLs and a
grade** — not paraphrasable prose. Until PR #1703, `get_intel` hardcoded `evidence.grade=null` and
never read `evidence_claims`. PR #1703 surfaces the **same public-safe claims the public PDP already
publishes** (`filterPublicSafeClaims`, the single FTC-rule source) onto the signal:

```jsonc
// get_intel → signals[0].evidence  (with AGENT_INTEL_PUBLIC_CLAIMS_ENABLED=1)
{
  "grade": "A",                       // strongest claim grade present
  "method": "published_intel",
  "sources": [{ "type": "product_intel_kb", "ref": "product:sig_…" }],
  "claims": [
    { "claim_text": "Niacinamide supports the skin barrier.",
      "evidence_grade": "A",
      "source_refs": ["https://pubmed.ncbi.nlm.nih.gov/…"] }   // ← the citable substrate
  ]
}
```

**Prereq for everything below: PR #1703 merged and deployed to the Railway "Pivota Agent" prod.**

## Phase 1 — turn on the read surface + citations (no OAuth yet)

Set on Railway (Pivota Agent → production). All three default **off**; flip them together so the moment
agents can read intel it already carries citations:

```text
AGENT_INTEL_PUBLIC_CLAIMS_ENABLED=true        # PR #1703 — claims+citations on the get_intel signal
AURORA_BFF_PRODUCT_INTEL_AGENT_ENABLED=true   # de-gate get_intel  (else returns {signals:[],reason:"disabled"})
AURORA_BFF_RELATIONSHIP_GRAPH_AGENT_ENABLED=true  # de-gate get_alternatives
```

**Verify (no connector needed)** — confirm the served bundle carries the claims before exposing `/mcp`.
The pilot is `sig_42edfffb0998c8e528926e26e82a7945` (Aruen Tofu Collagen). Use `get_pdp_v2` with
`include:["product_intel"]` (admin/agent rail) and assert `evidence_claims` + `public_claims` are
present and grade A–C — this is the same data `get_intel` now projects. The public proof already
holds: `agent.pivota.cc/products/{pilot}` JSON-LD shows 6 grade-A PubMed claims.

> Quality bar is unchanged: only Tier-H (human-reviewed) **or** Tier-G (grounded) intel reaches a
> buyer-facing agent (`isServableProductIntelBundle`); thin/pilot/unreviewed entries still drop.

## Phase 2 — make `/mcp` reachable

```text
AGENT_CHECKOUT_STRICT=1     # /mcp returns 404 until this is on
```

> This same flag also unlocks the *checkout* tools on `/mcp`, but they stay independently gated by
> `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED` / `AGENT_CHECKOUT_HOSTED_LINK_ENABLED` (both default
> **off**). For a pure citation connector, **leave those off** — reads are the whole point.

## Phase 3 — keyless OAuth channel (required for a *published* connector)

Native MCP clients connect over **OAuth 2.1 only** (never a pre-shared key). Pivota is the resource
server (built + tested, flag-gated by `MCP_OAUTH_ENABLED`). The Authorization Server is **our own
`pb-oauth-as`** — already MCP-purpose-built (DCR / PKCE-S256 / RFC 8707 / RS256+JWKS / consent). **No
external vendor.** See [`adr_mcp_oauth_authorization_server.md`](adr_mcp_oauth_authorization_server.md).

**(a) Deploy `pb-oauth-as`** (issuer `https://api.pivota.cc`):

```text
MCP_OAUTH_AS_ENABLED=1
MCP_OAUTH_AS_ISSUER=https://api.pivota.cc
MCP_OAUTH_AS_PRIVATE_KEY_PEM=<RSA-2048 private key, PEM>   # stable across instances/restarts
MCP_OAUTH_AS_REQUEST_SECRET=<32+ char secret>             # consent HMAC
MCP_OAUTH_AS_LOGIN_URL=<buyer login URL>                  # else unauthenticated → 401
```

**(b) Point PIVOTA-Agent's verifier at it** (Railway "Pivota Agent" prod):

```text
MCP_OAUTH_ENABLED=1
MCP_OAUTH_RESOURCE=https://pivota-agent-production.up.railway.app/mcp
MCP_OAUTH_AUTHORIZATION_SERVERS=https://api.pivota.cc
MCP_OAUTH_ISSUERS_JSON=[{"iss":"https://api.pivota.cc","jwksUri":"https://api.pivota.cc/.well-known/jwks.json","algs":["RS256"]}]
```

`MCP_OAUTH_RESOURCE` must **exactly** equal the `resource`/`aud` the AS mints (pb-oauth-as already pins
this value in its tests), or audience verification fails closed. Note **RS256**, not ES256.

**Note for read-only:** because discovery tools need no `user_ref`, you do **not** need
`PAYMENT_ISSUERS_JSON`, and the `acp_session_id` binding review item (open item #1 in the OAuth front-door
doc) does **not** block reads — it only matters for money ops. So the citation connector can ship
ahead of the paid-MCP review.

**Verify:** `GET https://api.pivota.cc/.well-known/oauth-authorization-server` → 200 (+ `/.well-known/jwks.json`);
`POST https://api.pivota.cc/oauth/register` with a redirect_uri → 201 (DCR works); on the Agent,
unauthenticated `GET /mcp` → **401 + `WWW-Authenticate`** and `GET /.well-known/oauth-protected-resource`
→ **200** (RFC 9728 doc).

## Phase 4 — publish one connector

1. Point a **Claude connector** (or ChatGPT MCP app) at `https://pivota-agent-production.up.railway.app/mcp`.
   The client auto-discovers the AS from the protected-resource metadata, runs DCR + consent, gets a
   token, then `tools/list` → `get_intel` / `search_catalog` / `get_product` / `get_alternatives`.
2. **End-to-end citation check:** from the connected client, ask about the pilot product and confirm the
   model surfaces the **grade-A PubMed claims** from `get_intel.evidence.claims[].source_refs` — i.e. it
   can *cite* Pivota, not just paraphrase. This is the first real proof-of-citation that doesn't wait on
   organic crawl/index.

## Rollback

Every flag is additive and independently reversible. To fully revert: unset the three Phase-1 flags
(get_intel returns to its prior no-claims shape — byte-for-byte), `MCP_OAUTH_ENABLED=0` (OAuth channel
off, behavior byte-identical to api-key), `AGENT_CHECKOUT_STRICT=0` (`/mcp` → 404). No data migration,
no schema change.

## Checklist

- [ ] PR #1703 merged + deployed
- [ ] `get_pdp_v2 include:[product_intel]` on the pilot shows graded `public_claims` with citation URLs
- [ ] Phase-1 flags on; `get_intel` returns `evidence.claims[]` with `source_refs`
- [ ] `AGENT_CHECKOUT_STRICT=1`; payment/hosted-link flags confirmed **off**
- [ ] `pb-oauth-as` deployed at `https://api.pivota.cc` with `MCP_OAUTH_AS_*` env (DCR confirmed via `/oauth/register`)
- [ ] `MCP_OAUTH_*` set; discovery returns 200; unauthenticated `/mcp` returns 401 + challenge
- [ ] One connector published + a real frontier client cites the pilot's grade-A claims
