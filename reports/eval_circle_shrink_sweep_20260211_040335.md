# Eval Circle Shrink Sweep (FASSEG)

- run_id: 20260211_040335
- generated_at: 2026-02-11T04:04:13.277Z
- datasets: fasseg
- sample_seed: fasseg_shrink_sweep_seed_v1
- limit: 150
- baseline_group: baseline
- circle_model_path: model_registry/circle_prior_latest.json
- circle_model_calibration: true

## DoD Check

- status: NOT_MET
- target: leakage_delta <= -0.10 and mIoU_delta >= -0.02 (vs baseline)

## Sweep Summary

| group | chin | forehead | cheek | under_eye | nose | module_mIoU_mean | leakage_mean | coverage_mean | leakage_delta_vs_baseline | mIoU_delta_vs_baseline | target_met |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| baseline | 1 | 1 | 1 | 1 | 1 | 0.124 | 0.842 | 0.395 | 0 | 0 | no |
| tight_b | 0.7 | 0.82 | 0.85 | 0.9 | 0.9 | 0.111 | 0.838 | 0.302 | -0.004 | -0.013 | no |
| loose_b | 0.9 | 0.93 | 0.94 | 0.98 | 0.98 | 0.12 | 0.84 | 0.376 | -0.002 | -0.004 | no |
| loose_a | 0.85 | 0.9 | 0.92 | 0.97 | 0.97 | 0.114 | 0.841 | 0.355 | -0.001 | -0.01 | no |
| default | 0.8 | 0.88 | 0.9 | 0.95 | 0.95 | 0.111 | 0.843 | 0.32 | 0.001 | -0.013 | no |
| mid_b | 0.82 | 0.9 | 0.9 | 0.94 | 0.96 | 0.111 | 0.843 | 0.322 | 0.001 | -0.013 | no |
| tight_a | 0.75 | 0.85 | 0.88 | 0.93 | 0.93 | 0.11 | 0.843 | 0.314 | 0.001 | -0.014 | no |
| mid_a | 0.78 | 0.86 | 0.88 | 0.92 | 0.94 | 0.11 | 0.843 | 0.314 | 0.001 | -0.014 | no |

## Per-Module Tradeoff (chin / forehead / cheeks)

| group | module | mIoU | leakage | coverage |
|---|---|---:|---:|---:|
| baseline | chin | 0.045 | 0.955 | 0.792 |
| baseline | forehead | 0.076 | 0.9 | 0.343 |
| baseline | cheeks | 0.085 | 0.901 | 0.44 |
| tight_b | chin | 0.044 | 0.954 | 0.532 |
| tight_b | forehead | 0.069 | 0.894 | 0.261 |
| tight_b | cheeks | 0.069 | 0.916 | 0.338 |
| loose_b | chin | 0.048 | 0.951 | 0.728 |
| loose_b | forehead | 0.078 | 0.893 | 0.324 |
| loose_b | cheeks | 0.085 | 0.901 | 0.44 |
| loose_a | chin | 0.048 | 0.951 | 0.728 |
| loose_a | forehead | 0.078 | 0.893 | 0.324 |
| loose_a | cheeks | 0.077 | 0.91 | 0.39 |
| default | chin | 0.045 | 0.953 | 0.598 |
| default | forehead | 0.079 | 0.89 | 0.315 |
| default | cheeks | 0.069 | 0.916 | 0.338 |
| mid_b | chin | 0.045 | 0.953 | 0.598 |
| mid_b | forehead | 0.078 | 0.893 | 0.324 |
| mid_b | cheeks | 0.069 | 0.916 | 0.338 |
| tight_a | chin | 0.045 | 0.953 | 0.598 |
| tight_a | forehead | 0.069 | 0.897 | 0.269 |
| tight_a | cheeks | 0.069 | 0.916 | 0.338 |
| mid_a | chin | 0.045 | 0.953 | 0.598 |
| mid_a | forehead | 0.068 | 0.898 | 0.269 |
| mid_a | cheeks | 0.069 | 0.916 | 0.338 |

## Pareto Frontier

| rank | group | module_mIoU_mean | leakage_mean | score_vs_baseline |
|---:|---|---:|---:|---:|
| 1 | loose_b | 0.12 | 0.84 | 0 |
| 2 | baseline | 0.124 | 0.842 | 0 |
| 3 | tight_b | 0.111 | 0.838 | -0.002 |

## Recommended Internal Defaults

- `loose_b` => DIAG_MODULE_SHRINK_CHIN=0.9, DIAG_MODULE_SHRINK_FOREHEAD=0.93, DIAG_MODULE_SHRINK_CHEEK=0.94, DIAG_MODULE_SHRINK_UNDER_EYE=0.98, DIAG_MODULE_SHRINK_NOSE=0.98
- `baseline` => DIAG_MODULE_SHRINK_CHIN=1, DIAG_MODULE_SHRINK_FOREHEAD=1, DIAG_MODULE_SHRINK_CHEEK=1, DIAG_MODULE_SHRINK_UNDER_EYE=1, DIAG_MODULE_SHRINK_NOSE=1
- `tight_b` => DIAG_MODULE_SHRINK_CHIN=0.7, DIAG_MODULE_SHRINK_FOREHEAD=0.82, DIAG_MODULE_SHRINK_CHEEK=0.85, DIAG_MODULE_SHRINK_UNDER_EYE=0.9, DIAG_MODULE_SHRINK_NOSE=0.9

## Artifacts

- sweep.md: `reports/eval_circle_shrink_sweep_20260211_040335.md`
- sweep.csv: `reports/eval_circle_shrink_sweep_20260211_040335.csv`
- sweep.jsonl: `reports/eval_circle_shrink_sweep_20260211_040335.jsonl`
- baseline.summary: `reports/.eval_circle_shrink_sweep_20260211_040335/baseline/eval_circle_summary_20260211_040336.md`
- baseline.csv: `reports/.eval_circle_shrink_sweep_20260211_040335/baseline/eval_circle_summary_20260211_040336.csv`
- baseline.jsonl: `reports/.eval_circle_shrink_sweep_20260211_040335/baseline/eval_circle_20260211_040336.jsonl`
- tight_b.summary: `reports/.eval_circle_shrink_sweep_20260211_040335/tight_b/eval_circle_summary_20260211_040350.md`
- tight_b.csv: `reports/.eval_circle_shrink_sweep_20260211_040335/tight_b/eval_circle_summary_20260211_040350.csv`
- tight_b.jsonl: `reports/.eval_circle_shrink_sweep_20260211_040335/tight_b/eval_circle_20260211_040350.jsonl`
- loose_b.summary: `reports/.eval_circle_shrink_sweep_20260211_040335/loose_b/eval_circle_summary_20260211_040408.md`
- loose_b.csv: `reports/.eval_circle_shrink_sweep_20260211_040335/loose_b/eval_circle_summary_20260211_040408.csv`
- loose_b.jsonl: `reports/.eval_circle_shrink_sweep_20260211_040335/loose_b/eval_circle_20260211_040408.jsonl`
- loose_a.summary: `reports/.eval_circle_shrink_sweep_20260211_040335/loose_a/eval_circle_summary_20260211_040404.md`
- loose_a.csv: `reports/.eval_circle_shrink_sweep_20260211_040335/loose_a/eval_circle_summary_20260211_040404.csv`
- loose_a.jsonl: `reports/.eval_circle_shrink_sweep_20260211_040335/loose_a/eval_circle_20260211_040404.jsonl`
- default.summary: `reports/.eval_circle_shrink_sweep_20260211_040335/default/eval_circle_summary_20260211_040340.md`
- default.csv: `reports/.eval_circle_shrink_sweep_20260211_040335/default/eval_circle_summary_20260211_040340.csv`
- default.jsonl: `reports/.eval_circle_shrink_sweep_20260211_040335/default/eval_circle_20260211_040340.jsonl`
- mid_b.summary: `reports/.eval_circle_shrink_sweep_20260211_040335/mid_b/eval_circle_summary_20260211_040400.md`
- mid_b.csv: `reports/.eval_circle_shrink_sweep_20260211_040335/mid_b/eval_circle_summary_20260211_040400.csv`
- mid_b.jsonl: `reports/.eval_circle_shrink_sweep_20260211_040335/mid_b/eval_circle_20260211_040400.jsonl`
- tight_a.summary: `reports/.eval_circle_shrink_sweep_20260211_040335/tight_a/eval_circle_summary_20260211_040345.md`
- tight_a.csv: `reports/.eval_circle_shrink_sweep_20260211_040335/tight_a/eval_circle_summary_20260211_040345.csv`
- tight_a.jsonl: `reports/.eval_circle_shrink_sweep_20260211_040335/tight_a/eval_circle_20260211_040345.jsonl`
- mid_a.summary: `reports/.eval_circle_shrink_sweep_20260211_040335/mid_a/eval_circle_summary_20260211_040354.md`
- mid_a.csv: `reports/.eval_circle_shrink_sweep_20260211_040335/mid_a/eval_circle_summary_20260211_040354.csv`
- mid_a.jsonl: `reports/.eval_circle_shrink_sweep_20260211_040335/mid_a/eval_circle_20260211_040354.jsonl`

