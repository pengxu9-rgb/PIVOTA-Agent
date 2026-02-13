# Circle Accuracy Evaluation

- run_id: 20260211_021007
- generated_at: 2026-02-11T02:10:12.065Z
- mode: local
- datasets: fasseg
- circle_model_enabled: true
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true
- skinmask_enabled: false
- skinmask_model_path: n/a
- samples_total: 114
- samples_ok: 114
- samples_failed: 0
- face_detect_fail_rate: 0
- landmark_fail_rate: 0
- module_mIoU_mean: 0.274
- leakage_mean: 0.722
- skin_roi_too_small_rate: 0
- geometry_sanitize_drop_rate_mean: 0

## Thresholds (soft gate)

- module_mIoU >= 0.65
- face_detect_fail_rate <= 0.05
- leakage_mean <= 0.1
- skin_roi_too_small_rate <= 0.2 (pred_pixels < 8)

## Soft Warnings

- module_mIoU 0.274 < threshold 0.65
- leakage_mean 0.722 > threshold 0.1

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
| fasseg | chin | 114 | 0.036 | 0.032 | 0.045 | 0.96 | 0.964 | 0 |
| fasseg | forehead | 114 | 0.099 | 0.107 | 0.162 | 0.743 | 0.898 | 0 |
| fasseg | left_cheek | 114 | 0.115 | 0.126 | 0.184 | 0.898 | 0.883 | 0 |
| fasseg | nose | 114 | 0.571 | 0.669 | 0.757 | 0.936 | 0.415 | 0 |
| fasseg | right_cheek | 114 | 0.107 | 0.12 | 0.163 | 0.907 | 0.891 | 0 |
| fasseg | under_eye_left | 114 | 0.502 | 0.641 | 0.788 | 0.789 | 0.495 | 0 |
| fasseg | under_eye_right | 113 | 0.489 | 0.628 | 0.772 | 0.788 | 0.506 | 0 |

## Artifacts

- jsonl: `reports/.eval_circle_skinmask_ab_20260211_021006/off/eval_circle_20260211_021007.jsonl`
- csv: `reports/.eval_circle_skinmask_ab_20260211_021006/off/eval_circle_summary_20260211_021007.csv`

