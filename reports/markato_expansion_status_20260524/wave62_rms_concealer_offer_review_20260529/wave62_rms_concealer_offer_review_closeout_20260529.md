# Wave62 RMS Concealer Offer Review Closeout - 2026-05-29

## Scope

Reviewed the second Wave51 RMS retailer-offer candidate: Dermstore's Revitalize Hydra Concealer duplicate/identity-refresh row and the matching official RMS canonical parent.

This was a source-review and operator-mapping pass only. It did not write to production data, update runtime tables, promote serving rows, or run `railway up`.

## Reviewed Rows

| Role | Domain | External product id | Title | Prior status |
| --- | --- | --- | --- | --- |
| Retailer offer candidate | dermstore.com | `ext_b8af61a562f4ab972197f413` | RMS Beauty Revitalize Hydra Concealer 0.17fl oz (Various Shades) | identity_refresh / duplicate-offer candidate |
| Official canonical parent | rmsbeauty.com | `ext_1c6390a4583df99215617f2b` | Revitalize Hydra Concealer | hold_risk_review / accessory_or_tool |

## Evidence

- Catalog extractor on the Dermstore PDP returned one product with 26 variants, USD 36 pricing, source quality `high`, and no failure category or block provider.
- Dermstore and official RMS both expose the same normalized 26-shade set.
- Dermstore and official RMS both support the same sellable family: RMS Beauty Revitalize Hydra Concealer, 0.17 fl oz.
- Official RMS product JSON identifies the product type as `Concealer`, with all 26 variants available, USD 36 price, full ingredient text, usage guidance, and 119 product images.
- Dermstore extraction also includes full ingredient text and how-to text for the offer row.

## Review Decision

`ext_b8af61a562f4ab972197f413` should not be promoted as a standalone canonical PDP. It is a retailer offer for official RMS canonical row `ext_1c6390a4583df99215617f2b`.

`ext_1c6390a4583df99215617f2b` is source-backed, but it remains blocked by risk/taxonomy classification. The official source describes a normal concealer beauty formula, while the local rollup still classifies the row as `accessory_or_tool` under `hold_risk_review`. That must be reviewed before any identity merge or serving promotion.

## Outcome

| Metric | Count |
| --- | ---: |
| Rows reviewed | 2 |
| Catalog extractions reviewed | 1 |
| Official brand pages reviewed | 1 |
| Official Shopify JSON captures reviewed | 1 |
| Retailer pages reviewed | 1 |
| Retailer variants extracted | 26 |
| Official variants reviewed | 26 |
| Normalized shade-set match | 26 |
| Runtime DB writes | 0 |
| Serving promotions approved | 0 |

## Next Actions

1. Review official RMS row `ext_1c6390a4583df99215617f2b` for taxonomy correction from `accessory_or_tool` to `beauty_formula`.
2. If the parent clears risk/taxonomy review, attach Dermstore row `ext_b8af61a562f4ab972197f413` as retailer-offer data against the official RMS canonical row.
3. Rerun identity and serving readiness gates before any serving promotion.
