# Wave6 Production Apply Servability Closeout - 2026-05-25

## Scope

Closed the `PRODUCT_NOT_SERVABLE` gap for the 7 Wave6 seeds that were inserted into production `external_product_seeds` but had not yet been promoted into catalog mirror / serving index / live PDP identity state.

External product ids:

- `ext_df8aac07d6c970d4c213b43f`
- `ext_438058253d57a2c8d75f5906`
- `ext_0d4ffd13b899460cabb1f392`
- `ext_065337312a937f0f26d50865`
- `ext_05c5a41a67fb37dcf352853e`
- `ext_c463dcd674e1138b1284ff37`
- `ext_1b95875bc9bdeee751d0cee1`

## Root Cause

The repeated `PRODUCT_NOT_SERVABLE` responses were not caused by malformed PDP signature ids. The direct gateway probe resolved each request through `external_seed_product_id`, but strict PDP serving had no eligible catalog/index identity state and returned `serving_eligibility_missing`.

The sync dry-run could already generate valid `sig_*` ids for all 7 rows. The actual blocker was a bootstrap cycle:

- `sync-external-seeds-to-catalog` required `pdp_identity_listing.live_read_enabled = true` before writing `serving_eligible = true`.
- `promote-pdp-identity-live-read` only considered active external seed identities whose catalog mirror and serving index were already live.
- Newly inserted reviewed external seeds could therefore be identity-approved but still unable to become live without an explicit bootstrap path.

## Code Change

Added an explicit opt-in sync flag:

`--bootstrap-reviewed-identity-live-read`

The flag only affects `sync-external-seeds-to-catalog` scoring when all of these are true:

- identity status is `approved`
- `review_required` is not true
- `source_tier` is `brand`
- `sellable_item_group_id` is present
- the caller explicitly passes the bootstrap flag

Default behavior is unchanged. Merchant-tier identity rows are not bootstrap-eligible.

Targeted test:

`npx jest tests/scripts/sync_external_seeds_to_catalog.test.js --runInBand`

Result: 5 passed.

## Production Apply

1. Identity graph dry-run:

   - source rows scanned: 7
   - identity rows built: 7
   - review queue rows built: 0

2. Identity graph apply:

   - written rows: 7
   - review queue rows: 0

3. Catalog sync bootstrap dry-run:

   - requested ids: 7
   - fetched rows: 7
   - mirror rows: 7
   - skipped: 0
   - planned sku rows: 7
   - planned offer rows: 7
   - planned index state rows: 7
   - serving ready in sample: 7/7
   - identity bootstrap eligible in sample: 7/7
   - blockers: none

4. Catalog sync bootstrap apply:

   - product upserts: 7
   - sku upserts: 7
   - offer upserts: 7
   - group member upserts: 7
   - seed attachment updates: 7
   - index state upserts: 7
   - identity live-read updates: 7

5. Postcheck dry-run without bootstrap flag:

   - existing catalog products: 7
   - existing catalog skus: 7
   - existing catalog offers: 7
   - existing product group members: 7
   - serving ready in sample: 7/7
   - live identity resolved in sample: 7/7
   - bootstrap eligible in sample: 0/7
   - blockers: none

## Live PDP Audit

Production live PDP audit after sync:

- scanned: 7
- ready: 0
- thin: 2
- not conversion ready: 5
- `PRODUCT_NOT_SERVABLE`: 0 observed
- `seller_only_insights_ids`: 0
- `force_filled_ids`: 0

Remaining blockers are content quality, not serving/index state:

- `missing_or_weak_insights`: 7
- `product_intel_unavailable`: 7
- `missing_how_to`: 5
- `missing_ingredients`: 5

Rows by bucket:

- `thin`: `ext_065337312a937f0f26d50865`, `ext_05c5a41a67fb37dcf352853e`
- `not_conversion_ready`: `ext_df8aac07d6c970d4c213b43f`, `ext_438058253d57a2c8d75f5906`, `ext_0d4ffd13b899460cabb1f392`, `ext_c463dcd674e1138b1284ff37`, `ext_1b95875bc9bdeee751d0cee1`

## Artifacts

- `wave6_prod_apply_identity_graph_dry_run.json`
- `wave6_prod_apply_identity_graph_apply.json`
- `wave6_prod_apply_catalog_sync_bootstrap_dry_run.json`
- `wave6_prod_apply_catalog_sync_bootstrap_apply.json`
- `wave6_prod_apply_catalog_sync_postcheck_dry_run.json`
- `wave6_prod_apply_live_pdp_audit_after_serving_sync.json`

## Next

The 7 rows now have catalog mirror, SKU, offer, group member, serving index, and live identity state. The next gate is content readiness: publish source-backed product intel and fill source-backed INCI/how-to for the 5 content-gap rows before any public-doc readiness claim.
