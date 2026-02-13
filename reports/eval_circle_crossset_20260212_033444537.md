# Eval Circle Crossset

- run_id: 20260212_033444537
- generated_at: 2026-02-12T03:34:46.315Z
- datasets: celebamaskhq, lapa
- limit: 5
- cache_dir: `datasets_cache/external`
- report_dir: `reports`

## Per-Dataset Metrics

| dataset | mode | exit_code | samples_total | strong_module_mIoU | coverage | leakage_bg | leakage_hair | worst_module | worst_module_mIoU |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|
| celebamaskhq | parsing_gt | 0 | 5 | 0.309 | 0.344 | 0.027 | 0.054 | forehead | 0.137 |
| lapa | parsing_gt | 0 | 5 | 0.303 | 0.368 | 0.204 | 0.133 | forehead | 0.144 |

## Worst Modules Across Datasets

| rank | dataset | module | mIoU | coverage | leakage_bg | leakage_hair | samples |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | celebamaskhq | forehead | 0.137 | 0.146 | 0.096 | 0.263 | 5 |
| 2 | lapa | forehead | 0.144 | 0.164 | 0.012 | 0.487 | 5 |
| 3 | celebamaskhq | nose | 0.17 | 0.247 | 0 | 0 | 5 |
| 4 | lapa | nose | 0.246 | 0.301 | 0.316 | 0 | 5 |
| 5 | lapa | chin | 0.34 | 0.429 | 0.368 | 0 | 5 |
| 6 | lapa | right_cheek | 0.373 | 0.461 | 0.247 | 0.03 | 5 |
| 7 | celebamaskhq | left_cheek | 0.401 | 0.431 | 0.008 | 0.008 | 5 |
| 8 | lapa | left_cheek | 0.412 | 0.486 | 0.079 | 0.149 | 5 |
| 9 | celebamaskhq | chin | 0.414 | 0.451 | 0.027 | 0 | 5 |
| 10 | celebamaskhq | right_cheek | 0.421 | 0.447 | 0.006 | 0 | 5 |

## Fail Reasons

### celebamaskhq

| reason | count | pct |
|---|---:|---:|
| - | 0 | 0 |

### lapa

| reason | count | pct |
|---|---:|---:|
| - | 0 | 0 |

## Artifacts

- report_md: `reports/eval_circle_crossset_20260212_033444537.md`
- report_json: `reports/eval_circle_crossset_20260212_033444537.json`

