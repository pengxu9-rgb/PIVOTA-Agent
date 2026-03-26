#!/usr/bin/env bash
set -euo pipefail

skip_preflight=0
if [[ "${1:-}" == "--skip-preflight" ]]; then
  skip_preflight=1
fi

if [[ "$skip_preflight" -ne 1 ]]; then
  bash scripts/test_preflight.sh
fi

bash scripts/run_jest_inband.sh --runTestsByPath \
  tests/gateway_guardrails.test.js \
  tests/find_products_multi_context.test.js \
  tests/find_products_multi_intent_llm_overrides.test.js \
  tests/find_products_multi_policy.test.js \
  tests/find_products_multi_profile_engine.test.js \
  tests/find_products_multi_slot_strategy.test.js \
  tests/find_products_multi_tool_first.test.js \
  tests/cross_merchant_cache_search.test.js \
  tests/admin.search_diagnostics.test.js \
  tests/admin.catalog_cache_diagnostics.test.js \
  tests/products/product_search_proxy_route.test.js \
  tests/commerce/invokeRequestContext.test.js \
  tests/commerce/invokeUpstreamRequest.catalog.test.js \
  tests/commerce/prepareInvokeUpstreamRequest.test.js \
  tests/commerce/crossMerchantCacheSearch.test.js \
  tests/commerce/invokeTransport.test.js \
  tests/commerce/invokeSearchPrelude.test.js \
  tests/commerce/invokeSearchExceptionFallback.test.js \
  tests/commerce/searchRouteHealth.test.js \
  tests/commerce/searchTrace.test.js \
  tests/commerce/searchGuards.test.js \
  tests/commerce/sellability.test.js \
  tests/commerce/queryHeuristics.test.js \
  tests/commerce/cacheSearchRuntime.test.js \
  tests/commerce/searchDedupe.test.js \
  tests/commerce/bootstrapProxySearchRuntime.test.js \
  tests/commerce/searchQueryParams.test.js \
  tests/commerce/agentProductsListResponse.test.js \
  tests/commerce/searchFallbackRuntime.test.js \
  tests/commerce/searchRelevance.test.js \
  tests/commerce/proxySearchFallbacks.test.js \
  tests/commerce/postUpstreamFallback.test.js \
  tests/commerce/searchResponseFinalizer.test.js \
  tests/commerce/finalizeInvokeResponseFlow.test.js \
  tests/commerce/resolverPolicy.test.js \
  tests/commerce/resolverCache.test.js \
  tests/commerce/resolverQueryCandidates.test.js \
  tests/commerce/queryResolveSearchFallback.test.js \
  tests/commerce/resolverFallbackResponse.test.js \
  tests/integration/invoke.find_products_cache_browse.test.js \
  tests/integration/invoke.find_products_multi_cache_search.test.js \
  tests/integration/invoke.find_products_multi_fallback.test.js \
  tests/integration/invoke.find_products_multi_clarify.test.js \
  tests/integration/invoke.find_products_multi_eligible_only.test.js
