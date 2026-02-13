# Circle Accuracy Evaluation

- run_id: 20260211_052615
- generated_at: 2026-02-11T05:26:27.856Z
- mode: local
- datasets: fasseg
- dataset_eval_mode: fasseg:segmentation_only
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: true
- skinmask_model_path: artifacts/skinmask_v2.onnx
- score_grid_size: 256
- samples_total: 150
- samples_ok: 150
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.096
- leakage_non_skin_mean: 0.835
- leakage_bg_mean: 0.132
- leakage_hair_mean: 0.009
- empty_module_rate: 0
- module_pixels_min: 1084
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65 (observation only for segmentation_only datasets)
- face_detect_fail_rate <= 0.05
- leakage_bg_mean <= 0.1
- empty_module_rate <= 0.01
- leakage_non_skin_mean (observation only)
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- leakage_bg_mean 0.132 > threshold 0.1
- leakage_non_skin_mean 0.835 > observation 0.1

## Top Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| - | 0 | 0 |

## PRED_MODULES_MISSING breakdown

| reason_detail | count | pct_of_missing |
|---|---:|---:|
| - | 0 | 0 |

## Per-Module Summary

| dataset | mode | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage_non_skin mean | leakage_bg mean | leakage_hair mean | module_pixels_min | empty_module_rate | roi_too_small_rate |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fasseg | segmentation_only | chin | 150 | 0.032 | 0.03 | 0.044 | 0.588 | 0.964 | 0.511 | 0.005 | 2908 | 0 | 0 |
| fasseg | segmentation_only | forehead | 150 | 0.086 | 0.095 | 0.146 | 0.184 | 0.858 | 0.129 | 0.018 | 1084 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 150 | 0.061 | 0.053 | 0.117 | 0.345 | 0.917 | 0.034 | 0.008 | 3448 | 0 | 0 |
| fasseg | segmentation_only | nose | 150 | 0.443 | 0.492 | 0.563 | 0.662 | 0.245 | 0.15 | 0.016 | 2154 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 150 | 0.053 | 0.052 | 0.098 | 0.326 | 0.929 | 0.037 | 0.007 | 3512 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 150 | 0 | 0 | 0 | 0 | 0.959 | 0.034 | 0.006 | 1432 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 150 | 0 | 0 | 0 | 0 | 0.972 | 0.028 | 0.004 | 1340 | 0 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_052615.jsonl`
- csv: `reports/eval_circle_summary_20260211_052615.csv`

