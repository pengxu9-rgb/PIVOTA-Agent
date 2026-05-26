# Wave20 NuBest Official PDP Closeout - 2026-05-26

## Scope

- Brand: NuBest
- Market: US
- Source: official NuBest Shopify PDPs (`nubest.com`)
- Input pool: `agent_wave7_batch_4/accepted_manifests/nubest.json`
- Final selected rows: 10 official PDP rows
- Final production live PDP status: 10 ready, 0 thin, 0 not conversion ready

## Source Gate

- Official PDPs audited: 21
- Selected ready rows: 10
- Held rows: 11
- Source errors: 0
- Selection criteria:
  - brand-owned official PDP
  - USD commerce gate pass
  - in-stock Shopify variants
  - source-backed ingredient accordion
  - source-backed directions/how-to accordion
  - no combo/shaker/gift-card rows

## Production Writes

- External seed creation apply:
  - scanned: 10
  - inserted: 10
  - skipped_existing: 0
  - invalid: 0
  - requires_seed_correction_count: 0
- Public description repair:
  - targeted production seed_data patch: 10 updated
  - surface `description`, `pdp_description_raw`, and variant descriptions were neutralized to avoid public health/growth claim amplification
  - raw official marketing description remains only in authority/provenance fields
- Identity graph apply:
  - source rows scanned: 10
  - identity rows built: 10
  - identity rows written: 10
  - review queue rows: 0
- Catalog sync apply:
  - product upserts: 10
  - SKU upserts: 30
  - offer upserts: 30
  - group member upserts: 10
  - seed attachment updates: 10
  - serving/index state upserts: 10
  - identity live-read updates: 10
  - audit reason: `no_strong_identifier` for 30 variant rows
- Product intel KB publish:
  - dry-run validate: 10 entries
  - write: 10 entries
  - skipped rows: 0
  - evidence profile: 10 `seller_plus_formula`
  - review mode: 10 `manual_reviewed_rewrite`

## Quality Fixes

- Added a Wave20 NuBest official-PDP manifest builder:
  - fetches official PDP HTML and Shopify `.js`
  - extracts Ingredients and Directions accordions
  - writes structured ingredient fields and how-to fields
  - preserves official PDP provenance
  - rejects source-thin rows
- Hardened product-intel builder for wellness supplement rows:
  - `wellness/supplements` now maps to `wellness_supplement`
  - avoids `beauty_product_shoppers`, `step: beauty`, and `texture: beauty_product` leakage
  - compact highlight becomes `Source-backed supplement detail`
- No seller-only fallback was published.
- No force-filled ingredient or PDP content was used.
- No `railway up` was used.

## Readiness Results

After catalog sync:

- scanned_rows: 10
- action_required_rows: 10
- blocker: 10 `kb_missing`
- identity_ready_rows: 10
- rows_with_public_doc: 10
- rows_with_public_doc_and_insight_summary: 0

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

- scanned: 10
- ready: 10
- thin: 0
- not_conversion_ready: 0
- weak_insights_ids: 0
- seller_only_insights_ids: 0
- force_filled_ids: 0
- content_gap_ids: 0
- domain rollup: `nubest.com` 10
- production build observed by audit: `11cee3295883`

## Artifacts

- `build_wave20_nubest_official_manifest.cjs`
- `wave20_nubest_official_candidate_manifest.json`
- `source_probe_audit.json`
- `local_manifest_apply_dry_run.json`
- `local_manifest_apply_dry_run_after_public_description_sanitize.json`
- `prod_db_dry_run.json`
- `prod_db_apply.json`
- `identity_graph_dry_run.json`
- `identity_graph_apply.json`
- `catalog_sync_dry_run.json`
- `catalog_sync_apply.json`
- `seed_data_patch_dry_run_after_public_description_sanitize.json`
- `seed_data_patch_apply_after_public_description_sanitize.json`
- `readiness_after_catalog_sync/`
- `official_seed_product_intel_report_10.json`
- `product_intel_publish_dry_run.json`
- `product_intel_publish_apply.json`
- `readiness_after_product_intel/`
- `live_pdp_modules_audit_after_product_intel.json`

## Verification

- `node --check reports/markato_expansion_status_20260524/wave20_nubest_official_pdp_20260526/build_wave20_nubest_official_manifest.cjs`
- `node --check scripts/build-reviewed-official-seed-product-intel-report.cjs`
- `npx jest tests/scripts/build_reviewed_official_seed_product_intel_report.test.js --runInBand`
- production external seed apply dry-run/apply
- production seed_data patch dry-run/apply
- production identity graph dry-run/apply
- production catalog sync dry-run/apply
- production readiness audit after catalog sync
- production product intel publish dry-run/apply
- production readiness audit after product intel
- production live PDP module audit

## Remaining Notes

- The 11 held NuBest rows were not promoted because they lacked the required live official source coverage, availability, or structured source fields.
- Similar products remain deferred in live PDP (`similar.status=deferred`) and did not block conversion readiness.
- External public index push was not configured in this run; DB serving readiness does not require it in the current config.
