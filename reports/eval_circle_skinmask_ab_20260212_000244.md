# Eval Circle Skinmask AB Compare

- run_id: 20260212_000244
- generated_at: 2026-02-12T00:02:59.370Z
- mode: local
- datasets: fasseg
- onnx: artifacts/skinmask_v2.onnx
- sample_seed: skinmask_ab_seed_v1
- limit: 150

## Overall Delta (on - off)

| metric | skinmask_off | skinmask_on | delta |
|---|---:|---:|---:|
| module_mIoU_mean | 0.052 | 0.053 | 0.001 |
| leakage_mean | 0.852 | 0.852 | 0 |
| PRED_MODULES_MISSING_rate | 0 | 0 | 0 |

## Per-Module Delta

| dataset | module | mIoU_off | mIoU_on | mIoU_delta | leakage_off | leakage_on | leakage_delta | coverage_off | coverage_on | coverage_delta |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 0.015 | 0.015 | 0 | 0.98 | 0.98 | 0 | 0.24 | 0.24 | 0 |
| fasseg | forehead | 0.043 | 0.043 | 0 | 0.927 | 0.926 | -0.001 | 0.093 | 0.094 | 0.001 |
| fasseg | left_cheek | 0.034 | 0.034 | 0 | 0.952 | 0.951 | -0.001 | 0.184 | 0.182 | -0.002 |
| fasseg | nose | 0.219 | 0.219 | 0 | 0.189 | 0.189 | 0 | 0.294 | 0.294 | 0 |
| fasseg | right_cheek | 0.029 | 0.029 | 0 | 0.958 | 0.958 | 0 | 0.188 | 0.186 | -0.002 |
| fasseg | under_eye_left | 0.014 | 0.014 | 0 | 0.984 | 0.984 | 0 | 0.207 | 0.209 | 0.002 |
| fasseg | under_eye_right | 0.01 | 0.01 | 0 | 0.988 | 0.988 | 0 | 0.22 | 0.22 | 0 |

## Top 20 Regression Samples

| rank | dataset | sample_hash | fail_reason_off | fail_reason_on | gt_skin_pixels_off | gt_skin_pixels_on | pred_module_count_off | pred_module_count_on | pred_skin_pixels_est_off | pred_skin_pixels_est_on | leakage_delta | miou_delta |
|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | fasseg | 0a100d0ac1ecbfb695b9 | - | - | 6800 | 6800 | 7 | 7 | 13786 | 12886 | 0.003 | -0.003 |
| 2 | fasseg | 77465688e28974a3e391 | - | - | 4771 | 4771 | 7 | 7 | 13338 | 13081 | 0.002 | -0.001 |
| 3 | fasseg | 1c09ab03a4e4f3b9d986 | - | - | 3889 | 3889 | 7 | 7 | 13530 | 12893 | 0.001 | -0.001 |
| 4 | fasseg | afb9401738e382bcc6be | - | - | 3520 | 3520 | 7 | 7 | 13578 | 12584 | 0 | -0.005 |
| 5 | fasseg | 3ff6207aeedc6cda5e96 | - | - | 3558 | 3558 | 7 | 7 | 13786 | 13709 | 0 | -0.001 |

## Artifacts

- ab.md: `reports/eval_circle_skinmask_ab_20260212_000244.md`
- ab.csv: `reports/eval_circle_skinmask_ab_20260212_000244.csv`
- ab.jsonl: `reports/eval_circle_skinmask_ab_20260212_000244.jsonl`
- off.md: `reports/.eval_circle_skinmask_ab_20260212_000244/off/eval_circle_summary_20260212_000245.md`
- on.md: `reports/.eval_circle_skinmask_ab_20260212_000244/on/eval_circle_summary_20260212_000251.md`
- off.jsonl: `reports/.eval_circle_skinmask_ab_20260212_000244/off/eval_circle_20260212_000245.jsonl`
- on.jsonl: `reports/.eval_circle_skinmask_ab_20260212_000244/on/eval_circle_20260212_000251.jsonl`

