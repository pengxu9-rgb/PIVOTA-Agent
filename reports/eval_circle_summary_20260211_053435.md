# Circle Accuracy Evaluation

- run_id: 20260211_053435
- generated_at: 2026-02-11T05:34:43.191Z
- mode: local
- datasets: fasseg
- dataset_eval_mode: fasseg:segmentation_only
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- score_grid_size: 256
- samples_total: 150
- samples_ok: 150
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.087
- leakage_non_skin_mean: 0.836
- leakage_bg_mean: 0.134
- leakage_hair_mean: 0.008
- empty_module_rate: 0
- module_pixels_min: 476
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

- leakage_bg_mean 0.134 > threshold 0.1
- leakage_non_skin_mean 0.836 > observation 0.1

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
| fasseg | segmentation_only | chin | 150 | 0.028 | 0.026 | 0.042 | 0.381 | 0.967 | 0.602 | 0.005 | 2460 | 0 | 0 |
| fasseg | segmentation_only | forehead | 150 | 0.053 | 0.064 | 0.086 | 0.077 | 0.844 | 0.094 | 0.016 | 476 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 150 | 0.045 | 0.033 | 0.095 | 0.251 | 0.939 | 0.029 | 0.007 | 3532 | 0 | 0 |
| fasseg | segmentation_only | nose | 150 | 0.443 | 0.492 | 0.551 | 0.585 | 0.192 | 0.144 | 0.014 | 2156 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 150 | 0.039 | 0.033 | 0.088 | 0.24 | 0.948 | 0.032 | 0.006 | 3532 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 150 | 0 | 0 | 0 | 0 | 0.979 | 0.021 | 0.004 | 1244 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 150 | 0 | 0 | 0 | 0 | 0.986 | 0.018 | 0.003 | 1244 | 0 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_053435.jsonl`
- csv: `reports/eval_circle_summary_20260211_053435.csv`

