-- Purpose: Persist LLM pre-label suggestions for Aurora reco dogfooding review queue.

CREATE TABLE IF NOT EXISTS reco_label_suggestions (
  id TEXT PRIMARY KEY,
  anchor_product_id TEXT NOT NULL,
  block TEXT NOT NULL,
  candidate_product_id TEXT NOT NULL,
  suggested_label TEXT NOT NULL,
  wrong_block_target TEXT,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  rationale_user_visible TEXT NOT NULL DEFAULT '',
  flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_name TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  request_id TEXT,
  session_id TEXT,
  snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reco_label_suggestions_anchor_block
  ON reco_label_suggestions(anchor_product_id, block);

CREATE INDEX IF NOT EXISTS idx_reco_label_suggestions_candidate
  ON reco_label_suggestions(candidate_product_id);

CREATE INDEX IF NOT EXISTS idx_reco_label_suggestions_confidence
  ON reco_label_suggestions(confidence DESC);

CREATE INDEX IF NOT EXISTS idx_reco_label_suggestions_input_hash
  ON reco_label_suggestions(input_hash);

CREATE INDEX IF NOT EXISTS idx_reco_label_suggestions_created_at
  ON reco_label_suggestions(created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_reco_label_suggestions_input_model_prompt_block
  ON reco_label_suggestions(input_hash, model_name, prompt_version, block);
