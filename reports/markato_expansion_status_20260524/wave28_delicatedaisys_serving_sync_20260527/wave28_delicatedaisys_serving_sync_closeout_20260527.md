# Wave28 Delicate Daisys Serving Sync Closeout

Generated: 2026-05-27

## Scope

- Brand: Delicate Daisys Botanical Beauty
- Domain: delicatedaisys.com
- Market: US
- Batch: 4 clean serving-sync SKUs from the Markato expansion rollup
- Change type: production catalog/sku/offer/index-state serving sync

## Applied SKUs

- ext_99b5d36c01c7614a5de71fa1 | Cleansing Face Milk Bulgarian Rose
- ext_9695064b5f7d76303f88beb1 | Firming & Toning Body Cream Pineapple & Retinol
- ext_3405f1b2b381c9a5e0941c20 | Glimmer Tanning Body Oil Colloidal Gold
- ext_b5dafedce57973dfcca9fb5b | Rejuvenating Night Face Cream Bulgarian Rose

## Pre-Apply Gate

- Readiness dry-run scanned: 4
- Terminal holds: 0
- Action required before sync: 4
- Blocker: index_doc_shadow_only x4
- Direct displayable KB rows: 4
- Direct high-quality product-intel rows: 4
- Identity ready rows: 4
- Source build failures: 0
- Warnings: 0

Serving sync dry-run:

- Requested IDs: 4
- Fetched rows: 4
- Mirror rows: 4
- Planned SKU rows: 4
- Planned offer rows: 4
- Planned index state rows: 4
- Missing IDs: 0
- Skipped rows: 0
- Sample serving eligible rows: 4/4

## Production Apply

- Product upserts: 4
- SKU upserts: 4
- Offer upserts: 4
- Product group member upserts: 4
- Index state upserts: 4
- Catalog row trust upserts: 4
- Stale SKU deletes: 4
- Stale offer deletes: 4

## Post-Apply Verification

- Post-apply readiness scanned: 4
- Action required rows: 0
- DB serving ready: 4/4
- Public index ready: 4/4
- Commerce public dry-run docs built: 4/4
- Public docs with insight summary: 4/4
- Source build failures: 0
- Warnings: 0

## Live PDP Audit

- Live PDP scanned: 4
- Ready: 4
- Thin: 0
- Not conversion ready: 0
- Weak insights IDs: 0
- Seller-only insights IDs: 0
- Force-filled IDs: 0
- Content gap IDs: 0

Content notes:

- 4/4 live PDPs returned ready with no blocking reasons.
- 4/4 have reviewed product-intel and public doc insight summaries.
- 4/4 have source-backed ingredient/how-to content and offer/gallery coverage.
- Firming & Toning Body Cream Pineapple & Retinol was classified as `set_or_collection` by product-kind heuristics, but still passed the live PDP quality bucket with no blocker.

## Updated Delicate Daisys Coverage Snapshot

From the latest rollup after this apply:

- Delicate Daisys production seed rows: 10
- Catalog attached: 10/10
- Index serving eligible: 4/10
- Identity ready: 7/10
- High-quality product intel: 10/10
- Ready or covered: 4
- Remaining serving-index-sync: 0
- Remaining identity refresh: 2
- Remaining source-gap hold: 1
- Remaining risk hold: 3

Primary remaining flags:

- regulated_claim_review: 2
- missing_full_inci: 1
- missing_how_to: 1
- wellness_or_supplement: 1

## Latest Markato Rollup After Delicate Daisys

- Production active US rows scanned: 597
- Domains with rows: 31
- Catalog attached: 597/597
- Index serving eligible: 62/597
- Identity ready: 304/597
- High-quality product intel: 356/597
- Ready or covered: 54
- Recommended next-batch rows: 49
- Source-gap rows: 136
- Risk-hold rows: 358

Next clean candidates, excluding the Joocyee duplicate-canonical block:

- Active Drip: 3 serving-index-sync rows
- Lucamar Skin Care: 3 serving-index-sync rows
- DAEBY: 2 serving-index-sync rows
- LIME Cosmetic: 2 serving-index-sync rows
- JouJou: 2 serving-index-sync rows

## Artifacts

- `wave28_delicatedaisys_serving_sync_candidate_ids.txt`
- `wave28_delicatedaisys_serving_sync_dry_run.json`
- `wave28_delicatedaisys_serving_sync_apply.json`
- `readiness_before_serving_sync/summary.json`
- `readiness_after_serving_sync/summary.json`
- `readiness_after_serving_sync/commerce_public_dry_run_docs.json`
- `live_pdp_modules_audit_after_serving_sync.json`
- `latest_rollup_after_delicatedaisys/wave24_candidate_rollup.json`
- `latest_rollup_after_delicatedaisys/wave24_domain_rollup.csv`
- `latest_rollup_after_delicatedaisys/wave24_recommended_next_batch.csv`

## Guardrails

- No seller-only fallback was used.
- No force-filled ingredient content was accepted.
- No Railway deploy was run; production write was limited to the reviewed serving/index sync.
- Joocyee remains blocked at dry-run and was not applied in this wave.
