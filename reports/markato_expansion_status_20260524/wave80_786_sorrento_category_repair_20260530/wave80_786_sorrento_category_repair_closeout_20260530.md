# Wave80 786 Sorrento Category, Serving, and Commerce Price Repair Closeout - 2026-05-30

## Scope

One 786 Cosmetics row from the Wave79 similar-underfill debug lane:

- `ext_55b774d3c57906a77a7167f0`
- Sorrento - Breathable Nail Polish
- `https://786cosmetics.com/products/sorrento-breathable-nail-polish`

No deploy was run, and `railway up` was not used.

## Reviewer Findings

Wave79 showed Sorrento was a similar-underfill case caused by bad category material, not downstream card filtering. Official PDP evidence supported the nail polish category:

- Official title: `Sorrento - Breathable Nail Polish`
- Official categories included `Breathable Nail Polish` and `Yellow & Orange Nail Polish`
- Official Shopify product JSON exposed one available variant, id `41349208309924`

The first category dry-run correctly blocked because the row still carried stale `derived.recall.category: Powder`. The reviewed overwrite patch replaced that with nail-polish category material.

## Production Writes

Reviewed category patch:

- Updated seeds: 1
- Catalog product updates: 1
- Identity payload updates: 1
- Patched fields: `category`, `product_type`, `category_path`, `catalog_category_path`
- New category path: `beauty/makeup/nails/nail-polish`

Serving/index sync after category repair:

- Product upserts: 1
- SKU upserts: 1
- Offer upserts: 1
- Product group member upserts: 1
- Index state upserts: 1
- Catalog row trust upserts: 1
- Stale canonical SKU/offer deletes: 1 each

Reviewer price catch:

- Strict PDP initially passed after category serving sync, but manual review found the official Shopify JSON and HTML price was `13.99` USD while the live offer/reference data still carried stale `9.79` USD.
- A reviewed source-variant price patch updated the variant to `13.99` from official Shopify JSON.
- A full catalog backfill dry-run was not applied because it would have replaced the reviewed visible `Shade: Sorrento` variant with a quarantined hidden default variant.
- A one-row commerce facts price patch updated only row/seed/snapshot commerce price fields from `9.79` to `13.99`, preserving the reviewed variant.
- The final serving sync refreshed SKU, offer, catalog payload, index state, and agent-safe commerce facts to `13.99`.

## Final Validation

Final KB/commerce readiness:

- Scanned: 1
- Terminal holds: 0
- Action required: 0
- DB serving ready: 1/1
- Public index ready: 1/1
- Direct high-quality product intel: 1/1
- Identity ready: 1/1
- Public dry-run docs with insight summary: 1/1
- Source build failures: 0
- Warnings: 0

Final live PDP module audit:

- Scanned: 1
- Ready: 1
- Thin: 0
- Not conversion-ready: 0
- Weak insights IDs: 0
- Seller-only insights IDs: 0
- Force-filled IDs: 0
- Content-gap IDs: 0

Final strict PDP quality gate:

- Status: passed
- Seed gate: passed
- Extractor gate: passed
- Identity gate: passed
- Product intel gate: passed
- Live PDP gate: passed
- Similar gate: passed
- Variant gate: passed
- Similar count: 6
- Live price: 13.99
- Reference price: 13.99

## Artifacts

- `sorrento_reviewed_category_patch_manifest.json`
- `sorrento_category_patch_dry_run.json`
- `sorrento_category_patch_allow_overwrite_dry_run.json`
- `sorrento_category_patch_apply.json`
- `sorrento_serving_sync_after_category_dry_run.json`
- `sorrento_serving_sync_after_category_apply.json`
- `786_sorrento_source_variant_price_mapping.json`
- `sorrento_variant_price_patch_dry_run/dry-run.json`
- `sorrento_variant_price_patch_apply/apply.json`
- `sorrento_serving_sync_after_price_patch_dry_run.json`
- `sorrento_serving_sync_after_price_patch_apply.json`
- `sorrento_commerce_facts_backfill_dry_run/`
- `apply_sorrento_commerce_facts_price_patch.cjs`
- `sorrento_commerce_facts_price_patch_dry_run.json`
- `sorrento_commerce_facts_price_patch_apply.json`
- `sorrento_serving_sync_after_commerce_facts_patch_dry_run.json`
- `sorrento_serving_sync_after_commerce_facts_patch_apply.json`
- `readiness_after_commerce_facts_resync/`
- `live_pdp_modules_after_commerce_facts_resync.json`
- `strict_pdp_quality_after_commerce_facts_resync_ext_55b774d3c57906a77a7167f0.json`

## Guardrails

- No seller-only fallback was accepted.
- No force-filled ingredient content was accepted.
- No broad backfill was applied after the dry-run showed it would downgrade reviewed variant quality.
- Production writes were exact-row reviewed patches and exact-row serving sync only.
- No Railway deploy was run.
