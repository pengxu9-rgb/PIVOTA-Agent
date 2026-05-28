# Wave44 Delicate Daisys Rose Mist Source Recovery Closeout

Generated: 2026-05-28

## Scope

- Expansion lane: Markato source-gap recovery with official public PDP evidence.
- Primary recovered SKU: `ext_397a1dbbcab4ad4a246b6a8c`
- Product: Delicate Daisys Botanical Beauty `Bulgarian Rose Water Face, Hair & Body Mist Spray`
- Official source URL: `https://delicatedaisys.com/products/bulgarian-rose-water-face-hair-body-mist-spray`

## Result

- Production DB apply: 1 scanned, 1 updated, 0 skipped, 0 failed.
- Applied fields:
  - `pdp_ingredients_raw`
  - `pdp_how_to_use_raw`
  - `pdp_details_sections`
- Serving mirror sync:
  - `catalog_products`: 1
  - `pdp_identity_listing`: 1
- Official extracted content:
  - Ingredients: `Organic Rosa Damascena (Damask Rose) Floral Water`
  - How-to: `Apply on clean skin using a cotton pad or by directly spraying it on your skin. No rinse is necessary.`

## Quality Gates

- Parser/runtime tests:
  - `npx jest tests/pdp_builder_structured_modules.test.js tests/scripts/backfill_external_seed_official_html_pdp_fields.test.js --runInBand`
  - 2 suites passed, 130 tests passed.
- Production dry-run before write:
  - 1 scanned, 1 dry_run, 0 skipped, 0 failed.
  - Planned patch keys matched final apply keys.
- Production readiness after apply:
  - missing_inci: 0
  - missing_how_to: 0
  - missing_details: 0
  - product-intel: displayable, high_quality_ready, reviewed.
- Production live PDP module audit before runtime deploy:
  - 1 scanned, 0 ready, 1 thin.
  - Remaining blocker: `missing_ingredients`.
  - Cause: deployed runtime does not yet accept official `official_html/high` single-ingredient raw INCI as authoritative.
- Main git deploy verification:
  - Production backend `/version`: `8fcc08093abe`, branch `main`, deployment `c2cf926c-3686-4808-811a-bac3da4403ba`.
  - `origin/main` contains merge `3a6640c3` and source recovery commit `ec723b1d`.
- Production live PDP module audit after git deploy:
  - 1 scanned, 1 ready, 0 thin, 0 not_conversion_ready.
  - `weak_insights_ids`: 0
  - `seller_only_insights_ids`: 0
  - `force_filled_ids`: 0
  - `content_gap_ids`: 0
- Production serving/index sync after git deploy:
  - Dry-run: 1 fetched, 1 mirror row, 1 planned index state row, 0 skipped.
  - Apply: 1 product upsert, 1 SKU upsert, 1 offer upsert, 1 group-member upsert, 1 index-state upsert, 1 catalog-row-trust upsert.
  - Stale SKU/offer deletes: 0.
- Markato rollup after serving sync:
  - Production rows: 602.
  - Catalog attached: 602/602 (100%).
  - DB serving eligible: 331/602 (55.0%).
  - Identity ready: 333/602 (55.3%).
  - Product intel high quality: 419/602 (69.6%).
  - Lane counts: ready_or_covered 141, hold_source_gap 100, hold_risk_review 361.
  - Recommended next batch rows: 0.
  - Delicate Daisys: 10 rows, 10 catalog attached, 10 index serving eligible, 10 identity ready, 10 product-intel high quality, 7 ready_or_covered, 0 source gaps.

## Code Changes

- Added generic Shopify official field host support for:
  - `baiebotanique.com`
  - `byrabeauty.com`
  - `delicatedaisys.com`
- Extended generic Shopify extractor to read inline `product: {...}` objects used by Delicate Daisys.
- Added official single botanical INCI gate for extractor writes.
- Cleaned generic overview/how-to extraction so `Caution:` blocks do not leak into display fields.
- Extended PDP ingredient authority so single-ingredient formula products can render an ingredients module when:
  - raw ingredient text is a single structured ingredient, and
  - the field-quality/content-asset marker is official source with high/reviewed quality.

## Probe Outcomes

Initial 3-SKU source-gap probe:

- Baie Botanique `ext_60ded78effb04e9d6389bfce`: held; official page yielded details only, no source-backed INCI/how-to.
- Byra `ext_d2be72abe173e52d5baa6879`: held; official page yielded details only, no source-backed INCI/how-to.
- Delicate Daisys `ext_397a1dbbcab4ad4a246b6a8c`: recovered after adding inline Shopify product object extraction.

No seller-only fallback was used.

## Artifacts

- `source_gap_probe_dry_run/dry-run.json`
- `delicate_rose_mist_dry_run/dry-run.json`
- `delicate_rose_mist_apply/apply.json`
- `delicate_rose_mist_readiness_before_apply.json`
- `delicate_rose_mist_readiness_after_apply.json`
- `delicate_rose_mist_live_pdp_modules_audit_after_apply.json`
- `delicate_rose_mist_live_pdp_modules_audit_after_git_deploy.json`
- `delicate_rose_mist_serving_sync_dry_run_after_git_deploy.json`
- `delicate_rose_mist_serving_sync_apply_after_git_deploy.json`
- `latest_rollup_after_git_deploy/`
- `latest_rollup_after_delicate_serving_sync/`

## Rollup Note

Earlier full Markato coverage rollup refresh was attempted three times after apply, but Railway backboard failed while fetching production environment context:

- `operation timed out`
- `tls handshake eof`

The rollup was successfully re-run after the git deployment and serving/index sync. No `railway up` was run.
