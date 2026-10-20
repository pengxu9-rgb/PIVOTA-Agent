# Undoing a night of relationship review

The nightly relgraph-sync review (`scripts/review-relationship-candidate-labels.js`) can write up
to 10,000 labels a night. Since PIVOTA-Agent #2468 every row it writes carries the run id, so one
UPDATE per kind of write returns that run's rows to the review queue.

**An undo returns rows to `generated`; it does not restore them.** It cannot:
- bring back provenance keys the review replaced whole: `ai_review` (approvals), `ai_review_last`
  (negative memos) and `cross_agent_review` (consensus);
- reset the columns the review set: `why_candidate`, `tradeoffs`, `watchouts`, `last_verified_at`,
  `expires_at` and `reviewed_at`.

That is harmless in practice: nothing serves a `generated` label, and the next review overwrites
all of it.

## What each write stamps

| Write | State change | Stamp |
| --- | --- | --- |
| Approval | `generated` -> `ai_approved` | `provenance.ai_review.run_id`, `decision: 'approve'` |
| Serving-guard block | `generated` -> `needs_evidence` | `provenance.review_serving_guard.run_id`, `decision: 'guard_blocked'`; the old flags are kept in `previous_reason_flags` |
| Cross-agent consensus reject / human review | `generated` -> `needs_evidence`, adds flag `cross_agent_rejected` or `cross_agent_human_review` | `provenance.ai_review_run` `{run_id, decision}` |
| Reject / uncertain / low-confidence memo | stays `generated` | `provenance.ai_review_last.run_id` |

## Find the run ids: one per attempt

The id is minted when the routine job's process starts (`relgraph_routine_<timestamp>`, in
`runRoutineJob`). **Every Cloud Run attempt gets its own id**: relgraph-sync runs with
`--max-retries 1`, so a failed night can have two.

The ledger (`relationship_graph_routine_runs`) has the id in two places:
- **`routine_run_id`** is always set;
- **`summary.recommendation_review_batch.review_run_id`** is copied from the review artifact.

The artifact is written only when the review finishes, so after a timeout or crash
`review_run_id` is null even though rows were stamped. Use `routine_run_id`, or read the ids off
the rows themselves:

```sql
SELECT run_id, kind, count(*) FROM (
  SELECT provenance->'ai_review'->>'run_id' AS run_id, 'approve' AS kind FROM relationship_candidate_labels
   WHERE label_state = 'ai_approved' AND updated_at >= :night_start
  UNION ALL
  SELECT provenance->'review_serving_guard'->>'run_id', 'guard_blocked' FROM relationship_candidate_labels
   WHERE label_state = 'needs_evidence' AND updated_at >= :night_start
  UNION ALL
  SELECT provenance->'ai_review_run'->>'run_id', 'consensus' FROM relationship_candidate_labels
   WHERE label_state = 'needs_evidence' AND updated_at >= :night_start
) s WHERE run_id IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2;
```

Run the four queries below **once per attempt id**.

## Undo

Each query is CAS'd on the state the run left the row in, so a label a human has since approved
or rejected is not touched. The guard and consensus undos also **drop their stamp key**. Without
that, re-running an old undo could revert a later night's work on the same row: the row would
still carry the old stamp, plus a newer disposition.

```sql
-- 1. Approvals back to the queue (they leave the rails: serving reads approved states only).
UPDATE relationship_candidate_labels
   SET label_state = 'generated',
       provenance = jsonb_set(provenance, '{ai_review,undone_at}', to_jsonb(now()::text), true),
       updated_at = now()
 WHERE label_state = 'ai_approved' AND provenance->'ai_review'->>'run_id' = :run;

-- 2. Serving-guard blocks back to the queue, with their reason_flags as they were.
UPDATE relationship_candidate_labels
   SET label_state = 'generated',
       reason_flags = ARRAY(SELECT jsonb_array_elements_text(provenance->'review_serving_guard'->'previous_reason_flags')),
       provenance = provenance - 'review_serving_guard',
       updated_at = now()
 WHERE label_state = 'needs_evidence' AND provenance->'review_serving_guard'->>'run_id' = :run;

-- 3. Consensus dispositions back to the queue, without the flag they added.
UPDATE relationship_candidate_labels
   SET label_state = 'generated',
       reason_flags = array_remove(array_remove(reason_flags, 'cross_agent_rejected'), 'cross_agent_human_review'),
       provenance = provenance - 'ai_review_run' - 'cross_agent_review',
       updated_at = now()
 WHERE label_state = 'needs_evidence' AND provenance->'ai_review_run'->>'run_id' = :run;

-- 4. Negative memos (they only defer re-review for 30 days).
UPDATE relationship_candidate_labels
   SET provenance = provenance - 'ai_review_last'
 WHERE label_state = 'generated' AND provenance->'ai_review_last'->>'run_id' = :run;
```

Re-running the approval undo is safe: a later approval replaces `ai_review` whole, with its own
run id.

The consensus undo removes both cross-agent flags even if the row carried one before the run. Only
consensus adds these flags, so that is only possible for a row consensus had already reviewed.

Prod writes go through the coordinator. Announce the undo to the relgraph lane owner, and run it as
a one-off job (`scripts/ops/run_oneoff_job.sh` in pivota-backend), never from a laptop.
