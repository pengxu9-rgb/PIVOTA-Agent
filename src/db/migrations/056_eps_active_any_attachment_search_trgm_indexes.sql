-- Status-only ("any attachment state") trigram indexes for the external-seed
-- text search arms used by pivota-backend's fetch_external_seed_rows
-- (services/external_seed_search.py, _build_text_match_clause).
--
-- Why: that query filters status='active' AND market=... plus an OR of
-- LIKE '%q%' arms over destination_url / canonical_url / domain / title and
-- four seed_data derived-recall paths — with NO attachment filter. Every
-- pre-existing trigram index on these expressions is partial on
-- attached_product_key IS NULL (or the attached_* variants on
-- COALESCE(attached_product_key,'') <> ''), and 9.1k of 9.7k seeds are
-- attached, so none of those predicates are implied by the query's WHERE and
-- the planner cannot use them (verified: enable_seqscan=off still chose the
-- status btree + full filter). Result: every arm evaluated per row with full
-- seed_data detoast — 2.8s seq scan + an equal-cost COUNT(*) against a 2.0s
-- statement_timeout, i.e. external_seed_skip_reason=query_timeout on EVERY
-- search, which made external-seed-resident brands (the crawl-ingested
-- K-beauty D2C cohort, e.g. ACROPASS) invisible to find_products_multi while
-- unrelated connected-merchant products filled the response.
--
-- These indexes carry only WHERE status = 'active' — implied by the query —
-- so the planner can BitmapOr all arms. Prod EXPLAIN after build: see the
-- fpm wrong-brand recall investigation (2026-07-11). Prod already has these
-- (built CONCURRENTLY out of band); IF NOT EXISTS makes this a no-op there.
--
-- Expressions must stay byte-equivalent to _build_text_match_clause.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_eps_active_any_destination_url_trgm
ON external_product_seeds USING gin (lower(destination_url) gin_trgm_ops)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_eps_active_any_canonical_url_trgm
ON external_product_seeds USING gin (lower(canonical_url) gin_trgm_ops)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_eps_active_any_domain_trgm
ON external_product_seeds USING gin (lower(domain) gin_trgm_ops)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_eps_active_any_title_trgm
ON external_product_seeds USING gin (lower(title) gin_trgm_ops)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_eps_active_any_recall_title_trgm
ON external_product_seeds USING gin (
  lower(COALESCE(seed_data->'derived'->'recall'->>'retrieval_title', '')) gin_trgm_ops
)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_eps_active_any_recall_summary_trgm
ON external_product_seeds USING gin (
  lower(COALESCE(seed_data->'derived'->'recall'->>'retrieval_summary', '')) gin_trgm_ops
)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_eps_active_any_recall_ingredient_tokens_trgm
ON external_product_seeds USING gin (
  lower(COALESCE(seed_data#>>'{derived,recall,ingredient_tokens}', '')) gin_trgm_ops
)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_eps_active_any_recall_alias_tokens_trgm
ON external_product_seeds USING gin (
  lower(COALESCE(seed_data#>>'{derived,recall,alias_tokens}', '')) gin_trgm_ops
)
WHERE status = 'active';

-- Broad-fallback arm (include_seed_data_text_match=True adds
-- LOWER(CAST(seed_data AS TEXT)) LIKE — the costliest arm by far because it
-- detoasts the full document per row).
CREATE INDEX IF NOT EXISTS idx_eps_active_any_seed_data_text_trgm
ON external_product_seeds USING gin (lower((seed_data)::text) gin_trgm_ops)
WHERE status = 'active';
