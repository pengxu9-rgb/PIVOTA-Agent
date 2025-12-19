-- Fallback embeddings store when pgvector is unavailable.
-- Stores embeddings as float arrays and performs cosine similarity in Node.

CREATE TABLE IF NOT EXISTS products_cache_embeddings_fallback (
  merchant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INT NOT NULL,
  embedding FLOAT8[] NOT NULL,
  content_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, product_id, provider, model)
);

CREATE INDEX IF NOT EXISTS idx_products_cache_embeddings_fallback_lookup
  ON products_cache_embeddings_fallback (merchant_id, provider, model, dim);

