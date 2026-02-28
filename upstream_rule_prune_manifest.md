# Upstream Rule Prune Manifest

Generated: 2026-02-28
Repo: `pivota-agent-backend` (`PIVOTA-Agent`)
Flag: `SEARCH_EXTERNAL_HARD_RULE_PRUNE` (default `true`)

## Node 9 - Cache Supplement Gate (remove hard block)
- File: `src/server.js`
- Symbols:
  - `const externalFillGateWouldBlock` (around line 14998)
  - `const canApplyExternalFillGate = SEARCH_EXTERNAL_HARD_RULE_PRUNE ? true : !externalFillGateWouldBlock;` (around line 15006)
  - soft marker: `external_fill_gate_soft_bypassed` (around line 15040)
- Old behavior:
  - `SEARCH_EXTERNAL_FILL_GATED=true` could hard stop supplement (`external_fill_gate_blocked`).
- New behavior:
  - In prune mode, gate becomes soft bypass; supplement keeps running, and diagnostics preserve gate state.

## Node 10 - Domain/Brand Hard Drop -> Soft handling
- File: `src/server.js`
- Symbols:
  - `isSupplementCandidateRelevant(...)` (around line 4032)
  - `hasFragranceSearchSignal(...)` (around line 4026)
  - hard checks now guarded by `!SEARCH_EXTERNAL_HARD_RULE_PRUNE`:
    - fragrance candidate mismatch
    - beauty-tool exclusion under fragrance
    - brand-term mismatch
- Old behavior:
  - External candidates were hard-continued/dropped on strict relevance mismatch.
- New behavior:
  - In prune mode, these checks are softened (ranking/filter downstream can still reduce weight).

## Node 11 - Diversity Gate hard empty path removal
- File: `src/server.js`
- Symbols:
  - `needsBeautyDiversitySupplement` excludes fragrance in prune mode (around line 14970)
  - supplement reason fallback:
    - old: `no_external_candidates_for_diversity`
    - new prune path: `no_external_candidates` (around line 15113)
- Old behavior:
  - Diversity path could force hard-empty semantics for fragrance/beauty shortage.
- New behavior:
  - Fragrance no longer forced into beauty diversity hard gate in prune mode.

## Node 12 - Fallback chain unify (primary -> semantic retry -> clarify)
- File: `src/server.js`
- Symbols:
  - `queryFindProductsMultiFallback(...)` semantic retry enablement:
    - `isFragranceSemanticRetry`
    - `semanticRetryEnabled`
    - search endpoint used on retry pass (around lines 4629-4665)
  - proxy primary path:
    - `fallbackNotBetterReason` maps to `semantic_retry_exhausted` when retry happened (around line 9998)
    - force strict/clarify on empty after fallback in prune mode (around lines 10057-10097)
  - invoke path:
    - `secondaryFallbackMeta` + semantic retry metadata sink (around lines 16940-17206)
    - force `invoke_fallback_exhausted` strict fallback in prune mode (around line 17185)
- Old behavior:
  - `fallback_not_better` could return empty without semantic retry semantics/clarify path.
- New behavior:
  - prune mode routes empty fallback into strict/clarify-compatible path and emits `semantic_retry_*` metadata.

## Metadata Contract Sink
- File: `src/server.js`
- Symbols:
  - `buildSearchRouteHealth(...)` expanded contract fields (around line 2783)
  - `withSearchDiagnostics(...)` top-level <-> `metadata.route_health` sink (around line 2961)
- Target behavior:
  - keep `metadata.fallback_reason` and `metadata.route_health.fallback_reason` aligned
  - sink `orchestrator_path/decision_node/domain_filter_dropped_external/external_fill_gate_reason/semantic_retry_*/external_seed_*`.

## Verification Pointer
- Integration suite: `tests/integration/invoke.find_products_multi_cache_search.test.js`
- Updated for prune semantics and guard-query matching (external supplement vs upstream query separation).
