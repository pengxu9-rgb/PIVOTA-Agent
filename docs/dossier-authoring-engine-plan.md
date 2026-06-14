# Dossier Authoring Engine — build plan & handoff

**Status:** Ready to implement (fresh session). **Date:** 2026-06-14.
**Builds on:** ADR-001 (canonical record; merchant = supplier), ADR-002 (agent decision-intelligence, not fact sheets), `docs/tier-g-evidence-claims-reconciliation.md`.

> **This is NOT the fallback route.** The shipped Tier-G work (item 9: PRs #1674–#1683) is a *serve-time, INCI-gated fallback* that fills gaps when no published intel exists. THIS plan is the opposite: make graded/cited/honest **dossier authoring the PRIMARY, at-rest content engine** for the whole catalog, and demote the positioning-blurb tier. Same output contract (`pivota.product_intel.v1`), different role.

## Why (diagnosis — verified by adversarial agent pass)
Root cause of "agents get minimal content" = **AUTHORING**, not serving/coverage:
- Serving does NOT strip content (`normalizePublishedProductIntelBundle` preserves `evidence_claims`/`community_signals`).
- **No production pipeline authors graded `evidence_claims`** — the only producer is `src/groundedProductIntel.js`. Backfill/social/pilot-publish write positioning snapshots with zero graded claims.
- The lone dossier producer (grounded) is **structurally amputated**: (i) **review-blind** (emits 0 `community_signals`/`review_summary`); (ii) **hard-gated on INCI** (no verified INCI → nothing rich → serve-time seller blurb).

## Baseline (the yardstick — `scripts/eval_dossier_coverage.cjs`, 50 prod products)
- **Meets dossier bar: 4%** · mean 42/100 · tiers: **positioning-blurb 92%**, grounded 4%, none 4%.
- Per-dimension: commerce 98%, honesty 90%, specificity 84%, **structured_why 48%, graded_claims 4%, review_synthesis 0%**.
- Detail snapshot: `docs/data/dossier_baseline_prod_2026-06-14.json`.
- **Rerun after every phase** (`AGENT_KEY=… BASE=… node scripts/eval_dossier_coverage.cjs`) to watch the number climb. This is also the **merchant AI-readiness score**.

## Grounding-truth model
Dossier claims are grounded in TWO source classes, both **verified before they become graded claims**:
1. **Pivota sources (primary, neutral):** curated Ingredient KB (`aurora_ingredient_research_kb`), verified INCI, brand-official crawl, real reviews, transaction outcomes (moat).
2. **Merchant-filled sources (gap-fill):** full INCI, concentrations/ppm, clinical/COA substantiation, certifications — collected at integration.

Discipline (ADR-001/002): merchant data is **verified, not trusted**. Merchant-asserted claims without substantiation stay ungraded/flagged (or feed marketing-vs-reality), never auto-promoted. Concentration/position gating (PRs #1680–#1683) still applies. Preserves neutrality (no pay-to-rank).

## Merchant integration ⟷ readiness intake loop
The AI-readiness analysis at onboarding IS the merchant-source intake:
1. Run the dossier-coverage eval over the merchant's catalog → **readiness score + per-SKU gap list** (missing INCI / ppm / substantiation / reviews).
2. Request the merchant fill exactly those gaps (merchant-filled sources).
3. Verify → author into dossiers → score climbs.
4. Mechanism: reuse the **rebuilt dispatch-agent + fix-after-analysis procedure** to act on the gap list.

## Phased plan (phase → dimension it moves)
- **Phase 0 — DONE.** Dossier-coverage eval + baseline (above).
- **Phase 1 — grounded → PRIMARY at-rest authoring (highest leverage).** Run `buildGroundedProductIntelBundle` as a catalog **backfill that persists to `aurora_product_intel_kb`** (tier=grounded); invert precedence so a graded dossier outranks a positioning blurb; demote/retire `strict_human_manual_rewrite` seller summaries. Fixes latency (served at rest). → drives `graded_claims`, `structured_why`.
- **Phase 2 — close the review half.** Wire `socialEnrichWorker`'s community/theme synthesis (and real-review aggregation) INTO the dossier so `community_signals` isn't permanently `insufficient_feedback`. → drives `review_synthesis` (0% →).
- **Phase 3 — close the INCI/coverage gate (breadth multiplier).** INCI capture-at-ingest + per-active efficacy floors (`task_69a3e5ac`) + KB breadth/alias/compound matching. Honest "limited data" state where INCI truly absent. → expands how many SKUs grounded can author for.
- **Phase 4 — thesis + author-time review gate.** Product-thesis ("does it firm? honest answer") + run the ADR-002 agent adversarial review AT AUTHORING (the generator currently stamps `grounded_pass` without actually running it).
- **Phase 5 — re-verify + roll.** Rerun eval each phase; staging → prod; flag `PDP_GROUNDED_PRODUCT_INTEL_ENABLED` (already ON in prod).

## Pointers
- Engine: `src/groundedProductIntel.js`. Gate/serve: `src/pdpProductIntel.js`. Read side: `src/services/pdpReviewedIngredientAuthority.js`. Authoring (current, blurb-producing): `src/auroraBff/productIntelBackfillRuntime.js`, `socialEnrichWorker.js`, `scripts/publish_product_intel_pilot_to_kb.js`, `scripts/generate_product_intel_with_highlights_v1.js`.
- Eval: `scripts/eval_dossier_coverage.cjs`. Ingredient KB store: `src/auroraBff/ingredientResearchKbStore.js`. Loader: pivota-backend `scripts/load_ingredient_kb_seed.js`.
- Memory: `feedback_agent_decision_intelligence.md` (root-cause + baseline + this plan).
