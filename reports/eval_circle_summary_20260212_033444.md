# Circle Accuracy Evaluation

- run_id: 20260212_033444
- generated_at: 2026-02-12T03:34:45.429Z
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
- samples_total: 5
- samples_ok: 5
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.22
- leakage_non_skin_mean: 0.056
- leakage_bg_mean: 0.019
- leakage_hair_mean: 0.039
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

- module_mIoU 0.22 < threshold 0.65

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
| celebamaskhq | parsing_gt | chin | 5 | 0.414 | 0.383 | 0.388 | 0.451 | 0.027 | 0.027 | 0 | 2124 | 0 | 0 |
| celebamaskhq | parsing_gt | forehead | 5 | 0.137 | 0.168 | 0.172 | 0.146 | 0.347 | 0.096 | 0.263 | 1318 | 0 | 0 |
| celebamaskhq | parsing_gt | left_cheek | 5 | 0.401 | 0.399 | 0.404 | 0.431 | 0.012 | 0.008 | 0.008 | 2492 | 0 | 0 |
| celebamaskhq | parsing_gt | nose | 5 | 0.17 | 0.169 | 0.252 | 0.247 | 0 | 0 | 0 | 700 | 0 | 0 |
| celebamaskhq | parsing_gt | right_cheek | 5 | 0.421 | 0.422 | 0.428 | 0.447 | 0.006 | 0.006 | 0 | 2700 | 0 | 0 |
| celebamaskhq | parsing_gt | under_eye_left | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1228 | 0 | 0 |
| celebamaskhq | parsing_gt | under_eye_right | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1228 | 0 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260212_033444.jsonl`
- csv: `reports/eval_circle_summary_20260212_033444.csv`

