# Markato Wave5 Partner Opportunity Packet - 2026-05-24

## Scope

This packet translates the Wave5 production/audit closeout into partner-facing opportunity language for Markato US brand collaboration follow-up. It is based on existing audit artifacts only and does not imply production writes, public-index enablement, seller-only fallback, or deployment.

Source artifacts:

- `wave5_quality_closeout_20260524.md`
- `wave5_live_pdp_after_absolute_berry_structured_inci/live_pdp_modules_25_ext.json`
- `wave5_commerce_public_dry_run_summary.json`
- `wave5_catalog_extract_content_gap_dry_run/`
- `wave5_official_html_content_gap_dry_run/dry-run.json`

## Executive Readout

Wave5 now has a reliable commerce-doc demo surface across the three brands:

| Brand | Public docs dry-run | Strict live PDP ready | Thin rows | Hold rows | Partner ask |
| --- | ---: | ---: | ---: | ---: | --- |
| JouJou | 11/11 | 10/11 | 1 | 0 | Resolve Cactus Nectar INCI normalization from source-backed extract |
| Active Drip | 8/8 | 0/8 | 8 | 0 | Provide official full INCI for 8 formula SKUs |
| Coconut Matter | 6/7 | 1/6 live rows | 5 | 1 | Provide full INCI/how-to for 5 formula SKUs; resolve Hand Balm identity |
| Total | 25/26 source rows | 11/25 live rows | 14 | 1 | Source-backed ingredients/how-to and one identity confirmation |

This is usable for collaboration planning because the remaining strict-readiness gaps are explicit and bounded. There are no weak-insight rows, seller-only insight rows, force-filled ingredient rows, or live 404/index-state blockers in the final Wave5 audit.

## Brand Packets

### JouJou

Current position:

- 11 public docs built in dry-run.
- 10 strict live PDP ready.
- 1 thin row: `CACTUS NECTAR Hydrating Cream Mist`.

Ready strict PDP assets:

- `ABSOLUTE BERRY Bio Retinol Face Oil`
- `PLUM MELT Exosome Amino Cleanser`
- `ISLAND GIRL Summer Oil`
- `JUICY DREAM Lip Velvet Oil`
- `APHRODITE Body Oil`
- `FLORAL FILTER Face Mask`
- `MARSHMALLOW ROSE Balancing Moisturizer`
- `LA CREME MAGIQUE Rich Cream`
- `Velvet Skincare Headband`
- `CHARM Beauty Case`

Opportunity readout:

- JouJou is the strongest Wave5 demo candidate: broad ready SKU coverage, clean public-doc dry-run, no identity holds.
- Cactus Nectar appears recoverable from source-backed catalog extract: the dry-run captured an official `Ingredients` section and `How to Use`, while the current live row is blocked because the existing raw ingredient field is polluted by Shopify variant JSON.

Recommended next action:

- Run the Cactus Nectar reviewed source-backed INCI patch dry-run.
- If dry-run only touches the intended ingredients/how-to/detail fields, apply and resync in a separate narrow operation.

Partner ask:

- No broad data request needed if the Cactus Nectar patch validates. Otherwise ask JouJou to confirm the full INCI for Cactus Nectar.

### Active Drip

Current position:

- 8 public docs built in dry-run.
- 0 strict live PDP ready.
- 8 thin rows, all blocked by missing source-backed full INCI.

Thin rows:

- `HA + PEPTIDES EYE CARE`
- `R-Q10 EYE CARE`
- `CICA MILK DRIP`
- `C + E DRIP`
- `RETINOL DRIP`
- `KOJIC DRIP`
- `HYDRATE DRIP`
- `THE ICONIC MOISTURISER`

Opportunity readout:

- The public-doc surface is already complete for the 8 selected Active Drip SKUs.
- Live PDP strict readiness is blocked only by full INCI. How-to, overview/gallery, and insight coverage pass.
- Catalog extract sees key-ingredient and how-to content, but the ingredient content is not a full INCI list and should not be promoted as `ingredients_inci`.

Partner ask:

- Provide official full INCI for each of the 8 formula SKUs, ideally as PDP sections or a brand-supplied product data sheet.
- Keep active-ingredient marketing copy separate from full INCI.

### Coconut Matter

Current position:

- 6 public docs built in dry-run from 7 source rows.
- 1 strict live PDP ready row: `2-in-1 Konjac Body Sponge`.
- 5 thin formula rows.
- 1 identity hold: `NOURISHING HAND BALM`.

Thin rows:

- `TINTED COCONUT LIP BALM`
- `Goji Shake Shampoo Concentrate | For Treated Hair`
- `Matcha Shake Shampoo Concentrate | For All Hair Types`
- `Oaty Shake Body Wash Concentrate`
- `CLEAR LIP CARE`

Opportunity readout:

- Konjac sponge is now a positive control for correct accessory/tool handling: INCI is not applicable, and the product can be ready without formula modules.
- The remaining formula rows need source-backed full INCI and how-to.
- The Hand Balm issue is identity/canonicalization, not content quality, and should remain separate from ingredient patching.

Partner ask:

- Provide full INCI and usage directions for the 5 formula rows.
- Confirm the canonical official PDP for Nourishing Hand Balm, distinct from upsell/duplicate URLs.

## Collaboration Framing

Recommended partner message themes:

- Pivota can already build public commerce docs with insight summaries for the selected Wave5 products.
- Strict PDP readiness is intentionally gated on official-source product facts.
- The remaining asks are narrow: full INCI, how-to directions, and one canonical identity confirmation.
- Pivota did not use seller-only fallback or infer formula details where the official source was incomplete.

## Do Not Claim Yet

- Do not claim all Wave5 SKUs are strict public-index ready.
- Do not present Active Drip active-ingredient marketing text as full INCI.
- Do not present Coconut Matter benefit-only ingredient snippets as INCI.
- Do not list Hand Balm as resolved until identity review is complete.
- Do not publish newly inserted SKUs to a public index without KB/Pivota Insights review.
