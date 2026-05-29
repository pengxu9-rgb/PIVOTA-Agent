# Wave63 RMS Taxonomy Review Closeout - 2026-05-29

## Scope

Packaged and production-tested a reviewed taxonomy correction manifest for the two RMS official canonical parent rows surfaced by Wave61 and Wave62.

This wave applied the non-conflicting reviewed category patch for one RMS official canonical parent row. It did not deploy code, promote new serving rows, or run `railway up`.

## Reviewed Rows

| External product id | Title | Current rollup kind | Proposed category path | Classifier result after patch |
| --- | --- | --- | --- | --- |
| `ext_f16d1ed12f9f2c9966d47d78` | Radiance Lock Setting Mist | bundle_or_sample | beauty/makeup/face/setting-spray | single_formula |
| `ext_1c6390a4583df99215617f2b` | Revitalize Hydra Concealer | accessory_or_tool | beauty/makeup/face/concealer | single_formula |

## Decision

Both rows have official RMS source evidence for normal beauty formulas. A local classifier probe using the proposed reviewed category paths returned `single_formula` for both rows, which made the reviewed category patch a plausible route to clear stale risk taxonomy signals.

The full production dry-run scanned 2 rows: 1 planned, 1 blocked. Radiance Lock Setting Mist was blocked by `existing_category_conflict:derived.recall.category:Treatment`, so it was not applied. Revitalize Hydra Concealer had no blocker, so a one-row split manifest was dry-run, applied with the script's explicit write confirmation, and postchecked.

The concealer apply updated 1 external seed row, 1 catalog product row, and 1 identity source payload. The postcheck dry-run for the split manifest returned 1 unchanged row and 0 blockers. The full postcheck kept the setting mist blocked and the concealer unchanged.

## Production Verification

Targeted KB/commerce readiness after the concealer patch scanned both RMS official rows:

- DB serving ready: 2/2
- Public index ready dry-run: 2/2
- Identity ready: 2/2
- Direct high-quality KB ready: 2/2
- Terminal holds: 0
- Action-required rows: 0
- Warnings: 0

Targeted live PDP audit after the patch scanned both rows:

- Ready: 2/2
- Thin: 0
- Not conversion ready: 0
- Weak insights ids: 0
- Seller-only insights ids: 0
- Force-filled ids: 0
- Content-gap ids: 0

## Remaining Hold

`ext_f16d1ed12f9f2c9966d47d78` Radiance Lock Setting Mist remains a reviewed taxonomy hold if we want to overwrite the existing `Treatment` category. It is already DB/live-PDP ready, so the next move should be human-reviewed category conflict resolution rather than a force apply.

## Artifacts

- `rms_reviewed_category_patch_manifest.json`
- `rms_taxonomy_classifier_probe.json`
- `rms_reviewed_category_patch_dry_run.json`
- `rms_reviewed_category_patch_concealer_only_manifest.json`
- `rms_reviewed_category_patch_concealer_only_dry_run.json`
- `rms_reviewed_category_patch_concealer_only_apply.json`
- `rms_reviewed_category_patch_concealer_only_postcheck_dry_run.json`
- `rms_reviewed_category_patch_full_postcheck_dry_run.json`
- `rms_taxonomy_apply_summary.csv`
- `kb_readiness_after_concealer_category_patch/`
- `live_pdp_modules_after_concealer_category_patch.json`
- `wave63_rms_taxonomy_review_closeout_20260529.md`
