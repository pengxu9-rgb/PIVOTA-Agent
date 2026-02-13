# Circle Accuracy Evaluation

- run_id: 20260212_000308
- generated_at: 2026-02-12T00:03:20.860Z
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
- samples_total: 150
- samples_ok: 149
- samples_failed: 1
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.201
- leakage_non_skin_mean: 0.053
- leakage_bg_mean: 0.004
- leakage_hair_mean: 0.087
- empty_module_rate: 0
- module_pixels_min: 380
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

- module_mIoU 0.201 < threshold 0.65

## Top Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| PRED_MODULES_MISSING | 1 | 0.007 |

## PRED_MODULES_MISSING breakdown

| reason_detail | count | pct_of_missing |
|---|---:|---:|
| UNKNOWN | 1 | 1 |

## Per-Module Summary

| dataset | mode | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage_non_skin mean | leakage_bg mean | leakage_hair mean | module_pixels_min | empty_module_rate | roi_too_small_rate |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| celebamaskhq | parsing_gt | chin | 149 | 0.366 | 0.372 | 0.396 | 0.385 | 0.007 | 0.007 | 0.002 | 2124 | 0 | 0 |
| celebamaskhq | parsing_gt | forehead | 149 | 0.163 | 0.18 | 0.21 | 0.175 | 0.272 | 0.017 | 0.409 | 1318 | 0 | 0 |
| celebamaskhq | parsing_gt | left_cheek | 149 | 0.364 | 0.389 | 0.411 | 0.379 | 0.021 | 0.001 | 0.034 | 828 | 0 | 0 |
| celebamaskhq | parsing_gt | nose | 149 | 0.144 | 0.169 | 0.256 | 0.172 | 0 | 0 | 0.001 | 380 | 0 | 0 |
| celebamaskhq | parsing_gt | right_cheek | 149 | 0.369 | 0.398 | 0.425 | 0.381 | 0.02 | 0.002 | 0.038 | 1020 | 0 | 0 |
| celebamaskhq | parsing_gt | under_eye_left | 149 | 0.001 | 0 | 0 | 0.001 | 0.024 | 0 | 0.061 | 1052 | 0 | 0 |
| celebamaskhq | parsing_gt | under_eye_right | 149 | 0.001 | 0 | 0 | 0.001 | 0.024 | 0 | 0.066 | 1052 | 0 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260212_000308.jsonl`
- csv: `reports/eval_circle_summary_20260212_000308.csv`

