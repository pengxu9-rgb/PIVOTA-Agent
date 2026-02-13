# Circle Accuracy Evaluation

- run_id: 20260211_075955
- generated_at: 2026-02-11T08:00:19.524Z
- mode: api
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
- samples_ok: 0
- samples_failed: 105
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0
- leakage_non_skin_mean: 0
- leakage_bg_mean: 0
- leakage_hair_mean: 0
- empty_module_rate: 0
- module_pixels_min: 0
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: n/a

## Thresholds (soft gate)

- module_mIoU >= 0.65 (observation only for segmentation_only datasets)
- face_detect_fail_rate <= 0.05
- leakage_bg_mean <= 0.1
- empty_module_rate <= 0.01
- leakage_non_skin_mean (observation only)
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Top Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| PRED_MODULES_MISSING | 105 | 1 |

## PRED_MODULES_MISSING breakdown

| reason_detail | count | pct_of_missing |
|---|---:|---:|
| CIRCLE_PRIOR_MISSING | 105 | 1 |

## Per-Module Summary

| dataset | mode | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage_non_skin mean | leakage_bg mean | leakage_hair mean | module_pixels_min | empty_module_rate | roi_too_small_rate |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|

## Artifacts

- jsonl: `reports/.review_pack_mixed_20260211_075912373/fasseg_eval/eval_circle_20260211_075955.jsonl`
- csv: `reports/.review_pack_mixed_20260211_075912373/fasseg_eval/eval_circle_summary_20260211_075955.csv`

