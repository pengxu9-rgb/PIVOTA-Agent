# Commerce Index — Recall Convergence + Publish/Citation Plan

**Date:** 2026-06-25 · **Status:** approved, sequencing in progress
**Repos:** `pivota-agent` (gateway, Node) · `pivota-backend` (Python) · `pivota-agent-ui` (Next.js public PDP)
**Parent context:** ADR-007 (citable index vs commerce overlay); the store-less brand + citable recall work shipped 2026-06-24/25.

> **Thesis being served:** a neutral, trust-graded **canonical product index that agents call and cite**, with citation decoupled from commerce. Two issues block that thesis at the infrastructure level: (A) recall logic is forked across two engines, and (B) the richest internal data isn't fully served on the public citation surface. This plan addresses both. Neither needs a redesign — both need *committing and connecting* what already exists.

---

## Part A — Recall stack convergence

### A.0 Grounded diagnosis (what's actually true)

- The **data is unified** (one Postgres: `catalog_products` / `catalog_skus` / `catalog_offers` / `index_pipeline_state`). The fork is in **query + ranking logic**, implemented twice:
  - **Node gateway** — `src/services/canonicalCatalogSearch.js` + the `external_seed` / `ingredient` / `citable` lanes. A hand-port of the Python SQL, **plus every new index primitive** (token matching, brand detection, the citable supplement, store-less surfacing).
  - **Python backend** — `services/pivot_query_service.py` `search_pivot_catalog`. Serves `/v1/pivot/query` + `get_pdp`; home of `RECALL_RELEVANCE_V2`.
- **The live agent path is the gateway, not the backend.** Proven empirically (2026-06-24): `RECALL_RELEVANCE_V2` lives in `search_pivot_catalog` and was **inert** on the live agent beauty path, while every gateway-side change took effect. `/v1/pivot` has **zero callers** from the gateway. So `search_pivot_catalog` is a *parallel* engine serving PDP/citation reads — not the agent search brain.
- **Drift is real and one-directional:** improvements keep landing in only one engine (V2 → backend only; token-match → gateway only — both confirmed). Other candidate divergences (lifecycle/sync gate, the `+200` multi-merchant-canonical boost missing in Node) are **to-confirm**, because Node may enforce equivalent gating via the `index_pipeline_state` eligibility **join** rather than inline columns. Confirm before treating as gaps.
- **The history (agent → backend → agent) wasn't a wrong pick — it was never committing.** The last shift to the gateway was correct (all index primitives work there for real agents). The cost came from keeping *both* as live recall.

### A.1 Decision

**Commit to the Node gateway as the single agent-facing recall core.** This is a code-ownership decision, not a data migration (the DB is already shared).

### A.2 Steps

| # | Step | Repo | Notes |
|---|---|---|---|
| A1 | Designate the gateway as the one recall engine for the agent path; stop treating `search_pivot_catalog` as a live agent search path. | docs/contract | Decision of record |
| A2 | Port the backend-only ranking features into the Node core **once**: RELEVANCE_V2 text/structure split + the `+200` multi-merchant-canonical boost. Confirm the lifecycle/sync gate is covered by the eligibility join; close it if not. | pivota-agent | Bounded one-time work; flag-gated |
| A3 | Demote `search_pivot_catalog` to its non-agent jobs only: PDP detail render, quote/offer resolution, citation read. | pivota-backend | Keeps recall *shape* for those, not a second agent brain |
| A4 | Add a **parity harness**: a golden query set run against both surfaces (gateway recall vs `/v1/pivot`) with a ranking-diff assertion in CI. Fails when a change moves one surface and not the other on a shared concept. | both | This is what makes "two surfaces, one contract" safe instead of hopeful |

### A.3 Validation
- Breadth no-regression on the existing recall harness (`pivota-agent-ui/scripts/eval_corpus_recall_*`).
- Parity harness green (A4) before/after A2.
- Trade-off neutralized: port V2 to Node **now**, while small, rather than letting the gap compound.

> **Part A is NOT in the current implementation slice.** It is the recall track; it follows Part C. Recorded here so the decision is durable.

### A.4 — GROUNDING UPDATE (2026-06-25) + harness shipped

Probing the live surfaces corrected a premise in A.0/A.2:

- **The two surfaces are NOT redundant engines.** The **gateway** `find_products_multi` is a *multi-lane orchestrator* (ingredient-recall / external-seed / canonical / citable + policy); **`/v1/pivot/query`** is the auth-gated citation/PDP search (`search_pivot_catalog`). They **share exactly one duplicated component** — `canonicalCatalogSearch.js` (Node) ↔ `_fetch_canonical_search_rows` (Python) — not a whole duplicated engine.
- **The gateway's beauty ranking does NOT run through `canonicalCatalogSearch`.** Live: "vitamin c serum" → gateway `query_source=agent_products_ingredient_recall_direct`. So **porting RELEVANCE_V2 into `canonicalCatalogSearch` (A.2) would have limited impact on the live agent path** — those queries rank via the ingredient/external-seed lanes, which are gateway-only (no backend twin). This is the key correction: the "two stacks" debt is the *shared canonical-search SQL*, plus a set of *gateway-only orchestration lanes* that aren't duplicated at all.
- **Revised convergence framing:** (1) keep the gateway as the agent orchestrator; (2) treat the shared canonical-search SQL as the one thing that must not drift → guard it with the parity harness + a contract; (3) the gateway-only lanes (ingredient/external-seed) are agent-specific and don't need a backend twin — don't "converge" them, *own* them; (4) re-evaluate whether V2 even needs porting (its win was on `/v1/pivot`; the gateway's relevance problem lives in the ingredient lane, a *different* fix).

**A4 DELIVERED — parity harness (pivota-agent-ui `scripts/recall_parity_runner.mjs`, PR #253 `7c32be30`).** Runs a golden corpus against both surfaces, matches by `content_key`, reports per-query Jaccard overlap + rank divergence + top-1 agreement + summary JSON. Read-only. `PIVOT_TOKEN=<jwt> node scripts/recall_parity_runner.mjs` (/v1/pivot is auth-gated). Smoke-tested (gateway live; pivot auth-failure reported cleanly).

**Next (decisions, not code):** (a) run the harness with a `/v1/pivot` JWT to capture the **divergence baseline** — that data decides whether A.2 is worth it; (b) if the ingredient lane is the real relevance gap, scope THAT fix (not a V2 port); (c) wire the harness into CI as the anti-re-fork guard. No live-ranking change until the baseline + sign-off exist.

### A.5 — BASELINE + DECISION (2026-06-25) — Part A RESOLVED

**Baseline measured** (`recall_parity_runner.mjs`, 53-query corpus, global, matched on `product_key`): **mean overlap 0.244 · top-1 agreement 0.038 · mean rank-delta 2.69 · 41/53 high-divergence**. The two surfaces are *substantially* divergent, and the cause is **structural** (different orchestrators selecting/ranking external seeds differently) — **not a single ranking flag, so a RELEVANCE_V2 port would not have fixed it.** (snapshot: `pivota-agent-ui/reports/recall_parity/baseline_2026-06-25.json`.)

**Crucial nuance: the divergence is LATENT.** Agents hit the **gateway**; `/v1/pivot` has essentially no live agent callers. So 76% divergence costs live traffic nothing today — it's a loaded gun, not an active wound.

**DECISION (founder, 2026-06-25): keep `/v1/pivot` INTERNAL-only.** Therefore:
- **The gateway is the single LIVE agent recall core.** `/v1/pivot` is the internal backend search/PDP path and is **explicitly NOT parity-guaranteed** with the gateway. A2 (V2 port) and A3 (demotion) are **NOT pursued** — the baseline showed the port wouldn't help and convergence isn't warranted while `/v1/pivot` stays internal.
- **Decoupling is now guarded** by `tests/recall_stack_boundary.test.js` (asserts the gateway src has **zero** `/v1/pivot` callers). If a future change wires the gateway to `/v1/pivot`, the test trips — forcing a conscious convergence decision.
- **Re-open only if** `/v1/pivot` is ever promoted to a first-class external surface; then scope true convergence (route one through the other) as its own project, using the parity harness as the before/after gate.

**Part A is RESOLVED as a decision, not a build.** The instrument (harness) exists, the divergence is measured, the cause is understood, and the decoupling is guarded.

---

## Part B — Publish / citation output

### B.0 Grounded status (corrected — more is built than first implied)

| Piece | Status | Evidence |
|---|---|---|
| JSON-LD `Product` structured data | 🟢 **Built** | `pivota-agent-ui/src/app/products/[id]/productJsonLd.ts`; emitted at `…/products/[id]/page.tsx` |
| Indexability / bot access | 🟢 **Built** | `robots.ts` allows GPTBot/ClaudeBot/Google-Extended; PDP `robots:{index:true}`; canonical links |
| Sitemap pipeline | 🟡 **Built, flag-gated** | `sitemap-products.xml/route.ts` → backend `/api/canonical/products`; gated by `INDEX_ELIGIBLE_SITEMAP` |
| **Enrichment on served PDP** | 🔴 **Missing** | `product_enrichment` written but `agent_pdp_v1.py` reads raw catalog / `agent_pdp_view` |
| **Pivota attribution in citation** | 🔴 **Missing** | JSON-LD credits brand/merchant, no `source`/`creditText` for Pivota |
| Citation read API | 🟠 **Spec-only** | ADR-007 P0; no `/agent/v1/citation/{content_key}` route |
| Citation observations | 🟡 **Built, write-only** | `db/audit_evidence.py` `citation_observations` written by audit; no external read |

### B.1 Sequenced items (priority order)

- **B① Serve the enrichment you already generate (highest ROI).** `product_enrichment` (AI-improved titles, bullets, usage scenarios, disclaimers) is populated but the serve path reads the raw merchant catalog. Fix: `LEFT JOIN product_enrichment` in the PDP read and prefer enriched fields when present. Biggest unlock, no new system.
- **B② Put Pivota *in* the citation.** Add `source.name: "Pivota"` + `creditText` to the JSON-LD `Product` so agents parsing it credit Pivota, not only the brand. Few lines; directly on-thesis. Ship with B①.
- **B③ Flip `INDEX_ELIGIBLE_SITEMAP` (canary).** Includes offer-free citable products (store-less brands) in the public sitemap → makes them crawler-discoverable, not just answerable on a direct query. One flag, reversible.
- **B④ Build the citation read API (ADR-007 P0).** `/agent/v1/citation/{content_key}` + `/search` returning a clean envelope (`title, brand, claim_summary, substantiation_basis, trust_grade, canonical_url, cite_as`). The one real new build; the canonical "call us" surface.
- **B⑤ Close the proof loop — read citation observations.** Serve `citation_observations` back (merchant proof loop now; public transparency/network-effect later).

---

## Part C — IMMEDIATE TASK: B① + B② (this slice, do not drift)

**Scope of this slice = B① and B② only.** A3/A4, B③, B④, B⑤ are explicitly **out of scope** for this slice.

### C.1 B① — serve `product_enrichment` on the PDP
- **Where:** `pivota-backend` PDP read path — `routes/agent_pdp_v1.py` (`get_pdp` / `_row_as_product`) and/or the `agent_pdp_view` SELECT.
- **Approach:**
  1. Read `db/product_enrichment.py` for the table shape (`title_override`, `description_markdown`, `bullet_points`, `usage_scenarios`, `regulatory_disclaimer`, `llm_readability_score`, freshness/author columns).
  2. `LEFT JOIN product_enrichment` (by the PDP's product key) into the read.
  3. **Prefer enriched fields when present, fall back to catalog fields when null** — never blank out a populated catalog field with an empty enrichment value. Title: `COALESCE(enrichment.title_override, catalog.title)`. Same pattern for description/bullets/usage.
  4. Surface a small provenance marker (e.g. `content_source: "enriched" | "catalog"`) so we can see coverage and the JSON-LD/citation can reflect it.
- **Guardrails:** read-only addition; no write path; do not regress the raw-catalog fallback; respect existing eligibility/scope gating; keep `offers`/`buyable` semantics unchanged.

### C.2 B② — stamp Pivota attribution in JSON-LD
- **Where:** `pivota-agent-ui/src/app/products/[id]/productJsonLd.ts` (the `Product` builder).
- **Approach:** add machine-readable attribution to the `Product` node:
  - `"creditText": "Data from Pivota"` (or agreed copy),
  - `"isBasedOn"` / `"sourceOrganization"` or a `"publisher"`/`"provider": { "@type": "Organization", "name": "Pivota", "url": "https://agent.pivota.cc" }` — pick the field that best signals Pivota as the **knowledge source/aggregator** without misrepresenting the brand as Pivota.
  - Keep the brand as `brand` (unchanged) — attribution is additive, not a relabel.
- **Guardrails:** additive only; do not alter existing offers/price/availability fields; valid Schema.org (must pass a structured-data validation shape); no visual/UI change.

### C.3 Acceptance criteria
- **B①:** for a product with a populated `product_enrichment` row, `get_pdp` returns the enriched title/description/bullets; for one *without* enrichment, it returns the catalog fields unchanged (no blanks). A provenance marker distinguishes the two.
- **B②:** the rendered PDP's `<script type="application/ld+json">` contains a Pivota `creditText`/`provider` attribution on the `Product`, brand unchanged, JSON-LD still valid.
- No regression to `offers`/`buyable`/eligibility on either change.

### C.4 Validation
- B① (backend): targeted test for the COALESCE/fallback behavior (enriched-present vs enriched-absent); live `get_pdp` on a known enriched product + a non-enriched one.
- B② (ui): unit/shape test on `productJsonLd.ts` asserting the attribution node + brand preserved + schema validity.
- End-to-end: load a public PDP, confirm enriched copy renders and the JSON-LD carries Pivota attribution.

### C.5 Rollout
- B① behind a flag if the enrichment coverage is uneven (e.g. `SERVE_PDP_ENRICHMENT`, default OFF → canary on), so we can confirm no PDP regresses before widening.
- B② is low-risk additive; can ship without a flag but verify structured-data validity first.

### C.6 Git hygiene (per prior lessons)
- `pivota-backend` local checkout rides a **stale branch** (`claude/commerce-index-p0`). **Branch off `origin/main`**, not the local branch. Watch for the `.pyc` stash-collision footgun; keep source edits out of any stash.
- One PR per repo (backend B①, ui B②); validate each before merge.

---

## Guardrails for this slice
- **Do B① and B② only.** Do not start A2/A3/A4, B③, B④, or B⑤ in this slice.
- Additive + fail-safe: never blank a populated field; never change commerce/offer semantics; attribution is additive.
- Follow this plan; if reality diverges from it (e.g. enrichment isn't keyed the way assumed), surface the divergence and adjust the plan doc — don't silently improvise.

---

## C.7 — Implementation outcome (2026-06-25) — the divergence the guardrail caught

**Verifying before building changed B①.** The premise in C.1 ("enrichment written but never read → LEFT JOIN at read") was **wrong**. Ground truth:

- The **E2 publish bridge already exists and is wired.** `services/agent_pdp_view_assembler.py` `assemble_row` overlays `product_enrichment` (`title_override` / `description_markdown` / `bullet_points` / `usage_scenarios`, brand-attested copy winning) **into `agent_pdp_view` at assembly time**, inside `refresh_agent_pdp_view_for_content_key` (→ `_fetch_enrichment_for_canonical`). `get_pdp` reading the view already gets enriched values. A read-time JOIN would have been **redundant**.
- **The real gap** = write-time propagation. Only the merchant add/edit routes re-assembled the view after `upsert_enrichment`. The **automated `product_enrichment_pipeline`** and the **`employee_products`** path wrote enrichment *without* re-assembling, so generated/curated copy sat in `product_enrichment` until some unrelated re-assembly. That's why it *looked* "written but never read."

**B① shipped (corrected mechanism)** — pivota-backend PR #1035 (`5aad3482`): new `refresh_agent_pdp_view_for_enrichment_write(merchant_id, platform, platform_product_id)` resolves `content_key` from `catalog_products` and rebuilds the served view; wired after the success-path upsert in the pipeline + the employee route. **Flag-gated** `SERVE_PDP_ENRICHMENT_ON_WRITE` (default OFF → current behavior; canary per C.5), best-effort (never raises into the writer). 10 tests pass (5 new).

**B② shipped** — pivota-agent-ui PR #251 (`1143418b`): `Product.mainEntityOfPage` → `WebPage` with `publisher` = Pivota `Organization` + `creditText` + `isPartOf` the Pivota `WebSite`. Validator-clean, additive; brand unchanged. 98 tests pass (1 new).

**Go-live:** flip `SERVE_PDP_ENRICHMENT_ON_WRITE` on a canary, confirm a generated-enrichment write reaches the served PDP + a non-enriched product is unchanged. B② is live on deploy (no flag).

**Note for the rest of the plan:** the E2 overlay covers title/description/bullets/usage but **not** `summary_short` / `regulatory_disclaimer_local` / `extra_images` / tags — extend only if a later slice needs them (out of scope here).

> Cross-ref: ADR-007, `external-citation-api-contract.md`, `docs/EXTERNAL_SEED_MAINLINE_BRAND_SCOPING.md`, and the `commerce-index-storeless-brand-decision-layer` memory.
