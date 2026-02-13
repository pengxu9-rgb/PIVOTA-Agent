# Eval Circle FASSEG Matrix (Circle × Calibration)

- run_id: 20260211_023741
- generated_at: 2026-02-11T02:37:44.821Z
- datasets: fasseg
- sample_seed: fasseg_matrix_seed_v1
- limit: 20
- circle_model_path: model_registry/circle_prior_latest.json
- regression_delta_threshold: 0.02

## Group Summary

| group | circle_enabled | calibration_enabled | module_mIoU_mean | leakage_mean | samples_ok | samples_total |
|---|---:|---:|---:|---:|---:|---:|
| c0_k0 | 0 | 0 | 0.024 | 0.902 | 19 | 19 |
| c0_k1 | 0 | 1 | 0.024 | 0.902 | 19 | 19 |
| c1_k0 | 1 | 0 | 0.028 | 0.903 | 19 | 19 |
| c1_k1 | 1 | 1 | 0.28 | 0.718 | 19 | 19 |

## Per-Module Compare (chin / forehead / cheeks)

| module | metric | c0_k0 | c0_k1 | c1_k0 | c1_k1 |
|---|---|---:|---:|---:|---:|
| chin | mIoU | 0.006 | 0.006 | 0.007 | 0.032 |
| chin | leakage | 0.904 | 0.904 | 0.904 | 0.968 |
| forehead | mIoU | 0.022 | 0.022 | 0.036 | 0.1 |
| forehead | leakage | 0.913 | 0.913 | 0.913 | 0.897 |
| left_cheek | mIoU | 0.014 | 0.014 | 0.024 | 0.129 |
| left_cheek | leakage | 0.906 | 0.906 | 0.906 | 0.871 |
| right_cheek | mIoU | 0.015 | 0.015 | 0.025 | 0.109 |
| right_cheek | leakage | 0.901 | 0.901 | 0.901 | 0.89 |
| cheeks_avg | mIoU | 0.014 | 0.014 | 0.025 | 0.119 |
| cheeks_avg | leakage | 0.904 | 0.904 | 0.904 | 0.881 |

## Driver Analysis (Leakage Delta)

| factor | context | leakage_delta | verdict |
|---|---|---:|---|
| circle | calibration=0 | 0.001 | ok |
| circle | calibration=1 | -0.184 | ok |
| calibration | circle=0 | 0 | ok |
| calibration | circle=1 | -0.185 | ok |

## Artifacts

- matrix.md: `reports/eval_circle_matrix_20260211_023741.md`
- c0_k0.summary: `reports/.eval_circle_matrix_20260211_023741/c0_k0/eval_circle_summary_20260211_023741.md`
- c0_k0.csv: `reports/.eval_circle_matrix_20260211_023741/c0_k0/eval_circle_summary_20260211_023741.csv`
- c0_k1.summary: `reports/.eval_circle_matrix_20260211_023741/c0_k1/eval_circle_summary_20260211_023742.md`
- c0_k1.csv: `reports/.eval_circle_matrix_20260211_023741/c0_k1/eval_circle_summary_20260211_023742.csv`
- c1_k0.summary: `reports/.eval_circle_matrix_20260211_023741/c1_k0/eval_circle_summary_20260211_023743.md`
- c1_k0.csv: `reports/.eval_circle_matrix_20260211_023741/c1_k0/eval_circle_summary_20260211_023743.csv`
- c1_k1.summary: `reports/.eval_circle_matrix_20260211_023741/c1_k1/eval_circle_summary_20260211_023744.md`
- c1_k1.csv: `reports/.eval_circle_matrix_20260211_023741/c1_k1/eval_circle_summary_20260211_023744.csv`

