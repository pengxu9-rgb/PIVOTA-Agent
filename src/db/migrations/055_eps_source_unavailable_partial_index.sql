-- Partial index supporting the external_seed "source unavailable" NOT EXISTS
-- gate in fetchCanonicalChainRows (src/services/canonicalCatalogSearch.js,
-- externalSeedUnavailableWhere). That gate probes external_product_seeds per
-- candidate row with an 8-way jsonb path OR; without an index the planner
-- either seq-scans all ~9.4k seeds (jsonb #>> per row) or runs a correlated
-- lookup that re-evaluates the jsonb OR on every probe.
--
-- Only ~120 of ~9.4k seeds are actually source_unavailable, so a partial index
-- on (external_product_id) over exactly those rows turns the gate into a tiny
-- Index Only Scan. Prod EXPLAIN ANALYZE of the citable-supplement tokenMatch
-- query dropped 5929ms -> 2778ms with this index (the unavailable gate went
-- from ~0.479ms/probe x 6620 probes to ~0.003ms/probe). See the
-- fpm-invoke-latency work / PR #1755 follow-up.
--
-- The predicate mirrors externalSeedUnavailableWhere's eps EXISTS subquery
-- byte-for-byte (same path order) so Postgres's predicate-implication prover
-- can match it. Prod already has this index (built CONCURRENTLY out of band);
-- IF NOT EXISTS makes this a no-op there and a normal build elsewhere.
CREATE INDEX IF NOT EXISTS idx_eps_source_unavailable_epid
ON external_product_seeds (external_product_id)
WHERE (
  lower(coalesce(seed_data #>> '{source_unavailable_v1,status}', '')) = 'source_unavailable'
  OR coalesce(seed_data #>> '{source_unavailable_v1,contract_version}', '') = 'external_seed.source_unavailable.v1'
  OR lower(coalesce(seed_data #>> '{snapshot,source_unavailable_v1,status}', '')) = 'source_unavailable'
  OR coalesce(seed_data #>> '{snapshot,source_unavailable_v1,contract_version}', '') = 'external_seed.source_unavailable.v1'
  OR lower(coalesce(seed_data #>> '{transaction_readiness_blocker_v1,status}', '')) = 'source_unavailable'
  OR coalesce(seed_data #>> '{transaction_readiness_blocker_v1,contract_version}', '') = 'external_seed.source_unavailable.v1'
  OR lower(coalesce(seed_data #>> '{snapshot,transaction_readiness_blocker_v1,status}', '')) = 'source_unavailable'
  OR coalesce(seed_data #>> '{snapshot,transaction_readiness_blocker_v1,contract_version}', '') = 'external_seed.source_unavailable.v1'
);
