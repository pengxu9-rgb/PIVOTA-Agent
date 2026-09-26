-- Durable candidate-pool cache for the Aurora reco recall lane (read-through, best-effort).
--
-- Every cache on this path today is in-process, so a deploy wipes it -- and this service deploys ~20
-- times a day. Postgres is the only store that survives a deploy, which is why the pool lives here.
--
-- `cache_key` is a SHA-256 of the normalized recall shape (the planned query strings, the resolved
-- step family, lang, catalog surface, planner mode). The caller's free text is NEVER stored: only its
-- hash reaches this table, and `payload` carries catalog candidate fields only -- no buyer text, no
-- uid, no session. This is a SHARED GLOBAL cache; nothing caller-scoped may enter it.
--
-- TTL is enforced in JS against `refreshed_at` (see src/auroraBff/recoRecallPoolCache.js), matching
-- external_offers_cache. `candidate_count` is stored so an EMPTY pool can be given a short negative
-- lease without deserializing the payload.

CREATE TABLE IF NOT EXISTS reco_recall_pool_cache (
  cache_key       text        PRIMARY KEY,
  step_family     text        NOT NULL DEFAULT '',
  lang            text        NOT NULL DEFAULT '',
  catalog_surface text        NOT NULL DEFAULT '',
  planner_mode    text        NOT NULL DEFAULT '',
  candidate_count integer     NOT NULL DEFAULT 0,
  payload         jsonb       NOT NULL,
  refreshed_at    timestamptz NOT NULL DEFAULT now()
);

-- Drives the age sweep; also the only ordering this table is ever read by.
CREATE INDEX IF NOT EXISTS reco_recall_pool_cache_refreshed_at_idx
  ON reco_recall_pool_cache (refreshed_at DESC);
