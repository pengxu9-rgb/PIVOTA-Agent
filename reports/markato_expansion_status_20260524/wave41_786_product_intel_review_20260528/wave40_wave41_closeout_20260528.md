# Wave40/Wave41 Markato Expansion Closeout

Generated: 2026-05-28

## Scope

- Wave40: MASAMI remainder source-rich serving sync.
- Wave41: 786 Cosmetics clean product-intel/category unblock batch.
- Production writes used `railway run` against production operational Postgres public proxy.
- No `railway up` was used.

## Wave40 MASAMI

Processed 3 source-rich MASAMI haircare SKUs:

- `ext_96a7ecc1003f0f94e5b6805c` Mekabu Hydrating Shampoo
- `ext_a1bb997d38b6823e83f23948` Mekabu Hydrating Conditioner
- `ext_fe9ef8f2a6343901489fe63e` Mekabu Hydrating Styling Cream

Pre-sync readiness:

- Scanned: 3
- Action required: 3
- Blocker: `index_doc_shadow_only` x3
- Identity ready: 3/3
- Direct high-quality product intel: 3/3

Serving sync apply:

- Product upserts: 3
- SKU upserts: 3
- Offer upserts: 3
- Product group member upserts: 3
- Index state upserts: 3
- Catalog row trust upserts: 3
- Stale canonical SKU deletes: 3
- Stale canonical offer deletes: 3

Final MASAMI validation:

- DB serving ready: 3/3
- Public docs: 3/3
- Public docs with insight summary: 3/3
- Live PDP audit: 3 scanned, 3 ready, 0 thin, 0 not conversion-ready
- Weak/seller-only/force-filled/content-gap IDs: 0

## Source-Rich Brand Probe

The new-brand probe found source-rich official PDP pages but no clean US/USD-ready expansion batch:

- Advanced Cosmetica: official INCI/how-to present, storefront currency AUD.
- Afrakari: official INCI/how-to present, storefront currency ZAR.
- Rutines: mostly toothbrush/accessory lane.
- Scented Life: bot challenge.
- Several other candidates returned no product URLs, dead sitemap, timeout, or non-storefront roots.

These are not production-ready Markato US expansion candidates without Markato/partner US commerce truth.

## Wave41 786 Cosmetics

Initial latest rollup after Wave40 showed 16 clean 786 Cosmetics `product_intel_review` candidates with full official INCI/how-to and no quality flags. Pre-product-intel readiness exposed the actual blocker:

- Scanned: 16
- Blocker: `seed_content_blocked` x16
- Detail: `missing:category`
- Identity ready: 16/16
- Public docs built: 16/16
- Direct KB displayable: 16/16, but direct high-quality ready: 0/16

Applied reviewed category patch for the 16 breathable nail polish SKUs:

- Category: `Nail Polish`
- Product type: `Nail Polish`
- Category path: `beauty/makeup/nails/nail-polish`
- Catalog category path: `beauty/makeup/nails/nail-polish`

Category patch dry-run:

- Scanned: 16
- Planned: 16
- Blocked/missing: 0

Category patch apply:

- Updated seeds: 16
- Catalog product updates: 16
- Identity source payload updates: 16

Final 786 validation:

- DB serving ready: 16/16
- Public index ready: 16/16
- Direct high-quality product intel: 16/16
- Public docs with insight summary: 16/16
- Live PDP audit: 16 scanned, 16 ready, 0 thin, 0 not conversion-ready
- Weak/seller-only/force-filled/content-gap IDs: 0

Three rows are currently `out_of_stock` in seed commerce facts (`Lisbon`, `Rotomahana`, `Sakura`); PDP content is ready, but commerce availability should remain visible in downstream shopping surfaces.

## Updated Coverage

Latest rollup after Wave41:

- Production active Markato rows scanned: 602
- Catalog attached: 602/602
- DB/index serving eligible: 320/602
- Identity ready: 325/602
- High-quality product intel: 418/602
- Ready or covered: 120
- Recommended next-batch rows: 0
- Source-gap hold rows: 122
- Risk-hold rows: 360

786 Cosmetics after Wave41:

- Rows: 51
- Catalog attached: 51/51
- Index serving eligible: 48/51
- Identity ready: 49/51
- High-quality product intel: 47/51
- Ready or covered: 35
- Remaining clean recommended rows: 0
- Remaining source-gap hold: 1
- Remaining risk hold: 15

## Verification

- `npx jest tests/scripts/apply_reviewed_external_seed_category_patch.test.js tests/scripts/build_reviewed_official_seed_product_intel_report.test.js --runInBand`
- JSON validation for reviewed category manifest.
- Production readiness audit before and after MASAMI serving sync.
- Production serving-sync dry-run and apply for MASAMI.
- Production live PDP audit for MASAMI.
- Production readiness audit before and after 786 category patch.
- Production reviewed category patch dry-run and apply for 786.
- Production live PDP audit for 786.
- Latest Markato coverage rollups after Wave40 and Wave41.

## Artifacts

- `../wave40_source_rich_brand_probe_20260528/source_rich_brand_probe.json`
- `../wave40_masami_remainder_source_rich_20260528/serving_sync_dry_run.json`
- `../wave40_masami_remainder_source_rich_20260528/serving_sync_apply.json`
- `../wave40_masami_remainder_source_rich_20260528/readiness_after_serving_sync/`
- `../wave40_masami_remainder_source_rich_20260528/live_pdp_modules_audit_after_serving_sync.json`
- `786_nail_polish_reviewed_category_manifest.json`
- `category_patch_dry_run.json`
- `category_patch_apply.json`
- `readiness_after_category_patch/`
- `live_pdp_modules_audit_after_category_patch.json`
- `latest_rollup_after_wave41/`

## Next

The clean recommended queue is empty. Further expansion should come from either:

- source-gap recovery with official INCI/how-to for held rows, especially Miss Nella and UpCircle where source gaps dominate, or
- explicit risk review policy for regulated-claim/bundle/accessory holds before any additional production writes.
