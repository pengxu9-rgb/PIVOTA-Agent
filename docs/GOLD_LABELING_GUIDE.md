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
7. Evaluate region-selection accuracy against internal gold labels:
```bash
make eval-region-accuracy \
  REGION_ACC_MODEL_OUTPUTS=tmp/diag_pseudo_label_factory/model_outputs.ndjson \
  REGION_ACC_GOLD_LABELS=tmp/diag_pseudo_label_factory/gold_labels.ndjson \
  REGION_ACC_IOU=0.3
```
   - Default is strict: if `gold_labels` file is missing/empty, command exits non-zero with explicit error.
   - Optional dry-run override: add `REGION_ACC_ALLOW_EMPTY_GOLD=true`.
8. Enable runtime calibration:
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

## Gold Labeling v2 (Seed Pack + Label Studio + Eval)
This section adds the local-first closed loop built around `review_pack_mixed` outputs.

1. Generate seed pack tasks + manifest from latest mixed review outputs:
```bash
make gold-seed-pack LIMIT=120
```
Outputs:
- `artifacts/gold_seed_tasks_labelstudio.json`
- `artifacts/gold_seed_manifest.json`
- `reports/gold_seed_pack_<run_id>.md`

2. Label in local Label Studio:
- Use config: `label_studio/project_oval_skin.xml`
- Import tasks: `artifacts/gold_seed_tasks_labelstudio.json`
- Export annotations as JSON.

3. Import Label Studio export into canonical Aurora NDJSON:
```bash
make gold-label-import GOLD_IMPORT_IN=/path/to/label_studio_export.json
```
Output:
- `artifacts/gold_labels.ndjson`

4. Run offline gold evaluation:
```bash
make eval-gold \
  EVAL_GOLD_LABELS=artifacts/gold_labels.ndjson \
  EVAL_GOLD_PRED_JSONL=reports/review_pack_mixed_<run_id>.jsonl
```
Outputs:
- `reports/eval_gold_<run_id>.md`
- `reports/eval_gold_<run_id>.csv`
- `reports/eval_gold_<run_id>.jsonl`
- `artifacts/calibration_train_samples.ndjson`

5. (Optional) Train calibrator directly from gold eval train samples:
```bash
make train-calibrator CAL_TRAIN_SAMPLES=artifacts/calibration_train_samples.ndjson
```

## Gold Round1 Pack (review_pack_mixed-driven)
Use this workflow for the first manual labeling round directly from mixed review outputs.

1. Build deterministic round1 tasks and local image pack:
```bash
make gold-round1-pack \
  RUN_ID=20260211_105639451 \
  REVIEW_JSONL=reports/review_pack_mixed_20260211_105639451.jsonl \
  LIMIT_INTERNAL=38 \
  LIMIT_DATASET_LAPA=50 \
  LIMIT_DATASET_CELEBA=50
```
Outputs:
- `artifacts/gold_round1_<run_id>/images/**` (jpg-only pack)
- `artifacts/gold_round1_<run_id>/label_studio_tasks.json`
- `artifacts/gold_round1_<run_id>/manifest.json`
- `reports/gold_round1_pack_<run_id>.md`
- `reports/lapa_local_fail_triage_<run_id>.md`

2. Import into local Label Studio:
- Label config: `label_studio/project_oval_skin.xml`
- Task JSON: `artifacts/gold_round1_<run_id>/label_studio_tasks.json`

3. Evaluate exported annotations end-to-end:
```bash
make eval-gold-round1 \
  RUN_ID=20260211_105639451 \
  GOLD_EXPORT_JSON=/absolute/path/to/label_studio_export.json
```
Outputs:
- `artifacts/gold_round1_<run_id>/gold_labels.ndjson`
- `reports/eval_gold_<run_id>.md`
- `reports/eval_gold_<run_id>.csv`
- `reports/eval_gold_<run_id>.jsonl`
- `artifacts/gold_round1_<run_id>/calibration_train_samples.ndjson`

4. Triage one failed sample (local pipeline):
```bash
node scripts/triage_one_sample.mjs \
  --source lapa \
  --sample_hash <sample_hash> \
  --review_jsonl reports/review_pack_mixed_<run_id>.jsonl
```
