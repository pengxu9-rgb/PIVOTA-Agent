# FASSEG Skinmask Evaluation

- run_id: 20260211_031109
- generated_at: 2026-02-11T03:11:24.980Z
- dataset: fasseg
- onnx: artifacts/skinmask_v1.onnx
- limit: 150
- grid_size: 128
- timeout_ms: 30000
- sample_seed: skinmask_fasseg_eval
- shuffle: false
- samples_total: 150
- samples_ok: 150
- samples_failed: 0

## Schema

- schema_path: artifacts/skinmask_v1.schema.json
- schema_loaded: true
- schema_version: aurora.skinmask.schema.v1
- input_color_space: RGB
- input_range: 0-1
- input_size: 512x512
- output_type: softmax
- output_classes: background,skin,hair,eyes,nose,mouth
- skin_class: skin
- skin_class_id: 1

## Metrics

| metric | mean | p50 | p90 |
|---|---:|---:|---:|
| skin_iou | 0.312 | 0.341 | 0.563 |
| hair_as_skin_rate | 0.005 | 0.002 | 0.015 |
| bg_as_skin_rate | 0.058 | 0.064 | 0.112 |
| skin_miss_rate | 0.673 | 0.652 | 0.977 |
| pred_skin_ratio | 0.21 | 0.232 | 0.385 |


## Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| - | 0 | 0 |

## Artifacts

- md: `reports/eval_skinmask_fasseg_20260211_031109.md`
- csv: `reports/eval_skinmask_fasseg_20260211_031109.csv`
- jsonl: `reports/eval_skinmask_fasseg_20260211_031109.jsonl`

