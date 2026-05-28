# Wave42 Markato Expansion Closeout

Generated: 2026-05-28

## Scope

- Batch: 3 source-rich Markato SKUs that already had official full INCI and how-to but were still held by short descriptions.
- Brands: Active Drip and Coconut Matter.
- Production writes used Railway production Postgres access through the `Postgres-xMr6` service and `DATABASE_PUBLIC_URL`.
- No `railway up` was used.

## Products

- `ext_11509e4feaf83a2419d8c77d` Active Drip `KOJIC DRIP`
- `ext_9518e81076efc5c5138214ee` Coconut Matter `Matcha Shake Shampoo Concentrate | For All Hair Types`
- `ext_57fe66e03e7b47b972b78c30` Coconut Matter `Oaty Shake Body Wash Concentrate`

## Source Review

Official PDP evidence:

- Active Drip KOJIC DRIP: `https://activedrip.com/products/niacinamide-kojic-acid-glow-and-corrective-serum`
- Coconut Matter Matcha Shake: `https://coconutmatter.com/products/matcha-shake-shampoo-concentrate`
- Coconut Matter Oaty Shake: `https://coconutmatter.com/products/oaty-shake-body-wash-concentrate`

The latest rollup showed these 3 rows as the only source-gap rows with:

- `has_full_inci=true`
- `has_how_to=true`
- `hard_risk=false`
- `quality_flags=missing_or_short_description`

## Production Write 1: Serving Sync

Pre-sync readiness:

- Scanned: 3
- Action required: 3
- Blocker: `index_doc_shadow_only` x3
- Direct high-quality product intel: 3/3
- Identity ready: 3/3
- Public dry-run docs: 0

Serving sync dry-run:

- Requested: 3
- Fetched: 3
- Mirror rows: 3
- Planned SKU rows: 3
- Planned offer rows: 3
- Planned index state rows: 3
- Missing/skipped: 0
- Serving eligible in sample: 3/3

Serving sync apply:

- Product upserts: 3
- SKU upserts: 3
- Offer upserts: 3
- Product group member upserts: 3
- Index state upserts: 3
- Catalog row trust upserts: 3
- Stale SKU/offer deletes: 0

## Production Write 2: Reviewed Description Patch

After serving sync, rollup increased index serving but still held the 3 rows in source-gap because the seed descriptions were 32-45 characters.

Reviewed description patch dry-run:

- Scanned: 3
- Blocked/missing: 0
- Change candidates: 3
- Patched fields: `description`, `pdp_description_raw`

Reviewed description patch apply:

- Updated seeds: 3
- Catalog product updates: 3
- Identity updates: 3

## Final Validation

Readiness after description patch:

- Scanned: 3
- Action required: 0
- DB serving ready: 3/3
- Public index ready: 3/3
- Direct high-quality product intel: 3/3
- Public dry-run docs: 3/3
- Public docs with insight summary: 3/3
- Source build failures: 0
- Warnings: 0

Live PDP module audit after description patch:

- Scanned: 3
- Ready: 3
- Thin: 0
- Not conversion-ready: 0
- Weak insights IDs: 0
- Seller-only insights IDs: 0
- Force-filled IDs: 0
- Content-gap IDs: 0

## Updated Coverage

Latest rollup after description patch:

- Production active Markato rows scanned: 602
- Catalog attached: 602/602
- DB/index serving eligible: 323/602
- Identity ready: 325/602
- High-quality product intel: 419/602
- Ready or covered: 123
- Recommended next-batch rows: 0
- Source-gap hold rows: 119
- Risk-hold rows: 360

Delta vs Wave41:

- DB/index serving eligible: +3
- High-quality product intel: +1
- Ready or covered: +3
- Source-gap hold: -3

## Verification

- `python3 -m json.tool reviewed_description_patch_manifest.json`
- `npx jest tests/scripts/apply_reviewed_external_seed_pdp_content_patch.test.js tests/scripts/sync_external_seeds_to_catalog.test.js --runInBand`
- Production readiness audit before serving sync.
- Production serving-sync dry-run and apply.
- Production readiness audit after serving sync.
- Production live PDP audit after serving sync.
- Production reviewed description patch dry-run and apply.
- Production readiness audit after description patch.
- Production live PDP audit after description patch.
- Latest Markato coverage rollup after description patch.

## Artifacts

- `reviewed_description_patch_manifest.json`
- `reviewed_description_patch_dry_run.json`
- `reviewed_description_patch_apply.json`
- `serving_sync_dry_run.json`
- `serving_sync_apply.json`
- `readiness_before_description_patch/`
- `readiness_after_serving_sync/`
- `readiness_after_description_patch/`
- `live_pdp_modules_audit_after_serving_sync.json`
- `live_pdp_modules_audit_after_description_patch.json`
- `latest_rollup_after_description_patch/`

## Next

The immediate clean queue is still empty. The next expansion path should be source-gap recovery, starting with official INCI/how-to recovery for the large Miss Nella and UpCircle backlogs, or a separate risk-review policy pass for regulated-claim, bundle, accessory, and supplement holds.
