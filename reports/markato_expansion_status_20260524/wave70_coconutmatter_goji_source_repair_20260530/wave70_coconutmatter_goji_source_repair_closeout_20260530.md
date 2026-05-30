# Wave70 Coconut Matter Goji Source Repair + Serving Closeout - 2026-05-30

## Scope

Expanded one Coconut Matter row that was identity-ready and high-quality-KB-ready but still shadow-only in the serving/index lane:

- `ext_a7f414cda657f8c5857fafe8`
- Goji Shake Shampoo Concentrate | For Treated Hair
- `https://coconutmatter.com/products/goji-shake-shampoo-concentrate`

No deploy was run, and `railway up` was not used.

## Review Decision

The first serving dry-run was mechanically clean but the reviewer pass did not accept the original 30-character seed description stub. Official PDP HTML contained richer meta-description evidence, while the seed already carried full INCI and how-to content. A reviewed source-backed PDP-content patch was applied before serving/index sync so the live PDP would not rely on the stub.

The official Shopify JSON exposed the store default as HKD, while the existing US seed and extractor evidence carried `25` USD. No price patch was applied because the US catalog row, extractor gate, offer sync, and live PDP all agreed on `25` USD after serving.

## Production Writes

Reviewed PDP content patch:

- Updated seeds: 1
- Catalog product updates: 1
- Identity payload updates: 1
- Patched fields: `description`, `pdp_description_raw`
- Description length after patch: 247
- Source kind: `official_pdp_meta_description`

Serving/index sync:

- Product upserts: 1
- SKU upserts: 1
- Offer upserts: 1
- Product group member upserts: 1
- Index state upserts: 1
- Catalog row trust upserts: 1
- Stale SKU/offer deletes: 0

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

Strict PDP quality gate:

- Scanned: 1
- Failed: 1
- Seed gate: passed
- Extractor gate: passed
- Identity gate: passed
- Product intel gate: passed
- Live PDP gate: passed
- Variant gate: passed
- Residual failure: `similar_underfill`

The residual strict-QA failure is isolated to recommendation depth: the similar rail returned 1 item, below the strict gate threshold of 4. Product content, price, images, identity, product intel, overview, INCI, and how-to all passed.

## Rollup After Wave70

- Production rows: 613
- Catalog attached: 613/613
- Index serving eligible: 386/613
- Identity ready: 392/613
- Product intel high-quality: 547/613
- Ready or covered: 160
- Hold source gap: 84
- Hold risk review: 369
- Recommended next-batch rows: 0

## Artifacts

- `goji_pdp_quality_before_repair.json`
- `goji_official_html_dry_run/dry-run.json`
- `goji_serving_sync_dry_run.json`
- `goji_reviewed_pdp_content_patch_manifest.json`
- `goji_reviewed_pdp_content_patch_dry_run.json`
- `goji_reviewed_pdp_content_patch_apply.json`
- `goji_serving_sync_after_content_patch_dry_run.json`
- `goji_serving_sync_after_content_patch_apply.json`
- `readiness_after_serving_sync/`
- `goji_live_pdp_modules_after_serving_sync.json`
- `goji_pdp_quality_after_serving_sync.json`
- `current_rollup_after_goji/`
