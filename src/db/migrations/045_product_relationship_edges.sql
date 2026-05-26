-- Purpose: reviewed beauty product relationship graph for dupes, alternatives, niche specialists, and related products.

CREATE TABLE IF NOT EXISTS product_relationship_edges (
  id TEXT PRIMARY KEY,
  anchor_type TEXT NOT NULL,
  anchor_ref TEXT NOT NULL,
  anchor_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  candidate_product_ref TEXT NOT NULL,
  candidate_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  relation_type TEXT NOT NULL,
  display_label TEXT,
  market TEXT NOT NULL DEFAULT 'US',
  vertical TEXT NOT NULL DEFAULT 'beauty',
  category_taxonomy JSONB NOT NULL DEFAULT '[]'::jsonb,
  use_case TEXT NOT NULL DEFAULT '',
  score_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  score_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  price_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_grade TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  why_candidate JSONB NOT NULL DEFAULT '{}'::jsonb,
  tradeoffs JSONB NOT NULL DEFAULT '[]'::jsonb,
  watchouts JSONB NOT NULL DEFAULT '[]'::jsonb,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_relationship_edges_anchor_type_chk
    CHECK (anchor_type IN ('product', 'need')),
  CONSTRAINT product_relationship_edges_relation_type_chk
    CHECK (relation_type IN ('dupe', 'competitive_alternative', 'niche_specialist', 'related_product')),
  CONSTRAINT product_relationship_edges_review_status_chk
    CHECK (review_status IN ('pending', 'approved', 'rejected', 'expired')),
  CONSTRAINT product_relationship_edges_score_total_chk
    CHECK (score_total >= 0 AND score_total <= 1),
  CONSTRAINT product_relationship_edges_vertical_chk
    CHECK (vertical = 'beauty')
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_product_relationship_edges_identity
  ON product_relationship_edges (
    lower(market),
    anchor_type,
    lower(anchor_ref),
    lower(candidate_product_ref),
    relation_type
  );

CREATE INDEX IF NOT EXISTS idx_product_relationship_edges_anchor_runtime
  ON product_relationship_edges (
    anchor_type,
    lower(anchor_ref),
    lower(market),
    review_status,
    score_total DESC
  );

CREATE INDEX IF NOT EXISTS idx_product_relationship_edges_candidate
  ON product_relationship_edges (lower(candidate_product_ref), updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_relationship_edges_staleness
  ON product_relationship_edges (review_status, expires_at, last_verified_at);

