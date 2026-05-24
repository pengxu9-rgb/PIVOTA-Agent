# Wave6 Markato Batch 5 Summary

Generated: 2026-05-24T05:10:24.147Z

## Key Counts

- Brands assigned: 8
- Manifest extractions completed: 7
- Manifest extractions blocked: 1
- Extracted products seen: 358
- Manifest rows emitted by extractor: 296
- Repo review-gate OK brands: 3
- Repo review-gate blocked brands: 5
- Repo review structurally accepted rows: 296
- Conservative DB-ready candidate rows: 0
- Conservative held rows: 296
- No-DB dry-run files: 3
- No-DB dry-run scanned rows: 0

## Brand Results

| Brand | Manifest | Review gate | Extracted | Manifest rows | Review accepted | DB-ready | Held | Dry-run | Main blockers |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| GinGingers | completed | blocked | 3 | 0 | 0 | 0 | 0 | 0 | zero_accepted_items_from_extractor |
| Rutines | completed | ok | 8 | 5 | 5 | 0 | 5 | 0 | accessory_or_non_core_beauty_merch (5); commerce_facts_gate:hold (5); commerce_problem:commerce_facts_currency_mismatch (5); commerce_problem:commerce_facts_market_switch_not_ok (5) |
| ADVANCED COSMETICA | completed | blocked | 0 | 0 | 0 | 0 | 0 | 0 | zero_accepted_items_from_extractor |
| Ilmma Beauty | completed | blocked | 0 | 0 | 0 | 0 | 0 | 0 | zero_accepted_items_from_extractor |
| Vegan Fox | blocked | blocked | 0 | 0 | 0 | 0 | 0 | 0 | manifest_extraction_timeout |
| Suntribe AB | completed | blocked | 62 | 37 | 37 | 0 | 37 | 0 | anti_abuse_signal:perimeterx (37); commerce_facts_gate:hold (37); commerce_problem:commerce_facts_currency_mismatch (37); commerce_problem:commerce_facts_market_switch_not_ok (37) |
| OUATE | completed | ok | 85 | 61 | 61 | 0 | 61 | 0 | commerce_facts_gate:hold (61); commerce_problem:market_currency_mismatch (61); non_us_seed_currency:EUR (61); bundle_wholesale_duplicate_or_non_single_sku (35) |
| born to bio | completed | ok | 200 | 193 | 193 | 0 | 193 | 0 | commerce_facts_gate:hold (193); commerce_problem:commerce_facts_currency_mismatch (193); commerce_problem:commerce_facts_market_switch_not_ok (193); commerce_problem:market_currency_mismatch (193) |

## Hold Reason Totals

- commerce_facts_gate:hold: 296
- commerce_problem:market_currency_mismatch: 296
- non_us_seed_currency:EUR: 296
- commerce_problem:commerce_facts_currency_mismatch: 235
- commerce_problem:commerce_facts_market_switch_not_ok: 235
- bundle_wholesale_duplicate_or_non_single_sku: 74
- regulated_or_therapeutic_claim_lane: 49
- anti_abuse_signal:perimeterx: 37
- review_blocker:anti_abuse_signal:perimeterx: 37
- accessory_or_non_core_beauty_merch: 33
- out_of_stock: 12
- wellness_supplement_claims_lane_review_required: 5

## Exact Next Steps

- Do not apply to DB from this batch as-is; conservative DB-ready candidate count is 0.
- For Rutines, Suntribe AB, OUATE, and born to bio, verify a US sellable storefront or US-localized PDPs with USD seed currency and commerce_facts_gate status ok before re-running curation.
- For Suntribe AB, resolve the PerimeterX extractor signal and split B2B box/POS/accessory rows from consumer single-SKU rows; sunscreen/SPF rows need the regulated claims lane.
- For OUATE and born to bio, remove out-of-stock, gift card, travel/refill/imparfait, coffret/bundle, and claims-lane rows before any future dry-run.
- For GinGingers, ADVANCED COSMETICA, Ilmma Beauty, and Vegan Fox, rerun extraction with direct PDPs, preferred titles, or catalog extractor fixes; Vegan Fox specifically timed out twice at 90 seconds.

## Artifact Root

/Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_5
