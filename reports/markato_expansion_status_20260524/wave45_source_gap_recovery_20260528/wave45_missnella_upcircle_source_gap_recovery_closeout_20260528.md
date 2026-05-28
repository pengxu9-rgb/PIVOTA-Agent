# Wave45 Miss Nella / UpCircle Source-Gap Recovery Closeout

Generated: 2026-05-28

## Scope

- Expansion lane: Markato source-gap recovery with official public PDP evidence.
- Target brands:
  - Miss Nella
  - UpCircle Beauty
  - small probe hold checks for Baie Botanique and Byra
- Guardrail: only official HTML fields were used. No seller-only fallback was used.

## Production Writes

Official HTML source-field apply:

- Initial mixed-brand dry-run: 24 scanned, 17 dry_run, 7 skipped, 0 failed.
  - fields found: `pdp_ingredients_raw` 9, `pdp_how_to_use_raw` 14, `pdp_details_sections` 17.
- Applied full source-backed fields to 9 rows:
  - 2 UpCircle rows.
  - 7 Miss Nella rows.
  - fields written: `pdp_ingredients_raw`, `pdp_how_to_use_raw`, `pdp_details_sections`.
- Remaining Miss Nella source-gap dry-run: 70 scanned, 25 dry_run, 45 skipped, 0 failed.
  - fields found: `pdp_ingredients_raw` 7, `pdp_how_to_use_raw` 9, `pdp_details_sections` 25.
- Applied full source-backed fields to 7 additional Miss Nella rows.

Catalog / identity / serving sync:

- First sync apply: 6 rows promoted.
  - 3 rows held as `identity_review_required`: UpCircle Home Mist, Miss Nella Blush, Miss Nella Eye Shadow.
  - product upserts: 6
  - SKU upserts: 10
  - offer upserts: 10
  - index-state upserts: 6
  - identity live-read updates: 6
  - stale SKU/offer deletes: 6 each
- Second Miss Nella sync apply: 7 rows promoted.
  - product upserts: 7
  - SKU upserts: 13
  - offer upserts: 13
  - index-state upserts: 7
  - identity live-read updates: 7
  - stale SKU/offer deletes: 7 each

## Newly Ready Rows

13 rows moved through source recovery and serving sync into live-ready PDP coverage:

- UpCircle Beauty: 1
  - `ext_aafb624684ba1a334a53a076` Flaura Eau De Parfum
- Miss Nella: 12
  - `ext_5b4820a93b2ff42fde402c6e` Alien Poo: Chrome Green Peel Off Nail Polish
  - `ext_61433fafb09e5fdde9d18422` Complete Eye Shadow Collection
  - `ext_83b5f562450f09c98c4dccb8` Happily Ever After: Pink Fine Glitter Peel Off Nail Polish
  - `ext_0bc6e4f7a15288822029334f` Itsy Glitzy Hippo: Sparkly Pink Peel Off Nail Polish
  - `ext_cf0f60c66afa3fb09944df4d` Lip Balm
  - `ext_b575a7ed71f0a4602a68c461` Nail Stickers
  - `ext_c6ea506cdaf48368131bfd6e` Once Upon A Time: Light Blue Fine Glitter Peel Off Nail Polish
  - `ext_026bb78a257f8ca3690ee787` Rawr-Some: Metallic Blue Peel Off Nail Polish
  - `ext_84caa40e0fafcee350045f96` Shooting Star: Sliver Peel Off Nail Polish
  - `ext_b36f6a65ae2c8f16e03809ab` Sparkly Zebra: Sparkly Lilac Peel Off Nail Polish
  - `ext_623cf12819008c78502d9e6a` Sweet-Osaurus: Metallic Bronze Peel Off Nail Polish
  - `ext_45317ff964aa286c595a250d` You're So Spacial: Chrome Blue Peel Off Nail Polish

## Live PDP Quality

Live PDP module audit after first 6-row sync:

- scanned: 6
- ready: 6
- thin: 0
- not_conversion_ready: 0
- weak_insights_ids: 0
- seller_only_insights_ids: 0
- force_filled_ids: 0
- content_gap_ids: 0

Live PDP module audit after second 7-row sync:

- scanned: 7
- ready: 7
- thin: 0
- not_conversion_ready: 0
- weak_insights_ids: 0
- seller_only_insights_ids: 0
- force_filled_ids: 0
- content_gap_ids: 0

Combined live PDP module audit for all 13 newly promoted rows:

- scanned: 13
- ready: 13
- thin: 0
- not_conversion_ready: 0
- weak_insights_ids: 0
- seller_only_insights_ids: 0
- force_filled_ids: 0
- content_gap_ids: 0

## Latest Markato Rollup

Final rollup after the second Miss Nella sync:

- production_rows: 602
- catalog_attached: 602/602 (100%)
- index_serving_eligible: 344/602 (57.1%)
- identity_ready: 346/602 (57.5%)
- product_intel_high_quality: 480/602 (79.7%)
- lane_counts:
  - ready_or_covered: 154
  - hold_source_gap: 84
  - hold_risk_review: 361
  - identity_refresh: 3
- recommended_next_batch_rows: 3

Brand-specific latest:

- Miss Nella: 198 rows, 19 ready_or_covered, 63 source gaps, 2 identity_refresh, 114 risk holds.
- UpCircle Beauty: 103 rows, 11 ready_or_covered, 5 source gaps, 1 identity_refresh, 86 risk holds.

## Remaining Actionable Holds

The remaining 3 recommended rows are source-recovered but still need identity review before serving sync:

- Miss Nella `ext_33466da0907b256ffc53783b` Blush
- Miss Nella `ext_e9e3fba6b05911bba1bfe71e` Eye Shadow
- UpCircle Beauty `ext_32e72e7e518f4dfa532a191d` Home Mist with Lemongrass + Grapefruit Water

Rows not promoted from the dry-run stayed held because official HTML did not provide source-backed full INCI/how-to, or because they were add-on/WH/legacy product surfaces with no usable official fields.

## Artifacts

- `official_html_source_gap_probe_dry_run/dry-run.json`
- `official_html_source_gap_apply_9/apply.json`
- `serving_identity_sync_9_dry_run.json`
- `serving_identity_sync_6_apply.json`
- `live_pdp_modules_audit_6_after_sync.json`
- `missnella_remaining_source_gap_dry_run/dry-run.json`
- `missnella_remaining_source_gap_apply_7/apply.json`
- `missnella_serving_identity_sync_7_dry_run.json`
- `missnella_serving_identity_sync_7_apply.json`
- `live_pdp_modules_audit_missnella_7_after_sync.json`
- `live_pdp_modules_audit_13_after_sync.json`
- `rollup_after_missnella_serving_identity_sync_7/`

No `railway up` was run.
