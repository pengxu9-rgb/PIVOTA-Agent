# FASSEG Skinmask Evaluation

- run_id: 20260212_004425
- generated_at: 2026-02-12T00:44:26.788Z
- dataset: fasseg
- onnx: artifacts/skinmask_v2.onnx
- limit: 30
- grid_size: 128
- timeout_ms: 30000
- sample_seed: skinmask_fasseg_eval
- shuffle: false
- samples_total: 30
- samples_ok: 30
- samples_failed: 0

## Schema

- schema_path: artifacts/skinmask_v2.schema.json
- schema_loaded: true
- schema_version: aurora.skinmask.schema.v1
- input_color_space: RGB
- input_range: 0-1
- input_size: 256x256
- output_type: sigmoid
- output_classes: non_skin,skin
- skin_class: skin
- skin_class_id: 1

## Metrics

| metric | mean | p50 | p90 |
|---|---:|---:|---:|
| skin_iou | 0.682 | 0.69 | 0.793 |
| hair_as_skin_rate | 0.219 | 0.199 | 0.388 |
| bg_as_skin_rate | 0.057 | 0.059 | 0.069 |
| skin_miss_rate | 0.074 | 0.028 | 0.162 |
| pred_skin_ratio | 0.829 | 0.856 | 0.963 |


## Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| - | 0 | 0 |

## Artifacts

- md: `reports/eval_skinmask_fasseg_20260212_004425.md`
- csv: `reports/eval_skinmask_fasseg_20260212_004425.csv`
- jsonl: `reports/eval_skinmask_fasseg_20260212_004425.jsonl`

