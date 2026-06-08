-- 053_relationship_candidate_labels_ai_approved.sql
-- Runtime serving now admits guarded ai_approved rows from
-- relationship_candidate_labels. Keep fresh/staging/prod schema compatible
-- by replacing the prior label_state check constraint with the expanded set.

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname
  INTO constraint_name
  FROM pg_constraint con
  WHERE con.conrelid = 'relationship_candidate_labels'::regclass
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%label_state%'
  ORDER BY con.conname
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE relationship_candidate_labels DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE relationship_candidate_labels
  ADD CONSTRAINT relationship_candidate_labels_label_state_check
  CHECK (label_state IN (
    'generated',
    'prefilter_rejected',
    'review_ready',
    'human_approved',
    'ai_approved',
    'human_rejected',
    'needs_evidence'
  ));

CREATE INDEX IF NOT EXISTS idx_rcl_serving_market_state_fresh
  ON relationship_candidate_labels (market, vertical, label_state, expires_at, last_verified_at)
  WHERE label_state IN ('human_approved','ai_approved')
    AND last_verified_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rcl_serving_anchor_fresh
  ON relationship_candidate_labels (market, lower(anchor_ref), label_state, score_total DESC, updated_at DESC)
  WHERE label_state IN ('human_approved','ai_approved')
    AND last_verified_at IS NOT NULL;

CREATE OR REPLACE VIEW product_relationship_edges AS
SELECT
  id, edge_id, anchor_type, anchor_ref, anchor_snapshot,
  candidate_product_ref, candidate_snapshot, relation_type,
  display_label, market, vertical, category_taxonomy, use_case,
  'approved'::text AS review_status,
  score_total, score_breakdown, price_evidence, source_refs, evidence_grade,
  why_candidate, tradeoffs, watchouts, provenance,
  last_verified_at, expires_at, created_at, updated_at
FROM relationship_candidate_labels
WHERE label_state IN ('human_approved','ai_approved')
  AND last_verified_at IS NOT NULL
  AND expires_at > now();
