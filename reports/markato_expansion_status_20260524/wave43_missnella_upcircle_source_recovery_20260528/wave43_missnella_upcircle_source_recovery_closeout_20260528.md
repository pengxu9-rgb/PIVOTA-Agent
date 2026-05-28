# Wave43 Miss Nella / UpCircle Source-Gap Recovery Closeout

Generated: 2026-05-28

## Scope

Recover source-backed PDP content for Miss Nella and UpCircle Markato US rows without seller-only fallback. All production writes were exact-ID scoped and preceded by dry-runs. No `railway up` was used.

## Runtime / Extractor Changes

- Added generic official Shopify PDP field extraction for `missnella.com`, `www.missnella.com`, and `upcirclebeauty.com`.
- Added Miss Nella `<details class="cc-accordion-item">` section extraction.
- Added UpCircle `s_qa_group` / `qa_group_title` section extraction.
- Normalized section headings ending in `?`, so FAQ-style headings can map to `ingredients` / `how_to`.
- Accepted UpCircle how-to copy beginning with `Dab`.
- Cleaned official ingredient prefixes such as `99% NATURAL INGREDIENTS:`.
- Fixed `sanitizeIngredientRawText()` so footnotes like `*Organic ingredients` and `^Natural constituent of essential oils listed` are not treated as trailing ingredient section headings or retained as INCI items.

## Production Writes

### UpCircle

- Official HTML field recovery:
  - Final dry-run: scanned 11, dry_run 11, failed 0.
  - Apply: updated 11/11.
  - Fields recovered: `pdp_ingredients_raw` 11/11, `pdp_how_to_use_raw` 11/11, `pdp_details_sections` 11/11.
- Reviewed category patch:
  - Dry-run: scanned 11, planned 11, blocked 0.
  - Apply: updated 11, catalog product updates 11, identity updates 11.
- Serving/index sync:
  - Dry-run: mirror rows 11, planned SKU rows 15, planned offer rows 15, planned index state rows 11.
  - Apply: product upserts 11, SKU upserts 15, offer upserts 15, group member upserts 11, index state upserts 11, catalog row trust upserts 11.

### Miss Nella

- Exact probe dry-run: scanned 13, dry_run 9, skipped 4, failed 0.
  - 7 nail polish rows had official INCI + how-to + details.
  - 2 roll-on perfumes had how-to/details but no official INCI, so held.
  - 4 Lav Kids rows produced no official fields from current HTML extractor, so held.
- Official HTML field recovery apply for the 7 reviewed nail polish rows:
  - Updated 7/7.
  - Fields recovered: `pdp_ingredients_raw` 7/7, `pdp_how_to_use_raw` 7/7, `pdp_details_sections` 7/7.
- Reviewed category patch:
  - Dry-run scanned 7, unchanged 7, blocked 0. No category write needed; rows already carried `Nail Polish` / `beauty/makeup/nails/nail-polish`.
- Serving/index sync with reviewed identity bootstrap:
  - Bootstrap dry-run: 7/7 servingEligible, contentQualityScore 90.
  - Apply: product upserts 7, SKU upserts 7, offer upserts 7, group member upserts 7, index state upserts 7, identity live-read updates 7, catalog row trust upserts 7.
  - Replaced 7 old canonical SKU/offer rows with Shopify variant-backed SKU/offer rows.

## Validation

- Targeted tests:
  - `npx jest tests/services/pdp_ingredient_authority.test.js tests/scripts/backfill_external_seed_official_html_pdp_fields.test.js tests/scripts/apply_reviewed_external_seed_category_patch.test.js --runInBand`
  - Result: 104 passed.
- UpCircle readiness after DB writes:
  - scanned rows 11, db serving ready rows 11, public index ready rows 11, action required rows 0.
- UpCircle live audit before runtime sanitizer deployment:
  - scanned 11, ready 8, thin 3, blocker `missing_ingredients`.
  - Root cause was runtime sanitizer handling of organic / essential-oil footnotes.
  - Read-only production payload replay against the fixed local runtime confirmed the 3 previously thin rows now produce authoritative `ingredients_inci` data.
- Miss Nella readiness after apply:
  - scanned rows 7, db serving ready rows 7, public index ready rows 7, action required rows 0.
  - Public dry-run docs 7/7, all with insight summary.
- Miss Nella live PDP audit after apply:
  - scanned 7, ready 7, thin 0, not_conversion_ready 0.
  - weak_insights_ids 0, seller_only_insights_ids 0, force_filled_ids 0, content_gap_ids 0.

## Coverage Snapshot

Post UpCircle recovery rollup:

- Production rows: 602.
- Ready or covered: 133.
- Hold source gap: 108.
- Hold risk review: 361.
- UpCircle: 103 rows, 71 index serving eligible, 72 identity ready, 10 ready_or_covered, 7 source-gap holds.

Post Miss Nella + UpCircle recovery rollup:

- Production rows: 602.
- Ready or covered: 140.
- Hold source gap: 101.
- Hold risk review: 361.
- Miss Nella: 198 rows, 7 index serving eligible, 7 identity ready, 7 ready_or_covered, 77 source-gap holds, 114 risk-review holds.
- UpCircle: 103 rows, 71 index serving eligible, 72 identity ready, 10 ready_or_covered, 7 source-gap holds.

## Remaining Holds

- UpCircle: remaining holds are mostly bundles/samples, accessories/tools, wellness/supplement/regulatory-risk rows, and 7 source-gap rows. Formula rows recovered this wave are DB-ready; the 3 live thin rows need the sanitizer runtime deployment from this commit before the live gateway audit turns green.
- Miss Nella: remaining source-gap rows need more selective handling. The roll-on perfumes currently lack official full INCI. The Lav Kids rows did not expose parseable official fields in the current extractor. Many other Miss Nella rows are add-ons, wholesale pack/display rows, nail stickers, bundles, out-of-stock variants, or regulated/risk-review candidates.

## Artifacts

- `upcircle_formula_official_html_dry_run_final/dry-run.json`
- `upcircle_formula_official_html_apply/apply.json`
- `upcircle_category_patch_apply.json`
- `upcircle_serving_sync_after_category_patch_apply.json`
- `upcircle_readiness_after_serving_sync/summary.json`
- `upcircle_live_pdp_modules_audit_after_serving_sync.json`
- `missnella_formula_probe_dry_run/dry-run.json`
- `missnella_nail_polish_official_html_apply/apply.json`
- `missnella_nail_polish_category_patch_dry_run.json`
- `missnella_nail_polish_serving_sync_apply.json`
- `missnella_nail_polish_readiness_after_apply/summary.json`
- `missnella_nail_polish_live_pdp_modules_audit_after_apply.json`
- `latest_rollup_after_missnella_upcircle_recovery/wave24_candidate_rollup.json`
