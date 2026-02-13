# Circle Accuracy Evaluation

- run_id: 20260210_160704
- generated_at: 2026-02-10T16:07:04.330Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 4
- samples_ok: 4
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.281
- leakage_mean: 0.719
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.281 < threshold 0.65
- leakage_mean 0.719 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 4 | 0.031 | 0.024 | 0.041 | 1 | 0.969 | 0 |
| fasseg | forehead | 4 | 0.093 | 0.107 | 0.122 | 0.828 | 0.906 | 0 |
| fasseg | left_cheek | 4 | 0.092 | 0.103 | 0.118 | 1 | 0.908 | 0 |
| fasseg | nose | 4 | 0.526 | 0.631 | 0.668 | 1 | 0.474 | 0 |
| fasseg | right_cheek | 4 | 0.124 | 0.122 | 0.182 | 1 | 0.876 | 0 |
| fasseg | under_eye_left | 4 | 0.603 | 0.747 | 0.779 | 1 | 0.397 | 0 |
| fasseg | under_eye_right | 4 | 0.5 | 0.578 | 0.691 | 1 | 0.5 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_ab_20260210_160704/off/eval_circle_20260210_160704.jsonl`
- csv: `reports/.eval_circle_ab_20260210_160704/off/eval_circle_summary_20260210_160704.csv`

