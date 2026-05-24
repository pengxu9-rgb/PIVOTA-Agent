# Wave7 Markato Batch 1 Summary

Output dir: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_1

## Counts

- Brands reviewed: 5
- Manifest rows reviewed: 5
- Generic review accepted rows: 5
- Conservative DB-ready candidate rows: 0
- Conservative holds: 5
- Review/extractor blocker brands: 4
- No-DB dry-run scanned: 0
- No-DB dry-run would_insert: 0
- No-DB dry-run would_insert_unverified: 0
- No-DB dry-run invalid: 0
- Dry-run database_available: false

## Source Note

Initial sandboxed catalog-intelligence DNS lookup failed for OIlÙJ; the required manifest extraction was rerun with approved network access. No cached manifests, DB apply, Railway deploy, git push, seller-only fallback, or force-filled ingredient data were used.

## Brand Outcomes

| Brand | Manifest rows | Review accepted | DB-ready | Holds | Outcome |
|---|---:|---:|---:|---:|---|
| OIlÙJ | 5 | 5 | 0 | 5 | held: commerce_facts_gate_not_pass; commerce_facts_missing_multi_offer_merge_candidate; source_requires_multi_offer_merge_validation |
| Scented Life | 0 | 0 | 0 | 0 | blocked: zero_accepted_items_from_extractor; extractor_failure_dead_sitemap |
| Serich | 0 | 0 | 0 | 0 | blocked: zero_accepted_items_from_extractor; extractor_failure_dead_sitemap |
| Cosmydor | 0 | 0 | 0 | 0 | blocked: zero_accepted_items_from_extractor; extractor_failure_bot_challenge |
| YOUTH LAB. | 0 | 0 | 0 | 0 | blocked: zero_accepted_items_from_extractor; zero_rows_after_incomplete_transaction_filter |

## DB-Ready Candidates

None. The consolidated DB-ready candidate manifest has zero rows.

## Holds By Reason

- commerce_facts_gate_not_pass: 5
- commerce_facts_missing_multi_offer_merge_candidate: 5
- source_requires_multi_offer_merge_validation: 5

## Blockers

- Scented Life: zero accepted extractor rows; dead_sitemap diagnostic
- Serich: zero accepted extractor rows; dead_sitemap diagnostic
- Cosmydor: zero accepted extractor rows; bot_challenge diagnostic
- YOUTH LAB.: zero accepted extractor rows; two products excluded by incomplete transaction data

## Exact Next Steps

- Apply nothing from this batch without a separate explicitly approved DB/prod write lane; the consolidated DB-ready manifest is empty.
- OIlÙJ: keep all five official-domain product rows held until commerce facts can pass, including multi-offer/market verification; do not force-fill the missing merge candidate.
- Scented Life and Serich: rerun extractor with official PDP/preferred-title input or improved discovery because current catalog-intelligence returned dead_sitemap and zero rows.
- Cosmydor: rerun only through an anti-abuse-safe official PDP discovery path; current extraction hit bot_challenge and produced no rows.
- YOUTH LAB.: rerun with preferred official PDPs or improved transaction extraction; current two discovered products were filtered as incomplete transaction rows.
- After any rerun, repeat review, conservative curation, and no-DB dry-run before proposing a DB apply lane.

## Key Artifacts

- Curation summary: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_1/curated_manifests/curation_summary.json
- Curation decisions CSV: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_1/curated_manifests/curated_decisions.csv
- DB-ready candidate manifest: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_1/curated_manifests/db_ready_candidate_manifest.json
- Consolidated no-DB dry-run: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_1/dry_runs/db_ready_candidate_manifest.json
