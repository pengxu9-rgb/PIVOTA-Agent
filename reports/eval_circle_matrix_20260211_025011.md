# Eval Circle FASSEG Matrix (Circle × Calibration)

- run_id: 20260211_025011
- generated_at: 2026-02-11T02:50:28.269Z
- datasets: fasseg
- sample_seed: fasseg_matrix_seed_v1
- limit: 150
- circle_model_path: model_registry/circle_prior_latest.json
- regression_delta_threshold: 0.02

## Group Summary

| group | circle_enabled | calibration_enabled | module_mIoU_mean | leakage_mean | samples_ok | samples_total |
|---|---:|---:|---:|---:|---:|---:|
| c0_k0 | 0 | 0 | 0.158 | 0.831 | 116 | 116 |
| c0_k1 | 0 | 1 | 0.158 | 0.831 | 116 | 116 |
| c1_k0 | 1 | 0 | 0.103 | 0.839 | 116 | 116 |
| c1_k1 | 1 | 1 | 0.128 | 0.831 | 116 | 116 |

## Per-Module Compare (chin / forehead / cheeks)

| module | metric | c0_k0 | c0_k1 | c1_k0 | c1_k1 |
|---|---|---:|---:|---:|---:|
| chin | mIoU | 0.035 | 0.035 | 0.033 | 0.046 |
| chin | leakage | 0.965 | 0.965 | 0.965 | 0.952 |
| forehead | mIoU | 0.106 | 0.106 | 0.08 | 0.08 |
| forehead | leakage | 0.887 | 0.887 | 0.887 | 0.887 |
| left_cheek | mIoU | 0.095 | 0.095 | 0.072 | 0.093 |
| left_cheek | leakage | 0.899 | 0.899 | 0.899 | 0.879 |
| right_cheek | mIoU | 0.082 | 0.082 | 0.063 | 0.082 |
| right_cheek | leakage | 0.914 | 0.914 | 0.914 | 0.895 |
| cheeks_avg | mIoU | 0.089 | 0.089 | 0.068 | 0.088 |
| cheeks_avg | leakage | 0.907 | 0.907 | 0.907 | 0.887 |

## Driver Analysis (Leakage Delta)

| factor | context | leakage_delta | verdict |
|---|---|---:|---|
| circle | calibration=0 | 0.008 | ok |
| circle | calibration=1 | 0 | ok |
| calibration | circle=0 | 0 | ok |
| calibration | circle=1 | -0.008 | ok |

## Artifacts

- matrix.md: `reports/eval_circle_matrix_20260211_025011.md`
- c0_k0.summary: `reports/.eval_circle_matrix_20260211_025011/c0_k0/eval_circle_summary_20260211_025011.md`
- c0_k0.csv: `reports/.eval_circle_matrix_20260211_025011/c0_k0/eval_circle_summary_20260211_025011.csv`
- c0_k1.summary: `reports/.eval_circle_matrix_20260211_025011/c0_k1/eval_circle_summary_20260211_025015.md`
- c0_k1.csv: `reports/.eval_circle_matrix_20260211_025011/c0_k1/eval_circle_summary_20260211_025015.csv`
- c1_k0.summary: `reports/.eval_circle_matrix_20260211_025011/c1_k0/eval_circle_summary_20260211_025019.md`
- c1_k0.csv: `reports/.eval_circle_matrix_20260211_025011/c1_k0/eval_circle_summary_20260211_025019.csv`
- c1_k1.summary: `reports/.eval_circle_matrix_20260211_025011/c1_k1/eval_circle_summary_20260211_025024.md`
- c1_k1.csv: `reports/.eval_circle_matrix_20260211_025011/c1_k1/eval_circle_summary_20260211_025024.csv`

