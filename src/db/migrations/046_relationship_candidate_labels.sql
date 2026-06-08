-- 046_relationship_candidate_labels.sql
-- Canonical label store for the SKU relation graph. Supersedes 045.
-- All reviewer decisions land here; runtime view filters to approved+fresh.

DROP TABLE IF EXISTS product_relationship_edges CASCADE;
-- 045 was never applied in prod; this is a no-op there. In staging or
-- dev where 045 might have been applied, this removes the stale table
-- so the view below can take the same name.

CREATE TABLE IF NOT EXISTS relationship_candidate_labels (
  id              TEXT PRIMARY KEY,
  edge_id         TEXT,
  anchor_type     TEXT NOT NULL CHECK (anchor_type IN ('product','need')),
  anchor_ref      TEXT NOT NULL,
  anchor_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  candidate_product_ref TEXT NOT NULL,
  candidate_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  relation_type   TEXT NOT NULL CHECK (relation_type IN
                    ('dupe','competitive_alternative','niche_specialist','related_product')),
  display_label   TEXT,
  market          TEXT NOT NULL,
  vertical        TEXT NOT NULL DEFAULT 'beauty' CHECK (vertical = 'beauty'),
  category_taxonomy JSONB NOT NULL DEFAULT '[]'::jsonb,
  use_case        TEXT,

  label_state     TEXT NOT NULL CHECK (label_state IN (
                    'generated',
                    'prefilter_rejected',
                    'review_ready',
                    'human_approved',
                    'ai_approved',
                    'human_rejected',
                    'needs_evidence'
                  )),

  score_total     DOUBLE PRECISION CHECK (score_total IS NULL OR (score_total >= 0 AND score_total <= 1)),
  score_breakdown JSONB,

  price_evidence  JSONB,
  source_refs     JSONB,
  evidence_grade  TEXT,

  why_candidate   JSONB,
  tradeoffs       JSONB,
  watchouts       JSONB,

  -- Reviewer block (raw and projected)
  human_review    JSONB,
  reason_flags    TEXT[],
  source_report   TEXT,

  provenance      JSONB,

  reviewed_at      TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_rcl_identity
  ON relationship_candidate_labels (
    market, anchor_type, lower(anchor_ref), lower(candidate_product_ref), relation_type
  );
CREATE INDEX idx_rcl_label_state_market ON relationship_candidate_labels (label_state, market);
CREATE INDEX idx_rcl_anchor_lookup ON relationship_candidate_labels (lower(anchor_ref), label_state);
CREATE INDEX idx_rcl_reason_flags ON relationship_candidate_labels USING GIN (reason_flags);

-- Runtime serving view. Code in productRelationshipGraph.js can keep
-- selecting from product_relationship_edges; this view exposes the same
-- column shape listApprovedRelationshipEdgesForAnchor selects.
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
