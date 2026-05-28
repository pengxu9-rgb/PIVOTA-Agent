# Wave36 Identity Refresh Small Batch Closeout

Date: 2026-05-28
Market: US
Scope: Markato expansion, quality-gated identity refresh candidates

## Result

- Evaluated 4 identity-refresh candidates.
- Applied production catalog/serving sync for 3 candidates.
- Held 1 candidate: Medicube `ext_37711c1df803ce80b791b2c5` (`Collagen Night Wrapping Mask`) because the sync gate returned `identity_review_required`.
- No seller-only fallback, no force-filled PDP content, and no `railway up`.

## Applied IDs

| external_product_id | Brand | Product |
| --- | --- | --- |
| `ext_05040ea019efc2b0fe1a9111` | Delicate Daisys Botanical Beauty | Firming & Polishing Body Scrub Sea Salt & Pineapple |
| `ext_5232f3454fc57c62d8d3e7bc` | Delicate Daisys Botanical Beauty | Refreshing Body Wash Bulgarian Rose |
| `ext_10d91302e0cbb32d89cb0cb7` | Joocyee | Dual-Ended Eyebrow Pencil & Cream 2.0 |

## Readiness Before Sync

Source: `readiness_before_catalog_sync/summary.json`

- Scanned rows: 4
- Action required: 4
- DB serving ready: 0
- Public index ready: 0
- Blocker breakdown: `identity_blocked` x4
- Direct displayable KB: 4
- Direct high-quality KB: 4
- Identity ready rows: 0
- Source build failures: 0
- Warnings: 0

## Sync Gate

Source: `wave36_identity_refresh_serving_sync_dry_run.json`

- Requested IDs: 4
- Fetched rows: 4
- Mirror rows: 3
- Planned SKU rows: 5
- Planned offer rows: 5
- Planned index-state rows: 3
- Skipped: `ext_37711c1df803ce80b791b2c5` (`identity_review_required`)

The production apply scope was narrowed to the 3 non-skipped rows.

## Production Apply

Source: `wave36_identity_refresh_serving_sync_apply.json`

- Requested IDs: 3
- Fetched rows: 3
- Mirror rows: 3
- Planned SKU rows: 5
- Planned offer rows: 5
- Planned index-state rows: 3
- Product upserts: 3
- SKU upserts: 5
- Offer upserts: 5
- Group member upserts: 3
- Seed attachment updates: 1
- Index state upserts: 3
- Identity live-read updates: 3
- Catalog row trust upserts: 3
- Stale offer deletes: 3
- Stale SKU deletes: 3

## Readiness After Sync

Source: `readiness_after_catalog_sync_all_candidates/summary.json`

- Scanned rows: 4
- Action required: 1
- DB serving ready: 3
- Public index ready: 3
- Blocker breakdown: `db_serving_ready` x3, `identity_blocked` x1
- Lane breakdown: `ready_no_action` x3, `lane_1_identity_index` x1
- Direct displayable KB: 4
- Direct high-quality KB: 4
- Identity ready rows: 3
- Public dry-run docs built: 3
- Rows with public doc and insight summary: 3
- Source build failures: 0
- Warnings: 0

## Live PDP Audit

Source: `live_pdp_modules_audit_after_catalog_sync_applied3.json`

- Scanned: 3
- Ready: 3
- Thin: 0
- Not conversion ready: 0
- Domain split: `delicatedaisys.com` x2, `joocyee.com` x1
- Weak insights IDs: 0
- Seller-only insights IDs: 0
- Force-filled IDs: 0
- Content gap IDs: 0

## Coverage Rollup After Wave36

Source: `latest_rollup_after_wave36/wave24_candidate_rollup.json`

- Production rows: 597
- Catalog attached: 597 / 597 (100%)
- Index serving eligible: 295 (49.4%)
- Identity ready: 316 (52.9%)
- Product intel high-quality: 373 (62.5%)
- Ready or covered: 88
- Hold source gap: 136
- Hold risk review: 358
- Serving index sync: 14
- Identity refresh: 1
- Recommended next batch rows: 15

Domain notes:

- Delicate Daisys: 10 rows, 6 ready-or-covered, 9 serving eligible, 9 identity ready, 10 high-quality product intel.
- Joocyee: 18 rows, 4 ready-or-covered, 4 serving eligible, 18 identity ready, 6 high-quality product intel; remaining 14 are same-canonical serving-index candidates and should not be plain-applied without product/variant consolidation review.
- Medicube: 17 rows, 9 ready-or-covered, 17 serving eligible, 14 identity ready, 17 high-quality product intel; the remaining identity-refresh candidate is still held by `identity_review_required`.

## Next Gate

The current recommended-next list has no clean plain-sync batch:

- Joocyee 14 rows require same-canonical identity/product-intel consolidation before serving sync.
- Medicube `Collagen Night Wrapping Mask` requires identity review confirmation before enabling identity live-read.

The next expansion wave should either resolve the Joocyee duplicate-canonical product model, or pull a fresh broader Markato candidate rollup and select brands outside this blocked set.
