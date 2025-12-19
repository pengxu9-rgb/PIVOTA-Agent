-- Adds a pgvector-backed embeddings store for products_cache records.
-- This is used for multilingual semantic recall (Route B: hybrid lexical + vector).
--
-- Safety: if pgvector is not available on the connected Postgres instance,
-- this migration becomes a no-op (the gateway will still run in lexical-only mode).

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION
    WHEN undefined_file THEN
      RAISE NOTICE 'pgvector extension not installed; skipping products_cache_embeddings migration';
      RETURN;
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'insufficient privilege to create pgvector extension; skipping products_cache_embeddings migration';
      RETURN;
    WHEN OTHERS THEN
      RAISE NOTICE 'pgvector unavailable (%): skipping products_cache_embeddings migration', SQLERRM;
      RETURN;
  END;

  EXECUTE $sql$
    CREATE TABLE IF NOT EXISTS products_cache_embeddings (
      merchant_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dim INT NOT NULL,
      embedding_768 vector(768),
      embedding_1536 vector(1536),
      content_hash TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (merchant_id, product_id, provider, model)
    );
  $sql$;

  EXECUTE $sql$
    CREATE INDEX IF NOT EXISTS idx_products_cache_embeddings_lookup
      ON products_cache_embeddings (merchant_id, provider, model, dim);
  $sql$;

  -- Vector indexes (optional acceleration). Safe to create even if tables are small.
  EXECUTE $sql$
    CREATE INDEX IF NOT EXISTS idx_products_cache_embeddings_vec768
      ON products_cache_embeddings
      USING ivfflat (embedding_768 vector_cosine_ops)
      WITH (lists = 100);
  $sql$;

  EXECUTE $sql$
    CREATE INDEX IF NOT EXISTS idx_products_cache_embeddings_vec1536
      ON products_cache_embeddings
      USING ivfflat (embedding_1536 vector_cosine_ops)
      WITH (lists = 100);
  $sql$;
END $$;
