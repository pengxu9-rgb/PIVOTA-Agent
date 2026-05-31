# Wave100 Embryolisse Product Intel Closeout

Date: 2026-06-01

Scope: Embryolisse US product-intel recovery for `us.embryolisse.com` lane-3 KB rewrite rows.

## Selection

The current production backlog probe showed Embryolisse as a strong next brand lane:

- Domain: `us.embryolisse.com`
- Domain rollup before this wave: 65 rows, 44 DB serving ready, 19 lane-3 product-intel blockers.
- Selected final exact batch: 8 rows.
- Selection gate: identity ready, public commerce doc present, offer price present, no terminal hold, and validation-safe official-source product intel.

Final selected product IDs:

- `ext_76bfd11a0bea190f4c9d32c7` - Radiant Eye Stick - Cool Treatment For A Brighter Look
- `ext_1b4a85868ba125bc6b7040e0` - Filaderme Emulsion - Face Lotion For Dry Skin
- `ext_a47933ea068521800615641f` - Lait-Creme Fluid+ Eco-Refill
- `ext_4df267da6c48f581bf6ff5f4` - Cicalisse Hands and Nails
- `ext_1204da285323c4c294847daf` - Exfoliating Milk Powder
- `ext_e13d80b8bf9b8dfe44042064` - SOS Corrective Cream
- `ext_3a04dcee79f96ee9570e93f3` - 3-in-1 Secret Paste
- `ext_1f01309541611d783b7fd63c` - Cicalisse - Restorative & Protective skin Cream - Face, Body, Lip

## Human Review Gate

The initial 8-row attempt was not forced through. Validation rejected:

- `ext_06b861e43ccc33e9fb1f87db` - Hydra Cream Energizing: `public_generic_marketing_copy`
- `ext_0b12b5f5480fe781b166ded4` - Firming-Lifting Cream: `what_it_is_too_long`
- `ext_20a7c25532777f964d7f16b9` - Eau de Beaute Rosamelis - Face Toner For All Skin Types: `generic_copy_signal`

Two replacement attempts were also rejected and kept out of the write set:

- `ext_54e411ece40eb37df4ad86f5` - Lait-Creme Fluid+: `generic_copy_signal`
- `ext_af50b9fc91fabe08ab67a7b4` - Anti-Blemish Serum: `what_it_is_too_long`

These rows remain review/repair candidates and were not published.

## Pre-Write Readiness

Artifact directory:

- `readiness_before/`

Summary:

- Scanned rows: 8
- Terminal holds: 0
- Action-required rows: 8
- DB serving ready: 0/8
- Public index ready: 0/8
- Main blocker: `kb_blocked` 8
- Lane: `lane_3_kb_rewrite_review` 8
- Identity ready: 8/8
- Public commerce docs built by dry-run: 8
- Direct high-quality product intel: 0/8
- Direct seller-only/limited product intel: 8/8

## Product Intel Report

Report:

- `embryolisse_official_product_intel_report.json`

Builder flags:

- `--require-public-commerce-doc`
- `--include-not-reviewed-official-source`
- `--validate-replacements`
- `--batch-name wave100_embryolisse_official_product_intel_review_20260601`
- `--reviewer codex_human_quality_reviewer`

Report result:

- Rows: 8
- Public ready: 8
- High-quality ready: 8
- Evidence profile: `seller_plus_formula` 8

## Publish

Dry-run artifact:

- `embryolisse_product_intel_publish_dry_run.json`

Dry-run result:

- Status: `ok`
- Mode: `dry_run_validate_replacements`
- Rows: 8
- Entries: 8
- Skipped rows: 0

Apply artifact:

- `embryolisse_product_intel_publish_apply.json`

Apply result:

- Status: `ok`
- Mode: `write`
- Rows: 8
- Entries: 8
- Skipped rows: 0

## Post-Write Readiness

Artifact directory:

- `readiness_after_product_intel/`

Summary:

- Scanned rows: 8
- Terminal holds: 0
- Action-required rows: 0
- DB serving ready: 8/8
- Public index ready: 8/8
- Main blocker: `db_serving_ready` 8
- Lane: `ready_no_action` 8
- Direct displayable product intel: 8/8
- Direct high-quality product intel: 8/8
- Public commerce docs with insight summary: 8/8

## Deployment Note

No `railway up` was run. Production DB writes were limited to the reviewed product-intel KB publish command above. Git deployment remains git-push only.

## Next Actionable Move

Continue Embryolisse with the remaining lane-3 rows that pass validation, or move to The Inkey List/BYOMA for smaller clean batches. Keep the rejected Embryolisse rows in repair review; do not force them through the replacement validator.
