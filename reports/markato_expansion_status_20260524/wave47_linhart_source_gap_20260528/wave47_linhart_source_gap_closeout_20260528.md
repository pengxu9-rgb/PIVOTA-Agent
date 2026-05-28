# Wave47 Linhart Source-Gap Recovery Closeout

Generated: 2026-05-28

## Scope

- Expansion lane: Markato source-gap recovery with official public PDP evidence.
- Target row:
  - Linhart Smile Care `ext_c1a3aac3be37dcedc3788d6a` Linhart Whitening Pen - NEW ARRIVAL!
- Official source:
  - `https://linhart.nyc/products/linhart-whitening-pen`
- Guardrail: only official PDP HTML fields were used. No seller-only fallback or inferred INCI was used.

## Operator Script Update

- Added a narrow Linhart extractor for Replo/Shopify PDP sections on `linhart.nyc`.
- The extractor accepts:
  - labeled `Ingredients:` text only when it passes existing full/short official INCI checks.
  - bounded `How to Use` and `Formula & Ingredients` details sections.
- The extractor was checked against nearby Linhart pages:
  - Whitening Pen: accepted official ingredients and how-to.
  - Linamel Toothpaste: accepted how-to/details only; no inferred full INCI.
  - Tooth Whitener Gel: accepted how-to/details only; no inferred full INCI.

## Production Writes

Official HTML dry-run:

- scanned: 1
- dry_run: 1
- fields found:
  - `pdp_ingredients_raw`: 1
- extracted evidence:
  - ingredients chars: 129
  - how-to chars: 442
  - details sections: 2

Official HTML apply:

- scanned: 1
- updated: 1
- skipped: 0
- failed: 0
- fields written:
  - `pdp_ingredients_raw`
- serving mirror sync:
  - `catalog_products`: 1
  - `pdp_identity_listing`: 1

Catalog / identity / serving sync apply:

- requested_ids: 1
- fetched_rows: 1
- mirror_rows: 1
- skipped: 0
- product upserts: 1
- SKU upserts: 1
- offer upserts: 1
- group member upserts: 1
- index-state upserts: 1
- identity live-read updates: 1
- catalog row trust upserts: 1
- stale SKU deletes: 1
- stale offer deletes: 1

## Live PDP Quality

Live PDP module audit after serving sync:

- scanned: 1
- ready: 1
- thin: 0
- not_conversion_ready: 0
- weak_insights_ids: 0
- seller_only_insights_ids: 0
- force_filled_ids: 0
- content_gap_ids: 0

## Latest Markato Rollup

Fresh rollup after the Linhart serving sync:

- production_rows: 602
- catalog_attached: 602/602 (100%)
- index_serving_eligible: 346/602 (57.5%)
- identity_ready: 348/602 (57.8%)
- product_intel_high_quality: 493/602 (81.9%)
- lane_counts:
  - ready_or_covered: 157
  - hold_source_gap: 82
  - hold_risk_review: 361
  - identity_refresh: 2
- recommended_next_batch_rows: 2

Current recommended rows:

- Miss Nella `ext_33466da0907b256ffc53783b` Blush
- Miss Nella `ext_e9e3fba6b05911bba1bfe71e` Eye Shadow

## Probe Decisions

- OILUJ pages expose common-name oil descriptions and usage, but no official labeled INCI block; no write.
- Moss & Noor shower gel pages expose full INCI, but no official how-to/directions; no write this round.
- Baie Botanique cleanser page still did not expose a bounded product-specific how-to; no write.
- Byra Deep Calm exposes a proprietary blend description, not a full INCI/how-to pair; no write.

## Artifacts

- `linhart_official_html_dry_run/dry-run.json`
- `linhart_official_html_apply/apply.json`
- `linhart_serving_identity_sync_dry_run.json`
- `linhart_serving_identity_sync_apply.json`
- `live_pdp_modules_audit_after_apply.json`
- `live_pdp_modules_audit_after_serving_sync.json`
- `latest_rollup_after_linhart_apply/`
- `latest_rollup_after_linhart_serving_sync/`

No `railway up` was run.
