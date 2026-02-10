# Circle Prior Model Training

- run_id: 20260210_115448
- generated_at: 2026-02-10T11:55:58.243Z
- datasets: lapa, celebamaskhq, fasseg
- limit: 1500
- grid_size: 256
- min_part_pixels: 24
- min_skin_overlap: 0.2
- model_out: model_registry/circle_prior_v1.json
- model_alias: model_registry/circle_prior_latest.json

## Sample Coverage

- samples_total: 3150
- samples_used: 3150
- samples_skipped: 0

| dataset | loaded | used | skipped |
|---|---:|---:|---:|
| lapa | 1500 | 1500 | 0 |
| celebamaskhq | 1500 | 1500 | 0 |
| fasseg | 150 | 150 | 0 |

## Module Boxes

| module | x | y | w | h | samples | strong | weak |
|---|---:|---:|---:|---:|---:|---:|---:|
| forehead | 0 | 0 | 0.9079 | 0.3548 | 3151 | 2794 | 357 |
| left_cheek | 0.04 | 0.4242 | 0.4361 | 0.3429 | 3151 | 2979 | 172 |
| right_cheek | 0.5181 | 0.4242 | 0.4419 | 0.3429 | 3151 | 2958 | 193 |
| nose | 0.3661 | 0.3906 | 0.2516 | 0.2674 | 3151 | 2995 | 156 |
| chin | 0.2568 | 0.7532 | 0.4454 | 0.2468 | 3151 | 2983 | 168 |
| under_eye_left | 0.3869 | 0.4263 | 0.3144 | 0.058 | 3151 | 2909 | 242 |
| under_eye_right | 0.2899 | 0.4234 | 0.3144 | 0.058 | 3151 | 2896 | 255 |

## Artifacts

- csv: `reports/circle_prior_train_20260210_115448.csv`

