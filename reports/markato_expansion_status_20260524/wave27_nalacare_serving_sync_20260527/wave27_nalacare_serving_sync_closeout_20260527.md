# Wave27 Nala Care Serving Sync Closeout

Generated: 2026-05-27

## Scope

- Brand: Nala Care
- Domain: nalacare.com
- Market: US
- Batch: 7 clean serving-sync SKUs from the Markato expansion rollup
- Change type: production catalog/sku/offer/index-state serving sync

## Applied SKUs

- ext_e08d2e62205f1691dfe30753 | Coastal Waters, Extra Strength Natural Deodorant
- ext_e5f66cf29d6c516775bb0fce | Essence of Rosewood, Extra Strength Natural Deodorant
- ext_446a5f126507ff6adba46258 | Eucalyptus & Champa, Extra Strength Natural Deodorant
- ext_b36935c92dc89857bf62f25e | Grapefruit & Neroli, Extra Strength Natural Deodorant
- ext_21216a67b62b16d88661367f | Lavender & Vetiver, Sensitive Skin Natural Deodorant
- ext_8136f11be69e6c18781a7f02 | Peppermint & Activated Charcoal, Natural Deodorant
- ext_5975f96c1d90b02d02329960 | Unscented, Sensitive Skin Natural Deodorant

## Pre-Apply Gate

- Readiness dry-run scanned: 7
- Terminal holds: 0
- Action required before sync: 7
- Blocker: index_doc_shadow_only x7
- Direct displayable KB rows: 7
- Direct high-quality product-intel rows: 7
- Identity ready rows: 7
- Source build failures: 0
- Warnings: 0

Serving sync dry-run:

- Requested IDs: 7
- Fetched rows: 7
- Mirror rows: 7
- Planned SKU rows: 7
- Planned offer rows: 7
- Planned index state rows: 7
- Missing IDs: 0
- Skipped rows: 0
- Sample serving eligible rows: 7/7

## Production Apply

- Product upserts: 7
- SKU upserts: 7
- Offer upserts: 7
- Product group member upserts: 7
- Index state upserts: 7
- Catalog row trust upserts: 7
- Stale SKU deletes: 7
- Stale offer deletes: 7

## Post-Apply Verification

- Post-apply readiness scanned: 7
- Action required rows: 0
- DB serving ready: 7/7
- Public index ready: 7/7
- Commerce public dry-run docs built: 7/7
- Public docs with insight summary: 7/7
- Source build failures: 0
- Warnings: 0

## Live PDP Audit

- Live PDP scanned: 7
- Ready: 7
- Thin: 0
- Not conversion ready: 0
- Weak insights IDs: 0
- Seller-only insights IDs: 0
- Force-filled IDs: 0
- Content gap IDs: 0

Content notes:

- 7/7 live PDPs returned ready with no blocking reasons.
- 7/7 have reviewed product-intel and public doc insight summaries.
- 7/7 have source-backed ingredient/how-to content and offer/gallery coverage.
- Two rows were classified as `set_or_collection` by product-kind heuristics but still passed the live PDP quality bucket; no conversion blocker was emitted.

## Updated Nala Care Coverage Snapshot

From the latest rollup after this apply:

- Nala Care production seed rows: 10
- Catalog attached: 10/10
- Index serving eligible: 7/10
- Identity ready: 8/10
- High-quality product intel: 10/10
- Ready or covered: 7
- Remaining serving-index-sync: 0
- Remaining source-gap hold: 0
- Remaining risk hold: 3

Primary remaining flags:

- regulated_claim_review: 2
- missing_how_to: 1
- wellness_or_supplement: 1

## Latest Markato Rollup After Nala Care

- Production active US rows scanned: 597
- Domains with rows: 31
- Catalog attached: 597/597
- Index serving eligible: 58/597
- Identity ready: 304/597
- High-quality product intel: 356/597
- Ready or covered: 50
- Recommended next-batch rows: 53
- Source-gap rows: 136
- Risk-hold rows: 358

Next clean candidates, excluding the Joocyee duplicate-canonical block:

- Delicate Daisys: 4 serving-index-sync rows
- Active Drip: 3 serving-index-sync rows
- Lucamar Skin Care: 3 serving-index-sync rows
- DAEBY: 2 serving-index-sync rows
- LIME Cosmetic: 2 serving-index-sync rows
- JouJou: 2 serving-index-sync rows

## Artifacts

- `wave27_nalacare_serving_sync_candidate_ids.txt`
- `wave27_nalacare_serving_sync_dry_run.json`
- `wave27_nalacare_serving_sync_apply.json`
- `readiness_before_serving_sync/summary.json`
- `readiness_after_serving_sync/summary.json`
- `readiness_after_serving_sync/commerce_public_dry_run_docs.json`
- `live_pdp_modules_audit_after_serving_sync.json`
- `latest_rollup_after_nalacare/wave24_candidate_rollup.json`
- `latest_rollup_after_nalacare/wave24_domain_rollup.csv`
- `latest_rollup_after_nalacare/wave24_recommended_next_batch.csv`

## Guardrails

- No seller-only fallback was used.
- No force-filled ingredient content was accepted.
- No Railway deploy was run; production write was limited to the reviewed serving/index sync.
- Joocyee was blocked at dry-run and was not applied.
