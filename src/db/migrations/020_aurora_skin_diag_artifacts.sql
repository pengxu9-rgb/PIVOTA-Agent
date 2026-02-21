-- Purpose: Persist skin diagnosis artifacts, ingredient plans, and recommendation runs.
-- Notes:
--  - BFF-first SSOT for skin diagnosis -> ingredient mapping -> product matching.
--  - Keep nullable identity fields to support guest and signed-in flows.

CREATE TABLE IF NOT EXISTS aurora_skin_diagnosis_artifacts (
  artifact_id TEXT PRIMARY KEY,
  aurora_uid TEXT,
  user_id TEXT,
  session_id TEXT,
  artifact_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence_score NUMERIC(5, 4),
  confidence_level TEXT,
  source_mix JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aurora_skin_diag_artifacts_aurora_uid_created
  ON aurora_skin_diagnosis_artifacts(aurora_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aurora_skin_diag_artifacts_user_id_created
  ON aurora_skin_diagnosis_artifacts(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aurora_skin_diag_artifacts_session_id_created
  ON aurora_skin_diagnosis_artifacts(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aurora_ingredient_plans (
  plan_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES aurora_skin_diagnosis_artifacts(artifact_id) ON DELETE CASCADE,
  aurora_uid TEXT,
  user_id TEXT,
  plan_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  intensity TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aurora_ingredient_plans_artifact
  ON aurora_ingredient_plans(artifact_id);

CREATE INDEX IF NOT EXISTS idx_aurora_ingredient_plans_artifact_created
  ON aurora_ingredient_plans(artifact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aurora_reco_runs (
  reco_run_id TEXT PRIMARY KEY,
  artifact_id TEXT REFERENCES aurora_skin_diagnosis_artifacts(artifact_id) ON DELETE SET NULL,
  plan_id TEXT REFERENCES aurora_ingredient_plans(plan_id) ON DELETE SET NULL,
  aurora_uid TEXT,
  user_id TEXT,
  request_context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  reco_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  overall_confidence NUMERIC(5, 4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aurora_reco_runs_aurora_uid_created
  ON aurora_reco_runs(aurora_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aurora_reco_runs_artifact
  ON aurora_reco_runs(artifact_id);

