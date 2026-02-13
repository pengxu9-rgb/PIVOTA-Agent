# Circle Accuracy Evaluation

- run_id: 20260211_053556
- generated_at: 2026-02-11T05:36:05.142Z
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
- module_mIoU_mean: 0.061
- leakage_non_skin_mean: 0.847
- leakage_bg_mean: 0.118
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

- leakage_bg_mean 0.118 > threshold 0.1
- leakage_non_skin_mean 0.847 > observation 0.1

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
| fasseg | segmentation_only | chin | 150 | 0.03 | 0.027 | 0.049 | 0.282 | 0.963 | 0.569 | 0.005 | 1340 | 0 | 0 |
| fasseg | segmentation_only | forehead | 150 | 0.031 | 0.02 | 0.078 | 0.056 | 0.919 | 0.05 | 0.011 | 316 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 150 | 0.033 | 0.016 | 0.077 | 0.171 | 0.954 | 0.025 | 0.006 | 2876 | 0 | 0 |
| fasseg | segmentation_only | nose | 150 | 0.307 | 0.323 | 0.408 | 0.368 | 0.148 | 0.123 | 0.009 | 1052 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 150 | 0.028 | 0.016 | 0.071 | 0.167 | 0.962 | 0.028 | 0.005 | 2876 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 150 | 0 | 0 | 0 | 0 | 0.99 | 0.016 | 0.003 | 1148 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 150 | 0 | 0 | 0 | 0 | 0.992 | 0.014 | 0.002 | 1148 | 0 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_053556.jsonl`
- csv: `reports/eval_circle_summary_20260211_053556.csv`

