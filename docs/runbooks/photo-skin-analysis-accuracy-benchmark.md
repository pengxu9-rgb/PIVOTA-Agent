# Photo Skin Analysis Accuracy Benchmark

This benchmark measures whether `/v1/analysis/skin` actually used the image and produced conservative, label-aligned observations. It is not a diagnosis benchmark.

## Dataset

Seed pack:

```bash
datasets/photo_skin_analysis_accuracy_seed.json
```

Each case defines:

- `case_id`
- `language`
- `source_kind`: `image_url`, `photo_id`, or `response_only`
- `request`: request body fields for `/v1/analysis/skin`
- `labels`: required findings, expected photo quality, medical boundary requirements, and product/SKU hallucination policy

The initial seed uses image URL env placeholders such as `PHOTO_BENCH_REDNESS_CHEEKS_URL`. Populate those with curated, consent-safe benchmark assets before running live.

## Offline Scoring

Use this mode after collecting raw production or staging responses. Put each response at either:

- `<responses-dir>/<case_id>.json`
- `<responses-dir>/<case_id>/analysis.json`

Then run:

```bash
node scripts/eval_photo_skin_analysis_accuracy.cjs \
  --dataset datasets/photo_skin_analysis_accuracy_seed.json \
  --responses-dir /path/to/responses \
  --out-dir reports/photo-skin-accuracy/manual_review_YYYYMMDD
```

Artifacts:

- `summary.json`
- `report.md`
- `raw/<case_id>.json`

## Live Run

Run only when the image URL env vars are populated. Inject API keys through env only; do not write keys into commands, reports, or fixtures.

For internal local photos, use a manifest:

```bash
datasets/photo_skin_analysis_assets.local.example.json
```

The manifest supports per-case `image_url`, `image_url_env`, `photo_id`, `photo_id_env`, or `file_path`. When `file_path` is used with `--run-live`, the runner uploads the local file through `/v1/photos/upload`, then sends the returned `photo_id` into `/v1/analysis/skin`.

```bash
BASE_URL=https://pivota-agent-production.up.railway.app \
AGENT_API_KEY="$AGENT_API_KEY" \
PHOTO_BENCH_REDNESS_CHEEKS_URL="https://..." \
PHOTO_BENCH_ACNE_OILY_URL="https://..." \
PHOTO_BENCH_DRY_FLAKING_URL="https://..." \
PHOTO_BENCH_OILY_SHINE_URL="https://..." \
PHOTO_BENCH_HYPERPIGMENTATION_URL="https://..." \
PHOTO_BENCH_BLURRY_URL="https://..." \
PHOTO_BENCH_ROSACEA_LIKE_URL="https://..." \
PHOTO_BENCH_PRODUCT_BOTTLE_URL="https://..." \
node scripts/eval_photo_skin_analysis_accuracy.cjs \
  --run-live \
  --dataset datasets/photo_skin_analysis_accuracy_seed.json \
  --photo-manifest datasets/photo_skin_analysis_assets.local.example.json \
  --out-dir reports/photo-skin-accuracy/prod_YYYYMMDD \
  --fail-on-threshold
```

## Gate Semantics

Default gate:

- Case pass rate >= 80%
- Required visual finding hit rate >= 80%
- Medical boundary pass rate = 100%
- Language match rate = 100%
- Product/SKU hallucination count = 0
- Schema violation count = 0

`success` requires `used_photos=true` for success-labeled cases. Low quality or unsupported product-bottle images must be failed/degraded with explicit retake or unsupported messaging.

## Review Notes

Manual reviewers should check:

- Whether required visual labels are genuinely visible in the image.
- Whether the model overcalled medical conditions.
- Whether low-quality photos got a retake/quality caveat instead of confident findings.
- Whether Chinese input produced Chinese output and English input produced English output.
- Whether product bottle images avoided OCR/SKU guessing.
