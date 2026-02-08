-- Purpose: Aurora dupe/comparable KB cache (validated once, reused)
-- Table:
--   - aurora_dupe_kb: key -> { original, dupes, comparables } with verification metadata

CREATE TABLE IF NOT EXISTS aurora_dupe_kb (
  kb_key TEXT PRIMARY KEY,
  original JSONB,
  dupes JSONB NOT NULL DEFAULT '[]'::jsonb,
  comparables JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  verified_by TEXT,
  source TEXT,
  source_meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aurora_dupe_kb_verified
  ON aurora_dupe_kb(verified, updated_at DESC);

