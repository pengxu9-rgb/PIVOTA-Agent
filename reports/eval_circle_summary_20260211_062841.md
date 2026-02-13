# Circle Accuracy Evaluation

- run_id: 20260211_062841
- generated_at: 2026-02-11T06:28:49.965Z
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
- samples_total: 150
- samples_ok: 150
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.076
- leakage_non_skin_mean: 0.821
- leakage_bg_mean: 0.066
- leakage_hair_mean: 0.007
- empty_module_rate: 0
- module_pixels_min: 438
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

- leakage_non_skin_mean 0.821 > observation 0.1

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
| fasseg | segmentation_only | chin | 150 | 0.005 | 0 | 0.016 | 0.125 | 0.99 | 0.065 | 0.002 | 1212 | 0 | 0 |
| fasseg | segmentation_only | forehead | 150 | 0.056 | 0.063 | 0.122 | 0.176 | 0.923 | 0.127 | 0.012 | 438 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 150 | 0.07 | 0.068 | 0.126 | 0.461 | 0.903 | 0.036 | 0.008 | 4620 | 0 | 0 |
| fasseg | segmentation_only | nose | 150 | 0.221 | 0.215 | 0.272 | 0.279 | 0.148 | 0.123 | 0.009 | 700 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 150 | 0.063 | 0.065 | 0.108 | 0.435 | 0.916 | 0.039 | 0.007 | 4796 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 143 | 0.066 | 0.05 | 0.15 | 0.981 | 0.931 | 0.033 | 0.007 | 1356 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 142 | 0.05 | 0.032 | 0.125 | 0.965 | 0.948 | 0.034 | 0.006 | 1356 | 0 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_062841.jsonl`
- csv: `reports/eval_circle_summary_20260211_062841.csv`

