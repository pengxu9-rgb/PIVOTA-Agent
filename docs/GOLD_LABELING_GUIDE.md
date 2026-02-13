# Gold Labeling Guide (Aurora Skin Diagnosis)

Last updated: 2026-02-12

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

## Gold Round1 Real Pack (review_pack_mixed-driven)
Use this workflow for the first real manual labeling round directly from mixed review outputs.

1. Generate runbook (recommended entry):
```bash
make gold-round1-runbook \
  RUN_ID=20260211_105639451 \
  REVIEW_JSONL=reports/review_pack_mixed_20260211_105639451.jsonl
```
Output:
- `reports/gold_round1_runbook_<run_id>.md`

2. Build deterministic round1 real tasks:
```bash
make gold-round1-real-pack \
  RUN_ID=20260211_105639451 \
  REVIEW_JSONL=reports/review_pack_mixed_20260211_105639451.jsonl \
  LIMIT=200 \
  OUT=artifacts/gold_round1_real_20260211_105639451
```
Outputs:
- `artifacts/gold_round1_real_<run_id>/tasks.json`
- `artifacts/gold_round1_real_<run_id>/manifest.json`
- `artifacts/gold_round1_real_<run_id>/preview.md`
- `tasks.json`/`manifest.json` include `double_annotate` (default 10% from top_risk + low_min_pixels)

3. Import into local Label Studio:
- Label config: `label_studio/project_oval_skin.xml`
- Task JSON: `artifacts/gold_round1_real_<run_id>/tasks.json`
- Double-annotate pool: filter task metadata `double_annotate=true` and assign second annotator.

4. Round1 real labeling spec (must follow):
- Forehead boundary: draw only visible forehead skin; clip away hairline overlap. If uncertain, prefer conservative smaller polygon.
- Under-eye (`under_eye_left`, `under_eye_right`) is optional weak label:
  - Draw only the under-eye skin band.
  - Do not include eyeball/sclera, lashes, eyeliner, or eyebrow shadow.
  - If band is not confidently visible, skip this module instead of forcing a polygon.
- Strong GT modules for mIoU: `nose`, `forehead`, `left_cheek`, `right_cheek`, `chin`.
- Weak metrics only: `under_eye_left`, `under_eye_right`.

5. Import exported annotations:
```bash
make gold-label-import \
  ROUND1_IN=/absolute/path/to/label_studio_export.json \
  OUT=artifacts/gold_round1_real_20260211_105639451/gold_labels.ndjson
```
Outputs:
- `artifacts/gold_round1_real_<run_id>/gold_labels.ndjson`
- `reports/gold_import_qc_<run_id>.md`
- `reports/gold_import_qc_<run_id>.jsonl`

6. Evaluate exported annotations end-to-end:
```bash
make eval-gold-round1 \
  GOLD_LABELS=artifacts/gold_round1_real_20260211_105639451/gold_labels.ndjson \
  PRED_JSONL=reports/review_pack_mixed_20260211_105639451.jsonl
```
Outputs:
- `reports/eval_gold_<run_id>.md`
- `reports/eval_gold_<run_id>.csv`
- `reports/eval_gold_<run_id>.jsonl`

7. Run AB comparison:
```bash
make eval-gold-ab \
  GOLD_LABELS=artifacts/gold_round1_real_20260211_105639451/gold_labels.ndjson \
  PRED_JSONL=reports/review_pack_mixed_20260211_105639451.jsonl
```
Outputs:
- `reports/eval_gold_ab_<run_id>.md`
- `reports/eval_gold_ab_<run_id>.json`

8. Run IAA on double-annotate subset:
```bash
make eval-gold-iaa \
  RUN_ID=20260211_105639451 \
  LS_EXPORT=/absolute/path/to/label_studio_export_round1_20260211_105639451.json
```
Outputs:
- `reports/eval_gold_iaa_<run_id>.md`
- `reports/eval_gold_iaa_<run_id>.jsonl`
- `reports/eval_gold_iaa_<run_id>.json`

9. Cross-dataset external contrast (Celeb + LaPa):
```bash
make eval-circle-crossset LIMIT=150
```
Outputs:
- `reports/eval_circle_crossset_<run_id>.md`
- `reports/eval_circle_crossset_<run_id>.json`

10. Release gate report:
```bash
make release-gate-circle \
  RUN_ID=20260211_105639451 \
  LS_EXPORT=/absolute/path/to/label_studio_export_round1_20260211_105639451.json \
  REVIEW_JSONL=reports/review_pack_mixed_20260211_105639451.jsonl \
  LIMIT=150
```
Outputs:
- `reports/RELEASE_GATE_CIRCLE_<run_id>.md`
- `reports/RELEASE_GATE_CIRCLE_<run_id>.json`

11. Legacy compatibility workflow (optional):
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

## Preference Labeling v1 (A/B Accuracy Preference)
Use this when pixel-perfect GT is too slow but you still need stable model-selection signals.

When to use preference labeling instead of pixel GT:
- Use **preference labeling** for fast A/B ranking: “which overlay is more accurate overall/per-module”.
- Use **pixel GT** for absolute geometry metrics (mIoU, leakage exactness, retraining targets).
- Recommended loop: preference first for quick variant selection, then pixel GT on contentious/worst buckets.

Recommended annotator instructions (“more accurate” means):
- Compare A and B on the same photo and choose the one with better module placement and cleaner boundaries.
- Prioritize strong modules: `nose`, `forehead`, `left_cheek`, `right_cheek`, `chin`.
- Penalize visible forehead-hair leakage and background absorption.
- Use `tie` only when both are effectively equal.
- Use `cannot_tell` when quality/overlay signal is insufficient to judge.
- Add short `notes` only when there is a clear reason (e.g. “B forehead leaks into hairline”).

Workflow:
```bash
# 1) Build deterministic real Round1 A/B pack (baseline vs variant1)
make preference-round1-real-pack \
  RUN_ID=<run_id> \
  INTERNAL_DIR="/absolute/path/to/internal_clean_photos" \
  REVIEW_PACK_JSONL=reports/review_pack_mixed_<run_id>.jsonl \
  LIMIT_INTERNAL=60 LIMIT_LAPA=70 LIMIT_CELEBA=70 TARGET_TOTAL=200 \
  OVERLAP_RATIO=0.25 OVERLAP_MIN=40 \
  PREFERENCE_MODULE_BOX_MODE=dynamic_skinmask \
  PREFERENCE_REQUIRE_DYNAMIC_BOXES=true \
  PREFERENCE_MIN_GEOMETRY_QC_SCORE=0.2 \
  PREFERENCE_HARD_FILTER_GATE=true \
  PREFERENCE_HARD_FILTER_REQUIRE_QUALITY_PASS=true \
  PREFERENCE_HARD_FILTER_MAX_GUARDED_MODULES=1 \
  PREFERENCE_HARD_FILTER_MIN_MODULE_PIXELS=48 \
  PREFERENCE_HARD_FILTER_MIN_DYNAMIC_SCORE=0.7

# Visual-separability focused sweep (recommended for cannot_tell-heavy slices):
make preference-round1-real-pack \
  RUN_ID=<run_id> \
  INTERNAL_DIR="/absolute/path/to/internal_clean_photos" \
  REVIEW_PACK_JSONL=reports/review_pack_mixed_<run_id>.jsonl \
  TARGET_TOTAL=80 PREFERENCE_MAX_EDGE=768 \
  PREFERENCE_REQUIRE_DYNAMIC_BOXES=true \
  OVERLAP_RATIO=0.25 OVERLAP_MIN=40

# Task files for assignment:
# - tasks_batch_a.json (annotator A)
# - tasks_batch_b.json (annotator B)
# - tasks_overlap.json (shared overlap subset)
# - tasks_all.json (all unique samples, convenience)

# 2) Label in Label Studio with label_studio/project_preference_ab.xml
# 3) Import Label Studio export
make preference-label-import \
  RUN_ID=<run_id> \
  ROUND1_IN=artifacts/preference_round1_<run_id>/label_studio_export_preference_<run_id>.json \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json \
  OUT=artifacts/preference_round1_<run_id>/preference_labels.ndjson

# 4) Evaluate preference win-rate + disagreement + IAA
make eval-preference \
  RUN_ID=<run_id> \
  PREFERENCE_LABELS=artifacts/preference_round1_<run_id>/preference_labels.ndjson \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json

# 5) Build adjudication pack for contentious samples
make preference-adjudication-pack \
  RUN_ID=<run_id> \
  EVAL_JSONL=reports/eval_preference_<run_id>.jsonl \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json \
  OUT=artifacts/preference_round1_<run_id>/adjudication

# 6) Release gate for variant1 vs baseline
make release-gate-preference \
  RUN_ID=<run_id> \
  EVAL_JSONL=reports/eval_preference_<run_id>.jsonl \
  EVAL_MD=reports/eval_preference_<run_id>.md \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json

# 7) Step 3 finalization: merge adjudication overrides + rerun eval/gate
make preference-final \
  RUN_ID=<run_id> \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json \
  BASE_EXPORTS="artifacts/preference_round1_<run_id>/label_studio_export_batch_a_<run_id>.json,artifacts/preference_round1_<run_id>/label_studio_export_batch_b_<run_id>.json,artifacts/preference_round1_<run_id>/label_studio_export_overlap_<run_id>.json" \
  ADJ_EXPORTS="artifacts/preference_round1_<run_id>/adjudication/label_studio_export_adjudication_<run_id>.json"

# Optional explicit split commands:
make preference-import EXPORTS="<base_export_1.json>,<base_export_2.json>" MANIFEST=artifacts/preference_round1_<run_id>/manifest.json OUT=artifacts/preference_round1_<run_id>/final/base_labels.ndjson
make preference-adjudication-merge BASE=artifacts/preference_round1_<run_id>/final/base_labels.ndjson ADJ=artifacts/preference_round1_<run_id>/final/adjudication_labels.ndjson OUT=artifacts/preference_round1_<run_id>/final/preference_labels_merged.ndjson

# 8) Diagnostics (why wins/disagreement + concrete next actions)
make preference-diagnostics \
  RUN_ID=<run_id> \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json \
  EVAL_JSONL=reports/eval_preference_<run_id>.jsonl \
  LABELS=artifacts/preference_round1_<run_id>/final/preference_labels_merged.ndjson \
  CROSSSET_JSONL=reports/eval_circle_crossset_<run_id>.jsonl
```

Smoke run recipe (Step2):
```bash
make preference-round1-real-pack \
  RUN_ID=<run_id> \
  INTERNAL_DIR=<internal_dir> \
  EXTERNAL_INDEX_LAPA=<lapa_index_jsonl> \
  EXTERNAL_INDEX_CELEBA=<celeba_index_jsonl> \
  LIMIT_INTERNAL=5 LIMIT_LAPA=5 LIMIT_CELEBA=5 \
  TARGET_TOTAL=20 OVERLAP_RATIO=0.3 OVERLAP_MIN=6 \
  PREFERENCE_MAX_EDGE=768 \
  MOCK_PIPELINE=true
```

Expected smoke outputs:
- `artifacts/preference_round1_<run_id>/tasks_batch_a.json`
- `artifacts/preference_round1_<run_id>/tasks_batch_b.json`
- `artifacts/preference_round1_<run_id>/tasks_overlap.json`
- `artifacts/preference_round1_<run_id>/tasks_all.json`
- `reports/eval_preference_<run_id>.md`
- `reports/RELEASE_GATE_PREFERENCE_<run_id>.md`
- `reports/PREFERENCE_FINAL_<run_id>.md`
- `reports/preference_diagnostics_<run_id>.md`

Adjudication policy:
- Include samples with high disagreement, high `cannot_tell`, or risk conflicts (`hair_overlap_est`, `leakage_bg_est_mean`, low `min_module_pixels`).
- Adjudicator labels only this reduced pack and writes final decision notes.
- Feed adjudication outcomes back into default-parameter choice before promoting a variant.
