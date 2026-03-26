# Ingredient Reference Controlled Vocabulary v1

## Goal

Define the controlled values used by the ingredient reference workbook so curation does not drift row by row.

Use this together with:

- [ingredient_reference_workbook_spec_v1.md](/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend/docs/runbooks/ingredient_reference_workbook_spec_v1.md)

## General Rules

- multi-value columns use semicolon-delimited values
- values should be trimmed and deduplicated
- prefer the smallest stable vocabulary that still captures recommendation and parser needs
- do not invent near-duplicate labels such as `barrier-repair` when `repair` already exists

## `primary_bucket`

Allowed values:

- `hydration`
- `repair`
- `anti-aging`
- `anti-acne`
- `exfoliant`
- `sunscreen`
- `preservative`
- `surfactant`
- `fragrance/essential oil`

Guidance:

- choose exactly one
- pick the dominant parser/recommendation role, not every possible role

Examples:

- `Ceramide NP` -> `repair`
- `Glycerin` -> `hydration`
- `Salicylic Acid` -> `anti-acne`
- `Limonene` -> `fragrance/essential oil`

## `ingredient_family`

Allowed values:

- `humectant`
- `emollient`
- `occlusive`
- `ceramide`
- `peptide`
- `retinoid`
- `acid_exfoliant`
- `uv_filter`
- `preservative`
- `surfactant`
- `fragrance`
- `plant_extract`
- `solvent`
- `vitamin`
- `other`

Guidance:

- use the narrowest stable family
- `other` is allowed but should be treated as a review bucket, not the default destination

Examples:

- `Ceramide NP` -> `ceramide`
- `Niacinamide` -> `vitamin`
- `Lactic Acid` -> `acid_exfoliant`
- `Phenoxyethanol` -> `preservative`
- `Aloe Barbadensis Leaf Extract` -> `plant_extract`

## `function_tags`

Allowed values:

- `humectant`
- `emollient`
- `occlusive`
- `solvent`
- `surfactant`
- `emulsifier`
- `preservative`
- `antioxidant`
- `buffering`
- `chelating`
- `film-forming`
- `fragrance`
- `colorant`
- `uv_filter`
- `soothing`
- `conditioning`

Guidance:

- this is formulation-function oriented
- do not use claim language here

Examples:

- `Glycerin` -> `humectant`
- `Dimethicone` -> `emollient; occlusive`
- `Disodium EDTA` -> `chelating`

## `benefit_tags`

Allowed values:

- `moisturizing`
- `barrier support`
- `barrier repair`
- `smoothing`
- `softening`
- `soothing`
- `brightening`
- `firming`
- `anti-wrinkle`
- `anti-acne`
- `exfoliating`
- `oil control`
- `formula protection`
- `vehicle`
- `sensory enhancement`
- `uv protection`

Guidance:

- this is user-facing or recommender-facing benefit language
- avoid overclaiming if the ingredient function does not support it

Examples:

- `Ceramide NP` -> `barrier support; barrier repair`
- `Glycerin` -> `moisturizing`
- `Titanium Dioxide` -> `uv protection`

## `risk_flags`

Allowed values:

- `fragrance allergen`
- `essential oil`
- `sensitization risk`
- `photosensitivity caution`
- `pregnancy caution`
- `irritation caution`
- `comedogenicity caution`
- `market-specific restriction`

Guidance:

- use only when a real cautionary framing is justified
- do not fill this column with generic fear language

Examples:

- `Limonene` -> `fragrance allergen`
- strong retinoids -> `pregnancy caution`
- AHAs/BHAs when appropriate -> `photosensitivity caution`

## `alias_quality`

Allowed values:

- `exact_label_alias`
- `common_alias`
- `marketing_alias`
- `legacy_alias`

Guidance:

- `exact_label_alias`: exact market label variant
- `common_alias`: commonly used consumer or shorthand synonym
- `marketing_alias`: widespread commercial naming, but not true nomenclature
- `legacy_alias`: historical or discouraged synonym

Examples:

- `Aloe Vera Extract` for `Aloe Barbadensis Leaf Extract` -> `common_alias`
- `Vitamin B3` for `Niacinamide` -> `common_alias`

## `review_status`

Allowed values:

- `draft`
- `reviewed`
- `approved`
- `deprecated`

Guidance:

- `draft`: structurally present, not yet curator-reviewed
- `reviewed`: curator checked, acceptable for seed ingest
- `approved`: strong confidence, suitable as trusted reference seed
- `deprecated`: no longer preferred for active use

## `confidence`

Allowed values:

- `high`
- `medium`
- `low`

Guidance:

- `high`: source coverage and naming confidence are strong
- `medium`: structurally acceptable, but still needs spot checking
- `low`: known ambiguity or incomplete evidence

## `source_types`

Allowed values:

- `official_nomenclature`
- `regulatory_database`
- `labeling_guidance`
- `ingredient_safety_review`
- `brand_label_example`

Guidance:

- use semicolon-delimited values
- prefer source types over free-text descriptions

## Work Packet Defaults

When reviewing the current workbook, prioritize in this order:

1. `aliases_common`
2. `notes_for_parser`
3. `ingredient_family=other`
4. `review_status`
5. `confidence`
