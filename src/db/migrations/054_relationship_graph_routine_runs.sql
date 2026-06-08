-- 054_relationship_graph_routine_runs.sql
-- Persistent audit ledger for scheduled relationship graph routines. Railway
-- cron logs and /tmp artifacts are ephemeral; this table keeps run status and
-- compact operational counters queryable from production Postgres.

CREATE TABLE IF NOT EXISTS relationship_graph_routine_runs (
  run_id TEXT PRIMARY KEY,
  run_kind TEXT NOT NULL DEFAULT 'sync_routine'
    CHECK (run_kind IN ('sync_routine', 'routine', 'cron')),
  trigger TEXT NOT NULL DEFAULT '',
  parent_run_id TEXT,
  routine_run_id TEXT,
  market TEXT NOT NULL DEFAULT 'US',
  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('passed', 'failed', 'skipped', 'unknown')),
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  apply_sync BOOLEAN NOT NULL DEFAULT FALSE,
  apply_build BOOLEAN NOT NULL DEFAULT FALSE,
  apply_review BOOLEAN NOT NULL DEFAULT FALSE,
  cutoff TIMESTAMPTZ,
  selector_updated_since TIMESTAMPTZ,
  selector_sources TEXT[] NOT NULL DEFAULT '{}'::text[],
  selector_limit INTEGER,
  affected_count INTEGER,
  anchor_count INTEGER,
  edge_count INTEGER,
  rejected_count INTEGER,
  reviewed_count INTEGER,
  approved_count INTEGER,
  review_rejected_count INTEGER,
  applied_count INTEGER,
  serving_total_rows INTEGER,
  serving_safe_rows INTEGER,
  serving_suppressed_rows INTEGER,
  serving_suppressed_pct DOUBLE PRECISION,
  db_lock_requested BOOLEAN NOT NULL DEFAULT FALSE,
  db_lock_acquired BOOLEAN NOT NULL DEFAULT FALSE,
  failed_step TEXT,
  out_dir TEXT,
  summary_path TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_relgraph_runs_market_generated
  ON relationship_graph_routine_runs (market, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_relgraph_runs_status_generated
  ON relationship_graph_routine_runs (status, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_relgraph_runs_trigger_generated
  ON relationship_graph_routine_runs (trigger, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_relgraph_runs_failed_step_generated
  ON relationship_graph_routine_runs (failed_step, generated_at DESC)
  WHERE failed_step IS NOT NULL;
