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
The shared scan walks all fresh approved labels by id in batches of 500 and evaluates the
serving guard per batch. It retains only anchor identities and counts for progress, or hidden
ids for coverage. It retries transient errors twice with the audit's pool-reset/backoff policy.
There is no sampling or total-row limit. Id keysets avoid timestamp precision loss.
The sync snapshot begins before renewal; the standalone routine snapshots remain inside its
advisory lock. After is measured after serving audit, including failed thresholds; interrupted
reviews also retain observed progress. A failed snapshot fails the run and leaves unavailable
metrics null. These are observed window changes, not proof of causation if an independent writer
runs concurrently. Distinct anchors are case-folded anchor type/ref identities in the run market.

The review step fails when at least 20 reviews completed and its error fraction is above
0.25, using reviewed_count minus guard_blocked_count minus low_confidence_count as the denominator.
The minimum-count threshold still uses reviewed_count. On a rate-gate failure the audit runs
before the routine reports ai_review as failed, including schema-invalid responses. Exactly 25%, 6%, and fewer than 20 reviews pass this
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
It strips explicit size tokens, Mini/Travel Size/Full Size/Refill and a bracketed brand label.
It never strips for/comma tails from both titles. A strict-prefix match permits a one-sided
for, comma or spaced-dash description after an otherwise exact normalized product title.
Scent/flavour/style siblings are outside this reason; existing variant/shade reasons keep
owning those decisions. Different tails do not become equal.
The exact 30-row sample titles suppress #12 (Find Comfort mist Mini/full listing) and #20
(Saccharomyces toner duplicate listing). All other 28 sample pairs remain accepted, including
#2, #4, #6, #9, #10, #16, #22 and #26. Before this PR, the guard ran only in offline audit/reviewer/renewal/quarantine tools;
the serving reader did not enforce it. This PR adds label_state to the view projection and
filters every unsafe edge before deduplication, family collapse and the caller limit.
The uncollapsed reader fetches 2x the requested limit, capped at 1000 (caller limit <=500).
A fully suppressed fetched window may still return fewer results. It logs dropped_count.
Human approvals remain exempt from AI-only reasons; nested-ref reasons still apply to all labels.

All serving integrations receive filtered edges: server.js injects the reader into intelligence
reads; both relationshipGraphRecall.js paths call it; intelligenceReads.js calls the injected
reader; relationshipEdgeToSignal.js projects those results and does not query the database.
Family collapse can still drop self-family human edges independently of the serving guard.

The supplied 29 production pairs yield 25 suppressions. Rouge Artist For Ever Matte/base and
all three Falscara FOR GOOD style pairs stay available. See the exact title/probe matrix in
[round 5 evidence](relgraph-round5-review-evidence.md). Deployment immediately enforces this
guard on serving, so quarantine must precede gateway deployment as well as nightly re-imaging.

Claude's production rollout order (Codex executes none of these steps):

1. Merge #2337 first; retarget the stacked #2336 to main, merge it and build the combined image. Keep uncovered priority off.
2. With the new image, dry-run quarantine targeting `related_product_same_product_across_listings_or_sizes`; inspect the expected 25 title pairs and any current additional reasons.
3. Quarantine the confirmed rows BEFORE deploying the gateway or re-imaging the nightly job. Run the complete serving audit; existing thresholds remain 25 rows and 1%.
4. Deploy the gateway and re-image the nightly job. Verify review gate/floor settings and audit/new coverage metrics. Retain existing limits, concurrency and timeouts unless deliberately changed.
5. Apply ONLY migration 061 as the job's DATABASE_URL_NOVERIFY role (or explicitly grant INSERT/SELECT to it), register its filename in schema_migrations, and verify table existence and both privileges. Never run npm run db:migrate, which could apply pending 060. Follow the companion rollout document.
6. Arm uncovered priority only after verification. Inspect the next run's error denominator/rate, real write/skip counts, serving audit and newly covered anchors.
