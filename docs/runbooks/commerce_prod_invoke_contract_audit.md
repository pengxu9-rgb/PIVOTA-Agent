# Commerce Prod Invoke Contract Audit

## Scope

This audit records which release and acceptance rails now use the supported authenticated commerce invoke contract and which rails intentionally remain on public Aurora routes.

## Rails Moved To Authenticated Invoke

- `Celestial Commerce Core Readiness`
  - deploy verify uses `scripts/verify_deployed_commit_matches.sh`
  - authoritative target: `COMMERCE_CORE_PROD_SMOKE_BASE_URL + /agent/shop/v1/invoke`
  - auth: `COMMERCE_CORE_PROD_AUTH_TOKEN` or `COMMERCE_CORE_PROD_AGENT_API_KEY`
- `Shopping Search Release Gate`
  - deploy verify uses authenticated invoke only
  - budget FX preflight uses authenticated invoke only
  - runtime warm uses authenticated invoke only
  - prod skincare smoke uses authenticated invoke only
- `scripts/verify_deployed_commit_matches.sh`
  - supports `INVOKE_BASE_URL`, `AUTH_TOKEN`, `AGENT_API_KEY`
  - supports `ALLOW_HEADER_FALLBACK=0` for strict invoke-only verification

## Rails Intentionally Left On Public Aurora Routes

- `Aurora BFF Release Gate` runtime smoke
  - `scripts/smoke_aurora_bff_runtime.sh`
  - `scripts/smoke_travel_plans_runtime.sh`
  - `scripts/smoke_aurora_skin_reco_gates.sh`
  - `scripts/smoke_photo_modules_production.sh`
  - `scripts/smoke_entry_routes.sh`
  - these remain on `BASE_URL` because they validate Aurora public runtime behavior, not commerce invoke
- `Aurora BFF Release Gate` best-effort `/v1/session/bootstrap` polling
  - kept as observability-only and marked non-blocking
  - strict release verification now uses authenticated invoke instead

## Shared Budget / FX Contract

The following rails share the same `EUR budget -> USD product pricing` contract:

- `scripts/check_budget_fx_freshness.js`
- `scripts/warm_find_products_multi_runtime.js`
- `scripts/smoke_find_products_multi_skincare_prod.sh`
- `scripts/fixtures/find_products_multi_skincare_prod_gate.json`
- `scripts/fixtures/find_products_multi_external_seed_ingredient_validity_batch.json`
- runtime implementation:
  - `src/findProductsMulti/intent.js`
  - `src/findProductsMulti/policy.js`

Expected contract for `vitamin c serum under €30`:

- `strict_constraint_query = true`
- `strict_constraint_reason = multi_constraint`
- `budget_fx_applied = true`
- `budget_fx_rate` present
- `budget_fx_source` present
- `budget_fx_candidate_currency = USD`
- `budget_fx_unresolved = false`
- non-empty results
- primary path only; resolver / error fallback does not count as pass

## Verification Notes

- For supported commerce production verification, treat authenticated `/agent/shop/v1/invoke` as authoritative.
- Public `/api/gateway` remains useful for observability and legacy probes, but it is no longer the shared commerce release gate.
