# Circle Accuracy Evaluation

- run_id: 20260211_040350
- generated_at: 2026-02-11T04:03:54.299Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 117
- samples_ok: 117
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.111
- leakage_mean: 0.838
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.111 < threshold 0.65
- leakage_mean 0.838 > threshold 0.1

## Top Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| - | 0 | 0 |

## PRED_MODULES_MISSING breakdown

| reason_detail | count | pct_of_missing |
|---|---:|---:|
| - | 0 | 0 |

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 117 | 0.044 | 0.039 | 0.064 | 0.532 | 0.954 | 0 |
| fasseg | forehead | 117 | 0.069 | 0.066 | 0.119 | 0.261 | 0.894 | 0 |
| fasseg | left_cheek | 117 | 0.073 | 0.065 | 0.139 | 0.34 | 0.91 | 0 |
| fasseg | nose | 117 | 0.526 | 0.61 | 0.686 | 0.644 | 0.256 | 0 |
| fasseg | right_cheek | 117 | 0.065 | 0.064 | 0.126 | 0.335 | 0.921 | 0 |
| fasseg | under_eye_left | 117 | 0 | 0 | 0 | 0 | 0.959 | 0 |
| fasseg | under_eye_right | 116 | 0 | 0 | 0 | 0 | 0.974 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_shrink_sweep_20260211_040335/tight_b/eval_circle_20260211_040350.jsonl`
- csv: `reports/.eval_circle_shrink_sweep_20260211_040335/tight_b/eval_circle_summary_20260211_040350.csv`

