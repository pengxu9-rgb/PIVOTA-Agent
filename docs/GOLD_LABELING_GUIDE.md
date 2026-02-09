# Gold Labeling Guide (Aurora Skin Diagnosis)

Last updated: 2026-02-09

## Scope
- This workflow labels **cosmetic skincare signals only**.
- This is **not** medical diagnosis or disease detection.
- Valid issue types: `redness`, `acne`, `shine`, `texture`, `tone`, `dryness`, `barrier`, `other`.

## Privacy Rules
- Default export is metadata-only task JSONL.
- ROI image URI is included only when explicitly enabled (`--allowRoi true`) and user opt-in exists.
- No raw full-face image export in this workflow.
- No EXIF/personal identifiers should be kept in task payload.

## End-to-End Workflow
1. Generate pseudo/hard-case artifacts from daily model outputs:
```bash
make pseudo-label-job
```
2. Sample labeling tasks with quota control:
```bash
make gold-label-sample GOLD_TOTAL=500 GOLD_HARD_RATIO=0.6 GOLD_ALLOW_ROI=false
```
3. Annotate in Label Studio and export JSON/JSONL.
4. Import labels into canonical gold label store:
```bash
make gold-label-import GOLD_IMPORT_IN=/path/to/label_studio_export.json GOLD_IMPORT_ANNOTATOR=annotator_a
```
5. Train calibrator from `model_outputs + gold_labels`:
```bash
make train-calibrator
```
6. Evaluate calibration quality (overall + grouped):
```bash
make eval-calibration
```
7. Enable runtime calibration:
```bash
export DIAG_CALIBRATION_ENABLED=true
export DIAG_CALIBRATION_USE_LATEST_VERSION=true
```

## Annotation Instructions
- Draw bbox only on visible evidence region.
- If no clear evidence, do not force a label.
- Keep label count minimal and specific.
- Severity is not manually entered in this pipeline; runtime sets calibrated severity.
- Use `other` only if none of the canonical issue types apply.

## Label Quality Checklist
- Bounding box should be inside face skin ROI.
- Type should match visible evidence, not product assumptions.
- Avoid duplicate boxes for same issue/region.
- Reject tasks with unusable image quality and mark for retake.

## Quota Strategy
- Ensure mixed coverage by:
  - `tone_bucket`
  - `lighting_bucket`
  - `region_bucket`
- Hard-case-first sampling is recommended (`hard_ratio >= 0.5`) for faster model improvement.

## Runtime Notes
- Model file naming: `model_registry/calibrator_vYYYYMMDD.json`.
- Alias file (default): `model_registry/diag_calibration_v1.json`.
- Runtime loader prefers latest version file when:
  - `DIAG_CALIBRATION_ENABLED=true`
  - `DIAG_CALIBRATION_USE_LATEST_VERSION=true`

