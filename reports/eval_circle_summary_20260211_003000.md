# Circle Accuracy Evaluation

- run_id: 20260211_003000
- generated_at: 2026-02-11T00:30:05.045Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 150
- samples_ok: 127
- samples_failed: 23
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.323
- leakage_mean: 0.676
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.323 < threshold 0.65
- leakage_mean 0.676 > threshold 0.1

## Top Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| PRED_MODULES_MISSING | 23 | 0.153 |

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 127 | 0.031 | 0.031 | 0.042 | 1 | 0.969 | 0 |
| fasseg | forehead | 127 | 0.117 | 0.122 | 0.168 | 0.822 | 0.88 | 0 |
| fasseg | left_cheek | 127 | 0.134 | 0.137 | 0.184 | 1 | 0.866 | 0 |
| fasseg | nose | 127 | 0.635 | 0.677 | 0.766 | 1 | 0.365 | 0 |
| fasseg | right_cheek | 127 | 0.122 | 0.125 | 0.169 | 1 | 0.878 | 0 |
| fasseg | under_eye_left | 127 | 0.619 | 0.686 | 0.792 | 0.953 | 0.379 | 0 |
| fasseg | under_eye_right | 126 | 0.604 | 0.65 | 0.781 | 0.952 | 0.394 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260211_003000.jsonl`
- csv: `reports/eval_circle_summary_20260211_003000.csv`

