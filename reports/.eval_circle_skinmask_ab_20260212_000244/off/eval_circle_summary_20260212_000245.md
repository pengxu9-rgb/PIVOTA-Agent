# Circle Accuracy Evaluation

- run_id: 20260212_000245
- generated_at: 2026-02-12T00:02:50.906Z
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
- samples_total: 114
- samples_ok: 114
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.052
- leakage_non_skin_mean: 0.852
- leakage_bg_mean: 0.066
- leakage_hair_mean: 0.006
- empty_module_rate: 0
- module_pixels_min: 700
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

- leakage_non_skin_mean 0.852 > observation 0.1

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
| fasseg | segmentation_only | chin | 114 | 0.015 | 0.011 | 0.029 | 0.24 | 0.98 | 0.153 | 0.003 | 2124 | 0 | 0 |
| fasseg | segmentation_only | forehead | 114 | 0.043 | 0.025 | 0.102 | 0.093 | 0.927 | 0.057 | 0.011 | 1318 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 114 | 0.034 | 0.015 | 0.077 | 0.184 | 0.952 | 0.028 | 0.006 | 3116 | 0 | 0 |
| fasseg | segmentation_only | nose | 114 | 0.219 | 0.213 | 0.285 | 0.294 | 0.189 | 0.157 | 0.011 | 700 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 114 | 0.029 | 0.018 | 0.078 | 0.188 | 0.958 | 0.033 | 0.006 | 2492 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 108 | 0.014 | 0 | 0.04 | 0.207 | 0.984 | 0.015 | 0.002 | 1052 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 109 | 0.01 | 0 | 0.03 | 0.22 | 0.988 | 0.017 | 0.002 | 1052 | 0 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_skinmask_ab_20260212_000244/off/eval_circle_20260212_000245.jsonl`
- csv: `reports/.eval_circle_skinmask_ab_20260212_000244/off/eval_circle_summary_20260212_000245.csv`

