CREATE TABLE IF NOT EXISTS aurora_ingredient_research_kb (
  kb_key TEXT PRIMARY KEY,
  query_norm TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'EN',
  status TEXT NOT NULL DEFAULT 'ready',
  provider TEXT,
  error_code TEXT,
  ingredient_profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS idx_aurora_ingredient_research_kb_query_lang
  ON aurora_ingredient_research_kb (query_norm, lang);

CREATE INDEX IF NOT EXISTS idx_aurora_ingredient_research_kb_expires_at
  ON aurora_ingredient_research_kb (expires_at);
