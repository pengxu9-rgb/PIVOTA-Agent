# Circle Prior Model Training

- run_id: 20260210_120546
- generated_at: 2026-02-10T12:07:23.967Z
- datasets: lapa, celebamaskhq, fasseg
- limit: 2000
- grid_size: 192
- min_part_pixels: 24
- min_skin_overlap: 0.2
- model_out: model_registry/circle_prior_v1.json
- model_alias: model_registry/circle_prior_latest.json

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
| forehead | 0 | 0 | 0.9099 | 0.3554 | 4151 | 3714 | 437 |
| left_cheek | 0.04 | 0.4239 | 0.4373 | 0.3433 | 4151 | 3959 | 192 |
| right_cheek | 0.5174 | 0.4239 | 0.4426 | 0.3433 | 4151 | 3932 | 219 |
| nose | 0.3655 | 0.3916 | 0.2516 | 0.2643 | 4151 | 3991 | 160 |
| chin | 0.2565 | 0.7532 | 0.4454 | 0.2468 | 4151 | 3980 | 171 |
| under_eye_left | 0.3961 | 0.4259 | 0.3114 | 0.0563 | 4151 | 3839 | 312 |
| under_eye_right | 0.2831 | 0.4238 | 0.3114 | 0.0563 | 4151 | 3822 | 329 |

## Artifacts

- csv: `reports/circle_prior_train_20260210_120546.csv`

