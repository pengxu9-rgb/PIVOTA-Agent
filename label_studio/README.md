# Label Studio Local Setup (Aurora Gold)

## 1) Start Label Studio (local only)

```bash
pip install label-studio
export LABEL_STUDIO_LOCAL_FILES_SERVING_ENABLED=true
export LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT=/absolute/path/to/pivota-agent-backend
label-studio start
```

Use `label_studio/project_oval_skin.xml` as the labeling config.

## 2) Generate seed tasks

```bash
make gold-seed-pack LIMIT=120
```

This generates:
- `artifacts/gold_seed_tasks_labelstudio.json`
- `artifacts/gold_seed_manifest.json`
- `reports/gold_seed_pack_<run_id>.md`

Import `artifacts/gold_seed_tasks_labelstudio.json` into the project.

For Round1 real workflow from `review_pack_mixed`, use:

```bash
make gold-round1-real-pack \
  RUN_ID=<run_id> \
  REVIEW_JSONL=reports/review_pack_mixed_<run_id>.jsonl \
  LIMIT=200
```

Import: `artifacts/gold_round1_real_<run_id>/tasks.json`.

## 3) Export labels and import to Aurora format

After labeling, export JSON from Label Studio and run:

```bash
make gold-label-import ROUND1_IN=/path/to/label_studio_export.json OUT=artifacts/gold_labels.ndjson
```

This writes `artifacts/gold_labels.ndjson`.

## 4) Evaluate gold labels

```bash
make eval-gold-round1 GOLD_LABELS=artifacts/gold_labels.ndjson PRED_JSONL=reports/review_pack_mixed_<run_id>.jsonl
make eval-gold-ab GOLD_LABELS=artifacts/gold_labels.ndjson PRED_JSONL=reports/review_pack_mixed_<run_id>.jsonl
```

Outputs:
- `reports/eval_gold_<run_id>.md`
- `reports/eval_gold_<run_id>.csv`
- `reports/eval_gold_ab_<run_id>.md`
- `artifacts/calibration_train_samples.ndjson`

## Notes
- Local-only workflow; no image upload is required.
- Tasks keep `sample_hash` as primary identifier.
- Do not commit real images or PII.

## Preference Labeling v1 (A/B)

Use config: `label_studio/project_preference_ab.xml`.

```bash
# 1) Build real Round1 A/B pack (baseline vs variant1)
make preference-round1-real-pack \
  RUN_ID=<run_id> \
  INTERNAL_DIR="/absolute/path/to/internal_clean_photos" \
  REVIEW_PACK_JSONL=reports/review_pack_mixed_<run_id>.jsonl \
  LIMIT_INTERNAL=60 LIMIT_LAPA=70 LIMIT_CELEBA=70 TARGET_TOTAL=200 \
  OVERLAP_RATIO=0.25 OVERLAP_MIN=40

# Outputs:
# - artifacts/preference_round1_<run_id>/tasks_batch_a.json
# - artifacts/preference_round1_<run_id>/tasks_batch_b.json
# - artifacts/preference_round1_<run_id>/tasks_overlap.json
# - artifacts/preference_round1_<run_id>/tasks_all.json

# 2) Export JSON from Label Studio and import (manifest-aware unflip)
make preference-label-import \
  RUN_ID=<run_id> \
  ROUND1_IN=artifacts/preference_round1_<run_id>/label_studio_export_preference_<run_id>.json \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json \
  OUT=artifacts/preference_round1_<run_id>/preference_labels.ndjson

# 3) Evaluate preference + IAA
make eval-preference RUN_ID=<run_id> PREFERENCE_LABELS=artifacts/preference_round1_<run_id>/preference_labels.ndjson MANIFEST=artifacts/preference_round1_<run_id>/manifest.json

# 4) Build adjudication tasks for contentious samples (non-blind baseline/variant1)
make preference-adjudication-pack RUN_ID=<run_id> EVAL_JSONL=reports/eval_preference_<run_id>.jsonl MANIFEST=artifacts/preference_round1_<run_id>/manifest.json OUT=artifacts/preference_round1_<run_id>/adjudication

# 5) Release gate
make release-gate-preference RUN_ID=<run_id> EVAL_JSONL=reports/eval_preference_<run_id>.jsonl EVAL_MD=reports/eval_preference_<run_id>.md MANIFEST=artifacts/preference_round1_<run_id>/manifest.json

# 6) Step 3 final: merge adjudication overrides and regenerate final verdict
make preference-final \
  RUN_ID=<run_id> \
  MANIFEST=artifacts/preference_round1_<run_id>/manifest.json \
  BASE_EXPORTS="artifacts/preference_round1_<run_id>/label_studio_export_batch_a_<run_id>.json,artifacts/preference_round1_<run_id>/label_studio_export_batch_b_<run_id>.json,artifacts/preference_round1_<run_id>/label_studio_export_overlap_<run_id>.json" \
  ADJ_EXPORTS="artifacts/preference_round1_<run_id>/adjudication/label_studio_export_adjudication_<run_id>.json"

# Optional split commands:
make preference-import EXPORTS="<base_export_1.json>,<base_export_2.json>" MANIFEST=artifacts/preference_round1_<run_id>/manifest.json OUT=artifacts/preference_round1_<run_id>/final/base_labels.ndjson
make preference-adjudication-merge BASE=artifacts/preference_round1_<run_id>/final/base_labels.ndjson ADJ=artifacts/preference_round1_<run_id>/final/adjudication_labels.ndjson OUT=artifacts/preference_round1_<run_id>/final/preference_labels_merged.ndjson

# 7) Diagnostics report for actionable follow-up
make preference-diagnostics RUN_ID=<run_id> MANIFEST=artifacts/preference_round1_<run_id>/manifest.json EVAL_JSONL=reports/eval_preference_<run_id>.jsonl LABELS=artifacts/preference_round1_<run_id>/final/preference_labels_merged.ndjson CROSSSET_JSONL=reports/eval_circle_crossset_<run_id>.jsonl
```
