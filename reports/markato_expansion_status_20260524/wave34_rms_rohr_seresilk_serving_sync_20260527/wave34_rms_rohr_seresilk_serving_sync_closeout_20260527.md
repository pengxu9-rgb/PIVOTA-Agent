# Wave34 RMS + Rohr Remedy + Seresilk Serving Sync Closeout - 2026-05-27

## Scope

Expanded Markato US PDP catalog serving coverage for 3 reviewed/high-quality product-intel SKUs:

| external_product_id | Brand | Product | Domain |
| --- | --- | --- | --- |
| `ext_9247e1285fadd4b02bc33aad` | RMS Beauty | Makeup Remover / Ultimate Makeup Remover Wipe | `rmsbeauty.com` |
| `ext_1b95875bc9bdeee751d0cee1` | Rohr Remedy | Lilly Pilly Face Moisturiser with Omega-3 | `rohrremedy.com` |
| `ext_0d4ffd13b899460cabb1f392` | Seresilk | Gentle Silk Cleanser | `seresilk.com.au` |

Candidate file:

- `wave34_rms_rohr_seresilk_serving_sync_candidate_ids.txt`

## Pre-Apply Gates

Readiness before serving sync:

- scanned rows: 3
- terminal holds: 0
- action required: 3
- DB serving ready: 0/3
- blocker breakdown: `seed_content_blocked=2`, `index_doc_shadow_only=1`
- direct displayable KB: 3/3
- direct high-quality product intel: 3/3
- identity ready: 3/3
- source build failures: 0
- warnings: 0

Serving-sync dry-run:

- requested ids: 3
- fetched rows: 3
- mirror rows: 3
- planned SKU rows: 3
- planned offer rows: 3
- planned index state rows: 3
- missing ids: 0
- skipped: 0
- `servingEligible=true`: 3/3

Classification repair added during the gate:

- RMS makeup remover wipes are now classified as `Makeup Remover Wipes`, `beauty/skincare/cleanser`, not a generic beauty set.
- Serving-sync now stamps `product_family`, `external_seed_product_family`, and normalized `product_kind` into catalog payload/snapshot from the final mirror category shape, so stale seed bundle kind does not suppress formula modules.

## Production Apply

Production DB writes were executed only after clean dry-run gates:

- initial serving-sync apply: product/SKU/offer/group/index_state/catalog_trust upserts: 3 each
- category seed backfill apply for Rohr + Seresilk: 2 rows updated
- RMS reviewed single-ingredient INCI patch: seed/catalog/identity updated
- RMS seed-level product family override: seed updated and serving mirrors synced
- stale SKU/offer deletes after final sync: 0
- missing ids: 0
- skipped: 0

No `railway up` was used.

## Quality Fixes

- Rohr Remedy and Seresilk were repaired from `seed_content_blocked` by source-backed category materialization.
- RMS official PDP Ingredients section was reviewed as single-ingredient INCI: `Cocos Nucifera (Coconut) Oil`.
- Reviewed INCI patch now materializes `ingredient_intel.authoritative` so runtime can display reviewed single-ingredient formulas without force-fill.
- Existing force-family remediation can now safely patch `single_formula` metadata when reviewed INCI already exists, preserving trusted ingredient fields in serving mirrors.

## Post-Apply Validation

Final readiness after family fix:

- scanned rows: 3
- terminal holds: 0
- action required: 0
- DB serving ready: 3/3
- public index ready: 3/3
- public dry-run docs: 3
- rows with public doc and insight summary: 3
- direct displayable KB: 3/3
- direct high-quality product intel: 3/3
- identity ready: 3/3
- source build failures: 0
- warnings: 0
- readiness product family: `single_formula=3`

Final live PDP module audit:

- scanned: 3
- ready: 3
- thin: 0
- not conversion ready: 0
- weak insights ids: 0
- seller-only insights ids: 0
- force-filled ids: 0
- content gap ids: 0

## Latest Markato Rollup After Wave34

- production rows: 597
- catalog attached: 597/597 (100%)
- DB/index serving eligible: 284/597 (47.6%)
- ready or covered: 76
- identity ready: 304/597 (50.9%)
- high-quality product intel: 364/597 (61.0%)
- recommended next batch rows: 27
- source gap rows: 136
- risk hold rows: 358

Lane counts:

- `ready_or_covered`: 76
- `serving_index_sync`: 14
- `identity_refresh`: 13
- `hold_source_gap`: 136
- `hold_risk_review`: 358

## Artifacts

- `wave34_rms_rohr_seresilk_serving_sync_dry_run_v2.json`
- `wave34_rms_rohr_seresilk_serving_sync_apply_v2.json`
- `seed_category_fix_apply/`
- `rms_makeup_remover_wipe_reviewed_ingredients_patch_apply_v4.json`
- `rms_force_single_formula_family_apply.json`
- `readiness_final_after_family_fix/`
- `live_pdp_modules_audit_final_after_family_fix.json`
- `latest_rollup_after_wave34/`

## Next Expansion Notes

The latest rollup is dominated by Joocyee clean `serving_index_sync` rows, but Joocyee still needs duplicate canonical identity review before write. The safer next expansion path is either:

- run a focused Joocyee identity/dedupe gate, then sync a small clean subset; or
- work through 786 Cosmetics `identity_refresh` rows, where serving/index is mostly present but identity readiness is the blocker.
