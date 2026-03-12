CREATE TABLE IF NOT EXISTS external_seed_audit_runs (
  audit_run_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  market TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  flagged_rows INTEGER NOT NULL DEFAULT 0,
  findings_total INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_seed_audit_runs_market_created_at_idx
  ON external_seed_audit_runs (market, created_at DESC);

CREATE TABLE IF NOT EXISTS external_seed_audit_findings (
  id BIGSERIAL PRIMARY KEY,
  audit_run_id TEXT NOT NULL REFERENCES external_seed_audit_runs(audit_run_id) ON DELETE CASCADE,
  seed_id TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  market TEXT NOT NULL DEFAULT '',
  canonical_url TEXT NOT NULL DEFAULT '',
  anomaly_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  evidence JSONB,
  recommended_action TEXT NOT NULL DEFAULT '',
  auto_fixable BOOLEAN NOT NULL DEFAULT FALSE,
  last_extracted_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_seed_audit_findings_run_idx
  ON external_seed_audit_findings (audit_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS external_seed_audit_findings_seed_idx
  ON external_seed_audit_findings (seed_id, created_at DESC);

CREATE TABLE IF NOT EXISTS external_seed_corrections (
  correction_id TEXT PRIMARY KEY,
  seed_id TEXT NOT NULL,
  audit_run_id TEXT REFERENCES external_seed_audit_runs(audit_run_id) ON DELETE SET NULL,
  correction_type TEXT NOT NULL,
  status TEXT NOT NULL,
  auto_applied BOOLEAN NOT NULL DEFAULT FALSE,
  before_payload JSONB,
  after_payload JSONB,
  applied_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_seed_corrections_seed_idx
  ON external_seed_corrections (seed_id, created_at DESC);

CREATE INDEX IF NOT EXISTS external_seed_corrections_run_idx
  ON external_seed_corrections (audit_run_id, created_at DESC);
