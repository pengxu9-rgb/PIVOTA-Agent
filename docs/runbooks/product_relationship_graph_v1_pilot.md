# Product Relationship Graph V1 Pilot Runbook

This runbook keeps V1 data production offline, reviewed, and feature-flagged. Runtime agents should only see graph candidates after approved, fresh labels have been written to `relationship_candidate_labels` and have passed the runtime serving guard.

## Scope

- Vertical: beauty only
- Pilot market: `US`
- Pilot size: 200 product anchors
- Runtime flag: `AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED=false` until dogfood approval
- Source of truth: `relationship_candidate_labels`
- Legacy compatibility: `aurora_dupe_kb` can remain a cache/source, but it is not the approval authority

## 1. Build Dry-Run Candidates

```bash
node scripts/build-product-relationship-graph.js \
  --limit 200 \
  --market US \
  --out reports/product_relationship_graph/pilot_200_dry_run.json
```

Expected output:

- `summary.anchor_count` is 200 when enough source products exist
- `edges` contains pending graph edges
- `review_packets` contains the human review queue
- No DB writes happen unless `--apply` is passed

## 2. Audit Before Review

```bash
node scripts/audit-product-relationship-graph.js \
  --report reports/product_relationship_graph/pilot_200_dry_run.json \
  --out reports/product_relationship_graph/pilot_200_audit.json \
  --markdown reports/product_relationship_graph/pilot_200_audit.md
```

Hard failures must be zero before review:

- Same-brand `dupe` or `competitive_alternative`
- On-page-related `dupe` or `competitive_alternative`
- Duplicate anchor/candidate/relation/market identity
- Dupe without candidate price or price observed within 14 days
- Missing category/use-case evidence
- Missing source refs
- Unsupported treatment, endorsement, or identical-formula claims

## 3. Human Review

Reviewers should approve only edges with enough evidence to recommend safely.

Decision records should include:

```json
{
  "edge_id": "prel_example",
  "decision": "approved",
  "reviewer": "human@example.com",
  "reviewed_at": "2026-05-25T00:00:00.000Z",
  "expires_at": "2026-06-24T00:00:00.000Z"
}
```

Use `decision: rejected` when the candidate is weak, same-brand competitive, unsupported, stale, or not category-aligned.

## 4. Publish Approved Edges

Dry-run first:

```bash
node scripts/publish-product-relationship-graph-review.js \
  --report reports/product_relationship_graph/pilot_200_dry_run.json \
  --decisions reports/product_relationship_graph/pilot_200_decisions.jsonl \
  --out reports/product_relationship_graph/pilot_200_publish_dry_run.json
```

Apply only after dry-run summary is clean:

```bash
node scripts/publish-product-relationship-graph-review.js \
  --report reports/product_relationship_graph/pilot_200_dry_run.json \
  --decisions reports/product_relationship_graph/pilot_200_decisions.jsonl \
  --apply \
  --out reports/product_relationship_graph/pilot_200_publish_apply.json
```

## 5. Pilot Acceptance

The pilot is ready for dogfood when:

- 200 anchors processed
- At least 70% of anchors have one approved alternative
- At least 100 approved niche-specialist edges
- Human top-3 accept rate is at least 85% on reviewed dupe/alternative candidates
- Unsupported-claim audit is 0
- Expired or stale edges are excluded from runtime

## 6. Runtime Enablement

Enable only for dogfood/internal traffic first:

```bash
AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED=true
```

Keep current Aurora router hard gates active. Graph candidates must still pass same-brand, category, source, and price rules before appearing in competitor or dupe blocks.

## 7. Routine Build After Merchant Sync Or Brand Crawl

Use the routine job whenever new merchant products are integrated, existing products are resynced, or a crawler imports a brand that was not already in catalog. The routine accepts the affected-products manifest emitted by catalog sync, refreshes product beauty attribute signature IDs for those products, builds only affected anchors, validates preflight, runs AI review, and audits what would be served.

Preferred operator wrapper:

```bash
npm run relgraph:sync-routine -- \
  --cutoff 2026-06-08T00:00:00Z \
  --market US \
  --external-product-ids seed_123,seed_456 \
  --out-dir reports/product_relationship_graph/sync_routine_YYYYMMDD
```

This wrapper creates `affected-products.json` from catalog sync dry-run output, then runs the relationship graph routine with production gates enabled by default:

- Postgres advisory lock (`--db-lock`)
- stale local-lock recovery (`--lock-stale-after-minutes 180`)
- aggregate suppression thresholds (`--max-serving-suppressed-pct 1`, `--max-serving-suppressed-rows 25`)
- critical reason gating for `ai_approved_dupe_quarantined`, `candidate_ref_unresolvable_nested_product_prefix`, and `anchor_ref_unresolvable_nested_product_prefix`

For already-synced products, pass an existing affected manifest:

```bash
npm run relgraph:sync-routine -- \
  --cutoff 2026-06-08T00:00:00Z \
  --market US \
  --affected-products-file reports/product_relationship_graph/affected-products.json \
  --out-dir reports/product_relationship_graph/sync_routine_YYYYMMDD
```

The GitHub workflows `External Seed Create From Brand` and `External Seed Create Reviewed Retailer Offer` can run this handoff after a confirmed seed apply. Set `dry_run=false`, `run_relgraph_routine=true`, and provide `relgraph_cutoff`. Those workflows extract applied external product IDs, apply catalog sync to produce an affected-products manifest, then run the relationship graph routine in graph dry-run mode with the production gates.

Write modes stay explicit. When the wrapper receives external product IDs, graph writes require catalog sync writes in the same run; otherwise use an existing affected manifest from an already-applied sync:

```bash
npm run relgraph:sync-routine -- \
  --cutoff 2026-06-08T00:00:00Z \
  --market US \
  --external-product-ids seed_123,seed_456 \
  --apply-sync \
  --apply-build \
  --confirm APPLY_RELGRAPH_SYNC_ROUTINE \
  --out-dir reports/product_relationship_graph/sync_routine_apply_YYYYMMDD
```

When `scripts/run-pdp-quality-upgrade-loop.cjs` is the orchestrator, keep its default behavior unless the loop is already running in confirmed write mode and serving sync is enabled. To run the relationship graph follow-up from the loop's generated affected manifest:

```bash
node scripts/run-pdp-quality-upgrade-loop.cjs \
  --write \
  --confirm RUN_PDP_QUALITY_UPGRADE_LOOP_V1 \
  --run-relgraph-routine \
  --relgraph-cutoff 2026-06-08T00:00:00Z
```

The loop writes `*_affected_products.json` beside the serving sync artifact, then calls `relgraph:sync-routine` from that manifest. Add `--relgraph-apply-build` or `--relgraph-apply-review` only after a clean dry-run artifact has been reviewed.

When syncing external seeds into catalog, write the affected manifest:

```bash
node scripts/sync-external-seeds-to-catalog.cjs \
  --market US \
  --affected-products-out reports/product_relationship_graph/affected-products.json
```

Run the relationship graph routine in dry-run mode first:

```bash
npm run relgraph:routine -- \
  --cutoff 2026-06-08T00:00:00Z \
  --market US \
  --affected-products-file reports/product_relationship_graph/affected-products.json \
  --db-lock \
  --lock-stale-after-minutes 180 \
  --fail-on-serving-suppression-reasons ai_approved_dupe_quarantined,candidate_ref_unresolvable_nested_product_prefix,anchor_ref_unresolvable_nested_product_prefix \
  --max-serving-suppressed-pct 1 \
  --max-serving-suppressed-rows 25
```

Apply generated labels only after the dry-run summary is clean:

```bash
npm run relgraph:routine -- \
  --cutoff 2026-06-08T00:00:00Z \
  --market US \
  --affected-products-file reports/product_relationship_graph/affected-products.json \
  --apply-build \
  --confirm APPLY_RELGRAPH_ROUTINE \
  --db-lock \
  --lock-stale-after-minutes 180 \
  --fail-on-serving-suppression-reasons ai_approved_dupe_quarantined,candidate_ref_unresolvable_nested_product_prefix,anchor_ref_unresolvable_nested_product_prefix \
  --max-serving-suppressed-pct 1 \
  --max-serving-suppressed-rows 25
```

Apply AI approvals only after the review artifact has been inspected. AI review excludes `dupe` by default.

```bash
npm run relgraph:routine -- \
  --cutoff 2026-06-08T00:00:00Z \
  --market US \
  --affected-products-file reports/product_relationship_graph/affected-products.json \
  --apply-build \
  --apply-review \
  --confirm APPLY_RELGRAPH_ROUTINE \
  --db-lock \
  --lock-stale-after-minutes 180 \
  --fail-on-serving-suppression-reasons ai_approved_dupe_quarantined,candidate_ref_unresolvable_nested_product_prefix,anchor_ref_unresolvable_nested_product_prefix \
  --max-serving-suppressed-pct 1 \
  --max-serving-suppressed-rows 25
```

Expected routine artifacts:

- `routine_summary.json`: step status, command tails, lock path, failure step
- `product_beauty_attribute_sig_refresh.json`: dry-run or apply result for PBA `sig_id` alignment
- `relationship_graph_build.json`: generated candidate labels for affected anchors
- `relationship_graph_preflight_validation.json`: incoherence and safety validation
- `relationship_graph_ai_review.json`: AI approval/rejection decisions
- `relationship_graph_serving_guard_audit.json`: runtime guard suppression summary

Operational notes:

- The routine is dry-run by default. Writes require `--apply-build` and/or `--apply-review` plus `--confirm APPLY_RELGRAPH_ROUTINE`.
- A local single-flight lock is acquired by default at `reports/relationship_graph_routine.lock` when the default report directory is used. For cron or CI, also use `--db-lock` and `--lock-stale-after-minutes`; pass `--db-lock-key` only when intentionally isolating independent graph jobs.
- Serving audit thresholds fail the routine after the audit step if approved rows would be suppressed above the configured row or percent limit.
- Critical serving suppression reasons should also fail cron even at low volume. Keep `ai_approved_dupe_quarantined`, `candidate_ref_unresolvable_nested_product_prefix`, and `anchor_ref_unresolvable_nested_product_prefix` in `--fail-on-serving-suppression-reasons` unless a human is running a one-off diagnosis.
- If catalog sync cannot emit a manifest, scope the routine with `--affected-refs`, `--affected-refs-file`, `--external-product-ids-file`, `--sig-ids-file`, or `--content-keys-file`. Automatic PBA signature refresh runs only when the routine receives an affected-products manifest, external product IDs, or signature IDs.
- Do not widen runtime flags when `routine_summary.json.ok` is false or when the serving audit shows unexpected suppressed approved edges.
- The scheduled `Relationship Graph Serving Guard Audit` workflow runs daily against production with zero-suppression defaults. If it fails, inspect `serving_guard_audit.json` and run the quarantine dry-run below before considering any runtime flag change.

## 8. Quarantine Unsafe Approved Rows

When the serving guard audit fails, quarantine active `ai_approved` rows that the runtime would suppress before widening flags.

Dry-run first:

```bash
npm run relgraph:quarantine-serving-unsafe -- \
  --market US \
  --db-lock \
  --out reports/product_relationship_graph/quarantine_serving_unsafe_dry_run.json \
  --audit-run-id relgraph_routine_YYYYMMDDTHHMMSS
```

Apply only after reviewing the dry-run:

```bash
npm run relgraph:quarantine-serving-unsafe -- \
  --market US \
  --db-lock \
  --out reports/product_relationship_graph/quarantine_serving_unsafe_apply.json \
  --audit-run-id relgraph_routine_YYYYMMDDTHHMMSS \
  --apply \
  --confirm QUARANTINE_RELGRAPH_UNSAFE_APPROVED
```

Default behavior:

- Only active `ai_approved` labels are considered.
- Matching rows move to `needs_evidence`, get `expires_at = now()`, and receive `serving_guard:*` reason flags plus quarantine provenance.
- Use `--include-human-approved` only for a manual repair run.
- Use `--mode expire` only when you want to preserve the approved label state while making rows non-serving.
