# Eval Circle FASSEG Matrix (Circle × Calibration)

- run_id: 20260211_035324
- generated_at: 2026-02-11T03:53:43.580Z
- datasets: fasseg
- sample_seed: fasseg_matrix_seed_v1
- limit: 150
- circle_model_path: model_registry/circle_prior_latest.json
- regression_delta_threshold: 0.02
- sample_set_consistent: true
- baseline_group: c1_k1

## Group Summary

| group | circle_enabled | calibration_enabled | module_mIoU_mean | leakage_mean | coverage_mean | samples_ok | samples_total | leakage_delta_vs_baseline | mIoU_delta_vs_baseline |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| c0_k0 | 0 | 0 | 0.151 | 0.84 | 0.841 | 116 | 116 | -0.001 | 0.028 |
| c0_k1 | 0 | 1 | 0.151 | 0.84 | 0.841 | 116 | 116 | -0.001 | 0.028 |
| c1_k0 | 1 | 0 | 0.099 | 0.847 | 0.334 | 116 | 116 | 0.006 | -0.024 |
| c1_k1 | 1 | 1 | 0.123 | 0.841 | 0.334 | 116 | 116 | 0 | 0 |

## Per-Module Compare (chin / forehead / cheeks)

| module | metric | c0_k0 | c0_k1 | c1_k0 | c1_k1 | best_group |
|---|---|---:|---:|---:|---:|---|
| chin | mIoU | 0.035 | 0.035 | 0.033 | 0.046 | c1_k1 |
| chin | leakage | 0.964 | 0.964 | 0.964 | 0.952 | c1_k1 |
| chin | coverage | 0.753 | 0.753 | 0.597 | 0.597 | c0_k0 |
| forehead | mIoU | 0.098 | 0.098 | 0.076 | 0.076 | c0_k0 |
| forehead | leakage | 0.897 | 0.897 | 0.897 | 0.897 | c0_k0 |
| forehead | coverage | 0.83 | 0.83 | 0.312 | 0.312 | c0_k0 |
| cheeks | mIoU | 0.07 | 0.07 | 0.055 | 0.073 | c1_k1 |
| cheeks | leakage | 0.927 | 0.927 | 0.927 | 0.912 | c1_k1 |
| cheeks | coverage | 0.689 | 0.689 | 0.335 | 0.335 | c0_k0 |

## Driver Analysis (Leakage Delta)

| factor | context | leakage_delta | verdict |
|---|---|---:|---|
| circle | calibration=0 | 0.007 | ok |
| circle | calibration=1 | 0.001 | ok |
| calibration | circle=0 | 0 | ok |
| calibration | circle=1 | -0.006 | ok |

## Max Regression Driver

- factor: circle, context: calibration=0, leakage_delta=0.007

## Artifacts

- matrix.md: `reports/eval_circle_matrix_20260211_035324.md`
- matrix.csv: `reports/eval_circle_matrix_20260211_035324.csv`
- matrix.jsonl: `reports/eval_circle_matrix_20260211_035324.jsonl`
- c0_k0.summary: `reports/.eval_circle_matrix_20260211_035324/c0_k0/eval_circle_summary_20260211_035324.md`
- c0_k0.csv: `reports/.eval_circle_matrix_20260211_035324/c0_k0/eval_circle_summary_20260211_035324.csv`
- c0_k0.jsonl: `reports/.eval_circle_matrix_20260211_035324/c0_k0/eval_circle_20260211_035324.jsonl`
- c0_k1.summary: `reports/.eval_circle_matrix_20260211_035324/c0_k1/eval_circle_summary_20260211_035329.md`
- c0_k1.csv: `reports/.eval_circle_matrix_20260211_035324/c0_k1/eval_circle_summary_20260211_035329.csv`
- c0_k1.jsonl: `reports/.eval_circle_matrix_20260211_035324/c0_k1/eval_circle_20260211_035329.jsonl`
- c1_k0.summary: `reports/.eval_circle_matrix_20260211_035324/c1_k0/eval_circle_summary_20260211_035334.md`
- c1_k0.csv: `reports/.eval_circle_matrix_20260211_035324/c1_k0/eval_circle_summary_20260211_035334.csv`
- c1_k0.jsonl: `reports/.eval_circle_matrix_20260211_035324/c1_k0/eval_circle_20260211_035334.jsonl`
- c1_k1.summary: `reports/.eval_circle_matrix_20260211_035324/c1_k1/eval_circle_summary_20260211_035339.md`
- c1_k1.csv: `reports/.eval_circle_matrix_20260211_035324/c1_k1/eval_circle_summary_20260211_035339.csv`
- c1_k1.jsonl: `reports/.eval_circle_matrix_20260211_035324/c1_k1/eval_circle_20260211_035339.jsonl`

