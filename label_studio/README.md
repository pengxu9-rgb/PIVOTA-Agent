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

## 3) Export labels and import to Aurora format

After labeling, export JSON from Label Studio and run:

```bash
make gold-label-import GOLD_IMPORT_IN=/path/to/label_studio_export.json
```

This writes `artifacts/gold_labels.ndjson`.

## 4) Evaluate gold labels

```bash
make eval-gold GOLD_LABELS=artifacts/gold_labels.ndjson PRED_JSONL=reports/review_pack_mixed_<run_id>.jsonl
```

Outputs:
- `reports/eval_gold_<run_id>.md`
- `reports/eval_gold_<run_id>.csv`
- `artifacts/calibration_train_samples.ndjson`

## Notes
- Local-only workflow; no image upload is required.
- Tasks keep `sample_hash` as primary identifier.
- Do not commit real images or PII.
