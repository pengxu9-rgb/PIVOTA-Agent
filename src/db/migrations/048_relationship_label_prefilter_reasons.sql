-- Phase B v2 builder integration.
--
-- Adds prefilter_reasons to relationship_candidate_labels so the build script
-- (scripts/build-product-relationship-graph.js) can persist the structured
-- reason codes emitted by applyAllGates whenever it routes an edge to
-- label_state='prefilter_rejected'.
--
-- Why a dedicated column (not reused reason_flags): reason_flags carries
-- reviewer-decision flags projected from human_review; prefilter_reasons
-- carries gate-output codes from the automated structural check. Conflating
-- the two would lose the provenance distinction needed for recalibration.

ALTER TABLE relationship_candidate_labels
  ADD COLUMN IF NOT EXISTS prefilter_reasons TEXT[];

CREATE INDEX IF NOT EXISTS idx_rcl_prefilter_reasons
  ON relationship_candidate_labels USING GIN (prefilter_reasons);
