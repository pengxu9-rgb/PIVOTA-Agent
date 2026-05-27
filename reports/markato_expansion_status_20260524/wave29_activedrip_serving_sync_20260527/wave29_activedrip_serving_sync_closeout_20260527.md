# Wave29 Active Drip Serving Sync Closeout

Generated: 2026-05-27

## Scope

- Brand: Active Drip
- Domain: activedrip.com
- Market: US
- Batch: 3 clean serving-sync SKUs from the Markato expansion rollup
- Change type: production catalog/sku/offer/index-state serving sync

## Applied SKUs

- ext_eea9ddc94177c421b32a1ed5 | C + E DRIP
- ext_441b5d142009ef8ae5082262 | HYDRATE DRIP
- ext_edef015844086dd8eaa792b2 | RETINOL DRIP

## Pre-Apply Gate

- Readiness dry-run scanned: 3
- Terminal holds: 0
- Action required before sync: 3
- Blocker: index_doc_shadow_only x3
- Direct displayable KB rows: 3
- Direct high-quality product-intel rows: 3
- Identity ready rows: 3
- Source build failures: 0
- Warnings: 0

Serving sync dry-run:

- Requested IDs: 3
- Fetched rows: 3
- Mirror rows: 3
- Planned SKU rows: 3
- Planned offer rows: 3
- Planned index state rows: 3
- Missing IDs: 0
- Skipped rows: 0
- Sample serving eligible rows: 3/3
- Planned stale SKU deletes: 0
- Planned stale offer deletes: 0

## Production Apply

- Product upserts: 3
- SKU upserts: 3
- Offer upserts: 3
- Product group member upserts: 3
- Index state upserts: 3
- Catalog row trust upserts: 3
- Stale SKU deletes: 0
- Stale offer deletes: 0

## Post-Apply Verification

- Post-apply readiness scanned: 3
- Action required rows: 0
- DB serving ready: 3/3
- Public index ready: 3/3
- Commerce public dry-run docs built: 3/3
- Public docs with insight summary: 3/3
- Source build failures: 0
- Warnings: 0

## Live PDP Audit

- Live PDP scanned: 3
- Ready: 3
- Thin: 0
- Not conversion ready: 0
- Weak insights IDs: 0
- Seller-only insights IDs: 0
- Force-filled IDs: 0
- Content gap IDs: 0

Content notes:

- 3/3 live PDPs returned ready with no blocking reasons.
- 3/3 have reviewed product-intel and public doc insight summaries.
- 3/3 are classified as single-formula serum rows with formula content required.
- 3/3 have source-backed ingredient/how-to content and offer/gallery coverage.

## Updated Active Drip Coverage Snapshot

From the latest rollup after this apply:

- Active Drip production seed rows: 8
- Catalog attached: 8/8
- Index serving eligible: 3/8
- Identity ready: 8/8
- High-quality product intel: 8/8
- Ready or covered: 3
- Remaining serving-index-sync: 0
- Remaining source-gap hold: 1
- Remaining risk hold: 4

Primary remaining flags:

- regulated_claim_review: 4
- missing_or_short_description: 1

## Latest Markato Rollup After Active Drip

- Production active US rows scanned: 597
- Domains with rows: 31
- Catalog attached: 597/597
- Index serving eligible: 65/597
- Identity ready: 304/597
- High-quality product intel: 359/597
- Ready or covered: 57
- Recommended next-batch rows: 46
- Source-gap rows: 136
- Risk-hold rows: 358

Next clean candidates, excluding the Joocyee duplicate-canonical block:

- Aetas: 1 serving-index-sync row
- Baie Botanique: 1 serving-index-sync row
- Coconut Matter: 1 serving-index-sync row
- DAEBY: 2 serving-index-sync rows
- LIME Cosmetic: 2 serving-index-sync rows
- JouJou: 2 serving-index-sync rows
- Lucamar Skin Care: 3 serving-index-sync rows

## Artifacts

- `wave29_activedrip_serving_sync_candidate_ids.txt`
- `wave29_activedrip_serving_sync_dry_run.json`
- `wave29_activedrip_serving_sync_apply.json`
- `readiness_before_serving_sync/summary.json`
- `readiness_after_serving_sync/summary.json`
- `readiness_after_serving_sync/commerce_public_dry_run_docs.json`
- `live_pdp_modules_audit_after_serving_sync.json`
- `latest_rollup_after_activedrip/wave24_candidate_rollup.json`
- `latest_rollup_after_activedrip/wave24_domain_rollup.csv`
- `latest_rollup_after_activedrip/wave24_recommended_next_batch.csv`

## Guardrails

- No seller-only fallback was used.
- No force-filled ingredient content was accepted.
- No Railway deploy was run; production write was limited to the reviewed serving/index sync.
- Joocyee remains blocked at dry-run and was not applied in this wave.
