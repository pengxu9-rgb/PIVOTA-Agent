# Markato Quality Repair Closeout - 2026-05-26

## Scope

Strict Markato project cohort:

- 19 brands
- 111 target products
- Wave5 domains plus wave6-wave22 targeted product IDs from reviewed Markato artifacts

## Production Writes

No `railway up` was used.

Production DB writes completed:

- Full cohort catalog/serving/index resync:
  - requested IDs: 111
  - mirrored rows: 110
  - skipped: 1 Coconut Matter Hand Balm, `identity_review_required`
  - product upserts: 110
  - SKU upserts: 153
  - offer upserts: 153
  - index state upserts: 110
- Cactus Nectar reviewed INCI patch:
  - updated rows: 1
  - catalog product updates: 1
  - identity updates: 1
  - patched fields: `pdp_details_sections`, `pdp_ingredients_raw`, `raw_ingredient_text_clean`, `ingredients_inci`
- Nala Care reviewed how-to patch:
  - updated rows: 8
  - catalog product updates: 8
  - identity updates: 8
  - patched field: `pdp_how_to_use_raw`
- Post-content patch resync:
  - requested IDs: 9
  - product upserts: 9
  - SKU upserts: 10
  - offer upserts: 10
  - index state upserts: 9

## DB Cohort Result

After repair:

- catalog PDP coverage: 111/111, 100%
- DB serving-ready: 110/111, 99.1%
- identity-ready: 110/111, 99.1%
- reviewed/high-quality product intel: 110/111, 99.1%
- brands at 100% DB serving-ready: 18/19
- only DB blocker: Coconut Matter Hand Balm, `no_seed`/identity hold

DB report:

- `reports/markato_expansion_status_20260524/markato_project_cohort_snapshot_after_content_patch_20260526/markato_project_cohort_report_20260526.md`

## Live PDP Result

Full production live PDP audit after content patch:

- scanned: 111
- ready: 96
- thin: 14
- not_conversion_ready: 1
- weak_insights_ids: 1, Coconut Matter Hand Balm only
- seller_only_insights_ids: 0
- force_filled_ids: 0

Improvement from pre-content patch live audit:

- ready: 87 -> 96
- thin: 23 -> 14
- Cactus Nectar cleared `missing_ingredients`
- Nala Care cleared 8 `missing_how_to` blockers

Live audit report:

- `reports/markato_expansion_status_20260524/markato_quality_repair_20260526/live_pdp_modules_audit_after_content_patch.json`

## Remaining Source-Backed Holds

| Brand | Products | Live status | Remaining blocker |
| --- | ---: | --- | --- |
| Active Drip | 8 | thin | missing official full INCI |
| Coconut Matter | 5 | thin | missing INCI and how-to |
| Coconut Matter | 1 | not_conversion_ready | Hand Balm identity/content hold |
| Delicate Daisys | 1 | thin | missing official how-to for Cleansing Face Milk |

## Verification

- `npx jest tests/scripts/apply_reviewed_external_seed_pdp_content_patch.test.js tests/scripts/audit_external_seed_live_pdp_modules.test.js --runInBand`
  - 2 suites passed
  - 11 tests passed
- production catalog resync dry-run and apply
- production live PDP audit for all 111 Markato target products
- production Markato cohort DB snapshot after content patch

