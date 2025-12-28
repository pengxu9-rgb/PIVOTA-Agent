-- External offers cache (read-through, best-effort)
CREATE TABLE IF NOT EXISTS external_offers_cache (
  market TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (market, offer_id)
);

CREATE INDEX IF NOT EXISTS external_offers_cache_updated_at_idx ON external_offers_cache (updated_at DESC);

