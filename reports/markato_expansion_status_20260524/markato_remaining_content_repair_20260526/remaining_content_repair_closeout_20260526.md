# Markato Remaining Content Repair Closeout - 2026-05-26

## Scope

Follow-up to the Markato quality repair pass, targeting the remaining live PDP content holds after the cohort reached 96 ready / 14 thin / 1 not conversion-ready.

## Delicate Daisys Fix

Product:

- `ext_99b5d36c01c7614a5de71fa1`
- Cleansing Face Milk Bulgarian Rose
- https://delicatedaisys.com/products/cleansing-face-milk-bulgarian-rose

Reviewed official PDP evidence:

- The official product page includes a Directions for use section with cotton wipe/pad application and no-rinse guidance.

Production writes:

- Reviewed how-to patch:
  - updated rows: 1
  - catalog product updates: 1
  - identity updates: 1
  - patched field: `pdp_how_to_use_raw`
- Catalog/index resync:
  - product upserts: 1
  - SKU upserts: 1
  - offer upserts: 1
  - index state upserts: 1

Verification:

- Delicate single-product live PDP audit: 1 scanned, 1 ready, 0 thin, 0 not conversion-ready
- Full conservative Markato live PDP audit:
  - scanned: 111
  - ready: 97
  - thin: 13
  - not_conversion_ready: 1
  - weak_insights_ids: Coconut Matter Hand Balm only
  - seller_only_insights_ids: 0
  - force_filled_ids: 0

## Transient Live Probe Check

The first full audit after the Delicate patch showed two temporary `product_intel_unavailable` rows:

- `ext_794deab047eb4a75225329df` - Joocyee Color-correcting Primer
- `ext_acff84a9f77766e338b83f44` - NuBest Tall Kids Berry Multivitamin Chewables

Both were retried with `concurrency=1` and `timeout-ms=60000`; both returned ready. The stable full-audit result is therefore the conservative run: 97 ready / 13 thin / 1 not conversion-ready.

## Remaining Partner Data Request

The remaining 14 live non-ready rows need partner or official source data, not fallback fill:

- Active Drip: 8 thin, all missing official full INCI
- Coconut Matter: 5 thin, missing official full INCI and how-to
- Coconut Matter Hand Balm: 1 not conversion-ready, still needs identity/content confirmation plus full INCI and how-to

Request sheet:

- `reports/markato_expansion_status_20260524/markato_remaining_content_repair_20260526/partner_data_request_active_drip_coconut_matter_20260526.csv`

## Artifacts

- `delicate_daisys_cleansing_face_milk_how_to_manifest.json`
- `delicate_daisys_cleansing_face_milk_how_to_dry_run.json`
- `delicate_daisys_cleansing_face_milk_how_to_apply.json`
- `delicate_daisys_catalog_resync_dry_run.json`
- `delicate_daisys_catalog_resync_apply.json`
- `delicate_daisys_live_pdp_audit_after_how_to_patch.json`
- `live_pdp_modules_audit_transient_weak_retry.json`
- `live_pdp_modules_audit_after_delicate_patch_conservative.json`

## Verification Commands

- `npx jest tests/scripts/apply_reviewed_external_seed_pdp_content_patch.test.js --runInBand`
- production reviewed content patch dry-run and apply
- production catalog/index resync dry-run and apply
- production live PDP audit for Delicate Daisys single product
- production conservative full Markato cohort live PDP audit

No `railway up` was used.
