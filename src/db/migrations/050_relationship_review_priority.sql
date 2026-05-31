-- 050_relationship_review_priority.sql
-- Lever-2: per-candidate predicted P(human approves), used to RANK the
-- review-pending (label_state='generated') queue highest-yield-first.
--
-- Populated by scripts/score-relationship-review-priority.js from the model in
-- src/auroraBff/relationshipReviewPriorityModel.json. Ranking aid only — does
-- NOT auto-promote (CV AUC 0.738, precision@top-5%=0.75, below the auto-promote
-- bar). NULL = not yet scored; order NULLS LAST.
--
-- Distinct from score_total (retrieval similarity, saturated ~1.0) and from the
-- preflight gates (hard structural rejects). This is a soft ordering signal.

ALTER TABLE relationship_candidate_labels
  ADD COLUMN IF NOT EXISTS review_priority NUMERIC
    CHECK (review_priority IS NULL OR (review_priority >= 0 AND review_priority <= 1));

-- Partial index: the review queue only ever orders the 'generated' rows.
CREATE INDEX IF NOT EXISTS idx_rcl_review_priority
  ON relationship_candidate_labels (review_priority DESC NULLS LAST)
  WHERE label_state = 'generated';
