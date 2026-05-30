# Wave76 Linhart Source-Gap Probe Closeout

Generated: 2026-05-30

## Scope

- Brand/domain: Linhart Smile Care / `linhart.nyc`
- Market: US
- Rows probed:
  - `ext_aa24dcd6cf3888a68f222281` - Linamel Toothpaste
  - `ext_e795b1a17f6222e44dfb3dfd` - Tooth Whitener Gel

## Reviewer Decision

Do not apply source-field updates and do not promote these rows.

The official HTML dry-run found official how-to copy for both rows, plus details/description fields, but it did not find product-specific full INCI/ingredient lists. Because both rows remain identity-blocked and still lack full ingredient evidence, a partial how-to-only patch would not clear the source-gap lane or make these rows safe for serving.

## Evidence

### Readiness Before Source Probe

Artifact directory: `readiness_before_source_probe/`

- Scanned rows: 2
- Terminal holds: 0
- Action required rows: 2
- DB serving ready rows: 0
- Public index ready dry-run rows: 0
- Blocker breakdown: `identity_blocked=2`
- Lane breakdown: `lane_1_identity_index=2`
- Direct high-quality KB rows: 2
- Identity ready rows: 0

Both rows have reviewed, displayable, high-quality product intel, but neither has live-read identity enabled.

### Official HTML Dry Run

Artifact: `official_html_dry_run/dry-run.json`

- Scanned rows: 2
- Dry-run candidates: 2
- Updated rows: 0
- Skipped rows: 0
- Failed rows: 0
- Fields found:
  - `pdp_how_to_use_raw`: 2
  - `pdp_details_sections`: 1
  - `pdp_description_raw`: 1

Per-row extraction:

- `ext_aa24dcd6cf3888a68f222281`
  - HTTP status: 200
  - Final URL: `https://linhart.nyc/products/linamel-toothpaste`
  - Patch keys: `pdp_how_to_use_raw`, `pdp_details_sections`
  - Ingredient chars: 0
  - How-to chars: 346
  - Details sections: 2

- `ext_e795b1a17f6222e44dfb3dfd`
  - HTTP status: 200
  - Final URL: `https://linhart.nyc/products/tooth-whitener-gel`
  - Patch keys: `pdp_description_raw`, `pdp_how_to_use_raw`
  - Ingredient chars: 0
  - How-to chars: 354
  - Details sections: 2

### Manual Official HTML Sanity Check

Manual `curl`/`rg` checks of the official PDP HTML confirmed the same pattern:

- The product pages expose how-to/use and benefit copy.
- The toothpaste page mentions a small set of highlighted ingredients, not a full formula list.
- The tooth whitener page exposes peroxide/whitening use copy, but not a product-specific full ingredient list.
- The only generic ingredient navigation found points to a site-level ingredient education page, not a complete PDP ingredient panel.

This is not strong enough to use as full INCI evidence.

## Closeout

Wave76 is a no-write source probe. Linhart is not a safe expansion target right now.

Next viable Linhart move would be one of:

- Find a product-specific official ingredient list or label image source for these exact SKUs.
- Add an explicit non-INCI policy for oral-care rows, then review these rows under that policy.
- Resolve identity/live-read first, but only if the source-gap policy accepts the available official evidence.
