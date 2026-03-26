# `find_products_multi` Hardening Audit

## Current Readiness

`find_products_multi` is no longer a single inline branch in `src/server.js`. It now runs through a staged commerce pipeline:

1. `src/commerce/invokeRequestContext.js`
2. `src/findProductsMulti/policy.js`
3. `src/commerce/prepareInvokeUpstreamRequest.js`
4. `src/commerce/catalog/preUpstreamCacheRoutes.js`
5. `src/commerce/catalog/crossMerchantCacheSearch.js`
6. `src/commerce/executeInvokeUpstreamFlow.js`
7. `src/commerce/catalog/postUpstreamFallback.js`
8. `src/commerce/catalog/searchResponseFinalizer.js`
9. `src/commerce/finalizeInvokeResponseFlow.js`

This is materially better than the earlier monolithic flow, but the chain is still fragile because one request can be altered by multiple policy and fallback layers before the final response contract is produced.

## Owner Map

### Request Context And Intent

- `src/commerce/invokeRequestContext.js`
  Builds runtime request context, metadata normalization, trace state, and top-level `find_products_multi` intent inputs.
- `src/findProductsMulti/policy.js`
  Owns query extraction, intent classification, ambiguity scoring, rewrite gating, association plans, and policy application.

### Request Construction And Guard Defaults

- `src/commerce/catalog/requestBuilders.js`
  Builds outbound search params for `find_products_multi`.
- `src/commerce/catalog/searchGuards.js`
  Owns shared guard defaults such as `applyShoppingCatalogQueryGuards`, source classification, Aurora-specific fallback overrides, and upstream base selection.

### Cache-First Search Path

- `src/commerce/catalog/preUpstreamCacheRoutes.js`
  Handles creator cache and browse short-circuit paths.
- `src/commerce/catalog/crossMerchantCacheSearch.js`
  Handles cross-merchant cache search, cache quality gates, strict-empty bypasses, early ambiguity decisions, and resolver-after-cache-miss.

### Upstream Search Path

- `src/commerce/executeInvokeUpstreamFlow.js`
  Coordinates upstream transport, resolver-first prelude, product-detail prelude, and exception fallback.
- `src/commerce/catalog/invokeSearchPrelude.js`
  Resolver-first and timeout-budget decisions.
- `src/commerce/catalog/invokeSearchExceptionFallback.js`
  Upstream exception handling for resolver fallback, invoke fallback, and soft fallback.

### Post-Upstream Search And Finalization

- `src/commerce/catalog/postUpstreamFallback.js`
  Handles second-stage expansion, quality re-evaluation, invoke fallback after primary response, and fallback adoption.
- `src/commerce/catalog/searchResponseFinalizer.js`
  Applies policy, eligible-only shaping, strict-empty handling, diagnostics, rerank, and gate summaries.
- `src/commerce/finalizeInvokeResponseFlow.js`
  Final wiring between post-upstream search flow and success finalization.

### Downstream Consumers

- `src/auroraBff/routes.js`
  Uses `find_products_multi` for proxy search and product recall.
- `src/auroraBff/recoBlocksDag.js`
  Does not own `find_products_multi`, but is sensitive to catalog recall and fallback behavior.
- `src/uiChatAgent.js`
  Uses `find_products_multi` as the main product search tool.

## Confirmed Fragility Sources

### 1. Too Many Semantic Layers

`find_products_multi` behavior is determined by all of the following:

- intent extraction
- query rewrite / expansion mode
- source-dependent query guards
- cache quality gate
- cache strict-empty bypass
- resolver-first gate
- second-stage expansion
- invoke fallback
- response finalization

This makes it easy for a refactor to preserve API shape while changing serving semantics.

### 2. Search Semantics Still Span Multiple Owners

Shared guard defaults have now moved into `src/commerce/catalog/searchGuards.js`, which is better than keeping them in `src/server.js`. The remaining risk is that second-stage expansion, resolver fallback, invoke fallback, and response finalization still live across several commerce modules, so internal decision drift is still possible without a public API regression.

### 3. Contract Coverage Was Incomplete

Before this audit, `eligible_only` serving was not included in the focused commerce gate. A regression there only surfaced in `full-repo`.

### 4. Downstream Aurora Tests Still Catch Integration Drift

`find_products_multi` does not only serve the invoke API. Aurora proxy search and recommendation DAGs are downstream consumers, so a green commerce-focused gate is necessary but not sufficient.

## Confirmed Cause From This Audit

The original `full-repo` blocker on `tests/integration/invoke.find_products_multi_eligible_only.test.js` was not a serving regression. The failing expectation encoded an outdated transport assumption: it required two upstream searches for a query that now legitimately stays single-pass when second-stage expansion does not actually change the query.

The stable contract is:

- outbound search params preserve `agent_api` eligible-only semantics
- response metadata remains `serving_mode=eligible_only`
- only eligible internal products are returned with `top_offer_summary` and `exact_resolution_identifiers`

That contract is now covered directly.

## Hardening Plan

### Phase 1: Protect The Core Chain

- Keep a dedicated `find_products_multi` gate.
- Keep `eligible_only`, cache search, fallback, clarify, and diagnostics in the fast gate.
- Treat downstream Aurora failures as `tier-2` integration blockers, not core-chain unit blockers.

### Phase 2: Remove Remaining Shared Search Semantics From `server.js`

- Keep `src/commerce/catalog/searchGuards.js` as the single source of truth.
- Make every FPM request-shaping stage consume that module directly or through explicit commerce-owned wiring.

### Phase 3: Collapse Policy And Fallback Ownership

- Reduce the number of places that can mutate search intent and final decision.
- Keep second-stage expansion and fallback adoption under one dedicated owner.

### Phase 4: Promote Downstream Compatibility Gates

- Keep Aurora proxy search and recommendation DAG tests in `full-repo`.
- Promote the most sensitive downstream search integrations into an explicit second-tier search compatibility tranche.

## Acceptance Criteria

- `npm run test:gate:find-products-multi` passes.
- `npm run test:gate:commerce:focused` passes.
- `find_products_multi` eligible-only serving remains covered in both builder-level and integration-level tests.
- Shared search guard defaults are no longer owned by `src/server.js`.
- `full-repo` passes with no `find_products_multi` or Aurora search-compat regressions.
