# Wave48 Next Brand Source-Gap Closeout

Generated: 2026-05-28

## Scope

- Continued Markato US brand expansion after the wave47 Linhart merge.
- Validated the deployed production commit before additional production writes.
- Probed the remaining source-gap backlog for official source-backed PDP fields.
- Guardrail: no `railway up` was run. Production actions used Railway env reads/writes only, and deploy work remains git-push based.

## Deployment / Merge Validation

- Production `/version` reported `1aff82d66be1` on `main`.
- `ec7462c9` (`Merge Markato wave47 Linhart source-gap recovery`) is an ancestor of deployed `1aff82d66be1`.
- Wave47 Linhart post-deploy live PDP audit:
  - scanned: 1
  - ready: 1
  - thin: 0
  - not_conversion_ready: 0

## Backlog Probe

Read-only official HTML dry-run against the 82-row source-gap backlog:

- scanned: 82
- dry_run: 27
- skipped: 55
- failed: 0
- fields found:
  - `pdp_description_raw`: 2
  - `pdp_details_sections`: 26
  - `pdp_how_to_use_raw`: 7
  - `pdp_ingredients_raw`: 2

Only two rows initially appeared to have both official ingredients and how-to:

- Miss Nella `ext_cfbb0ca2b9d0c7b411793b0b` Cool Like Me Roll On Perfume
- Miss Nella `ext_6f491538dbf9a790b66cf269` Sweet Like Me Roll On Perfume

Manual official PDP verification confirmed both pages expose description, how-to, and an Ingredients accordion. The ingredient text is official, but it starts with `Oil Base` and is not accepted by the live PDP ingredient authority as full INCI.

## Production Writes And Remediation

Official HTML apply for the two Miss Nella roll-on rows:

- updated: 2
- fields written:
  - `pdp_ingredients_raw`: 2
  - `pdp_how_to_use_raw`: 2
  - `pdp_details_sections`: 2

Serving/index sync dry-run and apply:

- mirror rows: 2
- product upserts: 2
- SKU upserts: 2
- offer upserts: 2
- group member upserts: 2
- index state upserts: 2
- identity live-read updates: 2
- catalog row trust upserts: 2
- stale SKU/offer deletes: 2 each

Live PDP audit after sync:

- scanned: 2
- ready: 0
- thin: 2
- blocker: `missing_ingredients`
- content_gap_ids:
  - `ext_cfbb0ca2b9d0c7b411793b0b`
  - `ext_6f491538dbf9a790b66cf269`

Remediation applied:

- Marked both rows with `content_evidence_hold_v1` reason `official_ingredient_text_not_full_inci`.
- Updated seed, catalog product, catalog SKU, and index state for both rows.
- Verified index state:
  - `serving_eligible=false`
  - `pipeline_stage=extracted`
  - `blocker_code=content_evidence_hold`

Live PDP audit after hold:

- scanned: 2
- ready: 0
- thin: 0
- not_conversion_ready: 2

## Runtime / Report Fixes

- Tightened `backfill-external-seed-official-html-pdp-fields.cjs` so short ingredient text containing `Oil Base` is not treated as official full INCI.
- Added a regression test covering the Miss Nella perfume oil-base ingredient case.
- Updated the Markato rollup builder to treat `content_evidence_hold_v1` as a source-gap hold so held rows are not recommended for serving sync.

Focused validation:

- `node --check scripts/backfill-external-seed-official-html-pdp-fields.cjs`
- `node --check reports/markato_expansion_status_20260524/wave24_expansion_planning_20260527/build_wave24_candidate_rollup.cjs`
- `npx jest tests/scripts/backfill_external_seed_official_html_pdp_fields.test.js --runInBand`
  - 52 passed

## Latest Markato Rollup

Final rollup after applying the content-evidence hold and classifier fix:

- production_rows: 602
- catalog_attached: 602/602 (100%)
- index_serving_eligible: 348/602 (57.8%)
- identity_ready: 352/602 (58.5%)
- product_intel_high_quality: 507/602 (84.2%)
- lane_counts:
  - ready_or_covered: 159
  - hold_source_gap: 82
  - hold_risk_review: 361
- recommended_next_batch_rows: 0

Miss Nella current domain rollup:

- rows: 198
- ready_or_covered: 21
- hold_source_gap: 63
- hold_risk_review: 114
- content_evidence_hold: 2

## Remaining Actionable State

- No conservative ready-to-promote rows remain from the current source-gap backlog probe.
- The two Miss Nella roll-on perfume rows are source-evidenced but held pending ingredient review because the official ingredient text is not full INCI.
- Previously known identity-review holds still must not be force-promoted without review:
  - Miss Nella `ext_33466da0907b256ffc53783b` Blush
  - Miss Nella `ext_e9e3fba6b05911bba1bfe71e` Eye Shadow
  - UpCircle Beauty `ext_32e72e7e518f4dfa532a191d` Home Mist with Lemongrass + Grapefruit Water

## Artifacts

- `official_html_backlog_probe_dry_run/dry-run.json`
- `missnella_rollon_official_html_apply/apply.json`
- `missnella_rollon_serving_identity_sync_dry_run.json`
- `missnella_rollon_serving_identity_sync_apply.json`
- `live_pdp_modules_audit_missnella_rollon_after_sync.json`
- `missnella_rollon_content_evidence_hold_dry_run.json`
- `missnella_rollon_content_evidence_hold_apply.json`
- `live_pdp_modules_audit_missnella_rollon_after_hold.json`
- `missnella_rollon_official_html_dry_run_after_guard/dry-run.json`
- `latest_rollup_after_rollon_hold_v2/`

No `railway up` was run.
