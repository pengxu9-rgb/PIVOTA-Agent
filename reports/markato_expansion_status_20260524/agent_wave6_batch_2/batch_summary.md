# Markato Wave6 Batch 2 Summary

Generated: 2026-05-24T05:06:33.348Z

## Totals

- Brands processed: 7
- Extracted products reported by extractor: 33
- Manifest rows before curation: 25
- Structural review: 4 pass, 3 block
- Conservative holds: 22
- DB-ready candidate rows after curation: 3
- No-DB dry-run: scanned 3, would_insert_unverified 3, invalid 0, database_available false
- Guardrails: no railway up, no git push, no DB apply/production writes

## Brand Counts

| Brand | Extracted | Manifest Rows | Review | DB-Ready Candidates | Holds | Review Blockers |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| Hello Mims | 6 | 6 | pass | 0 | 6 | - |
| KHUS KHUS modern herbal fusion | 0 | 0 | block | 0 | 0 | zero_accepted_items_from_extractor; anti_abuse_signal:perimeterx |
| DAEBY | 7 | 3 | pass | 0 | 3 | - |
| Akasha Superfoods | 10 | 8 | pass | 0 | 8 | - |
| Seresilk | 10 | 8 | pass | 3 | 5 | - |
| Akan Moringa | 0 | 0 | block | 0 | 0 | zero_accepted_items_from_extractor |
| Apiceuticals | 0 | 0 | block | 0 | 0 | zero_accepted_items_from_extractor |

## DB-Ready Candidate Rows

- Seresilk: Silk Night Cream (eps_44c1397b319a538f47b4ca1d) 79.97 USD - https://seresilk.com.au/products/silk-night-cream - dry-run would_insert_unverified
- Seresilk: Silk Night Serum (eps_68187b19d2f43540ff7e1b59) 94.51 USD - https://seresilk.com.au/products/silk-night-serum - dry-run would_insert_unverified
- Seresilk: Gentle Silk Cleanser (eps_5ae568728c95aa19d64a9413) 54.52 USD - https://seresilk.com.au/products/gentle-silk-cleanser - dry-run would_insert_unverified

## Holds And Blockers

- Hello Mims: holds: commerce_facts_gate_hold, commerce_facts_problem:market_currency_mismatch, non_us_currency:EUR, regulated_wellness_supplement_claims_lane, therapeutic_or_regulated_claims_text, availability:out_of_stock
- KHUS KHUS modern herbal fusion: review blockers: zero_accepted_items_from_extractor, anti_abuse_signal:perimeterx
- DAEBY: holds: commerce_facts_gate_hold, commerce_facts_problem:market_currency_mismatch, non_us_currency:EUR, therapeutic_or_regulated_claims_text
- Akasha Superfoods: holds: commerce_facts_gate_hold, commerce_facts_problem:market_currency_mismatch, non_us_currency:EUR, regulated_wellness_supplement_claims_lane, therapeutic_or_regulated_claims_text
- Seresilk: holds: wholesale_row, non_topical_accessory_or_tool
- Akan Moringa: review blockers: zero_accepted_items_from_extractor
- Apiceuticals: review blockers: zero_accepted_items_from_extractor

## Exact Next Steps

- Hello Mims: Hold all rows for the regulated wellness/supplement claims lane and EUR-vs-US commerce mismatch review. Exclude out-of-stock products unless a later extractor run confirms in-stock US availability.
- KHUS KHUS modern herbal fusion: Do not create seeds from this run; extractor returned zero rows behind PerimeterX bot challenge. Use a managed-browser/catalog extractor follow-up or approved PDP list, then rerun manifest and review gate.
- DAEBY: Hold all rows until the EUR seed-row currency is reconciled against US commerce facts. Route the SPF 50+ product through sunscreen/regulated-claims review before DB apply consideration.
- Akasha Superfoods: Hold all rows for wellness/supplement and therapeutic-claim review plus EUR-vs-US commerce mismatch review. Only rerun dry-run after claims lane and US offer/currency normalization clear specific PDPs.
- Seresilk: Keep only the three retail topical skincare rows as DB-ready candidates from this no-DB dry-run. Hold wholesale rows and the silk exfoliator accessory; before any apply, run DB duplicate/read check with approved production credentials.
- Akan Moringa: Do not create seeds from this run; extractor timed out after sitemap discovery with zero accepted rows. Retry extractor diagnostics with narrower known PDP URLs or managed-browser support before any seed lane.
- Apiceuticals: Do not create seeds from this run; extractor timed out after sitemap discovery with zero accepted rows. Retry extractor diagnostics with narrower known PDP URLs or managed-browser support before any seed lane.

## Primary Artifacts

- Curation decisions: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_2/curation_decisions.json
- Batch summary JSON: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_2/batch_summary.json
- Batch summary Markdown: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_2/batch_summary.md
- Seresilk no-DB dry-run: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_2/dry_runs/seresilk.json
