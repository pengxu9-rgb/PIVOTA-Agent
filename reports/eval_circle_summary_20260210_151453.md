# Circle Accuracy Evaluation

- run_id: 20260210_151453
- generated_at: 2026-02-10T15:15:00.582Z
- mode: local
- datasets: fasseg, lapa, celebamaskhq
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: false
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 180
- samples_ok: 139
- samples_failed: 41
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.074
- leakage_mean: 0.558
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.074 < threshold 0.65
- leakage_mean 0.558 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 56 | 0.1 | 0.095 | 0.14 | 0.987 | 0.313 | 0 |
| celebamaskhq | forehead | 56 | 0.192 | 0.187 | 0.244 | 0.881 | 0.319 | 0 |
| celebamaskhq | left_cheek | 56 | 0.157 | 0.142 | 0.203 | 0.888 | 0.314 | 0 |
| celebamaskhq | nose | 56 | 0.103 | 0.097 | 0.14 | 0.998 | 0.313 | 0 |
| celebamaskhq | right_cheek | 56 | 0.161 | 0.149 | 0.21 | 0.918 | 0.313 | 0 |
| celebamaskhq | under_eye_left | 56 | 0.024 | 0.023 | 0.036 | 0.911 | 0.285 | 0 |
| celebamaskhq | under_eye_right | 56 | 0.027 | 0.025 | 0.037 | 0.971 | 0.308 | 0 |
| fasseg | chin | 45 | 0.004 | 0.004 | 0.006 | 1 | 0.91 | 0 |
| fasseg | forehead | 45 | 0.03 | 0.031 | 0.041 | 0.842 | 0.914 | 0 |
| fasseg | left_cheek | 45 | 0.023 | 0.023 | 0.035 | 1 | 0.91 | 0 |
| fasseg | nose | 45 | 0.05 | 0.055 | 0.071 | 1 | 0.91 | 0 |
| fasseg | right_cheek | 45 | 0.02 | 0.021 | 0.03 | 1 | 0.91 | 0 |
| fasseg | under_eye_left | 45 | 0.013 | 0.015 | 0.018 | 0.978 | 0.913 | 0 |
| fasseg | under_eye_right | 44 | 0.013 | 0.015 | 0.019 | 0.977 | 0.911 | 0 |
| lapa | chin | 38 | 0.069 | 0.064 | 0.101 | 0.963 | 0.506 | 0 |
| lapa | forehead | 38 | 0.153 | 0.14 | 0.194 | 0.861 | 0.52 | 0 |
| lapa | left_cheek | 38 | 0.122 | 0.103 | 0.161 | 0.921 | 0.506 | 0 |
| lapa | nose | 38 | 0.079 | 0.069 | 0.111 | 1 | 0.506 | 0 |
| lapa | right_cheek | 38 | 0.118 | 0.109 | 0.158 | 0.911 | 0.506 | 0 |
| lapa | under_eye_left | 38 | 0.018 | 0.016 | 0.026 | 0.945 | 0.493 | 0 |
| lapa | under_eye_right | 38 | 0.017 | 0.017 | 0.027 | 0.919 | 0.507 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_151453.jsonl`
- csv: `reports/eval_circle_summary_20260210_151453.csv`

