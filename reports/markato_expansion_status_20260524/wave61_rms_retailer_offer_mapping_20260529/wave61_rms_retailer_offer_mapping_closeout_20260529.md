# Wave61 RMS Retailer Offer Mapping Closeout - 2026-05-29

## Scope

Reviewed the RMS Beauty Radiance Lock Setting Mist source-gap row from the Wave51 source-acquisition packet and the matching official RMS canonical row from the current rollups.

This was a source-review and operator-mapping pass only. It did not write to production data, update runtime tables, promote serving rows, or run `railway up`.

## Reviewed Rows

| Role | Domain | External product id | Title | Prior status |
| --- | --- | --- | --- | --- |
| Retailer offer candidate | dermstore.com | `ext_1cc14ab28dee629b0bb1d3db` | RMS Beauty Radiance Lock Setting Mist 100ml | P1 retailer-offer attachment candidate / hold_source_gap |
| Official canonical candidate | rmsbeauty.com | `ext_f16d1ed12f9f2c9966d47d78` | Radiance Lock Setting Mist | hold_risk_review / bundle_or_sample |

## Evidence

- Official RMS product page and Shopify product JSON resolve cleanly for `https://www.rmsbeauty.com/products/radiance-lock-setting-mist`.
- Official JSON identifies the product as `Radiance Lock Setting Mist`, vendor `RMS Beauty`, type `Hydrating Mist`.
- Official variants include `Full Size - 100ml` with SKU `SSP1` and `Travel-size - 30ml` with SKU `SSP1Travel`; both were available in the captured JSON.
- Official RMS page includes a full ingredient section and usage instructions.
- Dermstore current page exposes a matching ProductGroup for `RMS Beauty Radiance Lock Setting Mist 100ml`, productGroupID `15820047`, variant SKU `15820045`, offer URL, and a full ingredient section.

## Review Decision

`ext_1cc14ab28dee629b0bb1d3db` should not be promoted as a standalone canonical beauty formula. It is a retailer offer for the official RMS canonical product, matching on brand, product line, and the 100ml full-size variant. The right next move is retailer-offer attachment or merge logic, not serving promotion.

`ext_f16d1ed12f9f2c9966d47d78` is source-backed but remains blocked by risk/taxonomy classification. The official page describes a normal hydrating setting mist with full-size and travel-size variants, while the local rollup still classifies the row as `bundle_or_sample` under `hold_risk_review`. That mismatch needs review before any identity or serving sync.

## Outcome

| Metric | Count |
| --- | ---: |
| Rows reviewed | 2 |
| Official brand pages reviewed | 1 |
| Official Shopify JSON captures reviewed | 1 |
| Retailer pages reviewed | 1 |
| Canonical match found | 1 |
| Official full INCI found | 1 |
| Retailer full INCI found | 1 |
| Official how-to found | 1 |
| Runtime DB writes | 0 |
| Serving promotions approved | 0 |

## Next Actions

1. Attach the Dermstore offer row to official RMS canonical product `ext_f16d1ed12f9f2c9966d47d78` once retailer-offer modeling is available.
2. Review whether official RMS row `ext_f16d1ed12f9f2c9966d47d78` should be reclassified from `bundle_or_sample` to a normal beauty formula.
3. Only after taxonomy/risk review clears, rerun identity and serving gates before promotion.
