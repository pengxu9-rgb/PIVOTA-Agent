# FASSEG Skinmask Evaluation

- run_id: 20260211_031034
- generated_at: 2026-02-11T03:10:34.935Z
- dataset: fasseg
- onnx: artifacts/skinmask_v1.onnx
- limit: 150
- grid_size: 128
- timeout_ms: 30000
- sample_seed: skinmask_fasseg_eval
- shuffle: false
- samples_total: 150
- samples_ok: 0
- samples_failed: 150

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
| skin_iou | 0 | 0 | 0 |
| hair_as_skin_rate | 0 | 0 | 0 |
| bg_as_skin_rate | 0 | 0 | 0 |
| skin_miss_rate | 0 | 0 | 0 |
| pred_skin_ratio | 0 | 0 | 0 |


## Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| GT_SKIN_MISSING | 150 | 1 |

## Artifacts

- md: `reports/eval_skinmask_fasseg_20260211_031034.md`
- csv: `reports/eval_skinmask_fasseg_20260211_031034.csv`
- jsonl: `reports/eval_skinmask_fasseg_20260211_031034.jsonl`

