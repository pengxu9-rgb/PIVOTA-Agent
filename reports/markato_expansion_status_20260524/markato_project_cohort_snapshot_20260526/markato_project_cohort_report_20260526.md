# Markato Project Cohort PDP Coverage Snapshot

Generated: 2026-05-26T08:14:22.152Z

## Scope

- Source: production DB current state.
- Cohort: Wave5 Markato brand domains plus wave6-wave22 targeted `ext_*` SKUs found in local Markato apply/catalog/product-intel artifacts.
- This excludes the broader Pivota external-seed pool used in the previous snapshot.
- Catalog PDP coverage means a production `catalog_products` external-seed mirror exists.
- DB serving-ready means `index_pipeline_state.serving_eligible = true` at snapshot time.

## Summary

| Metric | Value |
| --- | --- |
| Markato project brands | 19 |
| Markato target products | 111 |
| Products in catalog PDP | 111 |
| Catalog PDP coverage | 100.0% |
| DB serving-ready products | 2 |
| DB serving-ready coverage | 1.8% |
| Identity-ready products | 110 |
| Reviewed product-intel products | 110 |
| High-quality product-intel products | 110 |
| High-quality intel coverage | 99.1% |
| Brands with 100% catalog coverage | 19 |
| Brands with 100% DB serving-ready | 0 |
| Brands with 0 DB serving-ready | 17 |

## Blockers

| Blocker | Products |
| --- | --- |
| low_quality | 96 |
| no_image | 12 |
| no_seed | 1 |

## Per-Brand Coverage

| Domain | Brand | Target SKUs | Catalog PDP | Catalog % | DB Ready | Ready % | Identity Ready | HQ Intel | HQ Intel % | Blockers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| joujoubotanicals.com | JouJou | 11 | 11 | 100.0% | 0 | 0.0% | 11 | 11 | 100.0% | low_quality:11 |
| 786cosmetics.com | 786 Cosmetics | 10 | 10 | 100.0% | 0 | 0.0% | 10 | 10 | 100.0% | low_quality:10 |
| nubest.com | NuBest | 10 | 10 | 100.0% | 0 | 0.0% | 10 | 10 | 100.0% | low_quality:10 |
| activedrip.com | Active Drip | 8 | 8 | 100.0% | 0 | 0.0% | 8 | 8 | 100.0% | low_quality:8 |
| khus-khus.com | KHUS KHUS | 8 | 8 | 100.0% | 0 | 0.0% | 8 | 8 | 100.0% | low_quality:8 |
| nalacare.com | Nala Care | 8 | 8 | 100.0% | 0 | 0.0% | 8 | 8 | 100.0% | low_quality:8 |
| coconutmatter.com | COCONUT MATTER | 7 | 7 | 100.0% | 0 | 0.0% | 6 | 6 | 85.7% | low_quality:6 \| no_seed:1 |
| delicatedaisys.com | Delicate Daisys Botanical Beauty | 7 | 7 | 100.0% | 1 | 14.3% | 7 | 7 | 100.0% | low_quality:6 |
| abyssianhaircare.com | Abyssian | 6 | 6 | 100.0% | 1 | 16.7% | 6 | 6 | 100.0% | low_quality:5 |
| lhamour.com | Lhamour | 6 | 6 | 100.0% | 0 | 0.0% | 6 | 6 | 100.0% | low_quality:6 |
| 7journeys.com | 7Journeys | 5 | 5 | 100.0% | 0 | 0.0% | 5 | 5 | 100.0% | low_quality:5 |
| apiceuticals.com | Apiceuticals | 5 | 5 | 100.0% | 0 | 0.0% | 5 | 5 | 100.0% | no_image:5 |
| lucamarskincare.com | Lucamar Skin Care | 5 | 5 | 100.0% | 0 | 0.0% | 5 | 5 | 100.0% | no_image:3 \| low_quality:2 |
| lovemasami.com | MASAMI | 4 | 4 | 100.0% | 0 | 0.0% | 4 | 4 | 100.0% | no_image:4 |
| seresilk.com.au | Seresilk | 4 | 4 | 100.0% | 0 | 0.0% | 4 | 4 | 100.0% | low_quality:4 |
| daebyskin.com | DAEBY | 2 | 2 | 100.0% | 0 | 0.0% | 2 | 2 | 100.0% | low_quality:2 |
| joocyee.com | Joocyee | 2 | 2 | 100.0% | 0 | 0.0% | 2 | 2 | 100.0% | low_quality:2 |
| rohrremedy.com | Rohr Remedy | 2 | 2 | 100.0% | 0 | 0.0% | 2 | 2 | 100.0% | low_quality:2 |
| aetasofficial.com | Aetās | 1 | 1 | 100.0% | 0 | 0.0% | 1 | 1 | 100.0% | low_quality:1 |

## Read

Catalog inclusion is complete for this Markato project cohort, and the content/identity side is almost complete. The current production serving-index state does not match the stronger wave closeout readiness claims for many SKUs; this should be treated as the next operational gap before more expansion.

