# Wave83 Baie / UpCircle Accessory Source-Gap Closeout

Generated: 2026-05-30

## Scope

Continue Markato US source-gap expansion with exact-ID production writes only after official-source dry runs. No `railway up` was used.

## Baie Botanique No-Write Result

- Target: `ext_60ded78effb04e9d6389bfce` - Rose & Cupuacu Enzyme Cleanser.
- Official PDP: `https://www.baiebotanique.com/products/rose-cupuacu-enzyme-cleanser-sns`.
- Dry run scanned 1, skipped 1, failed 0.
- Extracted official ingredients and details, but `how_to_chars=0`.
- Outcome: no production write. The row remains held for `missing_how_to`; no how-to copy was inferred or manufactured.

## UpCircle Accessory Repair

Reviewed rows:

- `ext_092b6aa9139491c529586778` - Bamboo Cotton Buds - 200 Pieces.
- `ext_f79a99a09a933e731880cdfb` - Safety Razor Stand.

Pre-apply state:

- Both rows were active, catalog-attached, index serving eligible, identity approved, live-read enabled, and not identity-review required.
- Both rows carried generic catalog taxonomy: `Beauty Product` / `beauty`.
- Official UpCircle PDP dry run found how-to and detail sections for both rows, with no ingredient text. This is correct for non-formula tools/accessories.

Production writes:

- Official HTML field apply:
  - scanned 2, updated 2, failed 0.
  - recovered `pdp_how_to_use_raw` 2/2 and `pdp_details_sections` 2/2.
- Reviewed category patch:
  - dry run: scanned 2, planned 2, blocked 0.
  - apply: updated 2, catalog product updates 2, identity updates 2.
  - taxonomy set to `Beauty Tool` with paths:
    - `beauty/tools/cotton-buds`
    - `beauty/tools/razor-stand`
- Serving mirror sync:
  - dry run: fetched 2, mirror rows 2, planned SKU rows 3, planned offer rows 3, planned index state rows 2.
  - apply: product upserts 2, SKU upserts 3, offer upserts 3, group member upserts 2, index state upserts 2, catalog row trust upserts 2.
  - stale SKU/offer deletes: 0.

Post-apply state:

- Both rows now carry `Beauty Tool` taxonomy in seed data, snapshot, catalog columns, and identity source payload.
- Both rows remain index serving eligible with `blocker_code=none`.
- Both rows remain identity approved, live-read enabled, and not review-required.

## Live PDP Validation

Fresh production PDP quality audits passed for both rows:

- Bamboo Cotton Buds:
  - overall status: passed.
  - live PDP gate: passed.
  - product intel gate: exempt as optional accessory.
  - similar gate: exempt as accessory.
  - variant gate: passed.
  - image health: 3 scanned, 0 broken.
  - active ingredients suppressed for product family: `accessory`.
- Safety Razor Stand:
  - overall status: passed.
  - live PDP gate: passed.
  - product intel gate: passed.
  - similar gate: exempt as accessory.
  - variant gate: passed.
  - image health: 5 scanned, 0 broken.
  - active ingredients suppressed for product family: `accessory`.

## Rollup Note

The rebuilt rollup includes the broader artifact-discovered production scope, not only the original 602-row Markato slice:

- production rows: 5770.
- catalog attached: 5770/5770.
- index serving eligible: 4334/5770.
- identity ready: 5118/5770.
- product intel high-quality: 4036/5770.
- ready or covered: 1345.
- hold source gap: 1078.
- hold risk review: 2954.

UpCircle domain snapshot after repair:

- rows: 103.
- index serving eligible: 39.
- identity ready: 92.
- product intel high-quality: 98.
- source-gap holds: 3.
- risk holds: 88.

## Remaining UpCircle Source-Gap Holds

UpCircle source-gap holds dropped to 3 in the broad rollup. The two repaired accessories are no longer ingredient/how-to source gaps; they are classified as non-formula accessories, so formula INCI is not applicable.

## Artifacts

- `official_html_dry_run/dry-run.json`
- `probe_upcircle_accessory_source_gap_state.cjs`
- `upcircle_accessory_source_gap_state_prod.json`
- `upcircle_accessory_official_html_dry_run/dry-run.json`
- `upcircle_accessory_reviewed_category_patch_manifest.json`
- `upcircle_accessory_category_patch_dry_run.json`
- `upcircle_accessory_official_html_apply/apply.json`
- `upcircle_accessory_category_patch_apply.json`
- `upcircle_accessory_serving_sync_dry_run.json`
- `upcircle_accessory_serving_sync_apply.json`
- `upcircle_bamboo_cotton_buds_pdp_quality_after_accessory_repair.json`
- `upcircle_safety_razor_stand_pdp_quality_after_accessory_repair.json`
- `upcircle_accessory_source_gap_state_after_apply_prod.json`
- `current_rollup_after_upcircle_accessory_repair/`
