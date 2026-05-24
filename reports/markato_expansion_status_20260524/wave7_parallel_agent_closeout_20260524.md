# Wave7 Parallel Agent Closeout - 2026-05-24

## Scope

Wave7 expanded Markato coverage beyond the Wave6 P0/P1 pool into P2 official-DTC brands plus a P1 extractor-recovery lane.

Guardrails held:

- No `railway up`.
- No git push during worker/validator analysis.
- No Wave7 DB apply or production write.
- No seller-only fallback.
- No force-filled ingredient or INCI writeback.

## Parallel Execution

Five worker agents processed 26 brands across independent output directories.

Reconciled totals:

- Brands processed: 26
- Extracted products: 281
- Manifest rows: 181
- Review-pass brands: 7
- Review-blocked brands: 19
- Conservative held rows: 181
- DB-ready candidates: 0
- No-DB dry-run scanned rows: 0
- No-DB dry-run invalid rows: 0

Batch outcomes:

| Batch | Brands | Manifest rows | Review pass | Review blocked | Held | DB-ready | Main blockers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 5 | 5 | 1 | 4 | 5 | 0 | commerce gate, missing offer merge, dead sitemap, bot challenge |
| 2 | 4 | 1 | 1 | 3 | 1 | 0 | listing/category page, commerce gate, zero transaction rows, Cloudflare |
| 3 | 4 | 66 | 2 | 2 | 66 | 0 | non-US currency/market, commerce gate, PerimeterX, bundle/accessory |
| 4 | 5 | 109 | 3 | 2 | 109 | 0 | PerimeterX, non-US currency, non-English copy, regulated claims, non-beauty |
| 5 | 8 | 0 | 0 | 8 | 0 | 0 | zero accepted rows, Cloudflare, extraction timeout, dead sitemap |

## Overall Validation

The requested overall validation agent was launched but did not produce files after repeated waits and a status interrupt. It was shut down, and the main agent reconciled the five batch summaries and candidate manifests.

Validation artifacts:

- `reports/markato_expansion_status_20260524/agent_wave7_overall_validation/overall_validation.md`
- `reports/markato_expansion_status_20260524/agent_wave7_overall_validation/overall_validation.json`

Validation finding:

- All DB-ready candidate manifests were empty.
- There are no duplicate candidate URLs or external IDs because there are no candidate rows.
- No Wave7 Tier A production DB dry-run manifest is warranted.

## Wave6 Post-Apply Serving Follow-Up

The 7 Wave6 seeds inserted into production DB were direct-probed through production gateway. All 7 returned:

- `PRODUCT_NOT_SERVABLE`
- `serving_eligibility_missing`
- resolution source: `external_seed_product_id`

Production catalog/serving sync dry-run for the same 7 rows succeeded:

- requested IDs: 7
- fetched rows: 7
- mirror rows: 7
- planned SKU rows: 7
- planned offer rows: 7
- planned index-state rows: 7
- skipped: 0
- existing catalog products before sync: 0

Artifact:

- `reports/markato_expansion_status_20260524/wave6_prod_apply_catalog_sync_dry_run.json`

This dry-run confirms the next production write should be a tightly scoped sync apply for the 7 already-approved seeds, not more seed creation.

## Interpretation

Wave7 broad scanning produced no safe seed candidates. The bottleneck is source quality and market fit:

- P2 official-DTC brands frequently expose non-US or non-USD storefronts.
- Several domains return category/listing pages or zero transaction-ready rows.
- PerimeterX/Cloudflare blocks remain common.
- Some candidates are wellness/supplement or non-beauty products and should not be forced into the beauty seed lane.

The next expansion loop should use direct official PDP lists, partner/source feeds, or managed-browser/source-access recovery for selected high-fit brands instead of another blind domain scan.

## Recommended Next Steps

1. Ask for explicit approval to run production catalog/serving sync apply for the 7 already-inserted Wave6 seeds, then rerun gateway probes and live PDP module audit.
2. Do not run a Wave7 production DB dry-run or apply; Wave7 has 0 Tier A rows.
3. Build direct PDP recovery packs for high-fit blocked brands: OIlUJ, Merindah Botanicals, NIMBUS CO, Bonjour La Vie, MANISANTE, KHUS KHUS, Apiceuticals, Pairfum, LIME, Lazy Society.
4. Route NuBest, YAY NOVELTY, and Anaya out of the beauty seed lane unless a reviewed official beauty PDP source is supplied.
