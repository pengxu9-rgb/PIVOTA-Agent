# Wave106 The Ordinary Product Intel Closeout

Date: 2026-06-01

Scope: The Ordinary product-intel recovery for public-doc-backed rows with missing card-highlight/displayability blockers.

## Quality Gate

- Filtered validation probe passed 8/8 rows.
- Exact pre-audit confirmed 8/8 action-required rows, no terminal holds, 8/8 identity-ready, and 8/8 public commerce docs.
- Report validation passed with 8 public-ready and 8 high-quality-ready rows.
- Publish dry-run matched the exact 8 entries with 0 skipped rows.

## Final Write Set

- `ext_3ddd25b09118f4eb30df093a` - The Multi-Peptide Collection
- `ext_40d86163d7cbfc82039b5a24` - The Mini Icons Set
- `ext_83513127a7a7cac50726b5cd` - Soothing & Barrier Support Serum Set
- `ext_86c02b71c4f8576cafdea079` - The Face & Body Set
- `ext_906f8e7c7685d563a502787b` - The Age Support Set
- `ext_a7d1193f64e8e78bf1ef9741` - The Mini Discovery Set
- `ext_b23ef7c54e22270375fd7b4e` - The Bright Set
- `ext_fd447e3ddace65210a62d6e1` - The Daily Set

## Before

- Scanned rows: 8
- Action-required rows: 8
- DB serving ready: 0/8
- Public index ready: 0/8
- Main blocker: `kb_blocked` 8

## After

- Scanned rows: 8
- Action-required rows: 0
- DB serving ready: 8/8
- Public index ready: 8/8
- Direct high-quality product intel: 8/8

## Deployment Note

No `railway up` was run. Production DB writes were limited to the reviewed product-intel KB publish command. Git deployment remains git-push only.
