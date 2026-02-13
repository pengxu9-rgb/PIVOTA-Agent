# Circle Accuracy Evaluation

- run_id: 20260211_014905
- generated_at: 2026-02-11T01:49:10.707Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 150
- samples_ok: 150
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.286
- leakage_mean: 0.71
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.286 < threshold 0.65
- leakage_mean 0.71 > threshold 0.1

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
| fasseg | chin | 150 | 0.035 | 0.031 | 0.045 | 0.969 | 0.965 | 0 |
| fasseg | forehead | 150 | 0.105 | 0.11 | 0.165 | 0.762 | 0.892 | 0 |
| fasseg | left_cheek | 150 | 0.122 | 0.132 | 0.184 | 0.919 | 0.876 | 0 |
| fasseg | nose | 150 | 0.597 | 0.673 | 0.761 | 0.95 | 0.39 | 0 |
| fasseg | right_cheek | 150 | 0.112 | 0.122 | 0.166 | 0.925 | 0.887 | 0 |
| fasseg | under_eye_left | 150 | 0.524 | 0.651 | 0.785 | 0.807 | 0.472 | 0 |
| fasseg | under_eye_right | 149 | 0.511 | 0.634 | 0.778 | 0.805 | 0.485 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_014905.jsonl`
- csv: `reports/eval_circle_summary_20260211_014905.csv`

