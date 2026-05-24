# Wave6 Markato Batch 3 Summary

Generated: 2026-05-24T05:10:56.414Z

## Guardrails

- No `railway up`, no git push, and no DB apply/production write commands were run.
- Manifest extraction required escalated network access after sandbox DNS blocked the catalog service.
- Dry-run was executed with `DATABASE_URL` removed; output reports `database_available=false`.

## Counts

- Brands processed: 7
- Manifest candidate rows: 48
- Generic review-gate pass brands: 3
- Generic review-gate blocked brands: 4
- Curated DB-ready candidate rows: 12
- Held rows after curation: 36
- No-DB dry-run scanned: 12
- No-DB dry-run would_insert_unverified: 12
- No-DB dry-run invalid: 0

## Brand Results

| Brand | Review Gate | Manifest Rows | DB-Ready | Held Rows | Dry Run | Main Blockers |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Australia's Manuka | hold | 0 | 0 | 0 | - | zero_accepted_items_from_extractor; anti_abuse_signal:cloudflare; no_extracted_rows_available_for_curation |
| Chatelier | hold | 10 | 0 | 10 | - | anti_abuse_signal:perimeterx; non_us_currency_or_market_mismatch; commerce_facts_gate_hold; market_currency_mismatch; review_gate_blocker:anti_abuse_signal:perimeterx |
| LIME | hold | 0 | 0 | 0 | - | zero_accepted_items_from_extractor; no_extracted_rows_available_for_curation |
| Lazy Society | hold | 0 | 0 | 0 | - | zero_accepted_items_from_extractor; no_extracted_rows_available_for_curation |
| Apih | pass | 10 | 0 | 10 | - | regulated_wellness_supplement_or_therapeutic_claims_lane; accessory_or_container_row; non_english_or_health_claim_copy_for_us_review; out_of_stock_or_unavailable |
| AFRAKARI | pass | 15 | 12 | 3 | 12/12 | therapeutic_or_correction_claim; regulated_cbd_claim_lane; possible_sunscreen_regulatory_claim |
| Fusspot Collagen Beauty Tea | pass | 13 | 0 | 13 | - | regulated_wellness_supplement_or_therapeutic_claims_lane; therapeutic_or_body_function_claims; out_of_stock_or_unavailable; accessory_or_container_row |

## DB-Ready Candidate Rows

| Brand | Title | Seed ID | External Product ID | Price | Availability | URL |
| --- | --- | --- | --- | ---: | --- | --- |
| AFRAKARI | Radiance Elixir | eps_2767ebd9da66c08f2bb81080 | ext_63426418919f510613d11dfc | 1500 USD | in_stock | https://afrakari.com/products/radiance-elixir |
| AFRAKARI | Prickly Pear Elixir | eps_10f419ffd1e558d0fe8c1790 | ext_212d963582191d90a381b919 | 1000 USD | in_stock | https://afrakari.com/products/prickly-pear-elixir |
| AFRAKARI | Recovery Cream | eps_fa2ac13757b056ce5e682c29 | ext_21c18dd88afe33fb11d9fbc6 | 2950 USD | in_stock | https://afrakari.com/products/recovery-cream |
| AFRAKARI | Recovery Serum | eps_95518d4281bf9d450327fe8b | ext_92fd955718af4577fe7a921f | 2950 USD | in_stock | https://afrakari.com/products/recovery-serum |
| AFRAKARI | Gentle Cleansing Milk | eps_f89eb02ceed27a8f692279fb | ext_f52a396425de7fce597534b1 | 900 USD | in_stock | https://afrakari.com/products/gentle-cleansing-milk |
| AFRAKARI | Kalahari Melon Seed Oil | eps_f13752e8e836b8debd48845f | ext_4d2036846dfde9236a2e5db9 | 900 USD | in_stock | https://afrakari.com/products/kalahari-melon-seed-oil |
| AFRAKARI | Marula Hydrating Elixir | eps_186e29e1e6fd806125dece26 | ext_18f015be942fdeb3df68ad45 | 1400 USD | in_stock | https://afrakari.com/products/marula-hydrating-elixir |
| AFRAKARI | Pure Marula Oil + Cape Chamomile | eps_347e8e61d70b03be347f97f1 | ext_d9acdecc612f64df18b8dda8 | 1000 USD | in_stock | https://afrakari.com/products/pure-marula-oil-cape-chamomile |
| AFRAKARI | Pure Marula Oil | eps_7f8a4c07e9c5b32c408cb824 | ext_d72da473fbf1b8456b2e9ab8 | 900 USD | in_stock | https://afrakari.com/products/pure-marula-oil |
| AFRAKARI | Resurface + Restore Night Cream | eps_84b4b04897b97446519566d1 | ext_40353e5d40b9c6d3866bfb35 | 2150 USD | in_stock | https://afrakari.com/products/resurface-restore-night-cream |
| AFRAKARI | Renewal Facial Oil | eps_71b0cab4af5aae7e1fa52ecf | ext_3d1d0b42b8eca59a501ff39e | 1650 USD | in_stock | https://afrakari.com/products/renewal-facial-oil |
| AFRAKARI | Cape Kelp Hydrating Cleanser | eps_5e3c158d7dd82beaf3ca9cc4 | ext_81b379a35a0ad778e3650f0e | 975 USD | in_stock | https://afrakari.com/products/cape-kelp-hydrating-cleanser |

## Holds And Blockers

- Australia's Manuka: 0 held rows.
- Chatelier: 10 held rows: non_us_currency_or_market_mismatch (10), commerce_facts_gate_hold (10), market_currency_mismatch (10), review_gate_blocker:anti_abuse_signal:perimeterx (10), description_pollution_page_script (7), bundle_accessory_or_set_like_row (3), out_of_stock_or_unavailable (1).
- LIME: 0 held rows.
- Lazy Society: 0 held rows.
- Apih: 10 held rows: regulated_wellness_supplement_or_therapeutic_claims_lane (10), non_english_or_health_claim_copy_for_us_review (8), accessory_or_container_row (1), out_of_stock_or_unavailable (1).
- AFRAKARI: 3 held rows: therapeutic_or_correction_claim (1), regulated_cbd_claim_lane (1), possible_sunscreen_regulatory_claim (1).
- Fusspot Collagen Beauty Tea: 13 held rows: regulated_wellness_supplement_or_therapeutic_claims_lane (12), therapeutic_or_body_function_claims (12), out_of_stock_or_unavailable (4), accessory_or_container_row (1).

## Exact Next Steps

- Australia's Manuka: Hold. Re-run manifest extraction only after Cloudflare/bot-challenge source access is resolved or an official product feed/fallback source is available. Do not create seeds until extractor returns product rows and review gate passes.
- Chatelier: Hold. Resolve PerimeterX/anti-abuse diagnostic, confirm a US-market/USD source, and filter remaining ritual/bundle/accessory rows. Rebuild after product descriptions are not polluted by Shogun/script blobs; current rows have EUR seed currency and commerce gate market_currency_mismatch.
- LIME: Hold. Re-run manifest extraction only after bot-challenge access is resolved or a clean official catalog endpoint/fallback source is available. Do not seed until nonzero product rows pass review.
- Lazy Society: Hold. Re-run with a reliable official source or extractor timeout remediation; current extraction timed out with zero rows. Do not seed until nonzero product rows pass review.
- Apih: Hold for regulated wellness/supplement claims lane. Remove accessory/container rows and out-of-stock rows before any seed work. Require US/English copy and claims review before reconsidering any DB-ready candidates.
- AFRAKARI: AFRAKARI curated manifest is dry-run ready: 12 rows passed no-DB validation as would_insert_unverified. Before any apply, run a production DB-aware dry-run/read check for existing rows, manually approve high-price/market-switch-unknown commerce facts, and keep CBD/scar/broad-spectrum protection rows held.
- Fusspot Collagen Beauty Tea: Hold for regulated wellness/supplement and therapeutic/body-function claims lane. Remove out-of-stock and accessory rows, then require claims review before any seed creation.

## Files

- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/manifests/australias-manuka.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/australias-manuka.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/australias-manuka.csv
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/curated_manifests/australias-manuka.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/manifests/chatelier.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/chatelier.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/chatelier.csv
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/curated_manifests/chatelier.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/manifests/lime.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/lime.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/lime.csv
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/curated_manifests/lime.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/manifests/lazy-society.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/lazy-society.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/lazy-society.csv
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/curated_manifests/lazy-society.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/manifests/apih.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/apih.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/apih.csv
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/accepted_manifests/apih.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/curated_manifests/apih.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/manifests/afrakari.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/afrakari.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/afrakari.csv
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/accepted_manifests/afrakari.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/curated_manifests/afrakari.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/dry_runs/afrakari.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/manifests/fusspot-collagen-beauty-tea.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/fusspot-collagen-beauty-tea.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/reviews/fusspot-collagen-beauty-tea.csv
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/accepted_manifests/fusspot-collagen-beauty-tea.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/curated_manifests/fusspot-collagen-beauty-tea.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/curation_decisions.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/batch_summary.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_3/batch_summary.md
