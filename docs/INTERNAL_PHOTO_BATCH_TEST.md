# INTERNAL PHOTO BATCH TEST

## Purpose

`internal_batch_run_photos` is an internal-only bulk photo validation toolchain for Aurora Diagnosis Pipeline.
It runs a local photo set against `/v1/analysis/skin`, then produces three artifacts:

- `reports/internal_batch_YYYYMMDD_HHMMSSmmm.jsonl`
- `reports/internal_batch_YYYYMMDD_HHMMSSmmm.csv`
- `reports/internal_batch_YYYYMMDD_HHMMSSmmm.md`

No original filename/path is written into artifacts. Samples are identified only by `photo_hash`.

## Privacy Defaults

Default mode is privacy-safe by design:

1. Sanitize photo in memory (no sanitized image file written to disk):
   - strip metadata/EXIF by re-encoding with `sharp`
   - resize max edge to `2048` (configurable)
   - compute `sha256(image_bytes)` as `photo_hash`
2. Reports/logs do not include:
   - local file path
   - EXIF tags
   - base64 blobs
   - `bbox_px` raw pixel coordinates
3. Token is read from env/CLI and never printed.

Disable sanitize only for controlled debugging:

- `--no-sanitize` or `SANITIZE=false`

## Photo Set Preparation

Recommended coverage for rigorous internal validation:

- Skin tone diversity (light/medium/deep)
- Lighting diversity (daylight/indoor/backlight)
- Device diversity (different phone models)
- Real-world confounders (makeup/filter/partial occlusion)
- Include some intentionally degraded photos (blur/underexposed) for fallback behavior checks

Compliance requirements:

- Use only authorized faces for internal testing
- Do not include unconsented personal photos
- Keep local photo directory out of git (already ignored by default):
  - `internal-test-photos/`
  - `internal_test_photos/`
  - `local-internal-photos/`

HEIC/HEIF:

- `.heic/.heif` is accepted if local `sharp` build can decode it
- If not supported, convert to JPEG first

## Run

### Make target

```bash
make internal-batch \
  PHOTOS_DIR="/absolute/path/to/internal-test-photos" \
  BASE="https://your-staging-or-prod-host" \
  TOKEN="$TOKEN" \
  MARKET=US \
  LANG=en \
  MODE=direct \
  CONCURRENCY=4 \
  LIMIT=100
```

Supported key params:

- `PHOTOS_DIR` local directory (recursive scan)
- `BASE` backend base URL
- `TOKEN` bearer/api key token
- `MARKET` `EU|US`
- `LANG` `en|zh`
- `MODE` `direct|confirm`
- `CONCURRENCY` default `4`
- `LIMIT` optional cap

Additional knobs:

- `TIMEOUT_MS` default `30000`
- `RETRY` default `2` (5xx/timeout)
- `SHUFFLE=true` random sample order
- `SANITIZE=false` disable sanitize
- `MAX_EDGE` default `2048`
- `FAIL_FAST_ON_CLAIM_VIOLATION=true` stop early on claims violation/template fallback

### Endpoint probing and fallback

- `MODE=direct` first calls multipart `/v1/analysis/skin`
  - if response indicates endpoint unsupported (`404/415/405/501`), script auto-fallbacks to confirm chain
- `MODE=confirm` first calls `/v1/photos/upload` + `/v1/photos/confirm` + JSON `/v1/analysis/skin`
  - if confirm/upload endpoint unsupported (`404/405/501`), script auto-fallbacks to direct

## Artifact Schema (Per Photo)

Each JSONL row includes at least:

- `run_id`, `photo_hash`, `market`, `lang`, `mode`
- `request_id`, `trace_id`
- `used_photos`, `analysis_source`, `quality_grade`
- photo modules summary:
  - `regions_count`, `regions_bbox_count`, `regions_polygon_count`, `regions_heatmap_count`
  - `modules_count`, `issues_top`, `actions_count`, `products_count`
  - `evidence_grade_distribution`, `citations_count_distribution`
- claims/template audit:
  - `claims_template_fallback_count`
  - `claims_violation_detected`
- failure fields:
  - `error_kind`: `HTTP_4XX|HTTP_5XX|TIMEOUT|SCHEMA_FAIL|NO_CARD|UNKNOWN`
  - `error_detail` (sanitized)

CSV is a flattened view of the same row-level summary for spreadsheet analysis.

## How To Read Markdown Report

1. **总览**
- success rate
- used_photos ratio
- photo_modules card ratio
- quality grade distribution

2. **photo_modules_v1 覆盖**
- average and distribution for regions/modules/actions/products
- evidence grade/citation count distributions

3. **claims/模板**
- violations must remain `0`
- fallback reason distribution helps identify template quality issues

4. **Product Rec**
- emitted vs suppressed
- top suppression reasons (when internal debug reason is available)

5. **Top 20 人工复核样本**
- listed by `photo_hash` only
- selected by degraded/fail, zero regions, NO_CARD, zero actions/products, or high fallback

6. **Gate Results**
- hard gate pass/fail and soft warnings

## Redline Thresholds (Gating)

### Hard gate (non-zero exit code if failed)

- any `claims_violation_detected=true`
- `photo_modules_v1` card ratio `< 0.8`
- `used_photos` ratio `< 0.8`

### Soft gate (warning only)

- `degraded|fail` ratio `> 0.3`
- `actions_count=0` ratio `> 0.2`
- `products_count=0` ratio `> 0.7` (only when product rec is enabled)

## Suggested Internal Rollout

- Start with `MARKET=EU/US`, `LANG=en`
- Then run small sampled `LANG=zh` batch for template translation checks
- Use `SHUFFLE=true` + `LIMIT` for quick daily smoke
- Use full set before release or major diagnosis/prompt/model changes
