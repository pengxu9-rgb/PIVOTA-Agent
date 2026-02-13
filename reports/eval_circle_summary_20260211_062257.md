# Circle Accuracy Evaluation

- run_id: 20260211_062257
- generated_at: 2026-02-11T06:23:02.510Z
- mode: local
- datasets: fasseg
- dataset_eval_mode: fasseg:segmentation_only
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_reverted_modules: none
- circle_model_reverted_module_count: 0
- circle_model_excluded_modules: under_eye_left, under_eye_right
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- score_grid_size: 256
- samples_total: 80
- samples_ok: 80
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.045
- leakage_non_skin_mean: 0.863
- leakage_bg_mean: 0.134
- leakage_hair_mean: 0.006
- empty_module_rate: 0
- module_pixels_min: 316
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
- leakage_non_skin_mean 0.863 > observation 0.1

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
| fasseg | segmentation_only | chin | 80 | 0.027 | 0.024 | 0.042 | 0.373 | 0.968 | 0.562 | 0.004 | 2076 | 0 | 0 |
| fasseg | segmentation_only | forehead | 80 | 0.024 | 0.014 | 0.062 | 0.047 | 0.935 | 0.051 | 0.01 | 316 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 80 | 0.032 | 0.015 | 0.077 | 0.209 | 0.955 | 0.032 | 0.007 | 2908 | 0 | 0 |
| fasseg | segmentation_only | nose | 80 | 0.192 | 0.195 | 0.26 | 0.283 | 0.253 | 0.218 | 0.015 | 636 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 80 | 0.027 | 0.011 | 0.078 | 0.214 | 0.962 | 0.037 | 0.005 | 2492 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 75 | 0.006 | 0 | 0.011 | 0.214 | 0.993 | 0.012 | 0.002 | 572 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 76 | 0.006 | 0 | 0.016 | 0.224 | 0.993 | 0.014 | 0.002 | 572 | 0 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_062257.jsonl`
- csv: `reports/eval_circle_summary_20260211_062257.csv`

