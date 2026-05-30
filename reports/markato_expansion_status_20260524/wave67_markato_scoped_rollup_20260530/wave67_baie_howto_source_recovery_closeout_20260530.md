# Markato Wave67 Baie Botanique How-To Source Recovery - 2026-05-30

## Reviewer Decision

Wave67 used a Markato-scoped production rollup, excluding broad report-artifact discovery and external-ID spillover. The corrected scoped rollup now covers 613 active US rows across 32 Markato/prior-verified Markato domains.

- Runtime/database writes performed: yes, exact reviewed patch for 1 row
- Railway CLI deployment action performed: no
- `railway up` performed: no
- Code deploy required: no
- Target: `ext_60ded78effb04e9d6389bfce`
- Brand/domain: Baie Botanique / `baiebotanique.com`
- Product: Rose & Cupuacu Enzyme Cleanser
- Patched field: `pdp_how_to_use_raw`

## Source Review

Wave57 had correctly held this row because the stored official `/sns` PDP and media did not expose explicit cleanser directions. Wave67 re-reviewed the official Baie product source and found product-specific how-to directions on the official US PDP, with the UK official PDP as corroborating same-product source.

- Primary reviewed source: `https://usa.baiebotanique.com/products/rose-cupuacu-enzyme-cleanser-120ml`
- Corroborating source: `https://www.baiebotanique.com/products/rose-cupuacu-enzyme-cleanser`
- Decision: source-backed how-to patch allowed
- Generic official-HTML dry-run against the stored `/sns` URL: scanned 1, skipped 1, `how_to_chars=0`
- Reviewed patch dry-run: planned 1 field, `pdp_how_to_use_raw`, 0 -> 173 chars

## Production Apply

Exact apply result:

- `external_product_seeds`: 1
- `catalog_products`: 1
- `pdp_identity_listing`: 1

Immediate postcheck:

- seed how-to length: 173
- seed how-to quality: `high`
- catalog payload how-to length: 173
- identity payload how-to length: 173

## Validation

Exact KB/readiness audit after patch:

- scanned rows: 1
- DB serving ready: 1
- public-index-ready dry-run: 1
- action required rows: 0
- terminal holds: 0
- warnings: 0

Exact live PDP modules audit after patch:

- scanned: 1
- ready: 1
- thin: 0
- not conversion ready: 0
- weak insights IDs: 0
- seller-only insights IDs: 0
- force-filled IDs: 0
- content-gap IDs: 0

Strict PDP quality audit after patch:

- status: passed
- seed gate: passed
- extractor gate: passed
- identity gate: passed
- product intel gate: passed
- live PDP gate: passed
- similar gate: passed
- variant gate: passed
- live modules included `ingredients_inci`, `how_to_use`, `product_overview`, `product_facts`, `product_details`, `media_gallery`, `offers`, and `similar`

## Rollup Delta

Pre-patch Markato-scoped rollup:

- production rows: 613
- ready or covered: 159
- hold source gap: 85
- hold risk review: 369
- recommended next-batch rows: 0

Post-patch Markato-scoped rollup:

- production rows: 613
- ready or covered: 160
- hold source gap: 84
- hold risk review: 369
- recommended next-batch rows: 0
- Baie Botanique domain: `ready=2`, `source_gap=0`

## Remaining Lane

There are no clean identity, serving, or product-intel rows left in the scoped rollup. The next expansion work remains source-gap recovery only.

Highest-signal remaining holds:

- Miss Nella: 63 source-gap rows, mostly missing formal full INCI and how-to; two perfume rows remain under content-evidence hold.
- Moss & Noor: 8 source-gap rows; official INCI is present for several rows, but explicit how-to is still absent on reviewed official PDPs.
- UpCircle: 5 source-gap rows, mostly accessories/non-formula pages currently classified as formula gaps.
- OILUJ: 3 source-gap rows, full INCI still not source-backed.
- Baie Botanique: no remaining source-gap rows after this patch.

Operator guidance: do not promote additional rows without product-specific official INCI/how-to or an accepted partner source. The next real move should be another exact source review, not a broad serving/index sync.

## Artifacts

- `build_wave67_markato_scoped_rollup.cjs`
- `current_rollup/`
- `baie_official_html_dry_run/dry-run.json`
- `baie_reviewed_howto_patch_dry_run/dry-run.json`
- `baie_reviewed_howto_patch_apply/apply.json`
- `kb_readiness_after_baie_howto/`
- `baie_live_pdp_modules_after_howto.json`
- `baie_pdp_quality_after_howto.json`
- `current_rollup_after_baie_howto/`
