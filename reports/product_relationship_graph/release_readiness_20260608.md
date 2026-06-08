# Relationship Graph Production Readiness - 2026-06-08

## Production Evidence

- Migration `053_relationship_candidate_labels_ai_approved.sql` was applied in production on 2026-06-08.
- Initial guarded production dry-run failed closed on serving suppression thresholds, as designed.
- Unsafe active `ai_approved` rows were quarantined out of serving:
  - Initial dry-run found 2,299 unsafe approved rows.
  - First apply partially completed before the public DB connection dropped; 1,111 rows are inferred applied from the remaining dry-run delta.
  - Remaining batched apply completed 1,188 rows.
- Post-quarantine serving audit:
  - total rows: 8,404
  - safe rows: 8,404
  - suppressed rows: 0
  - suppressed pct: 0
- Post-quarantine production routine dry-run:
  - `ok: true`
  - build: 200 anchors, 1,761 dry-run edges, 0 applied
  - preflight: passed
  - AI review: passed, 0 reviewed for cutoff
  - serving guard audit: passed thresholds

## Release Scope

Tracked modified relgraph files:

- `.github/workflows/external-seed-create-from-brand.yml`
- `.github/workflows/external-seed-create-reviewed-retailer-offer.yml`
- `docs/runbooks/product_relationship_graph_v1_pilot.md`
- `package.json`
- `scripts/build-product-relationship-graph.js`
- `scripts/review-relationship-candidate-labels.js`
- `scripts/sync-external-seeds-to-catalog.cjs`
- `src/auroraBff/productBeautyAttributes.js`
- `src/auroraBff/productRelationshipGraph.js`
- `src/auroraBff/productRelationshipGraphSources.js`
- `src/db/migrations/046_relationship_candidate_labels.sql`
- `tests/product_relationship_graph.test.js`
- `tests/product_relationship_graph_preflight.test.js`
- `tests/product_relationship_graph_sources.test.js`
- `tests/scripts/build_product_relationship_graph.test.js`
- `tests/scripts/sync_external_seeds_to_catalog.test.js`

New relgraph files:

- `.github/workflows/relationship-graph-serving-guard-audit.yml`
- `.github/workflows/relationship-graph-sync-routine.yml`
- `scripts/audit-relationship-graph-serving-guard.js`
- `scripts/quarantine-relationship-graph-serving-unsafe.js`
- `scripts/refresh-product-beauty-attribute-sig-ids.js`
- `scripts/run-pdp-quality-upgrade-loop.cjs`
- `scripts/run-relationship-graph-routine-job.js`
- `scripts/run-relationship-graph-sync-routine.js`
- `src/db/migrations/052_pba_sig_id.sql`
- `src/db/migrations/053_relationship_candidate_labels_ai_approved.sql`
- `src/services/relationshipGraphRecall.js`
- `tests/product_beauty_attributes_sig_lookup.test.js`
- `tests/scripts/audit_relationship_graph_serving_guard.test.js`
- `tests/scripts/quarantine_relationship_graph_serving_unsafe.test.js`
- `tests/scripts/refresh_product_beauty_attribute_sig_ids.test.js`
- `tests/scripts/review_relationship_candidate_labels.test.js`
- `tests/scripts/run_pdp_quality_upgrade_loop.test.js`
- `tests/scripts/run_relationship_graph_routine_job.test.js`
- `tests/scripts/run_relationship_graph_sync_routine.test.js`
- `tests/services/discovery_relationship_graph_recall.test.js`
- `tests/services/relationship_graph_recall.test.js`

## Validation

- Workflow YAML parse passed for:
  - `relationship-graph-serving-guard-audit.yml`
  - `relationship-graph-sync-routine.yml`
  - `external-seed-create-from-brand.yml`
  - `external-seed-create-reviewed-retailer-offer.yml`
- Syntax checks passed for relgraph scripts.
- Broader relationship graph Jest set passed:
  - 15 suites
  - 154 tests
- Focused workflow/PDP-loop set also passed earlier:
  - 5 suites
  - 48 tests

## Remaining Before Rollout

- Run one manual GitHub workflow dispatch with a tiny affected product set.
- Confirm production GitHub `DATABASE_URL` resolves from GitHub Actions.
- Review the first affected-products routine artifact before enabling `--apply-build`.
- Keep `--apply-review` gated behind human artifact review; `dupe` remains excluded by default.
- Wire failure notifications for the nightly serving guard audit.
