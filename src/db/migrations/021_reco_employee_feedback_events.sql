-- Purpose: Persist employee feedback events for reco dogfooding and prelabel quality evaluation.

CREATE TABLE IF NOT EXISTS reco_employee_feedback_events (
  id TEXT PRIMARY KEY,
  anchor_product_id TEXT NOT NULL,
  block TEXT NOT NULL,
  candidate_product_id TEXT,
  candidate_name TEXT,
  feedback_type TEXT NOT NULL,
  wrong_block_target TEXT,
  reason_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  was_exploration_slot BOOLEAN NOT NULL DEFAULT false,
  rank_position INTEGER NOT NULL DEFAULT 1,
  pipeline_version TEXT,
  models JSONB,
  request_id TEXT,
  session_id TEXT,
  suggestion_id TEXT,
  llm_suggested_label TEXT,
  llm_confidence DOUBLE PRECISION,
  timestamp_ms BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reco_employee_feedback_anchor_block
  ON reco_employee_feedback_events(anchor_product_id, block);

CREATE INDEX IF NOT EXISTS idx_reco_employee_feedback_candidate
  ON reco_employee_feedback_events(candidate_product_id);

CREATE INDEX IF NOT EXISTS idx_reco_employee_feedback_feedback_type
  ON reco_employee_feedback_events(feedback_type);

CREATE INDEX IF NOT EXISTS idx_reco_employee_feedback_suggestion
  ON reco_employee_feedback_events(suggestion_id);

CREATE INDEX IF NOT EXISTS idx_reco_employee_feedback_timestamp
  ON reco_employee_feedback_events(timestamp_ms DESC);
