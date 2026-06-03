-- 051_product_relationship_edges_ai_label_state.sql
-- Reconcile the relationship graph serving view with prod-approved labels and
-- expose label_state for read-time family-collapse ranking.

DO $$
DECLARE
  label_state_constraint TEXT;
BEGIN
  FOR label_state_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = to_regclass('relationship_candidate_labels')
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%label_state%'
  LOOP
    EXECUTE format(
      'ALTER TABLE relationship_candidate_labels DROP CONSTRAINT %I',
      label_state_constraint
    );
  END LOOP;
END $$;

ALTER TABLE IF EXISTS relationship_candidate_labels
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

CREATE OR REPLACE VIEW product_relationship_edges AS
SELECT
  id,
  edge_id,
  anchor_type,
  anchor_ref,
  anchor_snapshot,
  candidate_product_ref,
  candidate_snapshot,
  relation_type,
  display_label,
  market,
  vertical,
  category_taxonomy,
  use_case,
  'approved'::text AS review_status,
  score_total,
  score_breakdown,
  price_evidence,
  source_refs,
  evidence_grade,
  why_candidate,
  tradeoffs,
  watchouts,
  provenance,
  last_verified_at,
  expires_at,
  created_at,
  updated_at,
  label_state
FROM relationship_candidate_labels
WHERE (label_state = ANY (ARRAY['human_approved', 'ai_approved']))
  AND (expires_at IS NULL OR expires_at > now());
