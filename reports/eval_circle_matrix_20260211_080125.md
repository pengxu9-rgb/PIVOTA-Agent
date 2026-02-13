# Eval Circle FASSEG Matrix (Circle × Calibration)

- run_id: 20260211_080125
- generated_at: 2026-02-11T08:01:51.300Z
- datasets: fasseg
- sample_seed: fasseg_matrix_seed_v1
- limit: 150
- circle_model_path: model_registry/circle_prior_latest.json
- regression_bg_threshold: 0.02
- regression_module_threshold: 0.03
- score_tie_delta_threshold: 0.005
- sample_set_consistent: true
- baseline_group: c1_k1

## Recommended defaults

- group: `c0_k0` (circle=0, calibration=0)
- chosen_score: 0.728
- runner_up: `c0_k1` (circle=0, calibration=1, score=0.728, delta=0)
- reasons: selected from hard-gate passing groups; no regression driver above thresholds; score tie < 0.005 resolved by preferring circle=0
- leakage_bg_delta_vs_c1_k1: 0.003
- chin_leakage_bg_delta_vs_c1_k1: 0
- nose_leakage_bg_delta_vs_c1_k1: -0.007
- empty_module_rate_delta_vs_c1_k1: 0

## Group Summary

| group | circle_enabled | calibration_enabled | module_mIoU_mean | leakage_bg_mean | leakage_hair_mean | coverage_mean | empty_module_rate | module_pixels_min | chin_leakage_bg | nose_leakage_bg | samples_ok | samples_total | leakage_bg_delta_vs_baseline |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| c0_k0 | 0 | 0 | 0.056 | 0.052 | 0.006 | 0.251 | 0 | 204 | 0.074 | 0.132 | 116 | 116 | 0.003 |
| c0_k1 | 0 | 1 | 0.056 | 0.052 | 0.006 | 0.251 | 0 | 204 | 0.074 | 0.132 | 116 | 116 | 0.003 |
| c1_k0 | 1 | 0 | 0.048 | 0.053 | 0.006 | 0.172 | 0 | 204 | 0.074 | 0.139 | 116 | 116 | 0.004 |
| c1_k1 | 1 | 1 | 0.047 | 0.049 | 0.005 | 0.162 | 0 | 204 | 0.074 | 0.139 | 116 | 116 | 0 |

## Nose Impact (circle=1 vs circle=0)

| metric | circle_off_avg | circle_on_avg | delta_on_minus_off | verdict |
|---|---:|---:|---:|---|
| nose_leakage_bg | 0.132 | 0.139 | 0.007 | worse |
| nose_coverage | 0.34 | 0.276 | -0.064 | worse |
| nose_mIoU | 0.243 | 0.215 | -0.028 | worse |

- recommendation_note: segmentation_only dataset shows nose regression with circle=1; prefer circle=0 for internal tests.

## Per-Module Compare (chin / nose focus)

| module | metric | c0_k0 | c0_k1 | c1_k0 | c1_k1 | best_group |
|---|---|---:|---:|---:|---:|---|
| chin | leakage_bg | 0.074 | 0.074 | 0.074 | 0.074 | c0_k0 |
| chin | leakage_hair | 0.001 | 0.001 | 0.001 | 0.001 | c0_k0 |
| chin | mIoU | 0.008 | 0.008 | 0.006 | 0.006 | c0_k0 |
| chin | coverage | 0.167 | 0.167 | 0.134 | 0.134 | c0_k0 |
| nose | leakage_bg | 0.132 | 0.132 | 0.139 | 0.139 | c0_k0 |
| nose | leakage_hair | 0.011 | 0.011 | 0.011 | 0.011 | c0_k0 |
| nose | mIoU | 0.243 | 0.243 | 0.215 | 0.215 | c0_k0 |
| nose | coverage | 0.34 | 0.34 | 0.276 | 0.276 | c0_k0 |

## Driver Analysis (Segmentation gate)

| factor | context | leakage_bg_delta | chin_leakage_bg_delta | nose_leakage_bg_delta | max_delta | verdict | reason |
|---|---|---:|---:|---:|---:|---|---|
| circle | calibration=0 | 0.001 | 0 | 0.007 | 0.007 | ok | ok |
| circle | calibration=1 | -0.003 | 0 | 0.007 | 0.007 | ok | ok |
| calibration | circle=0 | 0 | 0 | 0 | 0 | ok | ok |
| calibration | circle=1 | -0.004 | 0 | 0 | 0 | ok | ok |

## Artifacts

- matrix.md: `reports/eval_circle_matrix_20260211_080125.md`
- matrix.csv: `reports/eval_circle_matrix_20260211_080125.csv`
- matrix.jsonl: `reports/eval_circle_matrix_20260211_080125.jsonl`
- c0_k0.summary: `reports/.eval_circle_matrix_20260211_080125/c0_k0/eval_circle_summary_20260211_080125.md`
- c0_k0.csv: `reports/.eval_circle_matrix_20260211_080125/c0_k0/eval_circle_summary_20260211_080125.csv`
- c0_k0.jsonl: `reports/.eval_circle_matrix_20260211_080125/c0_k0/eval_circle_20260211_080125.jsonl`
- c0_k1.summary: `reports/.eval_circle_matrix_20260211_080125/c0_k1/eval_circle_summary_20260211_080132.md`
- c0_k1.csv: `reports/.eval_circle_matrix_20260211_080125/c0_k1/eval_circle_summary_20260211_080132.csv`
- c0_k1.jsonl: `reports/.eval_circle_matrix_20260211_080125/c0_k1/eval_circle_20260211_080132.jsonl`
- c1_k0.summary: `reports/.eval_circle_matrix_20260211_080125/c1_k0/eval_circle_summary_20260211_080138.md`
- c1_k0.csv: `reports/.eval_circle_matrix_20260211_080125/c1_k0/eval_circle_summary_20260211_080138.csv`
- c1_k0.jsonl: `reports/.eval_circle_matrix_20260211_080125/c1_k0/eval_circle_20260211_080138.jsonl`
- c1_k1.summary: `reports/.eval_circle_matrix_20260211_080125/c1_k1/eval_circle_summary_20260211_080145.md`
- c1_k1.csv: `reports/.eval_circle_matrix_20260211_080125/c1_k1/eval_circle_summary_20260211_080145.csv`
- c1_k1.jsonl: `reports/.eval_circle_matrix_20260211_080125/c1_k1/eval_circle_20260211_080145.jsonl`

