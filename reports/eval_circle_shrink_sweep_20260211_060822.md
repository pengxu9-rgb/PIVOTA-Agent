# Eval Circle Shrink Sweep (FASSEG)

- run_id: 20260211_060822
- generated_at: 2026-02-11T06:09:11.845Z
- datasets: fasseg
- sample_seed: fasseg_shrink_sweep_seed_v1
- limit: 150
- baseline_group: baseline
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true

## DoD Check

- status: NOT_MET
- target: leakage_bg_delta <= -0.10 and mIoU_delta >= -0.02 (vs baseline)

## Sweep Summary

| group | chin | forehead | cheek | under_eye | nose | module_mIoU_mean | leakage_bg_mean | leakage_non_skin_mean | coverage_mean | leakage_bg_delta_vs_baseline | mIoU_delta_vs_baseline | target_met |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| baseline | 1 | 1 | 1 | 1 | 1 | 0.09 | 0.075 | 0.83 | 0.512 | 0 | 0 | no |
| default | 0.8 | 0.88 | 0.9 | 0.95 | 0.95 | 0.089 | 0.072 | 0.832 | 0.477 | -0.003 | -0.001 | no |
| loose_b | 0.9 | 0.93 | 0.94 | 0.98 | 0.98 | 0.091 | 0.073 | 0.828 | 0.511 | -0.002 | 0.001 | no |
| loose_a | 0.85 | 0.9 | 0.92 | 0.97 | 0.97 | 0.089 | 0.073 | 0.831 | 0.496 | -0.002 | -0.001 | no |
| tight_b | 0.7 | 0.82 | 0.85 | 0.9 | 0.9 | 0.089 | 0.074 | 0.83 | 0.472 | -0.001 | -0.001 | no |
| mid_b | 0.82 | 0.9 | 0.9 | 0.94 | 0.96 | 0.089 | 0.074 | 0.832 | 0.478 | -0.001 | -0.001 | no |
| tight_a | 0.75 | 0.85 | 0.88 | 0.93 | 0.93 | 0.088 | 0.074 | 0.833 | 0.472 | -0.001 | -0.002 | no |
| mid_a | 0.78 | 0.86 | 0.88 | 0.92 | 0.94 | 0.088 | 0.074 | 0.833 | 0.472 | -0.001 | -0.002 | no |

## Per-Module Tradeoff (chin / forehead / cheeks)

| group | module | mIoU | leakage_bg | leakage_non_skin | coverage |
|---|---|---:|---:|---:|---:|
| baseline | chin | 0.006 | 0.082 | 0.988 | 0.146 |
| baseline | forehead | 0.055 | 0.125 | 0.923 | 0.176 |
| baseline | cheeks | 0.063 | 0.04 | 0.915 | 0.453 |
| default | chin | 0.006 | 0.093 | 0.987 | 0.146 |
| default | forehead | 0.058 | 0.1 | 0.915 | 0.16 |
| default | cheeks | 0.053 | 0.038 | 0.93 | 0.347 |
| loose_b | chin | 0.006 | 0.086 | 0.988 | 0.146 |
| loose_b | forehead | 0.057 | 0.109 | 0.918 | 0.165 |
| loose_b | cheeks | 0.065 | 0.041 | 0.913 | 0.453 |
| loose_a | chin | 0.006 | 0.091 | 0.987 | 0.146 |
| loose_a | forehead | 0.057 | 0.109 | 0.918 | 0.165 |
| loose_a | cheeks | 0.059 | 0.039 | 0.922 | 0.403 |
| tight_b | chin | 0.006 | 0.104 | 0.985 | 0.146 |
| tight_b | forehead | 0.049 | 0.098 | 0.918 | 0.122 |
| tight_b | cheeks | 0.055 | 0.038 | 0.927 | 0.347 |
| mid_b | chin | 0.006 | 0.093 | 0.987 | 0.146 |
| mid_b | forehead | 0.057 | 0.109 | 0.918 | 0.165 |
| mid_b | cheeks | 0.053 | 0.038 | 0.93 | 0.347 |
| tight_a | chin | 0.006 | 0.093 | 0.987 | 0.146 |
| tight_a | forehead | 0.049 | 0.109 | 0.921 | 0.127 |
| tight_a | cheeks | 0.053 | 0.038 | 0.93 | 0.347 |
| mid_a | chin | 0.006 | 0.093 | 0.987 | 0.146 |
| mid_a | forehead | 0.049 | 0.109 | 0.921 | 0.127 |
| mid_a | cheeks | 0.053 | 0.038 | 0.93 | 0.347 |

## Pareto Frontier

| rank | group | module_mIoU_mean | leakage_bg_mean | leakage_non_skin_mean | score_vs_baseline |
|---:|---|---:|---:|---:|---:|
| 1 | default | 0.089 | 0.072 | 0.832 | 0.003 |
| 2 | loose_b | 0.091 | 0.073 | 0.828 | 0.003 |

## Recommended Internal Defaults

- `default` => DIAG_MODULE_SHRINK_CHIN=0.8, DIAG_MODULE_SHRINK_FOREHEAD=0.88, DIAG_MODULE_SHRINK_CHEEK=0.9, DIAG_MODULE_SHRINK_UNDER_EYE=0.95, DIAG_MODULE_SHRINK_NOSE=0.95
- `loose_b` => DIAG_MODULE_SHRINK_CHIN=0.9, DIAG_MODULE_SHRINK_FOREHEAD=0.93, DIAG_MODULE_SHRINK_CHEEK=0.94, DIAG_MODULE_SHRINK_UNDER_EYE=0.98, DIAG_MODULE_SHRINK_NOSE=0.98

## Artifacts

- sweep.md: `reports/eval_circle_shrink_sweep_20260211_060822.md`
- sweep.csv: `reports/eval_circle_shrink_sweep_20260211_060822.csv`
- sweep.jsonl: `reports/eval_circle_shrink_sweep_20260211_060822.jsonl`
- baseline.summary: `reports/.eval_circle_shrink_sweep_20260211_060822/baseline/eval_circle_summary_20260211_060822.md`
- baseline.csv: `reports/.eval_circle_shrink_sweep_20260211_060822/baseline/eval_circle_summary_20260211_060822.csv`
- baseline.jsonl: `reports/.eval_circle_shrink_sweep_20260211_060822/baseline/eval_circle_20260211_060822.jsonl`
- default.summary: `reports/.eval_circle_shrink_sweep_20260211_060822/default/eval_circle_summary_20260211_060829.md`
- default.csv: `reports/.eval_circle_shrink_sweep_20260211_060822/default/eval_circle_summary_20260211_060829.csv`
- default.jsonl: `reports/.eval_circle_shrink_sweep_20260211_060822/default/eval_circle_20260211_060829.jsonl`
- loose_b.summary: `reports/.eval_circle_shrink_sweep_20260211_060822/loose_b/eval_circle_summary_20260211_060905.md`
- loose_b.csv: `reports/.eval_circle_shrink_sweep_20260211_060822/loose_b/eval_circle_summary_20260211_060905.csv`
- loose_b.jsonl: `reports/.eval_circle_shrink_sweep_20260211_060822/loose_b/eval_circle_20260211_060905.jsonl`
- loose_a.summary: `reports/.eval_circle_shrink_sweep_20260211_060822/loose_a/eval_circle_summary_20260211_060859.md`
- loose_a.csv: `reports/.eval_circle_shrink_sweep_20260211_060822/loose_a/eval_circle_summary_20260211_060859.csv`
- loose_a.jsonl: `reports/.eval_circle_shrink_sweep_20260211_060822/loose_a/eval_circle_20260211_060859.jsonl`
- tight_b.summary: `reports/.eval_circle_shrink_sweep_20260211_060822/tight_b/eval_circle_summary_20260211_060841.md`
- tight_b.csv: `reports/.eval_circle_shrink_sweep_20260211_060822/tight_b/eval_circle_summary_20260211_060841.csv`
- tight_b.jsonl: `reports/.eval_circle_shrink_sweep_20260211_060822/tight_b/eval_circle_20260211_060841.jsonl`
- mid_b.summary: `reports/.eval_circle_shrink_sweep_20260211_060822/mid_b/eval_circle_summary_20260211_060853.md`
- mid_b.csv: `reports/.eval_circle_shrink_sweep_20260211_060822/mid_b/eval_circle_summary_20260211_060853.csv`
- mid_b.jsonl: `reports/.eval_circle_shrink_sweep_20260211_060822/mid_b/eval_circle_20260211_060853.jsonl`
- tight_a.summary: `reports/.eval_circle_shrink_sweep_20260211_060822/tight_a/eval_circle_summary_20260211_060835.md`
- tight_a.csv: `reports/.eval_circle_shrink_sweep_20260211_060822/tight_a/eval_circle_summary_20260211_060835.csv`
- tight_a.jsonl: `reports/.eval_circle_shrink_sweep_20260211_060822/tight_a/eval_circle_20260211_060835.jsonl`
- mid_a.summary: `reports/.eval_circle_shrink_sweep_20260211_060822/mid_a/eval_circle_summary_20260211_060847.md`
- mid_a.csv: `reports/.eval_circle_shrink_sweep_20260211_060822/mid_a/eval_circle_summary_20260211_060847.csv`
- mid_a.jsonl: `reports/.eval_circle_shrink_sweep_20260211_060822/mid_a/eval_circle_20260211_060847.jsonl`

