# Wave69 786 Muscat Risk Review + Serving Closeout - 2026-05-30

## Scope

Expanded one reviewed 786 Cosmetics row that was source-rich and identity-ready but still shadow-only in the serving/index lane:

- `ext_9cd211269e8480e6a7475b5e`
- Muscat - Breathable Nail Polish
- `https://786cosmetics.com/products/muscat`

No deploy was run, and `railway up` was not used.

## Review Decision

The row had full source-backed product content, identity readiness, high-quality product intel, USD price, in-stock commerce state, and one exact official PDP. The conservative rollup held it under `regulated_claim_review`, but the source page and product family are a normal nail polish PDP. The reviewer decision was to allow serving/index sync while preserving the normal caution that downstream copy should not amplify nail-health marketing language into therapeutic claims.

The category dry-run exposed a stale `derived.recall.category: Powder` conflict. The official PDP evidence supports `Nail Polish`, so the reviewed category patch used explicit overwrite confirmation.

## Production Writes

Reviewed category patch:

- Updated seeds: 1
- Catalog product updates: 1
- Identity payload updates: 1
- Patched fields: `category`, `product_type`, `category_path`, `catalog_category_path`
- New category path: `beauty/makeup/nails/nail-polish`

Serving/index sync:

- Product upserts: 1
- SKU upserts: 1
- Offer upserts: 1
- Product group member upserts: 1
- Index state upserts: 1
- Catalog row trust upserts: 1
- Stale SKU/offer deletes: 0

Strict PDP QA then found a live price mismatch: extractor/source price `13.99`, live PDP price `8.39`. Official Shopify product JSON for `/products/muscat.js` confirmed one available variant, id `51537209393383`, priced at `1399` USD cents with no compare-at price. A source-backed variant price repair was applied and the exact catalog/offer sync was rerun.

Price repair:

- Variant rows scanned: 1
- Updated: 1
- Patched fields: `variants`
- Re-synced SKU/offer price: `13.99` USD

## Validation

Final KB/commerce readiness:

- Scanned: 1
- DB serving ready: 1/1
- Public index ready dry-run: 1/1
- Action required: 0
- Terminal holds: 0
- Identity ready: 1/1
- Direct high-quality product intel ready: 1/1
- Public doc with insight summary: 1/1

Final live PDP module audit:

- Scanned: 1
- Ready: 1
- Thin: 0
- Not conversion-ready: 0
- Weak insights ids: 0
- Seller-only insights ids: 0
- Force-filled ids: 0
- Content-gap ids: 0

Final strict PDP quality gate:

- Scanned: 1
- Failed: 0
- Seed gate: passed
- Extractor gate: passed
- Identity gate: passed
- Product intel gate: passed
- Live PDP gate: passed
- Similar gate: passed
- Variant gate: passed

## Rollup After Wave69

- Production rows: 613
- Catalog attached: 613/613
- Index serving eligible: 385/613
- Identity ready: 392/613
- Product intel high-quality: 547/613
- Ready or covered: 160
- Hold source gap: 84
- Hold risk review: 369
- Recommended next-batch rows: 0

## Artifacts

- `786_muscat_reviewed_category_patch_manifest.json`
- `786_muscat_category_patch_dry_run.json`
- `786_muscat_category_patch_overwrite_dry_run.json`
- `786_muscat_category_patch_apply.json`
- `786_muscat_category_patch_postcheck_dry_run.json`
- `muscat_serving_sync_dry_run.json`
- `muscat_serving_sync_after_category_dry_run.json`
- `muscat_serving_sync_apply.json`
- `786_muscat_source_variant_price_mapping.json`
- `muscat_variant_price_patch_dry_run/dry-run.json`
- `muscat_variant_price_patch_apply/apply.json`
- `muscat_serving_sync_after_price_patch_dry_run.json`
- `muscat_serving_sync_after_price_patch_apply.json`
- `readiness_after_price_resync/`
- `muscat_live_pdp_modules_after_price_resync.json`
- `muscat_pdp_quality_after_price_resync.json`
- `current_rollup_after_muscat/`
