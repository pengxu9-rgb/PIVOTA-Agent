# Circle Accuracy Evaluation

- run_id: 20260211_062636
- generated_at: 2026-02-11T06:26:41.343Z
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
- module_mIoU_mean: 0.069
- leakage_non_skin_mean: 0.843
- leakage_bg_mean: 0.084
- leakage_hair_mean: 0.007
- empty_module_rate: 0
- module_pixels_min: 374
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

- leakage_non_skin_mean 0.843 > observation 0.1

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
| fasseg | segmentation_only | chin | 80 | 0.008 | 0 | 0.021 | 0.185 | 0.988 | 0.094 | 0.001 | 988 | 0 | 0 |
| fasseg | segmentation_only | forehead | 80 | 0.045 | 0.008 | 0.116 | 0.145 | 0.936 | 0.102 | 0.01 | 374 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 80 | 0.066 | 0.067 | 0.126 | 0.49 | 0.912 | 0.044 | 0.007 | 4620 | 0 | 0 |
| fasseg | segmentation_only | nose | 80 | 0.204 | 0.215 | 0.277 | 0.296 | 0.256 | 0.22 | 0.016 | 700 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 80 | 0.055 | 0.053 | 0.113 | 0.453 | 0.927 | 0.049 | 0.006 | 4556 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 75 | 0.056 | 0.045 | 0.12 | 0.981 | 0.941 | 0.038 | 0.006 | 1356 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 76 | 0.044 | 0.016 | 0.11 | 0.956 | 0.955 | 0.037 | 0.005 | 1356 | 0 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_062636.jsonl`
- csv: `reports/eval_circle_summary_20260211_062636.csv`

