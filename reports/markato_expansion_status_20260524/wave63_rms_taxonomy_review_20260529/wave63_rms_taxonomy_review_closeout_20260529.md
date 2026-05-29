# Wave63 RMS Taxonomy Review Closeout - 2026-05-29

## Scope

Packaged a reviewed taxonomy correction manifest for the two RMS official canonical parent rows surfaced by Wave61 and Wave62.

This wave did not write to production data, update runtime tables, promote serving rows, or run `railway up`.

## Reviewed Rows

| External product id | Title | Current rollup kind | Proposed category path | Classifier result after patch |
| --- | --- | --- | --- | --- |
| `ext_f16d1ed12f9f2c9966d47d78` | Radiance Lock Setting Mist | bundle_or_sample | beauty/makeup/face/setting-spray | single_formula |
| `ext_1c6390a4583df99215617f2b` | Revitalize Hydra Concealer | accessory_or_tool | beauty/makeup/face/concealer | single_formula |

## Decision

Both rows have official RMS source evidence for normal beauty formulas. A local classifier probe using the proposed reviewed category paths returned `single_formula` for both rows, which means the reviewed category patch is a plausible route to clear the stale risk taxonomy signal.

The patch is packaged but not applied. The safe next move is to run `scripts/apply-reviewed-external-seed-category-patch.cjs` in dry-run mode against production `DATABASE_URL`, inspect blockers/conflicts, and only then decide whether to apply with the script's explicit write confirmations.

## Artifacts

- `rms_reviewed_category_patch_manifest.json`
- `rms_taxonomy_classifier_probe.json`
- `wave63_rms_taxonomy_review_closeout_20260529.md`
