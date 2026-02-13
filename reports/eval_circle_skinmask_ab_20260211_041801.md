# Eval Circle Skinmask AB Compare

- run_id: 20260211_041801
- generated_at: 2026-02-11T04:18:13.626Z
- mode: local
- datasets: fasseg
- onnx: artifacts/skinmask_v2.onnx
- sample_seed: skinmask_ab_seed_v1
- limit: 150

## Overall Delta (on - off)

| metric | skinmask_off | skinmask_on | delta |
|---|---:|---:|---:|
| module_mIoU_mean | 0.111 | 0.111 | 0 |
| leakage_mean | 0.843 | 0.842 | -0.001 |
| PRED_MODULES_MISSING_rate | 0 | 0 | 0 |

## Per-Module Delta

| dataset | module | mIoU_off | mIoU_on | mIoU_delta | leakage_off | leakage_on | leakage_delta | coverage_off | coverage_on | coverage_delta |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 0.046 | 0.047 | 0.001 | 0.952 | 0.952 | 0 | 0.609 | 0.605 | -0.004 |
| fasseg | forehead | 0.076 | 0.076 | 0 | 0.894 | 0.893 | -0.001 | 0.314 | 0.307 | -0.007 |
| fasseg | left_cheek | 0.074 | 0.075 | 0.001 | 0.909 | 0.908 | -0.001 | 0.343 | 0.34 | -0.003 |
| fasseg | nose | 0.514 | 0.513 | -0.001 | 0.291 | 0.291 | 0 | 0.654 | 0.653 | -0.001 |
| fasseg | right_cheek | 0.067 | 0.067 | 0 | 0.918 | 0.918 | 0 | 0.343 | 0.339 | -0.004 |
| fasseg | under_eye_left | 0 | 0 | 0 | 0.962 | 0.962 | 0 | 0 | 0 | 0 |
| fasseg | under_eye_right | 0 | 0 | 0 | 0.974 | 0.973 | -0.001 | 0 | 0 | 0 |

## Top 20 Regression Samples

| rank | dataset | sample_hash | fail_reason_off | fail_reason_on | gt_skin_pixels_off | gt_skin_pixels_on | pred_module_count_off | pred_module_count_on | pred_skin_pixels_est_off | pred_skin_pixels_est_on | leakage_delta | miou_delta |
|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | fasseg | 0a100d0ac1ecbfb695b9 | - | - | 6800 | 6800 | 7 | 7 | 6400 | 5068 | 0.009 | -0.017 |
| 2 | fasseg | c7ed7829bd5e7367d667 | - | - | 4422 | 4422 | 7 | 7 | 4904 | 4732 | 0.006 | -0.005 |
| 3 | fasseg | 1c09ab03a4e4f3b9d986 | - | - | 3889 | 3889 | 7 | 7 | 5176 | 5024 | 0.004 | -0.004 |
| 4 | fasseg | 0e805d95c68a30fb570f | - | - | 4194 | 4194 | 7 | 7 | 5040 | 4824 | 0.003 | -0.004 |
| 5 | fasseg | b671f49e85b0b4ded08d | - | - | 4225 | 4225 | 7 | 7 | 5040 | 4756 | 0.001 | -0.003 |
| 6 | fasseg | 5aa0c7a0f53b25d372c4 | - | - | 4449 | 4449 | 7 | 7 | 6400 | 6184 | 0.001 | -0.002 |
| 7 | fasseg | 6193535862cc5975a14f | - | - | 4859 | 4859 | 7 | 7 | 5040 | 5020 | 0.001 | -0.001 |
| 8 | fasseg | c3a1e8c9f89fdaa53724 | - | - | 4080 | 4080 | 7 | 7 | 5856 | 5820 | 0.001 | 0 |
| 9 | fasseg | afb9401738e382bcc6be | - | - | 3520 | 3520 | 7 | 7 | 6244 | 5620 | 0 | -0.004 |
| 10 | fasseg | d206bfe446184f672f5e | - | - | 4011 | 4011 | 7 | 7 | 5040 | 4428 | 0 | -0.004 |
| 11 | fasseg | 329891d25fc6aedc755f | - | - | 4729 | 4729 | 7 | 7 | 5040 | 4796 | 0 | -0.002 |
| 12 | fasseg | 8d9b236ebde7f72b83c8 | - | - | 3276 | 3276 | 7 | 7 | 6400 | 5816 | 0 | -0.001 |
| 13 | fasseg | e9ec9295fef8b31470aa | - | - | 4024 | 4024 | 7 | 7 | 6400 | 6144 | 0 | -0.001 |

## Artifacts

- ab.md: `reports/eval_circle_skinmask_ab_20260211_041801.md`
- ab.csv: `reports/eval_circle_skinmask_ab_20260211_041801.csv`
- ab.jsonl: `reports/eval_circle_skinmask_ab_20260211_041801.jsonl`
- off.md: `reports/.eval_circle_skinmask_ab_20260211_041801/off/eval_circle_summary_20260211_041801.md`
- on.md: `reports/.eval_circle_skinmask_ab_20260211_041801/on/eval_circle_summary_20260211_041806.md`
- off.jsonl: `reports/.eval_circle_skinmask_ab_20260211_041801/off/eval_circle_20260211_041801.jsonl`
- on.jsonl: `reports/.eval_circle_skinmask_ab_20260211_041801/on/eval_circle_20260211_041806.jsonl`

