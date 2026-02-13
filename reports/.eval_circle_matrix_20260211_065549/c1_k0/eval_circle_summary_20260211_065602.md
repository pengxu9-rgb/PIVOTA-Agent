# Circle Accuracy Evaluation

- run_id: 20260211_065602
- generated_at: 2026-02-11T06:56:10.002Z
- mode: local
- datasets: fasseg
- dataset_eval_mode: fasseg:segmentation_only
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_reverted_modules: none
- circle_model_reverted_module_count: 0
- circle_model_excluded_modules: under_eye_left, under_eye_right
- circle_model_calibration: false
- skinmask_enabled: false
- skinmask_model_path: n/a
- score_grid_size: 256
- samples_total: 116
- samples_ok: 116
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.048
- leakage_non_skin_mean: 0.851
- leakage_bg_mean: 0.053
- leakage_hair_mean: 0.006
- empty_module_rate: 0
- module_pixels_min: 204
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

- leakage_non_skin_mean 0.851 > observation 0.1

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
| fasseg | segmentation_only | chin | 116 | 0.006 | 0 | 0.016 | 0.134 | 0.99 | 0.074 | 0.001 | 204 | 0 | 0 |
| fasseg | segmentation_only | forehead | 116 | 0.034 | 0.027 | 0.074 | 0.125 | 0.919 | 0.077 | 0.013 | 316 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 116 | 0.033 | 0.017 | 0.079 | 0.172 | 0.952 | 0.027 | 0.006 | 2492 | 0 | 0 |
| fasseg | segmentation_only | nose | 116 | 0.215 | 0.21 | 0.258 | 0.276 | 0.166 | 0.139 | 0.011 | 700 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 116 | 0.028 | 0.017 | 0.078 | 0.172 | 0.96 | 0.03 | 0.006 | 2492 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 111 | 0.005 | 0 | 0.009 | 0.155 | 0.994 | 0.009 | 0.001 | 572 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 110 | 0.007 | 0 | 0.016 | 0.166 | 0.992 | 0.011 | 0.001 | 572 | 0 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_matrix_20260211_065549/c1_k0/eval_circle_20260211_065602.jsonl`
- csv: `reports/.eval_circle_matrix_20260211_065549/c1_k0/eval_circle_summary_20260211_065602.csv`

