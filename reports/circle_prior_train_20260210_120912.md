# Circle Prior Model Training

- run_id: 20260210_120912
- generated_at: 2026-02-10T12:11:00.101Z
- datasets: lapa, celebamaskhq, fasseg
- limit: 2000
- grid_size: 192
- min_part_pixels: 24
- min_skin_overlap: 0.35
- model_out: model_registry/circle_prior_tune_v1.json
- model_alias: model_registry/circle_prior_tune_latest.json

## Sample Coverage

- samples_total: 4150
- samples_used: 4150
- samples_skipped: 0

| dataset | loaded | used | skipped |
|---|---:|---:|---:|
| lapa | 2000 | 2000 | 0 |
| celebamaskhq | 2000 | 2000 | 0 |
| fasseg | 150 | 150 | 0 |

## Module Boxes

| module | x | y | w | h | samples | strong | weak |
|---|---:|---:|---:|---:|---:|---:|---:|
| forehead | 0.0125 | 0 | 0.8775 | 0.356 | 4151 | 2993 | 1158 |
| left_cheek | 0.04 | 0.4229 | 0.4374 | 0.3432 | 4151 | 3859 | 292 |
| right_cheek | 0.5149 | 0.4239 | 0.4451 | 0.3432 | 4151 | 3857 | 294 |
| nose | 0.3665 | 0.3913 | 0.2516 | 0.2643 | 4151 | 3853 | 298 |
| chin | 0.2565 | 0.7521 | 0.4454 | 0.2479 | 4151 | 3867 | 284 |
| under_eye_left | 0.3968 | 0.4251 | 0.3114 | 0.0563 | 4151 | 3815 | 336 |
| under_eye_right | 0.2815 | 0.4238 | 0.3114 | 0.0563 | 4151 | 3796 | 355 |

## Artifacts

- csv: `reports/circle_prior_train_20260210_120912.csv`

