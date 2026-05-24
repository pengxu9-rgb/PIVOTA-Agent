# Wave6 Parallel Agent Closeout - 2026-05-24

## Scope

This closeout covers the parallel Wave6 Markato US brand opportunity pass after Wave5 live PDP cleanup.

Guardrails held:
- No `railway up`.
- No git push during worker/validator analysis.
- No DB apply or production write.
- No seller-only fallback.
- No force-filled ingredient or INCI writeback.

## Parallel Execution

Five worker agents processed 36 next-wave brands across independent output directories, followed by one cross-batch validation agent.

Reconciled cross-batch validation:
- Brands processed: 36
- Manifest rows: 598
- Review-gate pass brands: 19
- Review-gate blocked brands: 17
- Conservative holds: 568
- Consolidated no-DB candidate rows: 30
- No-DB dry-run scanned rows: 30
- `would_insert_unverified`: 30
- Invalid rows: 0
- Inserted rows: 0
- Dry-run DB state: all `database_available=false`

Candidate counts by brand:
- Aetas: 1
- Seresilk: 3
- AFRAKARI: 12
- Lucamar Skin Care: 7
- 7Journeys: 5
- Rohr Remedy: 2

Cross-batch validator findings:
- No duplicate candidate groups by canonical URL, brand/title, or external product id.
- Candidate rows show USD and `in_stock` in available worker/dry-run fields.
- No candidate URL/source-domain matched marketplace contamination patterns.
- No row is cleared for unconditional DB apply from validation alone.
- 20 rows need production DB dry-run and main-agent review.
- 10 rows have hard rework flags and were excluded from the next dry-run manifest.

## Main-Agent Gate

Tier A: production DB dry-run candidate only
- Count: 20
- Manifest: `reports/markato_expansion_status_20260524/wave6_tier_a_prod_db_dry_run_candidate_manifest.json`
- Local no-DB shape check: `reports/markato_expansion_status_20260524/wave6_tier_a_no_db_shape_check.json`
- Shape-check result: scanned 20, `would_insert_unverified` 20, invalid 0, inserted 0, `database_available=false`

Tier B: hold for rework
- Count: 10
- Hold file: `reports/markato_expansion_status_20260524/wave6_tier_b_rework_hold_candidates.json`
- Reason: hard regulated/therapeutic claim cues in AFRAKARI and Lucamar rows.

The Tier A manifest is suitable for the next production-environment dry-run only. It is not an apply manifest until a DB-backed dry-run confirms duplicate/insert behavior and the remaining shipping/sellable-region/claim cues are reviewed.

Recommended production-environment dry-run command:

```bash
node scripts/run_aurora_external_seed_creation_pipeline.cjs \
  --manifest reports/markato_expansion_status_20260524/wave6_tier_a_prod_db_dry_run_candidate_manifest.json \
  --out reports/markato_expansion_status_20260524/wave6_tier_a_prod_db_dry_run.json
```

Do not add `--apply` until that output has no invalid rows, no unexpected corrections, no duplicate canonical URLs, and no rows that should remain held after compliance review.

## Key Artifacts

- Wave5 closeout: `reports/markato_expansion_status_20260524/wave5_quality_closeout_20260524.md`
- Holistic plan: `reports/markato_expansion_status_20260524/markato_us_brand_opportunity_holistic_plan_20260524.md`
- Wave5 partner packet: `reports/markato_expansion_status_20260524/wave5_partner_opportunity_packet_20260524.md`
- Wave5 official source gap sheet: `reports/markato_expansion_status_20260524/wave5_official_source_gap_sheet_20260524.csv`
- Wave6 cross-batch validation: `reports/markato_expansion_status_20260524/agent_wave6_overall_validation/overall_validation.md`
- Wave6 consolidated validator candidates: `reports/markato_expansion_status_20260524/agent_wave6_overall_validation/consolidated_db_ready_candidate_manifest.json`
- Tier A prod DB dry-run manifest: `reports/markato_expansion_status_20260524/wave6_tier_a_prod_db_dry_run_candidate_manifest.json`
- Tier B rework hold list: `reports/markato_expansion_status_20260524/wave6_tier_b_rework_hold_candidates.json`

## Code Fixes In This Round

- Structured reviewed INCI patches now populate `ingredients_inci`, `inci_list`, and ingredient intel arrays instead of leaving only raw INCI text.
- Live PDP audit no longer reports a variant gap for single-SKU or default-title products with no real comparable variant axis.
- Product-kind classification now lets reviewed accessory/tool signals override broad beauty/body formula category paths.
- Scent/fragrance variant axes are normalized into identity graph and external seed product variant logic.

## Verification

Correct Jest verification:

```bash
npx jest --watchman=false --runInBand \
  tests/external_seed_product_kind.test.js \
  tests/scripts/apply_reviewed_external_seed_pdp_content_patch.test.js \
  tests/scripts/audit_external_seed_live_pdp_modules.test.js \
  tests/services/external_seed_products.test.js \
  tests/services/pdp_identity_graph.test.js
```

Post-rebase result: 5 suites passed, 196 tests passed.

Note: `node --test` was also attempted first and failed because these files are Jest-style tests using `describe`/`expect`; that was a runner mismatch, not a product regression.

## Deployment Gate

Code is ready for git-based deployment after commit review. Use `git push`; do not use `railway up`.

DB writes remain gated. The next DB action should be a production-environment dry-run using the Tier A manifest above, because `DATABASE_URL` is available in production and not in the local shell.
