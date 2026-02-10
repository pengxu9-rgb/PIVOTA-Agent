# Circle Prior Model Training

- run_id: 20260210_121615
- generated_at: 2026-02-10T12:21:17.277Z
- datasets: lapa, celebamaskhq, fasseg
- limit: 5000
- grid_size: 192
- min_part_pixels: 24
- min_skin_overlap: 0.2
- model_out: model_registry/circle_prior_v1.json
- model_alias: model_registry/circle_prior_latest.json

## Sample Coverage

- samples_total: 10150
- samples_used: 10150
- samples_skipped: 0

| dataset | loaded | used | skipped |
|---|---:|---:|---:|
| lapa | 5000 | 5000 | 0 |
| celebamaskhq | 5000 | 5000 | 0 |
| fasseg | 150 | 150 | 0 |

## Module Boxes

| module | x | y | w | h | samples | strong | weak |
|---|---:|---:|---:|---:|---:|---:|---:|
| forehead | 0.0006 | 0 | 0.9099 | 0.3573 | 10151 | 9291 | 860 |
| left_cheek | 0.04 | 0.426 | 0.44 | 0.3417 | 10151 | 9904 | 247 |
| right_cheek | 0.5174 | 0.426 | 0.4426 | 0.3417 | 10151 | 9852 | 299 |
| nose | 0.367 | 0.3932 | 0.2516 | 0.2643 | 10151 | 9979 | 172 |
| chin | 0.2565 | 0.7542 | 0.4531 | 0.2458 | 10151 | 9928 | 223 |
| under_eye_left | 0.4 | 0.4278 | 0.2995 | 0.0563 | 10151 | 9623 | 528 |
| under_eye_right | 0.2867 | 0.4259 | 0.2995 | 0.0563 | 10151 | 9580 | 571 |

## Artifacts

- csv: `reports/circle_prior_train_20260210_121615.csv`

