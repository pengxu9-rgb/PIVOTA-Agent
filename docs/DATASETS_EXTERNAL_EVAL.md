# External Datasets Circle Evaluation

This guide covers external dataset preparation and circle-accuracy evaluation for Aurora `photo_modules_v1`.

## Scope

- Supported datasets: `lapa`, `celebamaskhq`, `fasseg`, `acne04`
- Raw zip input directory (default): `~/Desktop/datasets_raw`
- Cache/output storage (gitignored): `datasets_cache/**`
- Default output artifacts (committable): `reports/*.md`, `reports/*.csv`, `reports/*.jsonl`

## Compliance Notes

- Raw datasets and extracted images are **never committed**.
- Default pipeline is **numeric-only**; no overlay images are generated.
- If debug output is explicitly enabled (`EVAL_EMIT_DEBUG=true`), files are written under `outputs/datasets_debug/` and treated as **DO NOT DISTRIBUTE**.

## Quick Start

1) Prepare datasets from zips:

```bash
make datasets-prepare RAW_DIR="$HOME/Desktop/datasets_raw" CACHE_DIR="datasets_cache/external" DATASETS="lapa,celebamaskhq,fasseg,acne04"
```

2) Audit registry + manifests + ignore policy:

```bash
make datasets-audit CACHE_DIR="datasets_cache/external" DATASETS="lapa,celebamaskhq,fasseg,acne04"
```

3) Train circle-prior module model:

```bash
make train-circle-prior CACHE_DIR="datasets_cache/external" DATASETS="lapa,celebamaskhq,fasseg" LIMIT=200
```

4) Run circle evaluation:

```bash
make eval-circle CACHE_DIR="datasets_cache/external" DATASETS="lapa,celebamaskhq,fasseg" LIMIT=200
```

Or one-shot:

```bash
make eval-datasets RAW_DIR="$HOME/Desktop/datasets_raw" CACHE_DIR="datasets_cache/external" DATASETS="lapa,celebamaskhq,fasseg" LIMIT=200
```

## API Mode (optional)

By default `eval-circle` uses local inference (`runSkinDiagnosisV1 + buildPhotoModulesCard`).
To evaluate via deployed API:

```bash
make eval-circle \
  CACHE_DIR="datasets_cache/external" \
  DATASETS="lapa,celebamaskhq,fasseg" \
  EVAL_BASE_URL="https://your-service" \
  EVAL_TOKEN="$TOKEN"
```

## Artifacts

Each run writes:

- `reports/circle_prior_train_<timestamp>.md`
- `reports/circle_prior_train_<timestamp>.csv`
- `model_registry/circle_prior_v1.json`
- `model_registry/circle_prior_latest.json`
- `reports/eval_circle_<timestamp>.jsonl` (per-sample rows, hashed sample IDs)
- `reports/eval_circle_summary_<timestamp>.csv`
- `reports/eval_circle_summary_<timestamp>.md`
- `datasets_cache/derived_gt/<dataset>/*.json` (RLE-derived GT in `face_crop_norm_v1`)

## Report Fields

- `module_iou` / `module_coverage` / `module_leakage`
- `skin_roi_too_small_rate` (`pred_pixels < EVAL_SKIN_ROI_MIN_PIXELS`)
- `face_detect_fail_rate`
- `landmark_fail_rate` (currently mirrors face-crop availability)
- `geometry_sanitize_drop_rate` (available in local mode from card builder metrics)

Soft-gate thresholds:

- `EVAL_MIN_MIOU` (default `0.65`)
- `EVAL_MAX_FAIL_RATE` (default `0.05`)
- `EVAL_MAX_LEAKAGE` (default `0.10`)
- `EVAL_MAX_SKIN_ROI_TOO_SMALL` (default `0.20`)
- `EVAL_SKIN_ROI_MIN_PIXELS` (default `8`)

Circle-prior calibration options:

- `EVAL_CIRCLE_MODEL_PATH` (default `model_registry/circle_prior_latest.json`)
- `CIRCLE_MODEL_CALIBRATION` (default `true`)
- `CIRCLE_MODEL_MIN_PIXELS` (default `24`)

## Troubleshooting

- `zip_not_found`: ensure zip filename includes dataset token (`lapa`, `celebamaskhq`, `fasseg`, `acne04`).
- `dataset_index_missing`: rerun `make datasets-prepare`.
- `no_samples_found_after_prepare`: check extracted folder structure and generated `dataset_index.jsonl`.
- `photo_modules_card_missing` in API mode: verify remote service flag/config includes `photo_modules_v1`.
- HEIC decode issues: convert to JPEG input set and rerun.
