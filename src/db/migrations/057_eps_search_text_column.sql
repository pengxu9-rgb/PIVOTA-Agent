-- Materialized search-text column for the Node external-seed text search
-- (src/services/externalSeedRecall.js buildExternalSeedRecallLikePredicate and
-- the staged predicates in src/auroraBff/routes.js).
--
-- Why: those predicates OR ~11 LIKE-ANY arms, most of which extract from the
-- large seed_data JSONB (rows average ~34KB; the table is 428MB for 12.6k rows,
-- almost all TOAST). Each arm detoasts seed_data again for every candidate row,
-- so a single search costs ~590k shared buffer hits / 5.7s on prod, and the
-- staged variants sit at 0.8-2.6s mean in pg_stat_statements — on the /v1/chat
-- recommendation critical path. The per-arm trigram indexes added by 033/035/056
-- don't help the Node predicate: its arm expressions differ byte-wise from the
-- indexed expressions (coalesce wrappers, the 13-way alias concat_ws chain, and
-- the brand/category coalesce chains have no index at all), and one unindexable
-- OR-arm forces a full scan.
--
-- Fix: materialize every arm's text into one small `search_text` column —
-- lower()ed, one arm per E'\n'-separated line so a LIKE pattern cannot span two
-- fields — maintained by trigger (covers the Python writer too), with a partial
-- trigram GIN index on status='active' (every search filters that). The Node
-- predicate builders collapse the full OR onto `search_text LIKE ANY(...)` and
-- AND the same clause into the staged per-field arms as an index-driving gate,
-- so query time never touches seed_data.
--
-- The line list must stay a superset of the fields referenced by
-- buildExternalSeedRecallLikePredicate / EXTERNAL_SEED_RECALL_SQL_FIELDS —
-- if an arm is added there, add its text here first (a field missing from
-- search_text makes the gate silently drop rows that arm would match).
--
-- Prod rollout: the backfill UPDATE and index build are run out of band
-- (batched UPDATE + CREATE INDEX CONCURRENTLY, same playbook as 055/056);
-- IF NOT EXISTS / OR REPLACE and the search_text = '' guard make this file a
-- fast no-op there. Fresh environments run everything inline (the table is
-- empty or tiny).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE external_product_seeds
  ADD COLUMN IF NOT EXISTS search_text text NOT NULL DEFAULT '';

-- Single source of truth for the materialized text. Line order mirrors the
-- OR-arm order in buildExternalSeedRecallLikePredicate; the alias line joins
-- with ' ' exactly like EXTERNAL_SEED_RECALL_SQL_FIELDS.aliasTokens so
-- patterns spanning alias sub-fields keep matching.
CREATE OR REPLACE FUNCTION external_product_seeds_search_text(
  p_title text,
  p_domain text,
  p_canonical_url text,
  p_destination_url text,
  p_seed_data jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(concat_ws(E'\n',
    coalesce(p_title, ''),
    coalesce(p_domain, ''),
    coalesce(p_canonical_url, ''),
    coalesce(p_destination_url, ''),
    coalesce(p_seed_data->'derived'->'recall'->>'retrieval_title', ''),
    coalesce(p_seed_data->'derived'->'recall'->>'retrieval_summary', ''),
    coalesce(p_seed_data->'derived'->'recall'->>'retrieval_body', ''),
    coalesce(p_seed_data->'derived'->'recall'->>'brand', p_seed_data->>'brand', p_seed_data->>'brand_name', p_seed_data->>'vendor', p_seed_data->>'vendor_name', p_seed_data->'snapshot'->>'brand', p_seed_data->'snapshot'->>'brand_name', p_seed_data->'snapshot'->>'vendor', p_seed_data->'snapshot'->>'vendor_name', ''),
    coalesce(p_seed_data->'derived'->'recall'->>'category', p_seed_data->>'category', p_seed_data->'product'->>'category', p_seed_data->'snapshot'->>'category', p_seed_data->>'product_type', p_seed_data->'product'->>'product_type', p_seed_data->'snapshot'->>'product_type', ''),
    coalesce(p_seed_data#>>'{derived,recall,ingredient_tokens}', ''),
    concat_ws(' ',
      coalesce(p_seed_data#>>'{derived,recall,alias_tokens}', ''),
      coalesce(p_seed_data#>>'{search_aliases}', ''),
      coalesce(p_seed_data#>>'{searchAliases}', ''),
      coalesce(p_seed_data#>>'{aliases}', ''),
      coalesce(p_seed_data#>>'{product,search_aliases}', ''),
      coalesce(p_seed_data#>>'{product,searchAliases}', ''),
      coalesce(p_seed_data#>>'{product,aliases}', ''),
      coalesce(p_seed_data#>>'{snapshot,search_aliases}', ''),
      coalesce(p_seed_data#>>'{snapshot,searchAliases}', ''),
      coalesce(p_seed_data#>>'{snapshot,aliases}', ''),
      coalesce(p_seed_data#>>'{snapshot,product,search_aliases}', ''),
      coalesce(p_seed_data#>>'{snapshot,product,searchAliases}', ''),
      coalesce(p_seed_data#>>'{snapshot,product,aliases}', '')
    )
  ))
$$;

CREATE OR REPLACE FUNCTION external_product_seeds_search_text_sync() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_text := external_product_seeds_search_text(
    NEW.title, NEW.domain, NEW.canonical_url, NEW.destination_url, NEW.seed_data
  );
  RETURN NEW;
END;
$$;

-- UPDATE OF <cols> so status-only / attachment-only updates skip the recompute
-- (and the backfill below, which only SETs search_text, does not re-fire it).
DROP TRIGGER IF EXISTS trg_eps_search_text_sync ON external_product_seeds;
CREATE TRIGGER trg_eps_search_text_sync
BEFORE INSERT OR UPDATE OF title, domain, canonical_url, destination_url, seed_data
ON external_product_seeds
FOR EACH ROW
EXECUTE FUNCTION external_product_seeds_search_text_sync();

-- Backfill. Plain UPDATE is fine on fresh environments; on prod this is run
-- out of band in id-ranged batches before the deploy, leaving 0 rows here.
UPDATE external_product_seeds
SET search_text = external_product_seeds_search_text(title, domain, canonical_url, destination_url, seed_data)
WHERE search_text = '';

CREATE INDEX IF NOT EXISTS idx_eps_active_search_text_trgm
ON external_product_seeds USING gin (search_text gin_trgm_ops)
WHERE status = 'active';

-- The support_alias_tokens stage keeps its per-field arm (staged scoring), and
-- that arm's 13-way alias chain is the costliest recheck: without its own
-- index it re-runs on every search_text candidate row (~0.7ms/row of jsonb
-- detoast). The chain uses || (IMMUTABLE textcat — concat_ws is only STABLE
-- and cannot be indexed) and must stay byte-equivalent to
-- EXTERNAL_SEED_RECALL_SQL_FIELDS.aliasTokens in src/services/externalSeedRecall.js
-- so the planner can drive the arm directly and only alias-matching rows recheck.
CREATE INDEX IF NOT EXISTS idx_eps_active_alias_chain_trgm
ON external_product_seeds USING gin (lower((
  coalesce(seed_data#>>'{derived,recall,alias_tokens}', '')
  || ' ' || coalesce(seed_data#>>'{search_aliases}', '')
  || ' ' || coalesce(seed_data#>>'{searchAliases}', '')
  || ' ' || coalesce(seed_data#>>'{aliases}', '')
  || ' ' || coalesce(seed_data#>>'{product,search_aliases}', '')
  || ' ' || coalesce(seed_data#>>'{product,searchAliases}', '')
  || ' ' || coalesce(seed_data#>>'{product,aliases}', '')
  || ' ' || coalesce(seed_data#>>'{snapshot,search_aliases}', '')
  || ' ' || coalesce(seed_data#>>'{snapshot,searchAliases}', '')
  || ' ' || coalesce(seed_data#>>'{snapshot,aliases}', '')
  || ' ' || coalesce(seed_data#>>'{snapshot,product,search_aliases}', '')
  || ' ' || coalesce(seed_data#>>'{snapshot,product,searchAliases}', '')
  || ' ' || coalesce(seed_data#>>'{snapshot,product,aliases}', '')
)) gin_trgm_ops)
WHERE status = 'active';
