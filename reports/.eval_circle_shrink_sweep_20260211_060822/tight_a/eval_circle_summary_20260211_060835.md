# Circle Accuracy Evaluation

- run_id: 20260211_060835
- generated_at: 2026-02-11T06:08:41.226Z
- mode: local
- datasets: fasseg
- dataset_eval_mode: fasseg:segmentation_only
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_reverted_modules: under_eye_left, under_eye_right
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- score_grid_size: 256
- samples_total: 117
- samples_ok: 117
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.088
- leakage_non_skin_mean: 0.833
- leakage_bg_mean: 0.074
- leakage_hair_mean: 0.008
- empty_module_rate: 0
- module_pixels_min: 342
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

- leakage_non_skin_mean 0.833 > observation 0.1

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
| fasseg | segmentation_only | chin | 117 | 0.006 | 0 | 0.017 | 0.146 | 0.987 | 0.093 | 0.002 | 1148 | 0 | 0 |
| fasseg | segmentation_only | forehead | 117 | 0.049 | 0.048 | 0.115 | 0.127 | 0.921 | 0.109 | 0.013 | 342 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 117 | 0.056 | 0.053 | 0.11 | 0.355 | 0.924 | 0.036 | 0.008 | 4092 | 0 | 0 |
| fasseg | segmentation_only | nose | 117 | 0.327 | 0.364 | 0.414 | 0.414 | 0.198 | 0.161 | 0.013 | 1340 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 117 | 0.049 | 0.048 | 0.092 | 0.339 | 0.935 | 0.039 | 0.007 | 4028 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 110 | 0.071 | 0.052 | 0.163 | 0.97 | 0.929 | 0.036 | 0.007 | 1356 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 110 | 0.052 | 0.03 | 0.125 | 0.955 | 0.948 | 0.038 | 0.006 | 1356 | 0 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_shrink_sweep_20260211_060822/tight_a/eval_circle_20260211_060835.jsonl`
- csv: `reports/.eval_circle_shrink_sweep_20260211_060822/tight_a/eval_circle_summary_20260211_060835.csv`

