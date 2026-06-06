-- Durable backing store for the Commerce Safety Kernel (quotes, idempotency ledger, confirmation
-- tokens, order records, vault refs). One table, namespaced; PRIMARY KEY gives the atomic
-- putIfAbsent via INSERT ... ON CONFLICT DO NOTHING.
--
-- Apply with the repo's migration runner (src/db/cli.js migrate) or psql.

CREATE TABLE IF NOT EXISTS commerce_kv (
  ns          text        NOT NULL,
  k           text        NOT NULL,
  v           jsonb       NOT NULL,
  expires_at  timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ns, k)
);

-- Partial index to make the TTL sweep + expiry filter cheap.
CREATE INDEX IF NOT EXISTS commerce_kv_expires_idx
  ON commerce_kv (expires_at)
  WHERE expires_at IS NOT NULL;
