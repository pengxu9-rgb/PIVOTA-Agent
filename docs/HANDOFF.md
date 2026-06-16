# Handoff — Pivota agent-citation work

_Last updated: 2026-06-16. Orientation + roadmap layer; deep detail lives in the agent
memory files (see bottom)._

## North-star
Get Pivota's product data **read and cited by frontier agents** (ChatGPT/Claude/Gemini).
Business frame = K-beauty merchant value loop: *integrate → enrich → publish citable claims →
get cited*. Pre-prod, testing with a few K-beauty pilots.

**Pilot:** Aruen "Tofu Collagen Dual-Firming Jelly Cream" · `sig_42edfffb0998c8e528926e26e82a7945`
· content_key `ck_a80578c9b07c16e0a4a3d4f0dfc1b5eb` · merchant `external_seed`.

## DONE + LIVE in prod (verified)
1. **find_products_multi active-aware rank** — flag `PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED=true`.
   Pilot ranks **5 / 10 / 17** for soy / adenosine / korean firming cream (was 38).
2. **Operator prompt-test** — `GET /api/admin/find-products-prompt-test?q=&product_id=` (admin key).
3. **WS1 actives derivation + preview** — `GET /api/admin/recall-actives-preview` (single / sample
   coverage). ~84–85% coverage.
4. **★ Public grounded claims in the PDP JSON-LD** (headline):
   - Gateway: gate PR #1701 (Tier-G grounded → `public_ready`) + stamp PR #1702 (`public_ready` +
     filtered `public_claims`). FTC rule single-sourced in
     `pivotaInsightsQuality.filterPublicSafeClaims` (substantiated + grade A–C).
   - UI: pivota-agent-ui PR #250 renders `public_claims` as schema.org `additionalProperty`.
   - Flags ON: `PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED=true` on **Railway (gateway)** + **Vercel (UI)**.
   - **Verified live:** `agent.pivota.cc/products/{pilot}` JSON-LD carries **6 grade-A PubMed-cited
     claims** (Niacinamide ×4, Soy isoflavones ×2).
5. **Citation baseline measured** — real Gemini `pivota_pdp_attribution_test` =
   **`visibility_score: 0/100`** (expected; pre-index). Script:
   `/Users/pengchydan/dev/run_pilot_citation_baseline.sh`.

## Resolved incident (do NOT repeat)
WS1.2 write-back corrupted the pilot's `product_payload` (`seed_data` is a **double-encoded JSON
string**; a jsonb merge turned it into an array → serving regressed 5→19). Fully repaired (rank 5
restored); broken writer + repair + debug endpoints removed (PR #1700).
**Lesson: inspect data encoding before writing; dry-run + pilot-first gating kept blast radius = 1.**

## Open / next (rough priority)
- **A. Re-measure citation** in ~1–2 weeks (re-run the baseline script) → first proof-of-lift.
  Optionally `/schedule` weekly (billed Gemini calls).
- **B. Extend beyond the pilot** — per onboarded merchant:
  `scripts/backfill_grounded_product_intel_to_kb.js --product-ids <catalog>` →
  `catalogRowTrustUpserter.upsertCatalogRowTrustForSourceListingRefs` (serving-eligibility). PDPs
  then auto-publish claims.
- **C. MCP / agent-read hardening** (for the public marketing push). The *fast* citation path (no crawl
  wait). Status:
  - ✅ **Keystone merged (#1703, default off):** `get_intel` no longer drops citation URLs+grades —
    `intelToSignal.js` now surfaces the public-safe grounded claims (reuses `filterPublicSafeClaims`),
    gated by `AGENT_INTEL_PUBLIC_CLAIMS_ENABLED`.
  - ⬜ **Ops/external (turnkey in `docs/mcp_citation_connector_runbook.md`):** flip the 3 read flags
    (`AGENT_INTEL_PUBLIC_CLAIMS_ENABLED` + de-gate `AURORA_BFF_PRODUCT_INTEL_AGENT_ENABLED` /
    `AURORA_BFF_RELATIONSHIP_GRAPH_AGENT_ENABLED`) → `AGENT_CHECKOUT_STRICT=1` (makes `/mcp` reachable) →
    enable MCP OAuth (`MCP_OAUTH_ENABLED`) → **build + publish one connector** (ChatGPT app /
    Claude connector → `/mcp`).
  - **AS is already ours:** `pb-oauth-as` is a purpose-built MCP Authorization Server (DCR/PKCE/RFC 8707/
    RS256+JWKS/consent — its env is `MCP_OAUTH_AS_*`, issuer `https://api.pivota.cc`). No vendor decision.
    Remaining work = deploy `pb-oauth-as` + point the Agent's `MCP_OAUTH_ISSUERS_JSON` at it (RS256). Full
    wiring in `docs/adr_mcp_oauth_authorization_server.md` + `docs/mcp_citation_connector_runbook.md`.
- **D. Phase 2 WS2 (recall)** — searchable actives field + match in both canonical lanes + finish the
  external-seed agent↔backend mirror + tokenize query + trigram index. For *non-category* ingredient
  recall. Scoped in `docs/find_products_multi_phase2_scope.md`.
  ⚠️ WS1.2 write was rolled back — **redesign**: do NOT write into the double-encoded `seed_data`; use
  a dedicated column or the KB grounded path.
- **E. WS3a.2 / WS3b** — merchant-facing "test a prompt" (OAuth + portal) + "suggested compete prompts".
- **F. Crawl acceleration** for `agent.pivota.cc` (Search Console sitemap submission, domain authority)
  to compress organic citation.

## Access / key facts
- **Repos:** `PIVOTA-Agent` (gateway, Node), `pivota-backend` (Python), `pivota-agent-ui`
  (Next.js → Vercel), `pb-oauth-as` (auth).
- **Gateway:** `pivota-agent-production.up.railway.app` (Railway "Pivota Agent"/production). DB = nozomi.
- **Keys (Railway vars):** `AGENT_API_KEY` (agent rail — **leaked, rotate**),
  `ADMIN_API_KEY` (header `X-ADMIN-KEY`), `PROMOTIONS_ADMIN_KEY` (header `X-Pivota-Internal-Key`, for
  `/internal/agent-center/llm-probe`).
- **Inspect the served grounded bundle:** invoke `get_pdp_v2` with `include:["product_intel"]` →
  `review_tier`, `evidence_claims`, `public_ready`, `public_claims`.
- **Citation status:** **readable = YES** (direct read + crawlable JSON-LD); **cited = NOT YET**
  (0 baseline, pre-index). Organic citation ≈ weeks–months, not guaranteed; direct connector = fast
  but undistributed.

## Marketing-portal / MCP positioning (decided this session)
Highlight at rollout as **"agent-ready"** (capability), NOT "agents cite you" (outcome — baseline is
0). Lead with the **AI-visibility score** (the most mature, provable asset). MCP matters most for
**connector distribution** (MCP registries / ChatGPT app store / Claude directory), not the merchant
portal. First close gap C (de-gate/de-loss read tools, OAuth, publish a connector) so the claim is
demoable.

## Loose ends
- `pivota-agent-ui` was mid-WIP on branch `fix/checkout-payment-surface-layout` (checkout work,
  untouched). It will need a **small merge** when syncing `main` (#250 touched `productJsonLd.ts` /
  `page.tsx`).
- `/Users/pengchydan/dev/phase1b-grounded-claims-jsonld.patch` superseded by #250 — deleted.

## Memory (persists across sessions)
`MEMORY.md` index → `pivota-frontier-citation-architecture.md` (north-star + paths live/gated/thin +
this loop), `find-products-multi-recall-lane.md` (recall/rank + the WS1.2 incident), plus
auth/commerce/cost-metering notes.
