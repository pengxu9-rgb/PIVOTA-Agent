# Circle Accuracy Evaluation

- run_id: 20260211_040404
- generated_at: 2026-02-11T04:04:08.645Z
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
- module_mIoU_mean: 0.114
- leakage_mean: 0.841
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.114 < threshold 0.65
- leakage_mean 0.841 > threshold 0.1

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
| fasseg | chin | 117 | 0.048 | 0.044 | 0.067 | 0.728 | 0.951 | 0 |
| fasseg | forehead | 117 | 0.078 | 0.076 | 0.135 | 0.324 | 0.893 | 0 |
| fasseg | left_cheek | 117 | 0.093 | 0.095 | 0.168 | 0.443 | 0.891 | 0 |
| fasseg | nose | 117 | 0.517 | 0.591 | 0.69 | 0.654 | 0.288 | 0 |
| fasseg | right_cheek | 117 | 0.06 | 0.059 | 0.12 | 0.336 | 0.929 | 0 |
| fasseg | under_eye_left | 117 | 0 | 0 | 0 | 0 | 0.961 | 0 |
| fasseg | under_eye_right | 116 | 0 | 0 | 0 | 0 | 0.975 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_shrink_sweep_20260211_040335/loose_a/eval_circle_20260211_040404.jsonl`
- csv: `reports/.eval_circle_shrink_sweep_20260211_040335/loose_a/eval_circle_summary_20260211_040404.csv`

