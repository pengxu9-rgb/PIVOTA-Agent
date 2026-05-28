# Wave24 Markato Expansion Candidate Rollup

Generated: 2026-05-28T04:05:22.749Z

## Summary

- Production active US seed rows scanned: 602
- Domains with active production rows: 32
- Catalog attached: 602/602 (100%)
- DB serving eligible: 323/602 (53.7%)
- Identity ready: 325/602 (54%)
- High-quality reviewed product intel: 419/602 (69.6%)
- Recommended next-batch rows: 0
- Source-gap hold rows: 108

## Recommended Next Batch

- No production rows passed the conservative source-quality gate for immediate expansion.

## Domain Rollup

- missnella.com: rows=198, ready=0, catalog=198, serving=0, intel_hq=100, source_gap=84, risk=114
- upcirclebeauty.com: rows=103, ready=10, catalog=103, serving=71, intel_hq=93, source_gap=7, risk=86
- 786cosmetics.com: rows=51, ready=35, catalog=51, serving=48, intel_hq=48, source_gap=1, risk=15
- nourwish.com: rows=26, ready=0, catalog=26, serving=18, intel_hq=0, source_gap=0, risk=26
- terraandco.com: rows=24, ready=0, catalog=24, serving=10, intel_hq=0, source_gap=0, risk=24
- joocyee.com: rows=18, ready=18, catalog=18, serving=18, intel_hq=18, source_gap=0, risk=0
- medicube.us: rows=17, ready=10, catalog=17, serving=17, intel_hq=17, source_gap=0, risk=7
- byrabeauty.com: rows=14, ready=0, catalog=14, serving=11, intel_hq=0, source_gap=1, risk=13
- baiebotanique.com: rows=12, ready=1, catalog=12, serving=11, intel_hq=12, source_gap=1, risk=10
- joujoubotanicals.com: rows=11, ready=2, catalog=11, serving=11, intel_hq=11, source_gap=0, risk=9
- delicatedaisys.com: rows=10, ready=6, catalog=10, serving=9, intel_hq=10, source_gap=1, risk=3
- nalacare.com: rows=10, ready=7, catalog=10, serving=8, intel_hq=10, source_gap=0, risk=3
- nubest.com: rows=10, ready=0, catalog=10, serving=10, intel_hq=10, source_gap=0, risk=10
- rmsbeauty.com: rows=9, ready=1, catalog=9, serving=6, intel_hq=8, source_gap=1, risk=7
- activedrip.com: rows=8, ready=4, catalog=8, serving=8, intel_hq=8, source_gap=0, risk=4
- khus-khus.com: rows=8, ready=5, catalog=8, serving=8, intel_hq=8, source_gap=0, risk=3
- linhart.nyc: rows=8, ready=0, catalog=8, serving=0, intel_hq=1, source_gap=3, risk=5
- coconutmatter.com: rows=7, ready=3, catalog=7, serving=6, intel_hq=7, source_gap=0, risk=4
- abyssianhaircare.com: rows=6, ready=5, catalog=6, serving=6, intel_hq=6, source_gap=0, risk=1
- lhamour.com: rows=6, ready=5, catalog=6, serving=6, intel_hq=6, source_gap=0, risk=1
- us.oiolab.co: rows=6, ready=0, catalog=6, serving=6, intel_hq=6, source_gap=1, risk=5
- 7journeys.com: rows=5, ready=5, catalog=5, serving=5, intel_hq=5, source_gap=0, risk=0
- apiceuticals.com: rows=5, ready=5, catalog=5, serving=5, intel_hq=5, source_gap=0, risk=0
- lucamarskincare.com: rows=5, ready=3, catalog=5, serving=5, intel_hq=5, source_gap=0, risk=2
- mossnoor.com: rows=5, ready=0, catalog=5, serving=0, intel_hq=5, source_gap=5, risk=0
- oiluj.com: rows=5, ready=0, catalog=5, serving=5, intel_hq=5, source_gap=3, risk=2
- lovemasami.com: rows=4, ready=1, catalog=4, serving=4, intel_hq=4, source_gap=0, risk=3
- seresilk.com.au: rows=4, ready=1, catalog=4, serving=4, intel_hq=4, source_gap=0, risk=3
- daebyskin.com: rows=2, ready=2, catalog=2, serving=2, intel_hq=2, source_gap=0, risk=0
- en.limecosmetic.com: rows=2, ready=2, catalog=2, serving=2, intel_hq=2, source_gap=0, risk=0

## Artifacts

- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave43_missnella_upcircle_source_recovery_20260528/latest_rollup_after_upcircle_recovery/wave24_candidate_rollup.json
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave43_missnella_upcircle_source_recovery_20260528/latest_rollup_after_upcircle_recovery/wave24_domain_rollup.csv
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave43_missnella_upcircle_source_recovery_20260528/latest_rollup_after_upcircle_recovery/wave24_product_gaps.csv
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave43_missnella_upcircle_source_recovery_20260528/latest_rollup_after_upcircle_recovery/wave24_recommended_next_batch.csv
- /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave43_missnella_upcircle_source_recovery_20260528/latest_rollup_after_upcircle_recovery/wave24_source_gap_backlog.csv

## Guardrails

- This report is read-only against production DB.
- Rows with missing full INCI/how-to, non-USD/high price, stock gaps, regulated claims, sunscreen, supplements, bundles, or non-formula products are held out of immediate PDP expansion.
- Next write step should be an exact-SKU dry-run before any production apply.
