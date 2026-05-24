# Wave7 Markato Batch 4 Summary

Generated: 2026-05-24T06:20:41.050Z

Read-only guardrails observed: no `railway up`, no git push, no DB apply/production writes, no seller-only fallback, and no force-filled ingredients. Dry-runs were executed with `DATABASE_URL` unset.

## Counts

- Brands: 5
- Extracted products: 158
- Manifest rows: 109
- Review passed brands: 3
- Review blocked brands: 2
- Curated candidates: 0
- Held rows: 109
- DB-ready candidate rows after no-DB dry-run: 0
- Dry-run invalid rows: 0

## Brand Rollup

| Brand | Manifest Rows | Review | Curated | DB-Ready | Held | Main Hold Reasons |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| GINZAI | 32 | blocked | 0 | 0 | 32 | anti_abuse_signal:perimeterx (32); commerce_facts_gate_hold (32); commerce:commerce_facts_currency_mismatch (32); commerce:commerce_facts_market_switch_not_ok (32); commerce:market_currency_mismatch (32) |
| orora | 25 | pass | 0 | 0 | 25 | commerce_facts_gate_hold (25); commerce:commerce_facts_currency_mismatch (25); commerce:commerce_facts_market_switch_not_ok (25); non_english_copy (25); price_over_250_usd (5) |
| NuBest | 51 | pass | 0 | 0 | 51 | wellness_supplement_or_regulated_claims (50); therapeutic_or_medical_claims (44); accessory_tool_or_non_beauty_product (4); bundle_set_sample_or_gift (4); out_of_stock (2) |
| YAY NOVELTY | 1 | pass | 0 | 0 | 1 | accessory_tool_or_non_beauty_product (1) |
| Anaya | 0 | blocked | 0 | 0 | 0 | - |

## DB-Ready Candidate Rows

None. All rows were held by the conservative curation gate.

## Blockers And Holds

- GINZAI: anti_abuse_signal:perimeterx (32), commerce_facts_gate_hold (32), commerce:commerce_facts_currency_mismatch (32), commerce:commerce_facts_market_switch_not_ok (32), commerce:market_currency_mismatch (32), non_english_copy (32), non_us_currency (32), review_gate_blocker (32). Next: Do not apply from this extraction. Clear the PerimeterX/anti-abuse source issue and find a verified US/USD English official PDP source before re-review.
- orora: commerce_facts_gate_hold (25), commerce:commerce_facts_currency_mismatch (25), commerce:commerce_facts_market_switch_not_ok (25), non_english_copy (25), price_over_250_usd (5), spf_sunscreen (2). Next: Find a verified English US/USD official market source, or route this brand to the correct non-US market lane before seed creation.
- NuBest: wellness_supplement_or_regulated_claims (50), therapeutic_or_medical_claims (44), accessory_tool_or_non_beauty_product (4), bundle_set_sample_or_gift (4), out_of_stock (2), repo_review_row_blocker (2). Next: Route to the regulated wellness/supplement claims lane; do not create Markato beauty seeds without explicit supplement approval and a passing commerce gate.
- YAY NOVELTY: accessory_tool_or_non_beauty_product (1). Next: Exclude from beauty expansion unless a true beauty PDP list is supplied; current row is a greeting-card novelty product.
- Anaya: zero_accepted_items_from_extractor. Next: Recover official sellable PDP URLs with transaction-ready commerce facts, then rebuild and review the manifest.

## Exact Next Steps

- Keep this batch read-only until an operator approves a separate DB apply lane.
- No row from this batch is DB-ready: every extracted row is held by commerce-facts gate hold and/or stricter curation rules.
- Before any apply, rebuild only verified official US/USD English PDP sources, rerun repo review, and rerun a DB-backed dry-run/postcheck.
- Do not continue GINZAI until the PerimeterX anti-abuse signal is cleared and a US/USD source is verified.
- Route NuBest to the regulated wellness/supplement claims lane; do not force-fill ingredients or seed claims-heavy supplement rows in this beauty lane.
- Exclude YAY NOVELTY from beauty expansion unless a true beauty/product-care PDP source is supplied.
- Recover Anaya official PDPs before any further seed creation work.

## Key Artifacts

- batch_summary_json: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_4/batch_summary.json
- batch_summary_md: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_4/batch_summary.md
- db_ready_candidate_manifest: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_4/db_ready_candidate_manifest.json
- curation_decisions_csv: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_4/curation_decisions.csv
- curation_summary_json: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_4/curation_summary.json
- dry_runs_dir: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_4/dry_runs
- manifests_dir: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_4/manifests
- reviews_dir: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_4/reviews
- curated_manifests_dir: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_4/curated_manifests
