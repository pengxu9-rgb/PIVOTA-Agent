# Circle Accuracy Evaluation

- run_id: 20260211_053443
- generated_at: 2026-02-11T05:34:51.249Z
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
- module_mIoU_mean: 0.083
- leakage_non_skin_mean: 0.846
- leakage_bg_mean: 0.131
- leakage_hair_mean: 0.007
- empty_module_rate: 0
- module_pixels_min: 444
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

- leakage_bg_mean 0.131 > threshold 0.1
- leakage_non_skin_mean 0.846 > observation 0.1

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
| fasseg | segmentation_only | chin | 150 | 0.025 | 0.022 | 0.039 | 0.315 | 0.969 | 0.583 | 0.004 | 2076 | 0 | 0 |
| fasseg | segmentation_only | forehead | 150 | 0.051 | 0.043 | 0.1 | 0.125 | 0.905 | 0.106 | 0.018 | 444 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 150 | 0.045 | 0.033 | 0.095 | 0.251 | 0.939 | 0.029 | 0.007 | 3532 | 0 | 0 |
| fasseg | segmentation_only | nose | 150 | 0.423 | 0.471 | 0.532 | 0.535 | 0.183 | 0.138 | 0.013 | 1916 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 150 | 0.039 | 0.033 | 0.088 | 0.24 | 0.948 | 0.032 | 0.006 | 3532 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 150 | 0 | 0 | 0 | 0 | 0.99 | 0.016 | 0.003 | 1148 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 150 | 0 | 0 | 0 | 0 | 0.992 | 0.014 | 0.002 | 1148 | 0 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_053443.jsonl`
- csv: `reports/eval_circle_summary_20260211_053443.csv`

