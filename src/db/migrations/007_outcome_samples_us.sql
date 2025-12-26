-- Outcome samples (US-only) for KB iteration workflow.
-- Stores derived-only artifacts and interaction signals per look replicate job.

CREATE TABLE IF NOT EXISTS outcome_samples_us (
  job_id UUID PRIMARY KEY,
  market TEXT NOT NULL CHECK (market = 'US'),
  locale TEXT NOT NULL,
  preference_mode TEXT NOT NULL,
  sample_json JSONB NOT NULL,
  rating INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outcome_samples_us_created_idx
  ON outcome_samples_us (created_at DESC);

CREATE INDEX IF NOT EXISTS outcome_samples_us_rating_idx
  ON outcome_samples_us (rating);

-- Layer2 engine version index for rolling upgrades.
CREATE INDEX IF NOT EXISTS outcome_samples_us_layer2_engine_idx
  ON outcome_samples_us ((sample_json->'engineVersions'->>'layer2'));

-- Useful for querying by techniques/rules (JSONB arrays of objects).
CREATE INDEX IF NOT EXISTS outcome_samples_us_used_techniques_gin_idx
  ON outcome_samples_us USING GIN ((sample_json->'usedTechniques'));

CREATE INDEX IF NOT EXISTS outcome_samples_us_used_rules_gin_idx
  ON outcome_samples_us USING GIN ((sample_json->'usedRules'));

