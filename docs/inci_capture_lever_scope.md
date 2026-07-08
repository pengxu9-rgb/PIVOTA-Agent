# INCI-Capture Lever — scope (Phase 3, unblocks the grounded-dossier tail)

**Date:** 2026-07-08. **Why now:** the grounded-synthesis run (35→608 dossiers,
dossier-bar coverage 4%→~37%) maxed out its addressable surface. The residual
`none` tier (~48% of served products) was probed and is the **genuine uncovered
tail**: 0/72 sampled have any bundle, 71/72 have **no INCI** — the generator
*correctly* skips them because there's no raw material. INCI is the gate.
This lever gets ingredient lists onto those products so the (already-built)
grounded generator can author dossiers for them. See
[grounded-synthesis-scaling] memory + `docs/dossier-authoring-engine-plan.md`.

## The gap (prod-measured 2026-07-08)

Serving products: **7,024**. With INCI: **2,793 (39%)**. **Without INCI: 4,231 (60%).**
By source: external_referral **3,844**, internal_merchant **387**.

Decomposed by *where the INCI could come from* (this is the load-bearing split):

| Cohort | Count | Meaning | Path |
|---|---|---|---|
| **A. Latent** | **457** | INCI already crawled into `external_product_seeds.seed_data` (`inci_list`/`pdp_ingredients_raw`/`raw_ingredient_text_clean`), never ingested into `beauty_sku_ingredients` | **run existing backfill** |
| **B. Seed, no INCI** | **3,238** | seed exists but the crawl never captured INCI (retailer PDPs, image-encoded INCI, thin external seeds — jumiso/ulta/etc.) | **re-source (canonical) or external DB** |
| **C. No seed** | **536** | connected-merchant products with no seed and no INCI | **merchant-provided or crawl** |

Yield rule of thumb: INCI → grounded generator ≈ **40–53%** produce a dossier
(actives must intersect the 126-entry ingredient KB; the KB-breadth lever is
separate). So ~4,231 INCI ≈ up to ~1,700–2,200 more grounded dossiers at the ceiling.

## What already exists (this is mostly RUN, not BUILD)

- **A — latent ingest:** `pivota-backend/scripts/backfill_seed_inci.py` (extract
  seed_data INCI → `ingest_crawled_inci_items` → `refresh_agent_pdp_view_for_content_key`).
  Ran 2026-07-02 (2,841 ingested); 457 accrued since. Dry-run default.
- **B — canonical re-source:** `scripts/source_canonical_inci.py` (per product /
  merchant / category: **discover authoritative source → resolve → ingest by
  ADR-001 precedence**, `--dry-run`). Resolver `services/canonical_inci_resolver.py`
  = `resolve_inci_from_urls` (brand-official PDP crawl) + `extract_inci_from_openbeautyfacts`
  (barcode→OBF adapter). `scripts/recrawl_inci_tail.py` re-crawls the tail.
  `services/canonical_source_discovery.py` finds sources.
- **C — merchant intake:** the ADR-002 AI-readiness gap-list loop (readiness eval →
  per-SKU "missing INCI" gap → merchant fills → verify → author). The eval already
  emits the gap; the intake is the merchant-onboarding ask.

## MEASURED 2026-07-08 (both cheap paths run — updates the plan)

- **Track A latent ingest RAN** (`backfill_seed_inci --apply --limit 0`): candidates=419,
  feedable=193, **inci_written=1**, skipped=192 (outranked=0), apv-refreshed=181.
  → **Track A is ~EXHAUSTED** (the 2026-07-02 run already harvested it; the residual
  latent seed INCI is thin/junk `skipped_thin=226` or blocked at the write gate).
  NOT the ~200-dossier win first estimated. (The 192 feedable-but-skipped with
  outranked=0 is worth a 30-min look — possible ingest-gate skip bug — but don't
  count on it.)
- **Track B canonical re-source DRY-RUN measured** (`source_canonical_inci --dry-run`).
  First sample (80, alphabetical) was a single-brand Glossier skew → 0/80 (Glossier
  PDPs are JS/image-hard — not representative). **Brand-diverse sample (60 distinct
  brands): sourced 17/60 = ~28%**, split brand_official=9 + reseller_listing=8 (Ulta
  etc.); no_inci_sourced=43, no_candidates=0, errors=0. → **Track B is the real win:
  ~28% of the 3,238 ≈ ~900 products get INCI → ~360–450 new grounded dossiers**, using
  EXISTING machinery, no new build. The other ~72% (no extractable INCI on discovered
  pages: image-encoded / JS-rendered) is the genuine hard tail → the licensed-DB /
  vision-OCR decision below.

## Recommended sequence (UPDATED with measured yields)

1. ~~Track A latent ingest~~ **DONE — exhausted (+1). Skip.** (Optional 30-min: check
   the 192 feedable-but-skipped ingest gate.)
2. **Track B — run `source_canonical_inci --apply` over the ~3,238 no-INCI cohort**
   (chunk by `--merchant`/`--category` or product-key batches). Measured ~28% yield →
   ~900 INCI written (brand-official + reseller, ADR-001 precedence-gated). Then
   **re-run the grounded backfill** over the newly-INCI'd products → ~360–450 net-new
   grounded dossiers. Existing machinery, no new build. **This is the primary win —
   do first now.**
3. **Track C — wire the merchant INCI gap-ask (536 no-seed connected + future).**
   Product work in onboarding (ADR-002 readiness gap-list), not a script; compounds.
4. **The ~72% hard tail — DECISION, don't build blind.** Products whose INCI is
   image-encoded / JS-rendered / absent from discovered pages. Options: vision-OCR on
   PDP images, or a **licensed INCI DB** (INCIDecoder / SkinSort / Hwahae — Hwahae best
   for K-beauty). Only pursue after Track B banks its ~28%; size this tail from Track
   B's `no_inci_sourced` breakdown by source/brand first.

## Key unknowns / decisions (do NOT build past these blind)

- **Track B yield is unmeasured** — run the dry-run (step 2) before committing.
  Prior signal is cautionary: **barcode density ≈ 0** in our catalog → OBF-by-barcode
  is mostly unavailable, and OBF coverage was measured at a **~5% ceiling** for our
  indie-K-beauty catalog (see [commerce-index-architecture-verdict] OBF spike). So
  the OBF adapter helps only the mass-market head; the tail leans on brand-official
  PDP crawl (`resolve_inci_from_urls`), which works only where the product has a
  resolvable brand URL whose INCI is **text, not image**.
- **The image-encoded-INCI wall** (retailer PDPs — the OY/jumiso/ulta problem, see
  [retailer-crawl-tierB-verdict]): a real subset of Track B has INCI *only* inside
  product images. Options if that subset is large: (a) vision/OCR extraction, (b) a
  **licensed INCI database** (INCIDecoder / SkinSort / Hwahae — NOT built; a
  licensing + integration decision, Hwahae best for K-beauty). Decide only if the
  dry-run shows this tail is worth it.

## Honesty constraints (non-negotiable — carry from ADR-001/002)

- **Verified, not trusted.** INCI is ingested by **source precedence** (brand-official
  > retailer > merchant-asserted). A wrong INCI is worse than none — it would feed
  the grounded generator false actives → false public claims. The resolver's
  `_clean_and_validate_inci` gate stays; low-confidence resolutions stay unwritten.
- **Fill-only-when-empty / never downgrade** — never overwrite a higher-authority
  INCI with a lower one (existing `skipped_outranked` behavior).

## Success metric

`% of serving products with INCI` (39% today) and, downstream, `grounded-dossier
coverage` (the `eval_dossier_coverage.cjs` number and the served-JSON-LD publish
rate). Track A + resolvable Track B should move INCI coverage from 39% toward
~55–65%; the image-encoded/licensed tail is the ceiling question.
