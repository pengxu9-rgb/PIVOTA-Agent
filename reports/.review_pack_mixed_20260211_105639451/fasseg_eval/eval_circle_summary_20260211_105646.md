# Circle Accuracy Evaluation

- run_id: 20260211_105646
- generated_at: 2026-02-11T10:56:51.784Z
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
- samples_total: 105
- samples_ok: 105
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.061
- leakage_non_skin_mean: 0.851
- leakage_bg_mean: 0.071
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
| fasseg | segmentation_only | chin | 105 | 0.019 | 0.013 | 0.04 | 0.312 | 0.98 | 0.157 | 0.003 | 2124 | 0 | 0 |
| fasseg | segmentation_only | forehead | 105 | 0.069 | 0.058 | 0.139 | 0.423 | 0.92 | 0.086 | 0.013 | 2108 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 105 | 0.039 | 0.018 | 0.102 | 0.311 | 0.953 | 0.029 | 0.006 | 2492 | 0 | 0 |
| fasseg | segmentation_only | nose | 104 | 0.238 | 0.231 | 0.262 | 0.347 | 0.181 | 0.153 | 0.012 | 700 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 105 | 0.037 | 0.021 | 0.097 | 0.323 | 0.957 | 0.034 | 0.005 | 2492 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 100 | 0.01 | 0 | 0.03 | 0.189 | 0.988 | 0.015 | 0.003 | 1052 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 98 | 0.011 | 0 | 0.028 | 0.207 | 0.987 | 0.016 | 0.002 | 1052 | 0 | 0 |

## Artifacts

- jsonl: `reports/.review_pack_mixed_20260211_105639451/fasseg_eval/eval_circle_20260211_105646.jsonl`
- csv: `reports/.review_pack_mixed_20260211_105639451/fasseg_eval/eval_circle_summary_20260211_105646.csv`

