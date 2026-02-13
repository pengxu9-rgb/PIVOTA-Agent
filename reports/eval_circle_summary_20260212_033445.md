# Circle Accuracy Evaluation

- run_id: 20260212_033445
- generated_at: 2026-02-12T03:34:46.300Z
- mode: local
- datasets: lapa
- dataset_eval_mode: lapa:parsing_gt
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
- module_mIoU_mean: 0.218
- leakage_non_skin_mean: 0.307
- leakage_bg_mean: 0.182
- leakage_hair_mean: 0.125
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

- module_mIoU 0.218 < threshold 0.65
- leakage_bg_mean 0.182 > threshold 0.1
- leakage_non_skin_mean 0.307 > observation 0.1

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
| lapa | parsing_gt | chin | 5 | 0.34 | 0.296 | 0.449 | 0.429 | 0.368 | 0.368 | 0 | 2124 | 0 | 0 |
| lapa | parsing_gt | forehead | 5 | 0.144 | 0.144 | 0.188 | 0.164 | 0.499 | 0.012 | 0.487 | 1318 | 0 | 0 |
| lapa | parsing_gt | left_cheek | 5 | 0.412 | 0.425 | 0.484 | 0.486 | 0.228 | 0.079 | 0.149 | 3324 | 0 | 0 |
| lapa | parsing_gt | nose | 5 | 0.246 | 0.181 | 0.184 | 0.301 | 0.316 | 0.316 | 0 | 700 | 0 | 0 |
| lapa | parsing_gt | right_cheek | 5 | 0.373 | 0.383 | 0.427 | 0.461 | 0.277 | 0.247 | 0.03 | 3324 | 0 | 0 |
| lapa | parsing_gt | under_eye_left | 5 | 0.009 | 0 | 0 | 0.023 | 0.282 | 0.122 | 0.161 | 1228 | 0 | 0 |
| lapa | parsing_gt | under_eye_right | 5 | 0.005 | 0 | 0.009 | 0.016 | 0.179 | 0.129 | 0.05 | 1228 | 0 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260212_033445.jsonl`
- csv: `reports/eval_circle_summary_20260212_033445.csv`

