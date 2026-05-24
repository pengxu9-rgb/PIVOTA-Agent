# Markato Wave7 Overall Validation - 2026-05-24

## Scope

This validation reconciles the five Wave7 worker batches:

- Batch 1: P2 low-count skincare/body candidates
- Batch 2: P2 body-care and low-mid candidates
- Batch 3: P2 mid-catalog skincare candidates
- Batch 4: P2 complex/large or adjacent candidates
- Batch 5: P1 recovery candidates from Wave6 extractor-blocked brands

Guardrails held: no DB apply or production write for Wave7, no `railway up`, no git push during worker analysis, no seller-only fallback, and no force-filled ingredients.

The requested overall validation agent was started, but it did not produce files after repeated waits and a status interrupt. It was shut down, and this main-agent validation reconciles the batch summaries and candidate manifests.

## Totals

| Metric | Count |
| --- | ---: |
| Batches | 5 |
| Brands processed | 26 |
| Extracted products | 281 |
| Manifest rows | 181 |
| Review-pass brands | 7 |
| Review-blocked brands | 19 |
| Held rows | 181 |
| DB-ready candidates | 0 |
| No-DB dry-run scanned rows | 0 |
| No-DB dry-run invalid rows | 0 |

## Batch Rollup

| Batch | Brands | Extracted | Manifest rows | Review pass | Review blocked | Held | DB-ready | Main blockers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 5 | 10 | 5 | 1 | 4 | 5 | 0 | commerce gate, missing offer merge, dead sitemap, bot challenge |
| 2 | 4 | 18 | 1 | 1 | 3 | 1 | 0 | category/listing page, commerce gate, zero transaction rows, Cloudflare |
| 3 | 4 | 95 | 66 | 2 | 2 | 66 | 0 | non-US currency/market, commerce gate, PerimeterX, bundle/accessory, non-English/local copy |
| 4 | 5 | 158 | 109 | 3 | 2 | 109 | 0 | PerimeterX, non-US currency, commerce gate, non-English copy, regulated claims, non-beauty |
| 5 | 8 | 0 | 0 | 0 | 8 | 0 | 0 | zero accepted rows, Cloudflare, extraction timeout, dead sitemap, no product URLs |

## Candidate Validation

Five DB-ready candidate manifests were checked across the batches. All were empty.

- Candidate rows found: 0
- Duplicate external product IDs: 0
- Duplicate canonical URLs: 0
- Tier A production DB dry-run manifest required: no

## Interpretation

Wave7 broad P2/P1-recovery blind scanning produced no safe seed candidates. This is not primarily a seed pipeline failure. It is a source and market-fit failure:

- Many P2 brands are not actually US/USD transaction-ready from the available official source.
- Several domains return category/listing pages, dead sitemap output, or zero transaction-ready rows.
- PerimeterX/Cloudflare blocks remain common.
- Wellness/supplement and non-beauty items should stay out of the beauty seed lane.

The next expansion loop should shift away from broad blind brand-domain extraction. Higher-yield next steps are direct official PDP-list recovery, partner/source feed intake, or managed-browser/source-access recovery for a smaller set of high-fit brands.

## Wave6 Post-Apply Serving Finding

The 7 Wave6 seeds inserted into production DB are not yet live-PDP servable by direct gateway probe. All 7 returned:

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

This means the next production write should be a tightly scoped catalog/serving sync apply for those 7 already-approved seeds, followed by gateway probes and live PDP module audit.

## Recommended Next Steps

1. Run production catalog/serving sync apply for the 7 Wave6 inserted seeds only after explicit approval, then rerun gateway probes and live PDP audit.
2. Stop blind Wave7 DB progression because there are 0 Tier A candidates.
3. Build direct official PDP lists for high-fit blocked brands before another extraction pass: OIlUJ, Merindah Botanicals, NIMBUS CO, Bonjour La Vie, MANISANTE, KHUS KHUS, Apiceuticals, Pairfum, LIME, Lazy Society.
4. Route wellness/supplement or non-beauty rows out of the beauty seed lane: NuBest, YAY NOVELTY, Anaya.
