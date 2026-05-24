# Wave7 Markato Batch 3 Summary

Generated: 2026-05-24T06:15:59.386Z

## Guardrails

- No `railway up`, no git push, and no DB apply/production write commands were run.
- No seller-only fallback rows and no force-filled ingredients were accepted.
- Manifest extraction required escalated network access after sandbox DNS blocked catalog-intelligence.
- No-DB dry-run was executed with `DATABASE_URL` removed; output reports `database_available=false`.
- All files were written under /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3.

## Counts

- Brands processed: 4
- Extracted products: 95
- Manifest candidate rows: 66
- Generic review-gate pass brands: 2
- Generic review-gate blocked brands: 2
- Curated DB-ready candidate rows: 0
- Held rows after curation: 66
- No-DB dry-run scanned: 0
- No-DB dry-run would_insert_unverified: 0
- No-DB dry-run invalid: 0

## Brand Results

| Brand | Manifest Rows | Review Gate | DB-Ready | Held Rows | Main Hold Reasons |
| --- | ---: | ---: | ---: | ---: | --- |
| Bonjour La Vie | 16 | pass | 0 | 16 | commerce_facts_currency_mismatch (16); commerce_facts_gate_hold (16); commerce_facts_market_switch_not_ok (16); market_currency_mismatch (16); missing_multi_offer_merge_candidate (16); non_english_or_local_market_copy_for_us_review (16) |
| MANISANTE | 23 | hold | 0 | 23 | commerce_facts_currency_mismatch (23); commerce_facts_gate_hold (23); commerce_facts_market_switch_not_ok (23); market_currency_mismatch (23); missing_multi_offer_merge_candidate (23); non_english_or_local_market_copy_for_us_review (23) |
| Merindah Botanicals | 13 | hold | 0 | 13 | commerce_facts_currency_mismatch (13); commerce_facts_gate_hold (13); commerce_facts_market_switch_not_ok (13); market_currency_mismatch (13); missing_multi_offer_merge_candidate (13); review_gate_blocker:anti_abuse_signal:perimeterx (13) |
| NIMBUS CO | 14 | pass | 0 | 14 | commerce_facts_currency_mismatch (14); commerce_facts_gate_hold (14); commerce_facts_market_switch_not_ok (14); market_currency_mismatch (14); missing_multi_offer_merge_candidate (14); regulated_wellness_supplement_or_therapeutic_claims_lane (10) |

## DB-Ready Candidate Rows

None. All 66 manifest rows were held by the conservative US coverage gate.

## Accepted Manifests

- Bonjour La Vie: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/accepted_manifests/bonjour-la-vie.json
- MANISANTE: not emitted; review gate blocked
- Merindah Botanicals: not emitted; review gate blocked
- NIMBUS CO: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/accepted_manifests/nimbus-co.json

## Holds And Blockers

- Bonjour La Vie: 16 held rows: commerce_facts_currency_mismatch (16); commerce_facts_gate_hold (16); commerce_facts_market_switch_not_ok (16); market_currency_mismatch (16); missing_multi_offer_merge_candidate (16); non_english_or_local_market_copy_for_us_review (16); non_us_currency_or_market_mismatch (16); missing_description (12); bundle_set_sample_or_travel_size (3); out_of_stock_or_unavailable (3); placeholder_or_demo_product (1).
- MANISANTE: 23 held rows: commerce_facts_currency_mismatch (23); commerce_facts_gate_hold (23); commerce_facts_market_switch_not_ok (23); market_currency_mismatch (23); missing_multi_offer_merge_candidate (23); non_english_or_local_market_copy_for_us_review (23); non_us_currency_or_market_mismatch (23); review_gate_blocker:anti_abuse_signal:perimeterx (23); accessory_tool_home_or_non_beauty_row (7); regulated_wellness_supplement_or_therapeutic_claims_lane (1).
- Merindah Botanicals: 13 held rows: commerce_facts_currency_mismatch (13); commerce_facts_gate_hold (13); commerce_facts_market_switch_not_ok (13); market_currency_mismatch (13); missing_multi_offer_merge_candidate (13); review_gate_blocker:anti_abuse_signal:perimeterx (13); accessory_tool_home_or_non_beauty_row (4); regulated_wellness_supplement_or_therapeutic_claims_lane (2); bundle_set_sample_or_travel_size (1).
- NIMBUS CO: 14 held rows: commerce_facts_currency_mismatch (14); commerce_facts_gate_hold (14); commerce_facts_market_switch_not_ok (14); market_currency_mismatch (14); missing_multi_offer_merge_candidate (14); regulated_wellness_supplement_or_therapeutic_claims_lane (10); accessory_tool_home_or_non_beauty_row (9); price_exceeds_250_usd_threshold (5); bundle_set_sample_or_travel_size (1); out_of_stock_or_unavailable (1).

## Exact Next Steps

- Bonjour La Vie: Hold current output. Recover or verify a US/USD official source with English PDP descriptions and passing commerce facts before seed creation.
- Bonjour La Vie: Remove placeholder, Journey/travel-size, missing-description, and out-of-stock rows before another dry-run.
- MANISANTE: Hold current output. Resolve the PerimeterX anti-abuse signal and confirm an official US/USD source or route the brand to a non-US lane.
- MANISANTE: Exclude candles, room sprays, sanitizer/therapeutic rows, and non-English local-market copy before reconsidering any seed creation.
- Merindah Botanicals: Hold current output. Resolve the PerimeterX anti-abuse signal and verify a true US/USD commerce path; current commerce facts observe AUD and hold every row.
- Merindah Botanicals: Filter accessory/tool, bundle, and age-claim rows; only rerun candidate dry-runs after commerce facts pass.
- NIMBUS CO: Hold current output. Verify a US/USD sellable source with passing commerce facts; current commerce facts observe AUD and hold every row.
- NIMBUS CO: Filter wellness equipment, tools/accessories, supplements/electrolytes, high-price rows, and out-of-stock sachets; reconsider only single beauty rows such as face/body oil after gate pass.
- Batch: Do not apply this batch. Re-run only after the relevant source, market, anti-abuse, and row-level hold reasons are resolved; then run a DB-backed dry-run/postcheck before any operator-approved apply lane.

## Key Artifacts

- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/batch_summary.json
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/batch_summary.md
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/curation_summary.json
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/curation_decisions.json
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/curation_decisions.csv
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/curated_manifests/db_ready_candidate_manifest.json
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/dry_runs/db_ready_candidates_no_db.json
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/manifests
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/reviews
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/accepted_manifests
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_3/curated_manifests
