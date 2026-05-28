# Wave35 786 Cosmetics Identity Refresh + Serving Sync Closeout

Generated: 2026-05-27

## Scope

- Brand: 786 Cosmetics
- Domain: 786cosmetics.com
- Market: US
- Batch: 9 identity-refresh breathable nail polish SKUs from the latest Markato expansion rollup
- Change type: production catalog/SKU/offer/index-state sync, identity live-read bootstrap, and reviewed Pivota Insights rewrite

## Applied SKUs

- ext_faf89834933316df0d8da973 | Azores - Breathable Nail Polish
- ext_5f55c01bae5cd6b5f0a0e78e | Dakar - Breathable Nail Polish
- ext_efe7512de8c6df9f75ca19e0 | Dubrovnik - Breathable Nail Polish
- ext_ab5107f3a835da10508757c6 | Havana - Breathable Nail Polish
- ext_a36359795b89961a7c052b21 | Karachi - Breathable Nail Polish
- ext_abd25039dea2189dfcca8079 | Patagonia - Breathable Nail Polish
- ext_c6d113bff874c00abfb4ba33 | Tallinn - Breathable Nail Polish
- ext_da3b149ed322142c187224b6 | Toulouse - Breathable Nail Polish
- ext_f56010dd5bf971f7b7f644a6 | Uluru - Breathable Nail Polish

## Pre-Apply Gate

- Readiness scan: 9 rows
- Terminal holds: 0
- Action required: 9
- Blocker: identity_blocked x9
- Direct displayable KB rows: 9
- Direct high-quality product-intel rows: 8
- Identity ready rows: 0
- Source build failures: 0
- Warnings: 0

## Production Catalog Apply

- Requested IDs: 9
- Fetched rows: 9
- Mirror rows: 9
- Missing IDs: 0
- Skipped rows: 0
- Product upserts: 9
- SKU upserts: 9
- Offer upserts: 9
- Product group member upserts: 9
- Index state upserts: 9
- Identity live-read updates: 9
- Catalog row trust upserts: 9
- Stale SKU deletes: 9
- Stale offer deletes: 9

## Product Intel Repair

- Dakar had a `kb_blocked` row after catalog sync due to `ellipsis_or_truncated|public_truncated_copy`.
- Built and published 1 reviewed official-seed rewrite for Dakar.
- Live PDP audit then exposed 8 older high-quality-eligible rows as weak insights due to `empty_watchouts|quality_eligible`.
- Built and published 8 reviewed official-seed rewrites for the remaining weak rows.
- Total reviewed product-intel writes in this wave: 9
- Evidence profile: 9 `seller_plus_formula`
- No seller-only fallback was used.
- No force-filled ingredients or PDP content were used.

## Final Readiness

- Scanned rows: 9
- Action required rows: 0
- DB serving ready: 9/9
- Public index ready: 9/9
- Direct displayable KB rows: 9/9
- Direct high-quality product-intel rows: 9/9
- Identity ready rows: 9/9
- Commerce public dry-run docs: 9/9
- Public docs with Pivota insight summary: 9/9
- Source build failures: 0
- Warnings: 0

## Final Live PDP Audit

- Live PDP scanned: 9
- Ready: 9
- Thin: 0
- Not conversion ready: 0
- Weak insights IDs: 0
- Seller-only insights IDs: 0
- Force-filled IDs: 0
- Content gap IDs: 0

## Updated Markato Rollup

- Production active US rows scanned: 597
- Catalog attached: 597/597
- DB/index serving eligible: 293/597
- Identity ready: 313/597
- High-quality product intel: 373/597
- Ready or covered: 85
- Recommended next-batch rows: 18
- Source-gap hold rows: 136
- Risk-hold rows: 358

786 Cosmetics after this wave:

- Production seed rows: 51
- Catalog attached: 51/51
- Index serving eligible: 45/51
- Identity ready: 46/51
- High-quality product intel: 19/51
- Ready or covered: 18
- Remaining identity refresh lane: 0
- Remaining source-gap hold: 18
- Remaining risk hold: 15

Next expansion candidates from the latest rollup:

- Joocyee: 14 serving-index-sync rows, but same-canonical multi-variant identity/dedupe gate should run before apply.
- Delicate Daisys: 2 identity-refresh rows.
- Joocyee: 1 identity-refresh row.
- Medicube: 1 identity-refresh row.

## Artifacts

- `wave35_786_identity_refresh_candidate_ids.txt`
- `readiness_before_catalog_sync/`
- `wave35_786_identity_refresh_serving_sync_dry_run.json`
- `wave35_786_identity_refresh_serving_sync_apply.json`
- `readiness_after_catalog_sync/`
- `official_seed_product_intel_report_dakar.json`
- `product_intel_publish_dakar_dry_run.json`
- `product_intel_publish_dakar_apply.json`
- `readiness_after_product_intel/`
- `live_pdp_modules_audit_after_product_intel.json`
- `weak_insights_inventory_8.json`
- `official_seed_product_intel_report_weak8.json`
- `product_intel_publish_weak8_dry_run.json`
- `product_intel_publish_weak8_apply.json`
- `readiness_final_after_insight_rewrite/`
- `live_pdp_modules_audit_final_after_insight_rewrite.json`
- `latest_rollup_after_wave35/`

## Verification

- Production readiness audit before catalog sync
- Production catalog/identity/serving dry-run
- Production catalog/identity/serving apply
- Production readiness audit after catalog sync
- Reviewed product-intel replacement validation and apply for Dakar
- Production readiness audit after Dakar rewrite
- Production live PDP audit after Dakar rewrite
- Reviewed product-intel replacement validation and apply for 8 weak-insight rows
- Final production readiness audit
- Final production live PDP audit
- JSON artifact parse check: 28 files, 0 bad

## Guardrails

- Exact SKU manifest was used for all production writes.
- Rows outside this 9-SKU candidate set were not modified by the catalog/serving sync.
- No `railway up` was used.
