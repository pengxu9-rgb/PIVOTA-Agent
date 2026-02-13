# Circle Accuracy Evaluation

- run_id: 20260210_142252
- generated_at: 2026-02-10T14:22:53.019Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 1
- samples_ok: 1
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.404
- leakage_mean: 0.596
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1

## Soft Warnings

- module_mIoU 0.404 < threshold 0.65
- leakage_mean 0.596 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean |
|---|---|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 1 | 0.024 | 0.024 | 0.024 | 1 | 0.976 |
| fasseg | forehead | 1 | 0.122 | 0.122 | 0.122 | 1 | 0.878 |
| fasseg | left_cheek | 1 | 0.145 | 0.145 | 0.145 | 1 | 0.855 |
| fasseg | nose | 1 | 0.787 | 0.787 | 0.787 | 1 | 0.213 |
| fasseg | right_cheek | 1 | 0.186 | 0.186 | 0.186 | 1 | 0.814 |
| fasseg | under_eye_left | 1 | 0.872 | 0.872 | 0.872 | 1 | 0.128 |
| fasseg | under_eye_right | 1 | 0.691 | 0.691 | 0.691 | 1 | 0.309 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_142252.jsonl`
- csv: `reports/eval_circle_summary_20260210_142252.csv`

