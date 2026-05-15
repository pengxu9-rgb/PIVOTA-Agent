# Shade Visual Quality Audit - 2026-05-16

This is a read-only production audit. The clean worktree did not have
`DATABASE_URL`, so discovery fell back to production search queries rather than
full DB enumeration.

## Scope

- Discovery mode: `search`
- Candidate PDPs checked: 160
- Shade PDPs found: 86
- Shade options audited: 1,390
- PDP probe errors: 0

## Result

- `blocked_product_image_source`: 1,215 shade options
- `text_fallback_missing_swatch`: 132 shade options
- `real_swatch_or_hex`: 43 shade options

No audited PDP should use the blocked product images as live shade swatches
after the stricter frontend guard is deployed. Rows marked
`blocked_product_image_source` still need source-backed `swatch_image_url` or
`shade_hex` backfill before they can show real color.

## Priority

- P0: product image source was present and must stay blocked from swatch UI.
- P1: no product-image misuse, but no source-backed swatch/hex is available.
- pass: source-backed swatch or hex is available.

## Files

- `summary.json`: aggregate counts and discovery caveats.
- `shade_visual_quality_audit.csv`: row-level shade visual classification.
- `shade_visual_product_rollup.csv`: PDP-level rollup and priority.
- `blocked_product_image_sources.csv`: P0 backfill queue.
- `missing_swatch_backfill_candidates.csv`: P1 backfill queue.
- `pdp_errors.csv`: PDP probe failures.
