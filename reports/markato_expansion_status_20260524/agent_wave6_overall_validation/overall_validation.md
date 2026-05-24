# Wave6 Overall Validation

Generated: 2026-05-24T05:16:10.010Z

## Verdict

Read-only validation completed across batches 1-5. All parsed batch summaries and dry-run JSON files are valid JSON. All no-DB dry-runs report `database_available=false` at both wrapper and apply-summary level, with 0 inserted rows. Consolidated candidate count is 30, all `would_insert_unverified`. No duplicate URL, brand/title, or external-product-id groups were found.

No candidate is cleared for unconditional DB apply from this validation alone: 20 rows need main-agent review because dry-run shipping/sellable-region are unknown and/or available text has cosmetic claim/accessory cues; 10 rows have hard rework flags.

## Reconciled Counts

| Batch | Brands | Manifest rows | Review pass brands | Review blocked brands | Holds | DB-ready candidates | Dry-run scanned | Would insert unverified | Invalid |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 7 | 132 | 4 | 3 | 131 | 1 | 1 | 1 | 0 |
| 2 | 7 | 25 | 4 | 3 | 22 | 3 | 3 | 3 | 0 |
| 3 | 7 | 48 | 3 | 4 | 36 | 12 | 12 | 12 | 0 |
| 4 | 7 | 97 | 5 | 2 | 83 | 14 | 14 | 14 | 0 |
| 5 | 8 | 296 | 3 | 5 | 296 | 0 | 0 | 0 | 0 |

Totals: 36 brands, 598 manifest rows, 19 review-pass brands, 17 review-blocked brands, 568 conservative holds, 30 DB-ready candidate rows, 30 actual dry-run scanned rows, 30 would-insert-unverified, 0 invalid.

## Candidate Brands/SKUs

- Aetas: 1
- Seresilk: 3
- AFRAKARI: 12
- Lucamar Skin Care: 7
- 7Journeys: 5
- Rohr Remedy: 2

| Batch | Brand | Title | Dry-run | Safety status | Review/rework notes |
| --- | --- | --- | --- | --- | --- |
| 1 | Aetas | The Serum | would_insert_unverified | needs_main_agent_review | dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 2 | Seresilk | Silk Night Cream | would_insert_unverified | needs_main_agent_review | dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 2 | Seresilk | Silk Night Serum | would_insert_unverified | needs_main_agent_review | cosmetic_claim_language_needs_review; dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 2 | Seresilk | Gentle Silk Cleanser | would_insert_unverified | needs_main_agent_review | dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 3 | AFRAKARI | Radiance Elixir | would_insert_unverified | needs_main_agent_review | cosmetic_claim_language_needs_review; dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 3 | AFRAKARI | Prickly Pear Elixir | would_insert_unverified | needs_main_agent_review | dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 3 | AFRAKARI | Recovery Cream | would_insert_unverified | blocked_or_needs_rework | dry_run_sellable_region_unknown; dry_run_shipping_unknown; regulated_or_therapeutic_claim_cue |
| 3 | AFRAKARI | Recovery Serum | would_insert_unverified | needs_main_agent_review | cosmetic_claim_language_needs_review; dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 3 | AFRAKARI | Gentle Cleansing Milk | would_insert_unverified | blocked_or_needs_rework | dry_run_sellable_region_unknown; dry_run_shipping_unknown; regulated_or_therapeutic_claim_cue |
| 3 | AFRAKARI | Kalahari Melon Seed Oil | would_insert_unverified | needs_main_agent_review | cosmetic_claim_language_needs_review; dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 3 | AFRAKARI | Marula Hydrating Elixir | would_insert_unverified | blocked_or_needs_rework | dry_run_sellable_region_unknown; dry_run_shipping_unknown; regulated_or_therapeutic_claim_cue |
| 3 | AFRAKARI | Pure Marula Oil + Cape Chamomile | would_insert_unverified | blocked_or_needs_rework | dry_run_sellable_region_unknown; dry_run_shipping_unknown; regulated_or_therapeutic_claim_cue |
| 3 | AFRAKARI | Pure Marula Oil | would_insert_unverified | needs_main_agent_review | cosmetic_claim_language_needs_review; dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 3 | AFRAKARI | Resurface + Restore Night Cream | would_insert_unverified | blocked_or_needs_rework | dry_run_sellable_region_unknown; dry_run_shipping_unknown; regulated_or_therapeutic_claim_cue |
| 3 | AFRAKARI | Renewal Facial Oil | would_insert_unverified | needs_main_agent_review | cosmetic_claim_language_needs_review; dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 3 | AFRAKARI | Cape Kelp Hydrating Cleanser | would_insert_unverified | needs_main_agent_review | cosmetic_claim_language_needs_review; dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 4 | Lucamar Skin Care | Lucamar Baalm 50g  UNSCENTED | would_insert_unverified | needs_main_agent_review | dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 4 | Lucamar Skin Care | Baa Ram Ewe  Lanolin Skin Balm  120g UNSCENTED | would_insert_unverified | blocked_or_needs_rework | dry_run_sellable_region_unknown; dry_run_shipping_unknown; regulated_or_therapeutic_claim_cue |
| 4 | Lucamar Skin Care | Musk: My Lips Are Sealed Lip Balm 10gms | would_insert_unverified | blocked_or_needs_rework | dry_run_sellable_region_unknown; dry_run_shipping_unknown; regulated_or_therapeutic_claim_cue |
| 4 | Lucamar Skin Care | Baa Ram Ewe  Lanolin Skin Balm  120g | would_insert_unverified | blocked_or_needs_rework | dry_run_sellable_region_unknown; dry_run_shipping_unknown; regulated_or_therapeutic_claim_cue |
| 4 | Lucamar Skin Care | Vanilla:   My Lips Are Sealed Natural Lip Balm 10gms | would_insert_unverified | blocked_or_needs_rework | dry_run_sellable_region_unknown; dry_run_shipping_unknown; regulated_or_therapeutic_claim_cue |
| 4 | Lucamar Skin Care | Lucamar Baalm 50g | would_insert_unverified | needs_main_agent_review | dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 4 | Lucamar Skin Care | Baa Ram Ewe Lanolin Skin Balm 50g | would_insert_unverified | blocked_or_needs_rework | dry_run_sellable_region_unknown; dry_run_shipping_unknown; regulated_or_therapeutic_claim_cue |
| 4 | 7Journeys | 7 Journeys Extra Soft Glow Renewal Moisturizer 50g - Hydrating & Firming | would_insert_unverified | needs_main_agent_review | cosmetic_claim_language_needs_review; dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 4 | 7Journeys | 7 Journeys Miracle Timeless Eye Cream 30g (Hydrating & Glowing) | would_insert_unverified | needs_main_agent_review | dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 4 | 7Journeys | 7 Journeys Antarctic Timeless Serum 45ml (Hydration & Anti-aging) | would_insert_unverified | needs_main_agent_review | cosmetic_claim_language_needs_review; dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 4 | 7Journeys | 7 Journeys Glow Renewal Serum 45ml (Hydrated & Glowing Skin) | would_insert_unverified | needs_main_agent_review | dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 4 | 7Journeys | 7 Journeys Miracle Glow Serum Mask 25ml (10 Sheets) | would_insert_unverified | needs_main_agent_review | dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 4 | Rohr Remedy | Kakadu Plum Super Serum with Vit C | would_insert_unverified | needs_main_agent_review | cosmetic_claim_language_needs_review; dry_run_sellable_region_unknown; dry_run_shipping_unknown |
| 4 | Rohr Remedy | Lilly Pilly Face Moisturiser with Omega-3 | would_insert_unverified | needs_main_agent_review | dry_run_sellable_region_unknown; dry_run_shipping_unknown |

## Safety Findings

- Currency/availability: candidate rows show USD and in-stock in available worker fields and dry-run commerce gates.
- Marketplace/third-party: no candidate URL/source-domain matched marketplace patterns; source role is primary where available.
- Duplicate check: no duplicate canonical URL, brand/title, or external product id groups.
- Claims and completeness: rows with anti-aging, recovery, repair, firming, Vit C, peptide, acid, or possible set/accessory language are marked `needs_main_agent_review`; missing or unknown shipping/sellable-region statuses are also not assumed pass.
- No forced ingredients: dry-runs reported ingredient evidence/writeback as missing/none, so no ingredient writeback occurred in these no-DB outputs.

## Blockers and Next Actions

- official_source_gap: 12 signals
- market_mismatch: 13 signals
- compliance_claims_lane: 18 signals
- extractor_contamination_timeout: 12 signals
- structural_review_failure: 17 signals
- out_of_stock_wholesale_accessory: 16 signals

Next actions: resolve official-source gaps and extractor blockers before re-run; keep non-USD/non-US rows held until US storefront/PDP evidence exists; route wellness/supplement/therapeutic/SPF-style products outside the cosmetics DB-ready lane; remove out-of-stock, wholesale, duplicate, bundle, accessory, gift-card, and contaminated rows before any future dry-run/apply.

## Write Scope

Worker output inventory for each requested batch directory stayed under its assigned directory. Batch 3 explicitly reported 35 changed files and all are under its assigned dir. Other batches did not report changed-files arrays, so validation used filesystem inventory of the requested batch dirs. Current validation wrote only this overall validation directory.

## Residual Risks

- All no-DB dry-runs report database_available=false and inserted=0; candidates remain would_insert_unverified, not DB-applied rows.
- Dry-run commerce gates commonly leave sellable_region_status and shipping_status as unknown; these rows need main-agent review before apply.
- Some candidate titles/descriptions contain cosmetic claim language such as anti-aging, recovery, repair, firming, Vit C, peptides, or acids; these were marked for main-agent review rather than treated as unconditional compliance passes.
- Batch 3 candidate rows are brand-level in batch_summary.json, not top-level, so downstream consumers should use this consolidated manifest or brand.curation rows.
- git status shows the broader reports/markato_expansion_status_20260524 tree contains other untracked Wave5/Wave6 artifacts; this validation only confirms the five requested worker dirs and writes only the overall validation dir.

## Outputs

- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_overall_validation/overall_validation.json
- /Users/pengchydan/dev/PIVOTA-Agent/reports/markato_expansion_status_20260524/agent_wave6_overall_validation/consolidated_db_ready_candidate_manifest.json
