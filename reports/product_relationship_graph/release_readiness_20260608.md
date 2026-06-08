# Relationship Graph Production Readiness - 2026-06-08

## Production Evidence

Historical production evidence collected before rebuilding this clean branch:

- `053_relationship_candidate_labels_ai_approved.sql` from the prior branch was applied in production on 2026-06-08.
- The first guarded production dry-run failed closed on serving-suppression thresholds, as designed.
- Unsafe active `ai_approved` rows were quarantined out of serving:
  - Initial dry-run found 2,299 unsafe approved rows.
  - A partial apply completed before the public DB connection dropped; the remaining dry-run delta inferred 1,111 rows applied.
  - The remaining batched apply completed 1,188 rows.
- Post-quarantine serving audit passed with 8,404 total rows, 8,404 safe rows, and 0 suppressed rows.
- Post-quarantine production routine dry-run passed:
  - build: 200 anchors, 1,761 dry-run edges, 0 applied
  - preflight: passed
  - AI review: passed, 0 reviewed for cutoff
  - serving guard audit: passed thresholds
- Tiny affected-products production dry-run stand-in for GitHub workflow dispatch passed:
  - run id: `relgraph_sync_routine_20260608T042939`
  - products: `ext_26307f21022853e886a7f210`, `ext_7f3fcd8b1ea9a9c48026e3ff`
  - catalog sync dry-run: passed, affected product count 2
  - DB advisory lock: acquired by routine
  - PBA signature refresh: passed dry-run
  - build: passed, 2 anchors, 0 edges, 0 applied
  - preflight: passed
  - AI review: passed, 0 reviewed for cutoff
  - serving guard audit: passed thresholds, 8,404 safe rows, 0 suppressed

## Clean Branch Scope

This clean branch is rebuilt from `origin/main` and intentionally excludes the older conflicted branch history.

- Adds relationship graph sync/routine workflows:
  - `.github/workflows/relationship-graph-serving-guard-audit.yml`
  - `.github/workflows/relationship-graph-sync-routine.yml`
- Adds routine, audit, quarantine, PBA refresh, and AI review scripts.
- Adds production package scripts:
  - `relgraph:routine`
  - `relgraph:sync-routine`
  - `relgraph:serving-audit`
  - `relgraph:pba-sig-refresh`
  - `relgraph:quarantine-serving-unsafe`
- Adds `053_pba_sig_id.sql` so `product_beauty_attributes` can resolve `sig_*` refs.
- Adds affected-products manifest output from catalog sync and scoped relationship-graph build inputs.
- Adds serving-suppression helpers for audit/quarantine gates.
- Adds focused unit coverage for the new routine layer and touched graph/PBA paths.

## Validation

Clean branch validation:

- `git diff --check`
- Focused relgraph/PBA Jest set:
  - 10 suites passed
  - 135 tests passed
- Broader relgraph Jest set:
  - 15 suites passed
  - 234 tests passed

Command used from the clean worktree:

```sh
NODE_PATH=/Users/pengchydan/dev/PIVOTA-Agent/node_modules /Users/pengchydan/dev/PIVOTA-Agent/node_modules/.bin/jest tests/scripts/run_relationship_graph_sync_routine.test.js tests/scripts/run_relationship_graph_routine_job.test.js tests/scripts/quarantine_relationship_graph_serving_unsafe.test.js tests/scripts/audit_relationship_graph_serving_guard.test.js tests/scripts/refresh_product_beauty_attribute_sig_ids.test.js tests/scripts/review_relationship_candidate_labels.test.js tests/scripts/build_product_relationship_graph.test.js tests/scripts/sync_external_seeds_to_catalog.test.js tests/product_relationship_graph.test.js tests/product_relationship_graph_builder.test.js tests/product_relationship_graph_sources.test.js tests/product_relationship_graph_preflight.test.js tests/product_beauty_attributes_sig_lookup.test.js tests/services/relationship_graph_recall.test.js tests/services/discovery_relationship_graph_recall.test.js --runInBand
```

## Remaining Rollout Steps

- Merge the clean PR first. GitHub Actions cannot manually dispatch a workflow file until that workflow exists on the default branch.
- Confirm the production GitHub environment exposes `DATABASE_URL`.
- Dispatch `relationship-graph-sync-routine.yml` in dry-run mode for a small affected-products set.
- Review artifacts before enabling `--apply-build`.
- Keep `--apply-review` gated behind human artifact review; `dupe` remains excluded by default.
- Wire notifications for the nightly serving guard audit.
