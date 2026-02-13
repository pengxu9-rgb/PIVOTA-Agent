# Circle Accuracy Evaluation

- run_id: 20260211_105506
- generated_at: 2026-02-11T10:55:07.548Z
- mode: local
- datasets: fasseg
- dataset_eval_mode: fasseg:segmentation_only
- circle_model_enabled: false
- circle_model_path: n/a
- circle_model_reverted_modules: none
- circle_model_reverted_module_count: 0
- circle_model_excluded_modules: under_eye_left, under_eye_right
- circle_model_calibration: false
- skinmask_enabled: false
- skinmask_model_path: n/a
- score_grid_size: 256
- samples_total: 19
- samples_ok: 19
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.071
- leakage_non_skin_mean: 0.819
- leakage_bg_mean: 0.041
- leakage_hair_mean: 0.007
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

- leakage_non_skin_mean 0.819 > observation 0.1

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
| fasseg | segmentation_only | chin | 19 | 0.018 | 0.015 | 0.04 | 0.226 | 0.981 | 0.134 | 0.003 | 2124 | 0 | 0 |
| fasseg | segmentation_only | forehead | 19 | 0.09 | 0.072 | 0.182 | 0.41 | 0.897 | 0.072 | 0.018 | 2108 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 19 | 0.062 | 0.051 | 0.095 | 0.271 | 0.924 | 0.026 | 0.008 | 3324 | 0 | 0 |
| fasseg | segmentation_only | nose | 19 | 0.257 | 0.232 | 0.253 | 0.273 | 0.033 | 0.019 | 0.006 | 700 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 19 | 0.034 | 0.021 | 0.092 | 0.185 | 0.96 | 0.015 | 0.005 | 2700 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 18 | 0.02 | 0.006 | 0.056 | 0.129 | 0.975 | 0.011 | 0.004 | 1228 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 17 | 0.01 | 0 | 0.021 | 0.073 | 0.989 | 0.004 | 0.002 | 1228 | 0 | 0 |

## Artifacts

- jsonl: `reports/.tmp_eval/eval_circle_20260211_105506.jsonl`
- csv: `reports/.tmp_eval/eval_circle_summary_20260211_105506.csv`

