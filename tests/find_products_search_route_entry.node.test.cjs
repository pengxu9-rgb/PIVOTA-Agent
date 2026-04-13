const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFindProductsSearchRouteEntryRuntime,
} = require('../src/findProductsSearchRouteEntry');
const {
  buildFindProductsSearchRequestContract,
} = require('../src/findProductsSearchContracts');

function buildRuntime(overrides = {}) {
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
    ...overrides,
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

test('direct route preserves local mainline child marker into invoke payload', () => {
  const runtime = buildRuntime({
    buildFindProductsMultiPayloadFromQuery: (query) => ({
      search: {
        query: query.query,
        catalog_surface: query.catalog_surface,
      },
      metadata: {
        ...(query.source ? { source: query.source } : {}),
        ...(query.catalog_surface ? { catalog_surface: query.catalog_surface } : {}),
      },
    }),
  });
  const routePlan = runtime.prepareAgentProductsSearchRoute({
    query: {
      query: 'best sunscreen for oily skin',
      source: 'aurora-bff',
      catalog_surface: 'beauty',
      local_mainline_child: 'true',
    },
  });

  assert.equal(routePlan.invalid, false);
  assert.equal(routePlan.payload.search.local_mainline_child, true);
  assert.equal(routePlan.payload.metadata.local_mainline_child, true);
  assert.equal(routePlan.payload.search.allow_external_seed, undefined);
  assert.equal(routePlan.payload.search.external_seed_strategy, undefined);
});

test('direct route child marker suppresses beauty semantic handoff reinjection', () => {
  const runtime = buildRuntime({
    buildFindProductsMultiPayloadFromQuery: (query) => ({
      search: {
        query: query.query,
        catalog_surface: query.catalog_surface,
      },
      metadata: {
        ...(query.source ? { source: query.source } : {}),
        ...(query.catalog_surface ? { catalog_surface: query.catalog_surface } : {}),
      },
    }),
    resolveLegacyBeautyCacheOwnerBypass: () => ({
      bypass: true,
      semanticContract: {
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
      },
    }),
  });
  const routePlan = runtime.prepareAgentProductsSearchRoute({
    query: {
      query: 'best sunscreen for oily skin',
      source: 'aurora-bff',
      catalog_surface: 'beauty',
      local_mainline_child: 'true',
    },
  });

  assert.equal(routePlan.invalid, false);
  assert.equal(routePlan.payload.search.local_mainline_child, true);
  assert.equal(routePlan.payload.search.semantic_contract, undefined);
  assert.equal(routePlan.forceDirectInvokeMainPath, true);
  assert.equal(routePlan.payload.metadata.search_request_contract.semantic_contract, null);
  assert.equal(routePlan.payload.metadata.primary_lane, 'catalog_child_recall');
  assert.equal(
    routePlan.payload.metadata.primary_retrieval_contract,
    'agent_v2_catalog_child_recall',
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

test('beauty head-term route skips guidance ladder and forces catalog child recall', () => {
  const runtime = buildRuntime();
  const routePlan = runtime.prepareAgentProductsSearchRoute({
    query: {
      query: 'lip balm',
      source: 'shopping',
      catalog_surface: 'beauty',
    },
  });

  assert.equal(routePlan.invalid, false);
  assert.equal(routePlan.forceDirectInvokeMainPath, true);
  assert.equal(routePlan.payload.search.local_mainline_child, true);
  assert.equal(routePlan.payload.metadata.local_mainline_child, true);
  assert.equal(routePlan.payload.metadata.primary_lane, 'catalog_child_recall');
  assert.equal(
    routePlan.payload.metadata.primary_retrieval_contract,
    'agent_v2_catalog_child_recall',
  );
});

test('public beauty head-term route defaults external seed on catalog child recall', () => {
  const runtime = buildRuntime();
  const routePlan = runtime.prepareAgentProductsSearchRoute({
    query: {
      query: 'lip balm',
      source: 'search',
      catalog_surface: 'beauty',
    },
  });

  assert.equal(routePlan.invalid, false);
  assert.equal(routePlan.forceDirectInvokeMainPath, true);
  assert.equal(routePlan.payload.search.allow_external_seed, true);
  assert.equal(routePlan.payload.search.external_seed_strategy, 'unified_relevance');
  assert.equal(routePlan.payload.metadata.primary_lane, 'catalog_child_recall');
  assert.equal(
    routePlan.payload.metadata.primary_retrieval_contract,
    'agent_v2_catalog_child_recall',
  );
  assert.deepEqual(
    routePlan.payload.metadata.search_request_contract.supplement_lanes,
    ['external_seed_supplement', 'coverage_supplement'],
  );
});

test('public beauty discovery route defaults external seed on mainline queries', () => {
  const runtime = buildRuntime();
  const routePlan = runtime.prepareAgentProductsSearchRoute({
    query: {
      query: 'vitamin c serum',
      source: 'search',
      catalog_surface: 'beauty',
    },
  });

  assert.equal(routePlan.invalid, false);
  assert.equal(routePlan.forceDirectInvokeMainPath, true);
  assert.equal(routePlan.payload.search.allow_external_seed, true);
  assert.equal(routePlan.payload.search.external_seed_strategy, 'unified_relevance');
  assert.equal(routePlan.payload.metadata.primary_lane, 'beauty_discovery_mainline');
  assert.equal(
    routePlan.payload.metadata.primary_retrieval_contract,
    'agent_v1_search_beauty_mainline',
  );
  assert.deepEqual(
    routePlan.payload.metadata.search_request_contract.supplement_lanes,
    ['external_seed_supplement', 'coverage_supplement'],
  );
});
