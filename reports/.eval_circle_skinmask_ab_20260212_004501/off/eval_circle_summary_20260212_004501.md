# Circle Accuracy Evaluation

- run_id: 20260212_004501
- generated_at: 2026-02-12T00:45:02.665Z
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
- samples_total: 27
- samples_ok: 27
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.058
- leakage_non_skin_mean: 0.837
- leakage_bg_mean: 0.053
- leakage_hair_mean: 0.011
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

- leakage_non_skin_mean 0.837 > observation 0.1

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
| fasseg | segmentation_only | chin | 27 | 0.022 | 0.006 | 0.032 | 0.196 | 0.971 | 0.141 | 0.004 | 2124 | 0 | 0 |
| fasseg | segmentation_only | forehead | 27 | 0.057 | 0.049 | 0.117 | 0.11 | 0.899 | 0.06 | 0.011 | 1318 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 27 | 0.042 | 0.031 | 0.088 | 0.167 | 0.937 | 0.025 | 0.01 | 3324 | 0 | 0 |
| fasseg | segmentation_only | nose | 27 | 0.219 | 0.21 | 0.259 | 0.274 | 0.15 | 0.095 | 0.038 | 700 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 27 | 0.031 | 0.017 | 0.075 | 0.171 | 0.956 | 0.025 | 0.008 | 2492 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 26 | 0.021 | 0.001 | 0.051 | 0.164 | 0.976 | 0.011 | 0.004 | 1052 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 25 | 0.011 | 0 | 0.035 | 0.193 | 0.987 | 0.012 | 0.003 | 1052 | 0 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_skinmask_ab_20260212_004501/off/eval_circle_20260212_004501.jsonl`
- csv: `reports/.eval_circle_skinmask_ab_20260212_004501/off/eval_circle_summary_20260212_004501.csv`

