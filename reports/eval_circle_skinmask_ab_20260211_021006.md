# Eval Circle Skinmask AB Compare

- run_id: 20260211_021006
- generated_at: 2026-02-11T02:10:27.321Z
- mode: local
- datasets: fasseg
- onnx: artifacts/skinmask_v1.onnx
- sample_seed: skinmask_ab_seed_v1
- limit: 150

## Overall Delta (on - off)

| metric | skinmask_off | skinmask_on | delta |
|---|---:|---:|---:|
| module_mIoU_mean | 0.274 | 0.275 | 0.001 |
| leakage_mean | 0.722 | 0.719 | -0.003 |
| PRED_MODULES_MISSING_rate | 0 | 0 | 0 |

## Per-Module Delta

| dataset | module | mIoU_off | mIoU_on | mIoU_delta | leakage_off | leakage_on | leakage_delta | coverage_off | coverage_on | coverage_delta |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fasseg | chin | 0.036 | 0.036 | 0 | 0.964 | 0.964 | 0 | 0.96 | 0.959 | -0.001 |
| fasseg | forehead | 0.099 | 0.103 | 0.004 | 0.898 | 0.891 | -0.007 | 0.743 | 0.734 | -0.009 |
| fasseg | left_cheek | 0.115 | 0.117 | 0.002 | 0.883 | 0.881 | -0.002 | 0.898 | 0.894 | -0.004 |
| fasseg | nose | 0.571 | 0.57 | -0.001 | 0.415 | 0.415 | 0 | 0.936 | 0.931 | -0.005 |
| fasseg | right_cheek | 0.107 | 0.109 | 0.002 | 0.891 | 0.889 | -0.002 | 0.907 | 0.902 | -0.005 |
| fasseg | under_eye_left | 0.502 | 0.501 | -0.001 | 0.495 | 0.491 | -0.004 | 0.789 | 0.776 | -0.013 |
| fasseg | under_eye_right | 0.489 | 0.492 | 0.003 | 0.506 | 0.502 | -0.004 | 0.788 | 0.776 | -0.012 |

## Top 20 Regression Samples

| rank | dataset | sample_hash | fail_reason_off | fail_reason_on | gt_skin_pixels_off | gt_skin_pixels_on | pred_module_count_off | pred_module_count_on | pred_skin_pixels_est_off | pred_skin_pixels_est_on | leakage_delta | miou_delta |
|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | fasseg | 6c783f6e648639309711 | - | - | 280 | 280 | 7 | 7 | 9321 | 6551 | 0.004 | -0.004 |
| 2 | fasseg | 3ff6207aeedc6cda5e96 | - | - | 3558 | 3558 | 7 | 7 | 9513 | 7949 | 0 | -0.034 |

## Artifacts

- ab.md: `reports/eval_circle_skinmask_ab_20260211_021006.md`
- ab.csv: `reports/eval_circle_skinmask_ab_20260211_021006.csv`
- ab.jsonl: `reports/eval_circle_skinmask_ab_20260211_021006.jsonl`
- off.md: `reports/.eval_circle_skinmask_ab_20260211_021006/off/eval_circle_summary_20260211_021007.md`
- on.md: `reports/.eval_circle_skinmask_ab_20260211_021006/on/eval_circle_summary_20260211_021012.md`
- off.jsonl: `reports/.eval_circle_skinmask_ab_20260211_021006/off/eval_circle_20260211_021007.jsonl`
- on.jsonl: `reports/.eval_circle_skinmask_ab_20260211_021006/on/eval_circle_20260211_021012.jsonl`

