# Wave6 Markato Batch 1 Summary

Output dir: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_1

## Counts

- Brands reviewed: 7
- Manifest rows reviewed: 132
- Generic review accepted rows: 131
- Conservative DB-ready candidate rows: 1
- Conservative holds: 131
- Review/extractor blocker brands: 3
- No-DB dry-run scanned: 1
- No-DB dry-run would_insert_unverified: 1
- No-DB dry-run invalid: 0

## Source Note

MASAMI live manifest extraction hit sandbox DNS block; escalated catalog-intelligence retry was rejected by sandbox reviewer, so cached read-only manifests were used where present. Depuravita has no cached manifest and is represented as a zero-item extractor blocker manifest.

## Brand Outcomes

| Brand | Manifest rows | Review accepted | DB-ready | Holds | Outcome |
|---|---:|---:|---:|---:|---|
| MASAMI | 100 | 99 | 0 | 100 | held/review-blocked: anti_abuse_signal:perimeterx; anti_abuse_signal_perimeterx; marketplace_third_party_contamination; non_us_currency_market_mismatch; out_of_stock |
| Herbalore | 2 | 2 | 0 | 2 | held: regulated_wellness_supplement_claims_hold |
| NOVOS | 0 | 0 | 0 | 0 | blocked: zero_accepted_items_from_extractor; zero_curatable_rows_from_extractor |
| Therapy Notebooks | 6 | 6 | 0 | 6 | held: therapeutic_claims_hold; non_us_currency_market_mismatch |
| Lhamour | 20 | 20 | 0 | 20 | held: non_us_currency_market_mismatch; therapeutic_or_high_claim_skincare_hold |
| Depuravita | 0 | 0 | 0 | 0 | blocked: zero_accepted_items_from_extractor; catalog_intelligence_dns_blocked_in_sandbox |
| Aetas | 4 | 4 | 1 | 3 | candidate dry-run complete |

## DB-Ready Candidates

- Aetas: The Serum (https://aetasofficial.com/products/serum) - ext_38b10ae142ef283bdc0acca8 - dry-run status: would_insert_unverified

## Holds By Reason

- non_us_currency_market_mismatch: 126
- anti_abuse_signal_perimeterx: 100
- marketplace_third_party_contamination: 100
- therapeutic_or_high_claim_skincare_hold: 16
- out_of_stock: 7
- therapeutic_claims_hold: 6
- regulated_wellness_supplement_claims_hold: 2

## Next Steps

- Apply nothing from this batch without a separate approved DB/prod write lane.
- Aetas: only The Serum is a DB-ready candidate from this run; if approved later, apply just the curated Aetas manifest and then run a live PDP/no-cache postcheck.
- Aetas: keep The Moisturizer, The Cleanser, and The Lotion held until official inventory is in_stock.
- MASAMI: do not apply the cached manifest; rerun extraction only after catalog-intelligence access is explicitly approved and scope extraction to brand-owned MASAMI PDPs/preferred titles to remove marketplace and third-party contamination.
- Herbalore, NOVOS, Therapy Notebooks, and Depuravita: keep in claims lane only; require regulated wellness/therapeutic claim review before any seed creation.
- Lhamour: hold all rows for US seed creation until USD/US-market extraction is available; separately review high-claim skincare rows before any later apply lane.
- Depuravita: rerun manifest extraction when network/catalog-intelligence access is available; this batch only has a zero-item blocker artifact.

## Key Artifacts

- Curation summary: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_1/curation/curation_summary.json
- Curation decisions JSON: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_1/curation/curated_decisions.json
- Curation decisions CSV: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_1/curation/curated_decisions.csv
- Curated Aetas manifest: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_1/curated_manifests/aetas.json
- Aetas no-DB dry-run: /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_batch_1/dry_runs/aetas.json
