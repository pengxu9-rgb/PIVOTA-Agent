# Eval Circle FASSEG Matrix (Circle × Calibration)

- run_id: 20260211_024126
- generated_at: 2026-02-11T02:41:43.820Z
- datasets: fasseg
- sample_seed: fasseg_matrix_seed_v1
- limit: 150
- circle_model_path: model_registry/circle_prior_latest.json
- regression_delta_threshold: 0.02

## Group Summary

| group | circle_enabled | calibration_enabled | module_mIoU_mean | leakage_mean | samples_ok | samples_total |
|---|---:|---:|---:|---:|---:|---:|
| c0_k0 | 0 | 0 | 0.029 | 0.899 | 116 | 116 |
| c0_k1 | 0 | 1 | 0.029 | 0.899 | 116 | 116 |
| c1_k0 | 1 | 0 | 0.031 | 0.9 | 116 | 116 |
| c1_k1 | 1 | 1 | 0.281 | 0.715 | 116 | 116 |

## Per-Module Compare (chin / forehead / cheeks)

| module | metric | c0_k0 | c0_k1 | c1_k0 | c1_k1 |
|---|---|---:|---:|---:|---:|
| chin | mIoU | 0.01 | 0.01 | 0.01 | 0.035 |
| chin | leakage | 0.907 | 0.907 | 0.907 | 0.965 |
| forehead | mIoU | 0.023 | 0.023 | 0.036 | 0.099 |
| forehead | leakage | 0.912 | 0.912 | 0.912 | 0.897 |
| left_cheek | mIoU | 0.019 | 0.019 | 0.027 | 0.121 |
| left_cheek | leakage | 0.906 | 0.906 | 0.906 | 0.877 |
| right_cheek | mIoU | 0.018 | 0.018 | 0.026 | 0.11 |
| right_cheek | leakage | 0.905 | 0.905 | 0.905 | 0.888 |
| cheeks_avg | mIoU | 0.019 | 0.019 | 0.027 | 0.115 |
| cheeks_avg | leakage | 0.906 | 0.906 | 0.906 | 0.883 |

## Driver Analysis (Leakage Delta)

| factor | context | leakage_delta | verdict |
|---|---|---:|---|
| circle | calibration=0 | 0.001 | ok |
| circle | calibration=1 | -0.184 | ok |
| calibration | circle=0 | 0 | ok |
| calibration | circle=1 | -0.185 | ok |

## Artifacts

- matrix.md: `reports/eval_circle_matrix_20260211_024126.md`
- c0_k0.summary: `reports/.eval_circle_matrix_20260211_024126/c0_k0/eval_circle_summary_20260211_024126.md`
- c0_k0.csv: `reports/.eval_circle_matrix_20260211_024126/c0_k0/eval_circle_summary_20260211_024126.csv`
- c0_k1.summary: `reports/.eval_circle_matrix_20260211_024126/c0_k1/eval_circle_summary_20260211_024130.md`
- c0_k1.csv: `reports/.eval_circle_matrix_20260211_024126/c0_k1/eval_circle_summary_20260211_024130.csv`
- c1_k0.summary: `reports/.eval_circle_matrix_20260211_024126/c1_k0/eval_circle_summary_20260211_024134.md`
- c1_k0.csv: `reports/.eval_circle_matrix_20260211_024126/c1_k0/eval_circle_summary_20260211_024134.csv`
- c1_k1.summary: `reports/.eval_circle_matrix_20260211_024126/c1_k1/eval_circle_summary_20260211_024139.md`
- c1_k1.csv: `reports/.eval_circle_matrix_20260211_024126/c1_k1/eval_circle_summary_20260211_024139.csv`

