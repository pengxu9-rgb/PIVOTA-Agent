# FASSEG Skinmask Evaluation

- run_id: 20260212_000232
- generated_at: 2026-02-12T00:02:37.813Z
- dataset: fasseg
- onnx: artifacts/skinmask_v2.onnx
- limit: 150
- grid_size: 128
- timeout_ms: 30000
- sample_seed: skinmask_fasseg_eval
- shuffle: false
- samples_total: 150
- samples_ok: 150
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
| skin_iou | 0.705 | 0.72 | 0.814 |
| hair_as_skin_rate | 0.202 | 0.181 | 0.353 |
| bg_as_skin_rate | 0.058 | 0.058 | 0.071 |
| skin_miss_rate | 0.057 | 0.028 | 0.143 |
| pred_skin_ratio | 0.807 | 0.826 | 0.968 |


## Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| - | 0 | 0 |

## Artifacts

- md: `reports/eval_skinmask_fasseg_20260212_000232.md`
- csv: `reports/eval_skinmask_fasseg_20260212_000232.csv`
- jsonl: `reports/eval_skinmask_fasseg_20260212_000232.jsonl`

