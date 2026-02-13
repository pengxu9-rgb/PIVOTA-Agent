# Eval Circle Shrink Follow-up (Targeted Candidates)

- run_id: 20260211_063032
- generated_at: 2026-02-11T06:30:32.708565Z
- dataset: fasseg
- sample_seed: fasseg_shrink_sweep_seed_v1
- samples_per_case: 150
- cache_dir: datasets_cache/external

## Baseline

- module_mIoU_mean: 0.076
- leakage_bg_mean: 0.066
- leakage_non_skin_mean: 0.821

## Candidate Comparison

| name | chin | forehead | cheek | under_eye | nose | mIoU | leakage_bg | leakage_non_skin | delta_bg_vs_baseline | delta_mIoU_vs_baseline |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| c1 | 0.9 | 0.88 | 0.9 | 0.95 | 0.95 | 0.075 | 0.061 | 0.824 | -0.005 | -0.001 |
| default | 0.8 | 0.88 | 0.9 | 0.95 | 0.95 | 0.075 | 0.062 | 0.824 | -0.004 | -0.001 |
| loose_b | 0.9 | 0.93 | 0.94 | 0.98 | 0.98 | 0.077 | 0.063 | 0.82 | -0.003 | 0.001 |
| c2 | 0.92 | 0.9 | 0.92 | 0.96 | 0.96 | 0.075 | 0.063 | 0.823 | -0.003 | -0.001 |
| c3 | 0.9 | 0.9 | 0.92 | 0.97 | 0.97 | 0.075 | 0.063 | 0.823 | -0.003 | -0.001 |
| c4 | 0.88 | 0.9 | 0.92 | 0.97 | 0.97 | 0.075 | 0.063 | 0.823 | -0.003 | -0.001 |
| c5 | 0.9 | 0.9 | 0.9 | 0.95 | 0.98 | 0.075 | 0.063 | 0.824 | -0.003 | -0.001 |
| baseline | 1 | 1 | 1 | 1 | 1 | 0.076 | 0.066 | 0.821 | 0.0 | 0.0 |

## Recommendation

- best_by_leakage_bg: `c1`
- env: `DIAG_MODULE_SHRINK_CHIN=0.9` `DIAG_MODULE_SHRINK_FOREHEAD=0.88` `DIAG_MODULE_SHRINK_CHEEK=0.9` `DIAG_MODULE_SHRINK_UNDER_EYE=0.95` `DIAG_MODULE_SHRINK_NOSE=0.95`
- effect_vs_baseline: leakage_bg `-0.005`, mIoU `-0.001`
