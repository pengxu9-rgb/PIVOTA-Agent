# Wave25 786 Cosmetics Serving Sync Closeout

Generated: 2026-05-27

## Scope

- Brand: 786 Cosmetics
- Domain: 786cosmetics.com
- Market: US
- Batch: 9 clean serving-sync SKUs from the Markato expansion rollup
- Change type: production catalog/sku/offer/index-state serving sync

## Applied SKUs

- ext_0d844fc65fd3348e35a09c80 | Abu Dhabi - Breathable Nail Polish
- ext_151aebc5b6246b8d2d9a877b | Agra - Breathable Nail Polish
- ext_2fc7cc1ac3370464b4b923d3 | Bahrain - Breathable Nail Polish
- ext_33fa1a749060cefdd3e0dc2b | Beirut - Breathable Nail Polish
- ext_36b452da1e0dde5c19bd2ed0 | Casablanca - Breathable Nail Polish
- ext_8573685e1cc94840934c764d | Goychay - Breathable Nail Polish
- ext_41aeeb470016979417c8637d | Kabul - Breathable Nail Polish
- ext_69dcb156e335cb9756e016b2 | Kashmir - Breathable Nail Polish
- ext_2c4793f5f96ec2d4680fd55b | Zhangye - Breathable Nail Polish

## Pre-Apply Gate

- Readiness dry-run scanned: 9
- Terminal holds: 0
- Action required before sync: 9
- Blocker: index_doc_shadow_only x9
- Direct displayable KB rows: 9
- Direct high-quality product-intel rows: 9
- Identity ready rows: 9
- Source build failures: 0
- Warnings: 0

## Production Apply

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
- Catalog row trust upserts: 9
- Stale SKU deletes: 9
- Stale offer deletes: 9

## Post-Apply Verification

- Post-apply readiness scanned: 9
- Action required rows: 0
- DB serving ready: 9/9
- Public index ready: 9/9
- Commerce public dry-run docs built: 9/9
- Public docs with insight summary: 9/9
- Source build failures: 0
- Warnings: 0

## Live PDP Audit

- Live PDP scanned: 9
- Ready: 9
- Thin: 0
- Not conversion ready: 0
- Weak insights IDs: 0
- Seller-only insights IDs: 0
- Force-filled IDs: 0
- Content gap IDs: 0

Content notes:

- 9/9 live PDPs returned HTTP 200 with `pdp_status=success`.
- 9/9 have reviewed product-intel with `seller_plus_formula` evidence profile.
- 9/9 have authoritative INCI from `pdp_section`.
- 9/9 have how-to content, overview, details, offers, gallery, reviews preview, and similar modules.
- Variant selector appears as a non-blocking empty/default selector for these single-SKU nail polish rows.

## Updated 786 Coverage Snapshot

From the latest rollup after this apply:

- 786 production seed rows: 51
- Catalog attached: 51/51
- Index serving eligible: 9/51
- Identity ready: 37/51
- High-quality product intel: 10/51
- Ready or covered: 9
- Remaining identity refresh lane: 9
- Remaining source-gap hold: 18
- Remaining risk hold: 15

Primary remaining flags for 786:

- missing_full_inci: 21
- missing_how_to: 21
- bundle_or_sample: 8
- regulated_claim_review: 6
- accessory_or_tool: 1
- missing_or_short_description: 1

## Latest Rollup After 786

- Production active US rows scanned: 597
- Domains with rows: 31
- Catalog attached: 597/597
- Index serving eligible: 51/597
- Identity ready: 304/597
- High-quality product intel: 356/597
- Recommended next-batch rows: 60
- Source-gap rows: 136
- Risk-hold rows: 358

Top clean serving-sync candidates in the updated rollup:

- Joocyee: 17 serving-index-sync rows
- Nala Care: 7 serving-index-sync rows
- Delicate Daisys: 4 serving-index-sync rows plus 2 identity-refresh rows
- Active Drip: 3 serving-index-sync rows
- Lucamar Skin Care: 3 serving-index-sync rows
- DAEBY: 2 serving-index-sync rows
- LIME Cosmetic: 2 serving-index-sync rows

## Artifacts

- `wave25_786_serving_sync_candidate_ids.txt`
- `wave25_786_serving_sync_dry_run.json`
- `wave25_786_serving_sync_apply.json`
- `readiness_before_serving_sync/summary.json`
- `readiness_after_serving_sync/summary.json`
- `readiness_after_serving_sync/commerce_public_dry_run_docs.json`
- `live_pdp_modules_audit_after_serving_sync.json`
- `latest_rollup_after_786/wave24_candidate_rollup.json`
- `latest_rollup_after_786/wave24_domain_rollup.csv`
- `latest_rollup_after_786/wave24_recommended_next_batch.csv`

## Guardrails

- No seller-only fallback was used.
- No force-filled ingredient content was accepted.
- No Railway deploy was run; production write was limited to the reviewed serving/index sync.
- Rows outside this exact 9-SKU candidate set were not modified by this batch.
