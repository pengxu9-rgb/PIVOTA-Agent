# Wave73 UpCircle Shampoo Source Recovery + Serving Closeout - 2026-05-30

## Scope

Recovered and promoted the UpCircle Pink Berry shampoo pair as a source-backed product-line move:

- `ext_5195cd2ff341a491822447d9` - Shampoo Creme with Pink Berry - Jumbo
- `ext_b13a29406f82ff32d2cc2a32` - Shampoo Creme with Pink Berry

No deploy was run, and `railway up` was not used.

## Review Decision

The initial identity-ready source probe compared Nourwish scalp serum and UpCircle jumbo shampoo. Nourwish was skipped with `no_official_html_fields`; UpCircle exposed official INCI, how-to, and details fields and became the recovery target.

After source/category repair, the reviewer pass found a same-line regular-size sibling that shared the product line and review family but was still not public because it had the same category gap. Promoting only the jumbo row would have left the pair inconsistent, so both rows were repaired and synced together.

The source recovery used official UpCircle PDP HTML for INCI, how-to, and details. Category fields were patched from reviewed PDP context as `Shampoo` with `beauty/haircare/shampoo`.

## Production Writes

Official source-field recovery:

- Rows updated: 2
- Patched fields: `pdp_ingredients_raw`, `pdp_how_to_use_raw`, `pdp_details_sections`
- Jumbo extracted source: 531 ingredient chars, 765 how-to chars, 3 detail sections
- Regular extracted source: 531 ingredient chars, 766 how-to chars, 3 detail sections
- Serving mirror sync during source recovery: 2 catalog product updates, 2 identity listing updates

Reviewed category patches:

- Seed updates: 2
- Catalog product updates: 2
- Identity updates: 2
- Patched fields: `category`, `product_type`, `category_path`, `catalog_category_path`

Serving/index sync:

- Product upserts: 2
- SKU upserts: 2
- Offer upserts: 2
- Product group member upserts: 2
- Index state upserts: 2
- Catalog row trust upserts: 2
- Stale SKU deletes: 0
- Stale offer deletes: 0

## Validation

Final KB/commerce readiness:

- Scanned: 2
- Terminal holds: 0
- Action required: 0
- DB serving ready: 2/2
- Public commerce doc dry-run: 2/2
- Direct high-quality product intel ready: 2/2
- Identity ready: 2/2
- Commerce docs with insight summary: 2/2

Final live PDP module audit:

- Scanned: 2
- Ready: 2
- Thin: 0
- Not conversion-ready: 0
- Weak insights ids: 0
- Seller-only insights ids: 0
- Force-filled ids: 0
- Content-gap ids: 0

Strict PDP quality gates:

- Jumbo: passed
- Regular: passed
- Seed gate: passed
- Extractor gate: passed
- Identity gate: passed
- Product intel gate: passed
- Live PDP gate: passed
- Similar gate: passed with 6 similar items on both rows
- Variant gate: passed
- Image health: 0 broken images on both rows

## Rollup After Wave73

- Production rows: 613
- Catalog attached: 613/613
- Index serving eligible: 387/613
- Identity ready: 392/613
- Product intel high-quality: 547/613
- Ready or covered: 160
- Hold source gap: 84
- Hold risk review: 369
- Recommended next-batch rows: 0

UpCircle domain snapshot:

- Rows: 103
- Index serving eligible: 91
- Identity ready: 92
- Product intel high-quality: 98
- Source-gap holds: 5
- Risk holds: 86

## Artifacts

- `../wave73_identity_ready_source_probe_20260530/official_html_dry_run/dry-run.json`
- `official_html_apply/apply.json`
- `sibling_official_html_apply/apply.json`
- `upcircle_jumbo_reviewed_category_patch_manifest.json`
- `upcircle_sibling_reviewed_category_patch_manifest.json`
- `upcircle_jumbo_category_patch_apply.json`
- `upcircle_sibling_category_patch_apply.json`
- `upcircle_shampoo_pair_serving_sync_dry_run.json`
- `upcircle_shampoo_pair_serving_sync_apply.json`
- `readiness_pair_after_serving_sync/`
- `upcircle_shampoo_pair_live_pdp_modules_after_serving_sync.json`
- `upcircle_jumbo_pdp_quality_after_serving_sync.json`
- `upcircle_regular_pdp_quality_after_serving_sync.json`
- `current_rollup_after_upcircle_shampoo_pair/`
