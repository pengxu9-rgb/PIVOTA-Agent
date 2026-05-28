# Wave46 Oio Lab Source-Gap Recovery Closeout

Generated: 2026-05-28

## Scope

- Expansion lane: Markato source-gap recovery with official public PDP evidence.
- Target row:
  - Oio Lab `ext_3a23e2090b4ac8dfcf1301fc` Aquasphere
- Official source:
  - `https://us.oiolab.co/products/aquasphere`
- Guardrail: only official PDP HTML fields were used. No seller-only fallback was used.

## Operator Script Update

- Added Oio Lab host support for `us.oiolab.co`, `en.oiolab.co`, and `pl.oiolab.co`.
- Added a bounded Oio Lab extractor for:
  - FAQ-style `Ingredients` sections.
  - `Daily ritual` how-to sections.
- Existing validation gates still apply before fields are accepted:
  - full/short/single-botanical INCI checks.
  - how-to text quality checks.
  - title match and official-page fetch checks.

## Production Writes

Dry-run baseline before the Oio-specific extractor:

- scanned: 1
- dry_run: 1
- fields found: `pdp_details_sections` only

Dry-run after the Oio-specific extractor:

- scanned: 1
- dry_run: 1
- fields found:
  - `pdp_how_to_use_raw`: 1
  - `pdp_details_sections`: 1
- extracted evidence:
  - ingredients chars: 667
  - how-to chars: 283
  - details sections: 2

Apply:

- scanned: 1
- updated: 1
- skipped: 0
- failed: 0
- fields written:
  - `pdp_how_to_use_raw`
  - `pdp_details_sections`
- serving mirror sync:
  - `catalog_products`: 1
  - `pdp_identity_listing`: 1

## Live PDP Quality

Live PDP module audit after apply:

- scanned: 1
- ready: 1
- thin: 0
- not_conversion_ready: 0
- weak_insights_ids: 0
- seller_only_insights_ids: 0
- force_filled_ids: 0
- content_gap_ids: 0

## Latest Markato Rollup

Fresh rollup after the Oio apply:

- production_rows: 602
- catalog_attached: 602/602 (100%)
- index_serving_eligible: 345/602 (57.3%)
- identity_ready: 347/602 (57.6%)
- product_intel_high_quality: 492/602 (81.7%)
- lane_counts:
  - ready_or_covered: 156
  - hold_source_gap: 83
  - hold_risk_review: 361
  - identity_refresh: 2
- recommended_next_batch_rows: 2

Current recommended rows:

- Miss Nella `ext_33466da0907b256ffc53783b` Blush
- Miss Nella `ext_e9e3fba6b05911bba1bfe71e` Eye Shadow

Note: UpCircle `ext_32e72e7e518f4dfa532a191d` Home Mist with Lemongrass + Grapefruit Water is `ready_or_covered` in this fresh rollup. This wave did not force any UpCircle identity or serving sync.

## Artifacts

- `oio_official_html_dry_run/dry-run.json`
- `oio_official_html_dry_run_v2/dry-run.json`
- `oio_official_html_apply/apply.json`
- `live_pdp_modules_audit_after_apply.json`
- `latest_rollup_after_oio_apply/`

No `railway up` was run.
