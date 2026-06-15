# find_products_multi — surface beauty products by their actives (design)

**Status:** design only (no code). **Date:** 2026-06-15. **Author:** investigation handoff.
**Pilot:** Aruen "Tofu Collagen Dual-Firming Jelly Cream"
(`sig_42edfffb0998c8e528926e26e82a7945` / `ck_a80578c9b07c16e0a4a3d4f0dfc1b5eb`, merchant `external_seed`).

## 1. Problem (prod-confirmed 2026-06-15)

For the acceptance queries "soy firming cream", "korean firming cream", "adenosine firming cream",
the pilot does **not** appear in the visible page of `find_products_multi`. Live invoke
(`POST /agent/shop/v1/invoke`) telemetry:

- `query_source = agent_products_beauty_external_seed_mainline` (the **mainline** is the serving path).
- `category_path_prefix = beauty/skincare/moisturize/` → canonical lane runs in **category-bucket mode**;
  288 candidates; `external_seed_count = 0`; all results from `canonical_chain`.
- Pilot is at a **fixed rank 38 / 52** for BOTH "soy firming cream" AND "adenosine firming cream"
  (identical → the active word has zero effect), and **rank 1** for "jelly cream" (a title token).

**Conclusion:** for these (category-bearing) queries this is a **ranking miss, not a candidate-recall
miss** — the pilot is already recalled into the pool but ranked below the visible page because the
ranker has no signal that it is about soy / adenosine. (A non-category ingredient query — e.g. bare
"soy isoflavones" — may additionally be a true recall miss; see Phase 2.)

## 2. Root cause (code-confirmed)

Serving path = `searchBeautyExternalSeedProductsMainline` (`src/server.js:19865`), invoked at
`server.js:42143`, early-returns at `42154`. It runs two lanes and ranks the union:

1. **Canonical** `catalog_products` via `fetchCanonicalChainRows`
   (`src/services/canonicalCatalogSearch.js`). In category mode the WHERE is category-path only
   (`canonicalCatalogSearch.js:345-346`); text is not used.
2. **External-seed** `external_product_seeds` via `queryBeautyExternalSeedRowsFast` (`server.js:15401`);
   text-recall clause (`15767-15784`) — returned 0 here.

The union is scored by **`scoreBeautyExternalSeedProduct`** (`server.js:19674`). It scores
`candidateText = buildFallbackCandidateText(product)` (`server.js:14716`), whose parts are
title / name / brand / vendor / **description** / product_type / category / URLs — **no ingredient or
active names.** The only query-sensitive terms are:

- `+32` iff `candidateText.includes(normalizedQuery)` — the **whole** phrase "soy firming cream"
  (never present) (`server.js:19749`),
- `+220` brand match (`19758`),
- `+140` category match — **uniform across all 288 creams** (`19760`),
- quality / recency tiebreakers (`19783-19795`).

There is **no per-token / actives-aware term** (only a narrow acne-oil regex at `19762-19770`). So
every moisturize-category cream gets the same base; the pilot's position is decided by quality
tiebreakers and is invariant to the active word → fixed rank 38.

Why prior fixes didn't help: the seed's `derived.recall.ingredient_tokens` / `alias_tokens` are
matched only by the **strict** lane (`server.js:2743` / `2767`), which requires
`attached_product_key IS NULL` (`2728`) and so excludes the attached pilot; the canonical builder
(`buildCanonicalChainMainlineProduct:16068`) attaches `description` + `raw_ingredient_text_clean` but
**not** `ingredient_tokens`, and the ranker reads neither into `candidateText`.

## 3. Design overview

The actives must reach the **ranker** (primary lever — fixes the confirmed rank-38 case) and the
**recall** match (secondary lever — fixes true recall misses on non-category ingredient queries).
Deliver in two phases so the high-blast-radius recall SQL changes are decoupled from the surgical
rank change.

**One DB fact to confirm first** (read-only; PROBE 0/1 in `tmp_recall_lane_probes.sql`): does the
pilot's `catalog_products.product_payload` carry `seed_data.derived.recall.ingredient_tokens` /
`retrieval_summary` (and is `raw_ingredient_text_clean` populated)? This decides whether Phase 1 needs
a catalog backfill or can read fields already present. The seed row has the tokens; the catalog mirror
may not.

## 4. Phase 1 — Rank lever (surgical; hits the acceptance criteria; lowest blast radius)

Goal: move the pilot from rank 38 into the visible page for the three acceptance queries, **without**
touching recall SQL or DB schema.

- **1a. Query active/concept tokens.** Add `extractQueryActiveTokens(queryText, intent)` that
  tokenizes the query (`tokenizeSearchTextForMatch`, `server.js:14513`) minus category/stopwords and
  maps known actives via an **expanded** alias table (extend `normalizeIngredientToken`,
  `externalSeedProducts.js:940` — it lacks soy / adenosine / collagen / soy-isoflavone / genistein /
  daidzein today). Output e.g. `{soy, adenosine}` for "soy firming cream" / "adenosine firming cream".
  Note `hasBeautyIngredientIntentSignal` (`server.js:20410`) is too narrow to reuse as-is.

- **1b. Product actives text.** Build `activesText` for each candidate from fields already on the
  product object: external-seed products carry `ingredient_tokens` + `external_seed_recall` +
  `raw_ingredient_text_clean` (`server.js:15347/15338/15339`); canonical products carry
  `raw_ingredient_text_clean` (`16276+`) but **not** `ingredient_tokens` — so extend
  `buildCanonicalChainMainlineProduct` to also project
  `product_payload #> '{seed_data,derived,recall,ingredient_tokens}'` and `retrieval_summary`
  (pending the PROBE 0 confirmation that payload carries them; else backfill payload first).

- **1c. Score term.** In `scoreBeautyExternalSeedProduct` (`server.js:19674`), after the existing
  `+32`/brand/category block, add
  `score += countMatchedActiveTokens(queryActiveTokens, activesText) * W` (start `W≈40`, tune so a
  single active match clears the ~12-18 quality-tiebreak spread that currently buries the pilot).
  Keep it additive and gated so non-beauty / non-active queries are unaffected.

- **1d. Gate.** New env flag e.g. `PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED` (default off → ship dark,
  enable for canary), so rollback is a flag flip.

**Expected effect:** for "soy firming cream" the pilot gains the active-match bonus that generic creams
don't, lifting it above the page cap; "jelly cream" unaffected (already #1); non-active queries
unchanged. Validate by re-running the live invoke and asserting pilot rank ≤ page_size.

## 5. Phase 2 — Recall lever + searchable field + index + backend mirror (general case)

Needed for ingredient-only queries that don't resolve a category (true recall misses) and for
catalog-wide robustness.

- **2a. Tokenize the query for recall.** Today `buildBeautyExternalSeedRecallPatterns` (`server.js:15150`)
  pushes only the whole `%query%`. Add per-active-token patterns (`%soy%`, `%adenosine%`) from 1a so the
  text-recall lane can hit `retrieval_summary` / the new field. (Whole-phrase matching is a co-equal
  blocker — a new field alone won't fix it.)

- **2b. Searchable actives field.** Add an indexable actives/keywords expression to `catalog_products`
  (and `external_product_seeds`) sourced from INCI / `derived.recall.ingredient_tokens` + concept
  aliases. Prefer a generated/materialized text column over deep JSON `#>>` paths for index-ability.

- **2c. Match it in BOTH agent lanes:** `canonicalCatalogSearch.js` `textWhereClause` (`337-344`) and
  `queryBeautyExternalSeedRowsFast` `patternClauses` (`15767-15784`).

- **2d. Mirror in backend (must stay in sync):** `pivot_query_service.py::_fetch_canonical_search_rows`
  and `external_seed_search._build_text_match_clause` (the lane PR #904 already touched).

- **2e. Trigram GIN index** on the matched expression, mirroring the existing
  `idx_external_product_seeds_recall_*_trgm` pattern; perf-test (multi-term ILIKE on these tables is the
  dominant cost per the team).

## 6. Data / backfill

1. Confirm payload contents (PROBE 0/1).
2. Backfill the **pilot** first (catalog_products payload/field + seed), validate live, then catalog-wide.
3. Source of truth for actives = product INCI → active names + concept aliases (grounded), same pipeline
   that wrote the seed's `derived.recall`.

## 7. Perf

- Phase 1 is in-process scoring over the already-fetched ≤288 candidates — negligible cost, no new SQL.
- Phase 2 adds ILIKE terms + an index; bound token count (≤ ~8 active tokens/query), index-back every
  matched expression, and load-test against nozomi before enabling (primary beauty path = high blast).

## 8. Agent ↔ backend mirror checklist

| Concern | Agent | Backend |
|---|---|---|
| Canonical recall SQL | `canonicalCatalogSearch.js` | `pivot_query_service.py::_fetch_canonical_search_rows` |
| External-seed recall | `queryBeautyExternalSeedRowsFast` (`server.js:15401`) | `external_seed_search._build_text_match_clause` |
| Ranker | `scoreBeautyExternalSeedProduct` (`server.js:19674`) | agent-authoritative for find_products_multi (no backend mirror needed for Phase 1) |
| Actives field + index | migration on `catalog_products` / `external_product_seeds` | same migration (shared nozomi) |

## 9. Rollout & validation

- Ship Phase 1 behind `PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED`, canary, re-run the live invoke probe
  (assert pilot rank ≤ page_size for the 3 acceptance queries; "jelly cream" still #1; spot-check a
  dozen unrelated beauty queries for no regression).
- Existing guards to extend: `tests/find_products_multi_rerank_provenance.test.js`,
  `tests/find_products_multi_policy.test.js`,
  `tests/integration/invoke.find_products_multi_cache_search.test.js`.
- Phase 2 after Phase 1 is validated and the index is perf-cleared.

## 10. Risks & blast radius

- Primary beauty recall/ranker = high blast radius. Mitigations: env-gate, additive scoring (no new
  hard filters), Phase split (rank change carries no SQL/schema risk), canary + live-probe assertion,
  agent↔backend mirror discipline for Phase 2.
- Over-boosting actives could pull loosely-related products up; tune `W` against a held-out query set
  and keep the bonus below brand/exact-match weights.
