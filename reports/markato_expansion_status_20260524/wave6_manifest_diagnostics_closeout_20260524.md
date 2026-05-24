# Markato Wave6 Manifest Diagnostics Closeout - 2026-05-24

## Scope

This is a manifest/extractor diagnostic pass only. It used catalog-intelligence read calls and local manifest validation. It did not run `railway up`, did not use DB-backed apply, and did not write production rows.

Input candidates:

- Low-risk beauty lane: Lhamour, DAEBY, Aetas, KHUS KHUS modern herbal fusion, Seresilk.
- Strategic P0 pilot lane: MASAMI.

## Manifest Diagnostic Result

Artifact: `wave6_manifest_diagnostics_summary.json`

| Metric | Count |
| --- | ---: |
| Candidates scanned | 6 |
| Manifest failures | 0 |
| Review passed | 4 |
| Review blocked | 2 |
| Raw manifest items | 135 |
| Accepted before manual curation | 134 |

Blocked:

- `KHUS KHUS modern herbal fusion`: zero accepted items from extractor.
- `MASAMI`: anti-abuse signal `perimeterx`; also the sample titles show third-party/marketplace contamination rather than clean MASAMI-owned PDPs.

Passed manifest review:

- `Lhamour`: 20 accepted before curation.
- `DAEBY`: 3 accepted before curation.
- `Aetas`: 4 accepted before curation.
- `Seresilk`: 8 accepted before curation.

## Manual Curation Result

Artifact: `wave6_curated_publishable_manifest_summary.json`

| Brand | Publishable | Held | Main holds |
| --- | ---: | ---: | --- |
| Lhamour | 12 | 8 | duplicate copy URL, baby/nipple claims, hair-growth claim, essential-oil claim |
| DAEBY | 3 | 0 | none at manifest curation layer |
| Aetas | 1 | 3 | out of stock |
| Seresilk | 4 | 4 | wholesale duplicate rows |
| Total | 20 | 15 | manual quality and market-fit holds |

Decision CSV: `wave6_curated_publishable_decisions.csv`

## No-DB Seed Creation Dry-Run

The curated 20 rows were passed through the seed creation dry-run without `DATABASE_URL`. This checks row shape and commerce facts but cannot dedupe against existing DB rows.

Result:

- `Lhamour`: 12 invalid, all blocked by market/currency mismatch (`EUR` for US target).
- `DAEBY`: 3 invalid, blocked by `market_currency_mismatch`.
- `Aetas`: 1 `would_insert_unverified`, commerce facts gate pass.
- `Seresilk`: 4 `would_insert_unverified`, commerce facts gate pass.

The safe next DB-backed dry-run subset is therefore 5 rows, not the full curated 20.

## DB-Ready Candidate Manifest

Artifact: `wave6_db_ready_candidate_manifest.json`

No-DB dry-run result: `wave6_db_ready_candidate_dry_run_no_db.json`

| Metric | Count |
| --- | ---: |
| Scanned | 5 |
| Would insert unverified | 5 |
| Invalid | 0 |
| Requires seed correction | 0 |

Rows:

- Aetas: `The Serum` (`ext_38b10ae142ef283bdc0acca8`)
- Seresilk: `Silk Night Cream` (`ext_df8aac07d6c970d4c213b43f`)
- Seresilk: `Silk Night Serum` (`ext_438058253d57a2c8d75f5906`)
- Seresilk: `Pure Silk Exfoliator` (`ext_7c5f8c37e37a5f147672a9f2`)
- Seresilk: `Gentle Silk Cleanser` (`ext_0d4ffd13b899460cabb1f392`)

## Recommended Next Step

Run DB-backed dry-run for `wave6_db_ready_candidate_manifest.json` in an environment with valid `DATABASE_URL`:

```bash
node scripts/run_aurora_external_seed_creation_pipeline.cjs --manifest reports/markato_expansion_status_20260524/wave6_db_ready_candidate_manifest.json --out reports/markato_expansion_status_20260524/wave6_db_ready_candidate_dry_run_db.json
```

Proceed to apply only if the DB-backed dry-run confirms the expected row state (`would_insert` or known `skipped_existing`) and no unexpected invalids, correction followups, or duplicate canonical URLs appear.

## Holds To Preserve

- Keep MASAMI out of the apply lane until there is a clean brand-owned source strategy or preferred-title scoped extraction that eliminates marketplace contamination.
- Keep KHUS KHUS out until extractor diagnostics produce nonzero product rows.
- Keep Lhamour out of US seed apply until market/currency handling is resolved.
- Keep DAEBY out until the `market_currency_mismatch` is explained or corrected.
- Keep Aetas out-of-stock rows held.
- Keep Seresilk wholesale rows held.
