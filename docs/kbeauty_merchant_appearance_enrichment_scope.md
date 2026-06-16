# K-beauty merchant "appearance" enrichment — scope

**Status:** scope only (no code). **Date:** 2026-06-16.
**Context:** pre-production; testing with a few K-beauty pilot merchants. **Goal / value loop:**
a merchant integrates with Pivota → their catalog is **enriched** (grounded product dossier) →
becomes **serving-eligible** → is **published** as citable structured data on the public PDP →
frontier models (ChatGPT/Claude/Gemini) crawling it have a reason to **cite Pivota** → the lift is
**measured** by agent-center. K-beauty is the ideal first cohort: INCI/actives-heavy, which is exactly
what the grounded dossier engine is strongest at (soy isoflavones, adenosine, niacinamide, …).

## The loop today — 3 of 4 stages exist; the gap is PUBLISH

| Stage | Mechanism | State |
|---|---|---|
| 1. ENRICH | `scripts/backfill_grounded_product_intel_to_kb.js --product-ids <catalog>` → Tier-G grounded dossiers (graded A–D, INCI-grounded, cited, FTC-screened) into `aurora_product_intel_kb` (dry-run default; `--write`) | **EXISTS** |
| 2. SERVE-ELIGIBLE | `src/services/catalogRowTrustUpserter.js::upsertCatalogRowTrustForSourceListingRefs(...)` → flips `serving_eligible` → product enters sitemap + retrieval | **EXISTS** |
| 3. PUBLISH | grounded claims onto the public PDP's crawlable schema.org JSON-LD | **THE GAP — this scope** |
| 4. MEASURE | agent-center real-mode probe (Gemini/ChatGPT/Claude) → per-SKU visibility/citation score | **EXISTS** (mock-by-default; real run is billed) |

**Why PUBLISH is the gap (confirmed live):** the pilot PDP renders JSON-LD that is **identity-only**
(name/brand/sku/offers/breadcrumb — no rating, no claims). A crawler can confirm the product exists but
has nothing to cite Pivota *for*. Three reasons, all in the data path:
- `productJsonLd.ts:802` (`buildProductJsonLd`) emits identity/offers only; its context is just
  `{reviewsModule, recommendationsModule}` — `product_intel` is never passed in.
- The PDP server render `PDP_SERVER_INCLUDE` (`pivota-agent-ui .../products/[id]/page.tsx:38-43`) does
  **not request** `product_intel`, so the grounded bundle isn't even fetched server-side.
- Grounded synthesis is behind `PDP_GROUNDED_PRODUCT_INTEL_ENABLED` (default **OFF**).

The grounded claims themselves are real and citable: `buildEvidenceClaims`
(`src/groundedProductIntel.js:418-465`) → per-claim `{claim_text, source_ref (the active),
evidence_grade A–D, substantiation_status, mechanism, confidence, source_refs [citation URLs]}`, served
in `get_pdp_v2`'s `product_intel` module (`server.js:40491`).

## Phase 0 — VALIDATE FIRST (read-only; do before ANY build)

The mapper flagged a make-or-break assumption, and after the WS1.2 incident we validate assumptions
*before* writing: grounded bundles carry `evidence_profile='grounded_verified'`, but
`PROTECTED_EVIDENCE_PROFILES` lists only `community_supported`
(`src/services/pivotaInsightsQuality.js:27`). The public gate is
`classifyPivotaInsightQualityLane().public_ready === true` (= lane `keep` + `displayable`, `:254`);
`seller_only` → `suppress_public` (agent-OK but **not** public, `:227-233`).

**If a grounded bundle does NOT classify `public_ready: true`, the whole feature silently emits nothing.**
So Phase 0 is two read-only checks:
1. Run `classifyPivotaInsightQualityLane` on a real **grounded** bundle (the Aruen pilot) → assert
   `public_ready === true`. (Unit test against a grounded fixture, or a read-only probe via `_debug`.)
   Trace `isKeepQualityInsight` (`:174`) / `isProtectedPivotaInsight` (`:158`) for `grounded_verified`.
2. With `PDP_GROUNDED_PRODUCT_INTEL_ENABLED` on (flagged/non-prod), fetch `get_pdp_v2` for the pilot
   incl. `product_intel` → confirm the bundle carries `evidence_claims` with grade A–C + substantiated +
   `source_refs`, and that `isServableProductIntelBundle` → tier `grounded`.

**Outcome gates the rest:** if `public_ready` is false for grounded, fix the classifier (add
`grounded_verified` to the keep/protected path) FIRST — that's a backend one-liner, not UI work.

## Phase 1 — the JSON-LD enrichment (`pivota-agent-ui`)

1. **Fetch the data:** add `'product_intel'` (and `'active_ingredients'`/`'ingredients_inci'` if the
   builder needs them) to `PDP_SERVER_INCLUDE` (`page.tsx:38-43`).
2. **Thread it through:** read the `product_intel` module in `page.tsx` (mirror `reviewsModule`,
   `:314-316`) and pass it into the builder context (`:321-331`). Extend `ProductJsonLdContext`
   (`productJsonLd.ts:37`) and the UI `ProductIntelCoreData` type (`types.ts:379-397`) to surface
   `evidence_claims`.
3. **Emit (schema.org):** add a claim→`additionalProperty` mapper in `productJsonLd.ts` (near `:944`),
   using the codebase's existing idiom (`PropertyValue`, `:569-574`). Per public-safe claim:
   ```js
   { '@type': 'PropertyValue', name: claim.source_ref /* the active */,
     value: claim.claim_text, url: claim.source_refs?.[0] /* citation */ }
   ```
   **Do NOT** use `Review`/`AggregateRating` for claims (collides with the synthetic-review suppression
   `_isSyntheticReviewsModule` `:704` and the spam-flag posture), and **not** `Drug` (cosmetic; drug
   language is already stripped by `claimSafe`/`DRUG_RE`, `groundedProductIntel.js:34`).
4. **PUBLIC-SAFE filter (compliance — the crux), matching the existing posture:**
   - Bundle: `public_ready === true` AND `isServableProductIntelBundle` (tier `human`|`grounded`).
     Exclude `suppress_public` / `seller_only`.
   - Per claim: `substantiation_status === 'substantiated'` AND `evidence_grade ∈ {A,B,C}` (same filter
     as `scripts/backfill_grounded_product_intel_to_kb.js::countGradedClaims`, `:60-65`). Drop grade-D,
     `unverified`, and all `marketing_vs_reality`/`flagged`.
   - Cap to ~top 5 claims by grade → keep the JSON-LD lean + defensible.
   - Keep `aggregateRating` real-only (unchanged). Respect the file header guardrail (`productJsonLd.ts:16`).
5. **Gate the emission** behind a flag (e.g. `PDP_PUBLIC_GROUNDED_CLAIMS_JSONLD_ENABLED`, default off) so
   it ships dark and we validate on the pilot before the cohort.

## Phase 2 — onboarding wiring (makes the loop automatic per merchant)

So "any K-beauty merchant that integrates gets enriched + improved appearance" is true without manual
runs: on merchant catalog ingest, trigger the existing CLI over that merchant's product IDs
(`backfill_grounded_product_intel_to_kb.js --product-ids`/`--products-file`) → then
`upsertCatalogRowTrustForSourceListingRefs` to flip serving-eligibility. The grounded bundle then flows
into `get_pdp_v2` automatically and (Phase 1) into the public JSON-LD. Productize the trigger as an
"enrich-on-onboarding" job hung off the merchant integration event.

## Phase 3 — measure the lift (close the loop)

Run the agent-center real-mode probe on the pilot merchant's SKUs **before and after**, compare the
per-assistant visibility/citation score. This is the proof the loop works — and the merchant-facing
dashboard (`pivota-merchants-portal/app/dashboard/agent-center`) already renders it. (Billed frontier
calls — run on explicit go.)

## Guardrails & risks
- **Compliance (FTC / Google spam):** only review-gated, substantiated, cosmetic claims via the SAME
  gate the agent surface already uses; no fabricated reviews/ratings; cap claim count. Validated Phase 0.
- **The classifier-vs-profile mismatch (Phase 0)** is the single make-or-break — confirm before UI work.
- **Cross-repo:** pivota-agent-ui (JSON-LD + fetch) + PIVOTA-Agent (gate/intel + onboarding CLI) +
  backend (serving-eligibility). Coordinate; flag-gate each side.
- **Coverage:** only `serving_eligible` products are published/retrievable — Phase 2 must flip it.

## Sequencing
Phase 0 (validate, read-only) → [fix classifier if needed] → Phase 1 (JSON-LD enrichment, flag-gated,
validate on the Aruen pilot via Google Rich Results / raw JSON-LD) → Phase 3 (measure lift on the pilot)
→ Phase 2 (productize onboarding trigger) → roll to the other K-beauty pilot merchants.

**Recommended first step:** Phase 0 — it's read-only and it's the thing that decides whether the whole
approach is viable.
