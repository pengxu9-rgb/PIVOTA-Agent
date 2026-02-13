# Circle Accuracy Evaluation

- run_id: 20260211_053817
- generated_at: 2026-02-11T05:38:26.038Z
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
- module_mIoU_mean: 0.096
- leakage_non_skin_mean: 0.828
- leakage_bg_mean: 0.133
- leakage_hair_mean: 0.01
- empty_module_rate: 0
- module_pixels_min: 1084
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

- leakage_bg_mean 0.133 > threshold 0.1
- leakage_non_skin_mean 0.828 > observation 0.1

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
| fasseg | segmentation_only | chin | 150 | 0.032 | 0.03 | 0.043 | 0.593 | 0.964 | 0.511 | 0.005 | 4028 | 0 | 0 |
| fasseg | segmentation_only | forehead | 150 | 0.088 | 0.096 | 0.146 | 0.19 | 0.859 | 0.131 | 0.018 | 1084 | 0 | 0 |
| fasseg | segmentation_only | left_cheek | 150 | 0.059 | 0.053 | 0.112 | 0.348 | 0.919 | 0.033 | 0.007 | 4028 | 0 | 0 |
| fasseg | segmentation_only | nose | 150 | 0.443 | 0.492 | 0.562 | 0.665 | 0.245 | 0.15 | 0.016 | 2716 | 0 | 0 |
| fasseg | segmentation_only | right_cheek | 150 | 0.052 | 0.05 | 0.098 | 0.33 | 0.93 | 0.037 | 0.007 | 4028 | 0 | 0 |
| fasseg | segmentation_only | under_eye_left | 150 | 0 | 0 | 0 | 0 | 0.931 | 0.033 | 0.007 | 1356 | 0 | 0 |
| fasseg | segmentation_only | under_eye_right | 150 | 0 | 0 | 0 | 0 | 0.948 | 0.034 | 0.006 | 1356 | 0 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_053817.jsonl`
- csv: `reports/eval_circle_summary_20260211_053817.csv`

