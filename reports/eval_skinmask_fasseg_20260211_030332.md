# FASSEG Skinmask Evaluation

- run_id: 20260211_030332
- generated_at: 2026-02-11T03:03:50.548Z
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
| skin_iou | 0.089 | 0.097 | 0.117 |
| hair_as_skin_rate | 0.006 | 0.005 | 0.008 |
| bg_as_skin_rate | 0.904 | 0.897 | 0.991 |
| skin_miss_rate | 0.09 | 0.071 | 0.148 |
| pred_skin_ratio | 0.858 | 0.868 | 0.962 |

## Warnings

- WARNING: SKINMASK_CLASS_MAPPING_LIKELY_WRONG (pred_skin_ratio_mean=0.858, skin_iou_mean=0.089). likely class mapping wrong.


## Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| - | 0 | 0 |

## Artifacts

- md: `reports/eval_skinmask_fasseg_20260211_030332.md`
- csv: `reports/eval_skinmask_fasseg_20260211_030332.csv`
- jsonl: `reports/eval_skinmask_fasseg_20260211_030332.jsonl`

