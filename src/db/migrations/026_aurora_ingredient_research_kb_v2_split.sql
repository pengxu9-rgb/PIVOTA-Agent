ALTER TABLE IF EXISTS aurora_ingredient_research_kb
  ADD COLUMN IF NOT EXISTS kb_layer TEXT NOT NULL DEFAULT 'generic',
  ADD COLUMN IF NOT EXISTS variant_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_aurora_ingredient_research_kb_layer_variant
  ON aurora_ingredient_research_kb (query_norm, lang, kb_layer, variant_key);

CREATE INDEX IF NOT EXISTS idx_aurora_ingredient_research_kb_revision
  ON aurora_ingredient_research_kb (revision DESC);
