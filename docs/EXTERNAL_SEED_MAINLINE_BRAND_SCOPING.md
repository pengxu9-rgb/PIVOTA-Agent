# Measured task: brand scoping on the external-seed-mainline lane

**Status:** scoped, not built · **owner:** recall · **flag:** new, default OFF (TBD name e.g. `GATEWAY_BRAND_SCOPE_EXTERNAL_SEED`)
**Repo:** `pivota-agent` (the gateway). Sibling of the dynamic-brand-detection work (`GATEWAY_DYNAMIC_BRAND_DETECT`, #1715/#1724) and the top-level-sync fix (#1725).

> **One-line:** dynamic brand detection now fires (catalog cache → `search_decision.brand_entities`), and the *main* `find_products_multi` policy lane is brand-scoped — but the **external-seed-mainline fast-path lane is not**, so multi-term branded queries still return mixed-brand results. This is the original [#1032](https://github.com/pengxu9-rgb/pivota-backend) junk problem, surviving on one lane.

---

## 1. Symptom (live, 2026-06-25, post-`da329cfc`)

| Query | Lane (`query_source`) | Result |
|---|---|---|
| `skin1004` (bare) | `agent_products_search` | brand detected (`sd.brand_entities=['skin1004']`), 0 products → **clarify** (reasonable for a broad bare-brand query) |
| `anuko hair butter` | search_decision lane | `sd.brand_entities=['anuko']`, n=7, **mostly Anuko** (+1 MOYU) ✅ scoped |
| `skin1004 centella ampoule` | `…beauty_external_seed_mainline` | n=6, **all SKIN1004** — but on-brand only by luck of the product terms, not by brand scoping |
| `beauty of joseon serum` | `…beauty_external_seed_mainline` | n=6, **MIXED**: Beauty of Joseon + SKIN1004 + Aetās + TIRTIR ⚠️ |

The `beauty of joseon serum` case is the bug: the brand is a real catalog brand (detectable via the warm cache), the intent is clearly brand-scoped, yet the lane returns a mixed-brand set.

## 2. What already exists (don't rebuild)

The external-seed runtime **already has** brand-scoping machinery — this task is about making it *engage*, not building it:

- `src/findProductsExternalSeedBrandFastpath.js`
  - calls `detectBrandEntities(relevanceQueryText, { candidateProducts: [] })` (`:33`)
  - has brand-scoped strategies `brand_search_external_seed_mainline_exact` (`:261,283`) and `…_broad` (`:366`)
  - emits `external_seed_brand_strict_rows` (`:190`)
- `src/findProductsExternalSeedSupplementRuntime.js`
  - `detectBrandEntities(queryText, …)` (`:68`), derives `brandTerms` (`:70-71`), sets `brand_scope` (`:168,202,390`)

So detection + a brand-exact/broad strategy + strict-row telemetry are all present. The mainline path just isn't routing multi-term branded queries through the scoped strategy.

## 3. Hypotheses to confirm (the investigation)

Pick the actual cause before changing anything — instrument first:

1. **Detection not firing on this lane's call.** `findProductsExternalSeedBrandFastpath.js:33` calls `detectBrandEntities` on `relevanceQueryText` (possibly transformed) with `candidateProducts: []`. Confirm via a temporary log (or extend `/internal/diag/brand-dict`) whether `detectBrandEntities('beauty of joseon serum')` returns `brand_like:true, detection_mode:'catalog'` *on the fast-path's exact input string*. If the input is mangled (e.g. category words appended, or normalized differently than `matchCatalogBrand` expects), detection misses.
2. **Detection fires but the scoped strategy is gated off.** The fast-path may only engage `…_exact` for single-token / exact-title queries and fall through to an unscoped mainline for multi-term queries. Find the branch that chooses `_exact` vs `_broad` vs no-scope and check the multi-term condition.
3. **Scoping applied but not enforced as a filter.** `brand_strict` may *rank* brand rows higher without *excluding* off-brand rows, so a thin BoJ catalog + external-seed fill still injects SKIN1004/TIRTIR. Confirm whether `external_seed_brand_strict_rows` > 0 for the query and whether off-brand rows are dropped or merely deprioritized.

The diag endpoint (`/internal/diag/brand-dict?q=…`) already answers (1) directly — run it with the exact fast-path query string first.

## 4. Fix shape (after the cause is known)

- If (1): normalize the fast-path's detection input to match what `matchCatalogBrand` expects (the brand span survives category suffixes — the cache already does longest-span token matching, so pass the raw normalized query, not a category-stripped one).
- If (2): extend the scoped-strategy gate to engage on multi-term queries where `brand_entities` is non-empty (use the detected brand span as a hard `required_term`, the remaining tokens as `prefer_terms`).
- If (3): make brand-strict an actual filter on the external-seed fill (exclude rows whose brand ≠ a detected `brand_entities` member when `brand_scope` is `broad`/`category_scoped`), not just a rank boost.

All behind a **new default-OFF flag** so it's a canary, independent of `GATEWAY_DYNAMIC_BRAND_DETECT` (which stays the detection gate).

## 5. Validation (mirror #1029/#1032 discipline)

- **Harness:** `pivota-agent-ui/scripts/eval_corpus_recall_runner.mjs` → `…_summarize.mjs`. Breadth must not regress (currently ~62%).
- **Precision (the point):** a fixed set of multi-term branded queries — `beauty of joseon serum`, `skin1004 toner`, `the ordinary niacinamide`, `anuko hair butter` — must return **single-brand** (or detected-brand-dominant) result sets. Add these to `eval_corpus_recall_precision.jsonl`.
- **Over-scoping guard:** non-brand queries (`vitamin c serum`, `gentle cleanser`) must be **unchanged** (no brand filter applied → no recall loss). This is the key risk: a too-eager brand filter starves generic category recall.
- **No-regression on the buyable lane:** confirm `serving_eligible` shopping recall + ordering unchanged.

## 6. Out of scope

- The bare-brand-query → clarify UX (`skin1004` alone) — that's intended.
- The pivota-backend `/v1/pivot` lane (separate stack; its brand handling is its own task).
- Re-litigating `GATEWAY_DYNAMIC_BRAND_DETECT` (detection works; this is purely about *scoping* the external-seed fill once a brand is detected).

> Cross-ref: `commerce-index-storeless-brand-decision-layer` memory (the gateway brand-detection thread, #1715/#1724/#1725 + this gap), `pivota-backend/docs/gateway-brand-detection-recall-fix.md` (#1032, the detection-coverage sibling).
