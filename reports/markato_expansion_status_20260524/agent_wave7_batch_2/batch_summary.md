# Markato Wave7 Batch 2 Summary

Generated: 2026-05-24T06:19:33.495Z

Read-only guardrails observed: no `railway up`, no git push, no DB apply/production writes, no seller-only fallback, and no force-filled ingredients. Dry-runs were executed with `DATABASE_URL` unset.

## Counts

- Brands processed: 4
- Extracted products reported by extractor: 18
- Manifest rows before curation: 1
- Structural review: 1 pass, 3 block
- Conservative holds: 1
- DB-ready candidate rows after curation: 0
- No-DB dry-run: scanned 0, would_insert_unverified 0, invalid 0, database_available false

## Brand Rollup

| Brand | Extracted | Manifest Rows | Review | Curated | DB-Ready | Held | Blockers / Holds |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
| ashbury BLOOM | 1 | 1 | pass | 0 | 0 | 1 | not_single_product_pdp:category_page; not_single_product_pdp:unrecognized_product_path; commerce_facts_gate_hold; commerce_facts_problem:missing_multi_offer_merge_candidate |
| ISODENT | 6 | 0 | block | 0 | 0 | 0 | zero_accepted_items_from_extractor |
| The Natural Deodorant Co. | 9 | 0 | block | 0 | 0 | 0 | zero_accepted_items_from_extractor; anti_abuse_signal:cloudflare |
| Usva Cosmetics | 2 | 0 | block | 0 | 0 | 0 | zero_accepted_items_from_extractor |

## DB-Ready Candidate Rows

- None from this batch.

## Holds And Blockers

- ashbury BLOOM: curation_hold: not_single_product_pdp:category_page, not_single_product_pdp:unrecognized_product_path, commerce_facts_gate_hold, commerce_facts_problem:missing_multi_offer_merge_candidate
- ISODENT: review_blocker: zero_accepted_items_from_extractor
- The Natural Deodorant Co.: review_blocker: zero_accepted_items_from_extractor, anti_abuse_signal:cloudflare
- Usva Cosmetics: review_blocker: zero_accepted_items_from_extractor

## Exact Next Steps

- ashbury BLOOM: Hold category/listing output; rerun with official product-detail URLs or an extractor fix that returns single sellable PDPs.
- ashbury BLOOM: Only reconsider rows after commerce facts gate passes for US sellability, shipping, availability, and offer merge evidence.
- ISODENT: Do not create seeds from this run; extractor reported 6 products but no transaction-ready PDP rows.
- The Natural Deodorant Co.: Do not create seeds from this run; recover a non-blocked official PDP source or rerun through approved managed-browser/catalog support.
- Usva Cosmetics: Do not create seeds from this run; extractor reported 2 products but no transaction-ready PDP rows.

## Primary Artifacts

- Batch summary JSON: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_2/batch_summary.json
- Batch summary Markdown: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_2/batch_summary.md
- Curation decisions JSON: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_2/curation_decisions.json
- Curation decisions CSV: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_2/curation_decisions.csv
- DB-ready candidate manifest: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_2/db_ready_candidate_manifest.json
- Manifests: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_2/manifests
- Reviews: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_2/reviews
- Accepted manifests: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_2/accepted_manifests
- Curated manifests: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_2/curated_manifests
- No-DB dry-runs: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_2/dry_runs
