# Internal Role/SKU Pins (CSV → JSON)

This repo supports **hybrid offers** in Layer 3:

- Internal offers come from Pivota infra (catalog/checkout routing).
- Ops/BD can optionally **pin** internal SKUs for specific roles or categories (pins first, then algorithmic fill).

Pins are maintained as a CSV and compiled into deterministic JSON per market.

## Files

- Source of truth (Ops-maintained, optional in repo):
  - `src/layer3/data/internal_role_sku_map.csv`
- Template (always present):
  - `src/layer3/data/internal_role_sku_map.template.csv`
- Roles dictionary (validation):
  - `src/layer2/dicts/roles_v1.json`
- Generated outputs (commit these):
  - `src/layer3/data/internalPins_us.json`
  - `src/layer3/data/internalPins_jp.json`

## CSV schema

Columns (required unless noted):

- `market` (US|JP)
- `scope` (role|category)
- `scope_id`
  - For `scope=category`: one of `prep,base,contour,brow,eye,blush,lip`
  - For `scope=role`: a role id like `ROLE:hydrating_primer` (must exist in `src/layer2/dicts/roles_v1.json` after stripping `ROLE:`)
- `sku_id` (required)
- `merchant_id` (optional)
- `priority` (integer 0..100; higher = earlier)
- `pin_reason` (optional: partner|promo|high_cvr|supply_guarantee|manual_test)
- `tags` (optional; comma-separated)
- `notes` (optional)
- `start_date` (optional; YYYY-MM-DD)
- `end_date` (optional; YYYY-MM-DD)

## Commands

- Build pins (deterministic ordering):
  - `npm run internal:build-pins`
  - Reads `internal_role_sku_map.csv` if present; otherwise builds empty pins from the template.
- Lint (CI-friendly; no network; does not call infra):
  - `npm run internal:lint`
  - Passes with a warning if `internal_role_sku_map.csv` is missing.
- Coverage report (local files only):
  - `npm run internal:report:us`
  - `npm run internal:report:jp`

## Operational workflow

1) Update `src/layer3/data/internal_role_sku_map.csv`.
2) Run `npm run internal:lint` and fix any errors.
3) Run `npm run internal:build-pins`.
4) (Optional) Run `npm run internal:report:us|jp` to generate a report under `artifacts/reports/`.
5) Commit:
   - `src/layer3/data/internalPins_us.json`
   - `src/layer3/data/internalPins_jp.json`
   - and the updated CSV as needed.

## Notes

- Deduplication is per `(market, scope, scope_id)`:
  - within a group, `sku_id` is unique; highest priority wins.
- Active window:
  - if `start_date`/`end_date` are present, runtime will only apply pins inside that window (inclusive).
