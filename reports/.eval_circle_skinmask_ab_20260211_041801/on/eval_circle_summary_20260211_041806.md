# Circle Accuracy Evaluation

- run_id: 20260211_041806
- generated_at: 2026-02-11T04:18:13.589Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: true
- skinmask_model_path: artifacts/skinmask_v2.onnx
- samples_total: 114
- samples_ok: 114
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.111
- leakage_mean: 0.842
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.111 < threshold 0.65
- leakage_mean 0.842 > threshold 0.1

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
| fasseg | chin | 114 | 0.047 | 0.043 | 0.064 | 0.605 | 0.952 | 0 |
| fasseg | forehead | 114 | 0.076 | 0.077 | 0.127 | 0.307 | 0.893 | 0 |
| fasseg | left_cheek | 114 | 0.075 | 0.061 | 0.143 | 0.34 | 0.908 | 0 |
| fasseg | nose | 114 | 0.513 | 0.588 | 0.686 | 0.653 | 0.291 | 0 |
| fasseg | right_cheek | 114 | 0.067 | 0.064 | 0.126 | 0.339 | 0.918 | 0 |
| fasseg | under_eye_left | 114 | 0 | 0 | 0 | 0 | 0.962 | 0 |
| fasseg | under_eye_right | 113 | 0 | 0 | 0 | 0 | 0.973 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_skinmask_ab_20260211_041801/on/eval_circle_20260211_041806.jsonl`
- csv: `reports/.eval_circle_skinmask_ab_20260211_041801/on/eval_circle_summary_20260211_041806.csv`

