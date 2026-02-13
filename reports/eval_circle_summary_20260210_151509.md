# Circle Accuracy Evaluation

- run_id: 20260210_151509
- generated_at: 2026-02-10T15:15:36.765Z
- mode: local
- datasets: fasseg, lapa, celebamaskhq
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: false
- skinmask_enabled: true
- skinmask_model_path: artifacts/skinmask_v1.onnx
- samples_total: 180
- samples_ok: 139
- samples_failed: 41
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.049
- leakage_mean: 0.587
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.049 < threshold 0.65
- leakage_mean 0.587 > threshold 0.1

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| celebamaskhq | chin | 56 | 0.098 | 0.088 | 0.207 | 0.498 | 0.323 | 0 |
| celebamaskhq | forehead | 56 | 0.098 | 0.066 | 0.235 | 0.332 | 0.33 | 0 |
| celebamaskhq | left_cheek | 56 | 0.101 | 0.084 | 0.207 | 0.393 | 0.324 | 0 |
| celebamaskhq | nose | 56 | 0.068 | 0.056 | 0.155 | 0.436 | 0.323 | 0 |
| celebamaskhq | right_cheek | 56 | 0.097 | 0.084 | 0.19 | 0.391 | 0.323 | 0 |
| celebamaskhq | under_eye_left | 56 | 0.019 | 0 | 0.044 | 0.396 | 0.305 | 0 |
| celebamaskhq | under_eye_right | 56 | 0.022 | 0.007 | 0.045 | 0.419 | 0.318 | 0 |
| fasseg | chin | 45 | 0.007 | 0.004 | 0.017 | 0.614 | 0.943 | 0 |
| fasseg | forehead | 45 | 0.019 | 0.005 | 0.041 | 0.399 | 0.943 | 0 |
| fasseg | left_cheek | 45 | 0.014 | 0.002 | 0.035 | 0.496 | 0.943 | 0 |
| fasseg | nose | 45 | 0.028 | 0.013 | 0.069 | 0.487 | 0.943 | 0 |
| fasseg | right_cheek | 45 | 0.012 | 0.005 | 0.027 | 0.493 | 0.943 | 0 |
| fasseg | under_eye_left | 45 | 0.007 | 0.001 | 0.018 | 0.463 | 0.945 | 0 |
| fasseg | under_eye_right | 44 | 0.007 | 0 | 0.018 | 0.455 | 0.944 | 0 |
| lapa | chin | 38 | 0.046 | 0.056 | 0.082 | 0.597 | 0.558 | 0 |
| lapa | forehead | 38 | 0.105 | 0.093 | 0.194 | 0.533 | 0.572 | 0 |
| lapa | left_cheek | 38 | 0.084 | 0.092 | 0.147 | 0.586 | 0.558 | 0 |
| lapa | nose | 38 | 0.054 | 0.056 | 0.106 | 0.633 | 0.558 | 0 |
| lapa | right_cheek | 38 | 0.088 | 0.098 | 0.158 | 0.596 | 0.558 | 0 |
| lapa | under_eye_left | 38 | 0.015 | 0.013 | 0.024 | 0.582 | 0.556 | 0 |
| lapa | under_eye_right | 38 | 0.013 | 0.012 | 0.026 | 0.557 | 0.554 | 0 |

## Artifacts

- jsonl: `reports/eval_circle_20260210_151509.jsonl`
- csv: `reports/eval_circle_summary_20260210_151509.csv`

