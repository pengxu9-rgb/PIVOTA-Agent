# Truthful relgraph progress and quality rollout

Builder `applied_count` and `written_count` count only label rows returned by INSERT/UPDATE.
`skipped_protected_count` includes both conflict no-ops and protected rows omitted by fan-in
selection/recount. The requested id/edge_id/label_state return fields remain unchanged for
existing callers. The review publisher handles an explicit `written:false`; review and renewal
already inspect returned rows or affected-row counts. Review `applied_count` now includes actual
approval and guard-quarantine writes; `approved_applied_count` retains the approval-only count.
The ledger's aggregate applied count still includes renewal. It is a write total, not coverage.

Routine summaries and the existing ledger summary JSONB store `served_edges_before/after`,
`distinct_anchors_served_before/after`, `anchors_newly_covered`, `approved_count`,
`review_error_count`, `review_error_rate`, and `guard_blocked_count`. No migration is added.
Fresh approved rows are filtered through the shared serving guard, with no sampling or limit.
The sync snapshot begins before renewal; the standalone routine snapshots remain inside its
advisory lock. After is measured after serving audit, including failed thresholds; interrupted
reviews also retain observed progress. A failed snapshot fails the run and leaves unavailable
metrics null. These are observed window changes, not proof of causation if an independent writer
runs concurrently. Distinct anchors are case-folded anchor type/ref identities in the run market.

The review step fails when at least 20 reviews completed and its raw error fraction is above
0.25, including schema-invalid responses. Exactly 25%, 6%, and fewer than 20 reviews pass this
gate; the separate transport breaker still fails on sustained timeout/request failures.
`--min-reviews-for-error-gate` and `--max-review-error-rate` override the thresholds.
Cron forwards `RELGRAPH_SYNC_MAX_REVIEW_ERROR_RATE` (and the optional
`RELGRAPH_SYNC_MIN_REVIEWS_FOR_ERROR_GATE`) through sync to routine-job.
With Cloud Run `--max-retries 1`, a failed step reruns the whole task. This is acceptable;
protected states are preserved and the ledger reports actual writes on each run.

`MIN_AI_APPROVAL_CONFIDENCE=0.70` is checked before promotion and inside applyApproval.
`--min-approval-confidence` is clamped to 0.5..0.99; cron optionally forwards
`RELGRAPH_SYNC_MIN_APPROVAL_CONFIDENCE`. Confidence is checked before rounding. An approve below
the floor stays generated with verdict `low_confidence`, included in the summary and replayable
without promotion. Claude's verified production facts: all 6,787 live AI approvals are >=0.70,
so the default floor changes none of today's live approvals.

The shared reason `related_product_same_product_across_listings_or_sizes` applies only to
AI-approved related_product edges, consistent with existing related-product reasons. It requires
a same-brand match after case folding and preserves formulation, percentage and SPF tokens.
It strips explicit sizes and marketing tails; a size listing can match the other listing's
explicit descriptive suffix. It does not fuzzy-match arbitrary common prefixes.
The exact 30-row sample titles suppress #12 (Find Comfort mist Mini/full listing) and #20
(Saccharomyces toner duplicate listing). All other 28 sample pairs remain accepted, including
#2, #4, #6, #9, #10, #16, #22 and #26. These rules apply automatically to reviewer pre-check,
serving reads, renewal and reason-targeted quarantine, through the existing single owner.

Claude's production rollout order (Codex executes none of these steps):

1. Merge/rebase both code PRs as needed, build the combined image and keep uncovered priority off.
2. BEFORE re-imaging the nightly job, run quarantine dry-run with that image and
   `--reasons related_product_same_product_across_listings_or_sizes`; inspect examples/counts.
3. Quarantine the newly hidden rows in the same window, as for the 252 variant siblings on 09-30.
   Run serving audit with the new image and confirm suppression stays within 25 rows and 1%.
4. Re-image the nightly job and verify the new review gate/floor settings. Retain the existing
   write approvals, limits, concurrency and timeout unless Claude deliberately changes them.
5. Apply ONLY migration 061 in one operator transaction and register its exact filename in
   schema_migrations, then confirm to_regclass. Do not run npm run db:migrate in production,
   which has DB_AUTO_MIGRATE=false and would also apply pending 060. See the uncovered-priority
   rollout document in the companion PR for the SQL. Arm uncovered priority only after verification.
6. Inspect the next run's error rate, real write/skip counts, serving audit and newly-covered anchors.
