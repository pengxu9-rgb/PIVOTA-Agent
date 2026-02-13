# Circle Accuracy Evaluation

- run_id: 20260212_004450
- generated_at: 2026-02-12T00:44:52.289Z
- mode: local
- datasets: celebamaskhq
- dataset_eval_mode: celebamaskhq:parsing_gt
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_reverted_modules: none
- circle_model_reverted_module_count: 0
- circle_model_excluded_modules: under_eye_left, under_eye_right
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- score_grid_size: 256
- samples_total: 20
- samples_ok: 20
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.199
- leakage_non_skin_mean: 0.06
- leakage_bg_mean: 0.009
- leakage_hair_mean: 0.066
- empty_module_rate: 0
- module_pixels_min: 700
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_bg_mean <= 0.1
- empty_module_rate <= 0.01
- leakage_non_skin_mean (observation only)
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.199 < threshold 0.65

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
| celebamaskhq | parsing_gt | chin | 20 | 0.371 | 0.372 | 0.395 | 0.394 | 0.012 | 0.012 | 0 | 2124 | 0 | 0 |
| celebamaskhq | parsing_gt | forehead | 20 | 0.144 | 0.158 | 0.189 | 0.157 | 0.353 | 0.049 | 0.373 | 1318 | 0 | 0 |
| celebamaskhq | parsing_gt | left_cheek | 20 | 0.351 | 0.381 | 0.414 | 0.367 | 0.007 | 0.002 | 0.012 | 828 | 0 | 0 |
| celebamaskhq | parsing_gt | nose | 20 | 0.139 | 0.159 | 0.269 | 0.18 | 0 | 0 | 0 | 700 | 0 | 0 |
| celebamaskhq | parsing_gt | right_cheek | 20 | 0.391 | 0.378 | 0.428 | 0.407 | 0.02 | 0.002 | 0.022 | 1452 | 0 | 0 |
| celebamaskhq | parsing_gt | under_eye_left | 20 | 0 | 0 | 0 | 0 | 0.014 | 0 | 0.038 | 1052 | 0 | 0 |
| celebamaskhq | parsing_gt | under_eye_right | 20 | 0 | 0 | 0 | 0 | 0.012 | 0 | 0.016 | 1052 | 0 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260212_004450.jsonl`
- csv: `reports/eval_circle_summary_20260212_004450.csv`

