# Ingredient And SKU Seed Rebuild

## Goal

Use workbook seeds to rebuild the ingredient and SKU knowledge base in a controlled way without treating workbook rows as runtime truth.

This design separates:

- parser/reference seed data
- brand/SKU inventory seed data
- harvested and reviewed SKU ingredient evidence
- runtime recommendation evidence

## Seed Roles

### Ingredient Workbook

Source example:

- operator-provided ingredient reference workbook path

Intended role:

- parser/reference dictionary seed
- ingredient normalization seed
- benefit/risk/function taxonomy seed

Not intended role:

- final runtime SKU ingredient evidence
- direct replacement for `pci_kb.sku_ingredients`

Canonical landing table:

- `seed_ingest.ingredient_reference_seed`

Recommended key:

- `record_id`

Secondary uniqueness constraints:

- `normalized_key`
- `canonical_inci_name`

Core fields to preserve:

- `record_id`
- `canonical_inci_name`
- `us_label_name`
- `eu_label_name`
- `normalized_key`
- `aliases_common`
- `parser_variants`
- `primary_bucket`
- `all_buckets`
- `function_tags`
- `benefit_tags`
- `risk_flags`
- all boolean flags
- `regulatory_bucket`
- `source_urls`
- `notes`
- `kb_version`

### SKU Workbook

Source example:

- operator-provided brand/SKU seed workbook path

Intended role:

- brand roster seed
- SKU inventory seed
- extraction queue seed

Not intended role:

- final runtime product catalog
- final reviewed SKU ingredient KB

Canonical landing tables:

- `seed_ingest.brand_roster_seed`
- `seed_ingest.sku_seed_inventory_seed`
- `seed_ingest.extraction_queue_seed`

## Staging Tables

### `seed_ingest.ingredient_reference_seed`

Purpose:

- keep workbook-provided ingredient reference rows intact
- support parser/normalization logic

Suggested columns:

- `source_file`
- `source_sheet`
- `record_id`
- `canonical_inci_name`
- `us_label_name`
- `eu_label_name`
- `normalized_key`
- `aliases_common`
- `parser_variants`
- `primary_bucket`
- `all_buckets`
- `function_tags`
- `benefit_tags`
- `risk_flags`
- `is_humectant`
- `is_barrier_support`
- `is_retinoid`
- `is_exfoliant`
- `is_uv_filter`
- `is_preservative`
- `is_surfactant`
- `is_fragrance_or_eo`
- `regulatory_bucket`
- `source_urls`
- `notes`
- `kb_version`
- `ingested_at`

### `seed_ingest.brand_roster_seed`

Purpose:

- drive brand expansion planning
- anchor official brand sites

Suggested key:

- `(brand_name, official_url)`

Suggested columns:

- `source_file`
- `source_sheet`
- `brand_name`
- `brand_raw_examples`
- `official_url`
- `alternate_urls`
- `market_focus_guess`
- `site_status`
- `priority_tier`
- `seed_inventory_status`
- `notes`
- `ingested_at`

### `seed_ingest.sku_seed_inventory_seed`

Purpose:

- drive product-level extraction and harvest
- track whether a row contains full INCI or only hero ingredients

Suggested key:

- `official_product_url`

Suggested columns:

- `source_file`
- `source_sheet`
- `brand_name`
- `product_name`
- `official_product_url`
- `market`
- `sku_code`
- `size_options`
- `category`
- `ingredient_granularity`
- `ingredients_or_key_ingredients`
- `source_note`
- `extraction_status`
- `ingested_at`

Derived columns to add during import:

- `seed_key`
- `url_key`
- `needs_full_inci_harvest`
- `is_sample_seed`
- `is_variant_seed`

### `seed_ingest.extraction_queue_seed`

Purpose:

- operator-facing queue for catalog and ingredient expansion

Suggested key:

- `(brand_name, official_url, phase)`

Suggested columns:

- `source_file`
- `source_sheet`
- `brand_name`
- `official_url`
- `market_focus_guess`
- `priority_tier`
- `seed_inventory_status`
- `phase`
- `suggested_next_step`
- `notes`
- `ingested_at`

## Promotion Path

1. Import workbook rows into `seed_ingest.*` tables.
2. Validate column presence, unique keys, market values, and URL hygiene.
3. Use `sku_seed_inventory_seed` and `brand_roster_seed` to drive official PDP extraction.
4. Harvest full INCI where workbook rows only contain hero ingredients.
5. Review harvested ingredient rows before KB ingest.
6. Ingest reviewed rows into `pci_kb.sku_ingredients`.
7. Only then wire runtime ranking to SKU ingredient evidence.

## Runtime Contract

Runtime recommendation should not consume workbook rows directly.

Runtime ranking should use:

- reviewed SKU ingredient evidence
- parser-normalized ingredient names
- explicit `ingredient_kb_hit` / `ingredient_kb_miss` signals

For ingredient-directed queries such as `panthenol serum`:

- strong candidates should require real ingredient evidence where coverage exists
- textual-only matches should fall back to supportive or generic tiers

## Read-Only Audit Script

Use:

```bash
python3 scripts/audit_kb_seed_workbooks.py \
  --ingredient-xlsx /path/to/ingredient_reference.xlsx \
  --sku-xlsx /path/to/brand_sku_seed.xlsx
```

The script reports:

- required column coverage
- uniqueness and duplicate risk
- sparse fields
- seed/sample readiness
- recommended target staging tables

## Current Interpretation

- ingredient workbook: good seed for parser/reference rebuild
- SKU workbook: useful sample seed for brand/SKU staging and extraction planning
- neither workbook should be treated as a finished runtime KB
