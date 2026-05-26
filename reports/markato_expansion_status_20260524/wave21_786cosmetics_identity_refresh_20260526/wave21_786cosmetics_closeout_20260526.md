# Wave21 786 Cosmetics Identity + Product Intel Closeout - 2026-05-26

## Scope

- Brand: 786 Cosmetics
- Market: US
- Source: existing official brand-owned seed rows (`786cosmetics.com`)
- Final selected rows: 10 breathable nail polish PDPs
- Final production live PDP status: 10 ready, 0 thin, 0 not conversion ready

## Selection Gate

- Candidate domain probe: 51 active US rows
- Initial blockers: 30 `seed_content_blocked`, 20 `identity_blocked`, 1 `terminal_hold`
- Selected rows: 10 identity-blocked rows with:
  - direct KB `seller_plus_formula`
  - human-reviewed source coverage
  - no direct KB blocking issues
  - `variant_status=no_visible_variant_axis`
  - `active_ingredients_status=not_expected_missing`
- Excluded rows with seed/content blockers or truncated public copy were not promoted.

## Production Writes

- New seed rows inserted: 0
- Catalog sync apply:
  - product upserts: 10
  - SKU upserts: 10
  - offer upserts: 10
  - group member upserts: 10
  - serving/index state upserts: 10
  - identity live-read updates: 10
  - skipped/missing rows: 0
- Product intel KB publish:
  - dry-run validate: 10 entries
  - write: 10 entries
  - skipped rows: 0
  - evidence profile: 10 `seller_plus_formula`
  - review mode: 10 `manual_reviewed_rewrite`

## Quality Fixes

- Added `nail_polish` handling to the reviewed official-seed product-intel builder.
- Added explicit `--include-high-quality-existing` support for protected, human-reviewed, source-backed rows whose live PDP insight still needs a reviewed rewrite.
- The rewrite is still gated by replacement validation and only allowed for source-backed rows with no KB blocking issues.
- No seller-only fallback was published.
- No force-filled ingredient or PDP content was used.
- No `railway up` was used.

## Readiness Results

After catalog sync:

- scanned_rows: 10
- action_required_rows: 0
- db_serving_ready_rows: 10
- public_index_ready_rows: 10
- direct_displayable KB rows: 10
- direct_high_quality_ready KB rows: 10
- rows_with_public_doc: 10
- rows_with_public_doc_and_insight_summary: 10

After product intel publish:

- scanned_rows: 10
- action_required_rows: 0
- db_serving_ready_rows: 10
- public_index_ready_rows: 10
- direct_displayable KB rows: 10
- direct_high_quality_ready KB rows: 10
- rows_with_public_doc: 10
- rows_with_public_doc_and_insight_summary: 10

## Live PDP Audit

Initial live audit after catalog sync:

- scanned: 10
- ready: 0
- thin: 10
- blocker: 10 `missing_or_weak_insights`
- seller_only_insights_ids: 0
- force_filled_ids: 0
- content_gap_ids: 0

Final live audit after reviewed product intel:

- scanned: 10
- ready: 10
- thin: 0
- not_conversion_ready: 0
- weak_insights_ids: 0
- seller_only_insights_ids: 0
- force_filled_ids: 0
- content_gap_ids: 0
- domain rollup: `786cosmetics.com` 10

## Artifacts

- `catalog_sync_dry_run.json`
- `catalog_sync_apply.json`
- `readiness_after_catalog_sync/`
- `live_pdp_modules_audit_after_catalog_sync.json`
- `official_seed_product_intel_report_10.json`
- `product_intel_publish_dry_run.json`
- `product_intel_publish_apply.json`
- `readiness_after_product_intel/`
- `live_pdp_modules_audit_after_product_intel.json`

## Verification

- `node --check scripts/build-reviewed-official-seed-product-intel-report.cjs`
- `npx jest tests/scripts/build_reviewed_official_seed_product_intel_report.test.js --runInBand`
- production catalog sync dry-run/apply
- production readiness audit after catalog sync
- production product intel publish dry-run/apply
- production readiness audit after product intel
- production live PDP module audit

## Remaining Notes

- Single-SKU PDPs expose no displayable variant axis; the live audit did not treat this as a variant blocker because there are no bad `Default` labels.
- External public index push is not configured in this run; DB serving readiness does not require it in the current config.
