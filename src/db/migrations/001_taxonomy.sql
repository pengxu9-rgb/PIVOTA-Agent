-- Canonical taxonomy (GLOBAL IDs) + views + localization + mapping + overrides

CREATE TABLE IF NOT EXISTS canonical_category (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  parent_id TEXT NULL REFERENCES canonical_category(id),
  level INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active|deprecated|hidden
  replaced_by_id TEXT NULL REFERENCES canonical_category(id),
  default_image_url TEXT NULL,
  default_priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_category_parent_id ON canonical_category(parent_id);

CREATE TABLE IF NOT EXISTS category_localization (
  category_id TEXT NOT NULL REFERENCES canonical_category(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  display_name TEXT NOT NULL,
  synonyms JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (category_id, locale)
);

CREATE TABLE IF NOT EXISTS taxonomy_view (
  view_id TEXT PRIMARY KEY,
  market TEXT NOT NULL DEFAULT 'GLOBAL',
  status TEXT NOT NULL DEFAULT 'active', -- active|disabled
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- This table acts as both membership + per-view overrides.
CREATE TABLE IF NOT EXISTS taxonomy_view_category (
  view_id TEXT NOT NULL REFERENCES taxonomy_view(view_id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES canonical_category(id) ON DELETE CASCADE,
  visibility_override TEXT NULL, -- visible|hidden|debugOnly
  priority_override INT NULL,
  image_override TEXT NULL,
  display_name_override TEXT NULL,
  synonyms_override JSONB NULL,
  PRIMARY KEY (view_id, category_id)
);

CREATE TABLE IF NOT EXISTS merchant_category_mapping (
  id BIGSERIAL PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  merchant_category_key TEXT NOT NULL,
  path_raw TEXT NULL,
  path_norm TEXT NULL,
  canonical_category_id TEXT NOT NULL REFERENCES canonical_category(id) ON DELETE RESTRICT,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'rule', -- rule|model|manual
  model_version TEXT NULL,
  updated_by TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence JSONB NULL,
  UNIQUE (merchant_id, merchant_category_key)
);

CREATE TABLE IF NOT EXISTS ops_category_override (
  category_id TEXT NOT NULL REFERENCES canonical_category(id) ON DELETE CASCADE,
  pinned BOOLEAN NULL,
  hidden BOOLEAN NULL,
  display_name_override TEXT NULL,
  image_override TEXT NULL,
  priority_boost INT NULL,
  updated_by TEXT NULL,
  reason TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (category_id)
);

CREATE TABLE IF NOT EXISTS creator_category_override (
  creator_id TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES canonical_category(id) ON DELETE CASCADE,
  pinned BOOLEAN NULL,
  hidden BOOLEAN NULL,
  display_name_override TEXT NULL,
  image_override TEXT NULL,
  priority_boost INT NULL,
  updated_by TEXT NULL,
  reason TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (creator_id, category_id)
);

