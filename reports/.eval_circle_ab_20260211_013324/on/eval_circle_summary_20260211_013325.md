# Circle Accuracy Evaluation

- run_id: 20260211_013325
- generated_at: 2026-02-11T01:33:29.409Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: true
- skinmask_model_path: artifacts/skinmask_v1.onnx
- samples_total: 30
- samples_ok: 17
- samples_failed: 13
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.195
- leakage_mean: 0.805
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.195 < threshold 0.65
- leakage_mean 0.805 > threshold 0.1

## Top Fail Reasons

| fail_reason | count | pct_of_total |
|---|---:|---:|
| PRED_MODULES_MISSING | 13 | 0.433 |

## Per-Module Summary

| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 17 | 0.023 | 0.022 | 0.034 | 1 | 0.977 | 0 |
| fasseg | forehead | 17 | 0.064 | 0.065 | 0.131 | 0.833 | 0.935 | 0 |
| fasseg | left_cheek | 17 | 0.072 | 0.086 | 0.155 | 0.978 | 0.928 | 0 |
| fasseg | nose | 17 | 0.358 | 0.524 | 0.718 | 0.982 | 0.642 | 0 |
| fasseg | right_cheek | 17 | 0.072 | 0.073 | 0.174 | 0.985 | 0.928 | 0 |
| fasseg | under_eye_left | 17 | 0.393 | 0.619 | 0.782 | 0.941 | 0.607 | 0 |
| fasseg | under_eye_right | 16 | 0.392 | 0.578 | 0.722 | 0.938 | 0.608 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_ab_20260211_013324/on/eval_circle_20260211_013325.jsonl`
- csv: `reports/.eval_circle_ab_20260211_013324/on/eval_circle_summary_20260211_013325.csv`

