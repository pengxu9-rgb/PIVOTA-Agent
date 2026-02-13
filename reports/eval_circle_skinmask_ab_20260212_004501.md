# Eval Circle Skinmask AB Compare

- run_id: 20260212_004501
- generated_at: 2026-02-12T00:45:05.321Z
- mode: local
- datasets: fasseg
- onnx: artifacts/skinmask_v2.onnx
- sample_seed: skinmask_ab_seed_v1
- limit: 30

## Overall Delta (on - off)

| metric | skinmask_off | skinmask_on | delta |
|---|---:|---:|---:|
| module_mIoU_mean | 0.058 | 0.058 | 0 |
| leakage_mean | 0.837 | 0.837 | 0 |
| PRED_MODULES_MISSING_rate | 0 | 0 | 0 |

## Per-Module Delta

| dataset | module | mIoU_off | mIoU_on | mIoU_delta | leakage_off | leakage_on | leakage_delta | coverage_off | coverage_on | coverage_delta |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 0.022 | 0.022 | 0 | 0.971 | 0.971 | 0 | 0.196 | 0.196 | 0 |
| fasseg | forehead | 0.057 | 0.057 | 0 | 0.899 | 0.899 | 0 | 0.11 | 0.11 | 0 |
| fasseg | left_cheek | 0.042 | 0.043 | 0.001 | 0.937 | 0.937 | 0 | 0.167 | 0.167 | 0 |
| fasseg | nose | 0.219 | 0.219 | 0 | 0.15 | 0.15 | 0 | 0.274 | 0.274 | 0 |
| fasseg | right_cheek | 0.031 | 0.03 | -0.001 | 0.956 | 0.956 | 0 | 0.171 | 0.166 | -0.005 |
| fasseg | under_eye_left | 0.021 | 0.021 | 0 | 0.976 | 0.976 | 0 | 0.164 | 0.164 | 0 |
| fasseg | under_eye_right | 0.011 | 0.011 | 0 | 0.987 | 0.987 | 0 | 0.193 | 0.193 | 0 |

## Top 20 Regression Samples

| rank | dataset | sample_hash | fail_reason_off | fail_reason_on | gt_skin_pixels_off | gt_skin_pixels_on | pred_module_count_off | pred_module_count_on | pred_skin_pixels_est_off | pred_skin_pixels_est_on | leakage_delta | miou_delta |
|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | fasseg | 0a100d0ac1ecbfb695b9 | - | - | 6800 | 6800 | 7 | 7 | 13786 | 12886 | 0.003 | -0.003 |
| 2 | fasseg | 1c09ab03a4e4f3b9d986 | - | - | 3889 | 3889 | 7 | 7 | 13530 | 12893 | 0.001 | -0.001 |

## Artifacts

- ab.md: `reports/eval_circle_skinmask_ab_20260212_004501.md`
- ab.csv: `reports/eval_circle_skinmask_ab_20260212_004501.csv`
- ab.jsonl: `reports/eval_circle_skinmask_ab_20260212_004501.jsonl`
- off.md: `reports/.eval_circle_skinmask_ab_20260212_004501/off/eval_circle_summary_20260212_004501.md`
- on.md: `reports/.eval_circle_skinmask_ab_20260212_004501/on/eval_circle_summary_20260212_004502.md`
- off.jsonl: `reports/.eval_circle_skinmask_ab_20260212_004501/off/eval_circle_20260212_004501.jsonl`
- on.jsonl: `reports/.eval_circle_skinmask_ab_20260212_004501/on/eval_circle_20260212_004502.jsonl`

