const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFindProductsSearchRouteEntryRuntime,
} = require('../src/findProductsSearchRouteEntry');
const {
  buildFindProductsSearchRequestContract,
} = require('../src/findProductsSearchContracts');

function buildRuntime() {
  return createFindProductsSearchRouteEntryRuntime({
    resolveGuidanceSearchSessionId: () => null,
    firstQueryParamValue: (value) => (Array.isArray(value) ? value[0] : value),
    buildFindProductsMultiPayloadFromQuery: (query) => ({
      search: { ...query },
      metadata: {
        ...(query.source ? { source: query.source } : {}),
        ...(query.ui_surface ? { ui_surface: query.ui_surface } : {}),
        ...(query.decision_mode ? { decision_mode: query.decision_mode } : {}),
        ...(query.catalog_surface ? { catalog_surface: query.catalog_surface } : {}),
      },
    }),
    buildFindProductsSearchRequestContract,
    resolveLegacyBeautyCacheOwnerBypass: () => ({ bypass: false, semanticContract: null }),
    normalizeAgentSource: (value) => String(value || '').trim().toLowerCase(),
    runGuidanceServerOwnedLadderSearch: async () => null,
    persistGuidanceSearchSeenProducts: async () => undefined,
    normalizeSearchUiSurface: (value) => String(value || '').trim().toLowerCase(),
    normalizeRecommendationDecisionMode: (value) => String(value || '').trim().toLowerCase(),
    searchExternalSeedOnlyProductsDirect: async () => null,
    searchIngredientIntentProductsDirect: async () => null,
  });
}

test('direct route source does not switch discovery owner to strict shop lane', () => {
  const runtime = buildRuntime();
  const routePlan = runtime.prepareAgentProductsSearchRoute({
    query: {
      query: 'im oily skin, what products should i use?',
      source: 'shopping',
    },
  });

  assert.equal(routePlan.invalid, false);
  assert.equal(routePlan.forceDirectInvokeMainPath, true);
  assert.equal(routePlan.payload.metadata.primary_lane, 'beauty_discovery_mainline');
  assert.equal(
    routePlan.payload.metadata.primary_retrieval_contract,
    'agent_v1_search_beauty_mainline',
  );
  assert.equal(
    routePlan.payload.metadata.search_request_contract.ownership_domain,
    'beauty_mainline',
  );
});

test('direct route explicit strict catalog surface uses strict shop lane', () => {
  const runtime = buildRuntime();
  const routePlan = runtime.prepareAgentProductsSearchRoute({
    query: {
      query: 'merchant constrained serum',
      source: 'shopping',
      catalog_surface: 'agent_api',
      allow_external_seed: 'true',
    },
  });

  assert.equal(routePlan.invalid, false);
  assert.equal(routePlan.forceDirectInvokeMainPath, true);
  assert.equal(routePlan.payload.search.allow_external_seed, false);
  assert.equal(routePlan.payload.metadata.catalog_surface, 'agent_api');
  assert.equal(routePlan.payload.metadata.primary_lane, 'shop_invoke_strict');
  assert.equal(routePlan.payload.metadata.primary_retrieval_contract, 'shop_invoke_strict');
  assert.equal(
    routePlan.payload.metadata.search_request_contract.ownership_domain,
    'strict_shop',
  );
});

test('guidance-only external seed route remains a direct fastpath, not discovery owner lock', () => {
  const runtime = buildRuntime();
  const routePlan = runtime.prepareAgentProductsSearchRoute({
    query: {
      query: 'ceramide cream',
      external_seed_only: true,
      ui_surface: 'ingredient_plan_guidance_only',
      decision_mode: 'guidance_only',
    },
  });

  assert.equal(routePlan.invalid, false);
  assert.equal(routePlan.forceDirectInvokeMainPath, false);
  assert.equal(routePlan.payload.metadata.primary_lane, 'beauty_discovery_mainline');
  assert.equal(routePlan.payload.metadata.search_request_contract.request_class, 'support_recall');
});
