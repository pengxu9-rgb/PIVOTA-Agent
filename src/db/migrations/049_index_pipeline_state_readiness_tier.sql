ALTER TABLE IF EXISTS index_pipeline_state
  ADD COLUMN IF NOT EXISTS readiness_tier VARCHAR(64);
