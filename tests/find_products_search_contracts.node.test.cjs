const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeFindProductsSearchRequestContract,
  buildFindProductsSearchRequestContract,
  selectFindProductsSearchRequestContract,
  resolveFindProductsSearchExecutionPlan,
  buildFindProductsSearchExecutionTrace,
} = require('../src/findProductsSearchContracts');

test('beauty discovery source changes policy metadata but not primary owner', () => {
  const auroraContract = buildFindProductsSearchRequestContract({
    surface: 'chat',
    operation: 'find_products_multi',
    search: { query: 'im oily skin, what products should i use?' },
    metadata: { source: 'aurora' },
  });
  const shoppingContract = buildFindProductsSearchRequestContract({
    surface: 'direct',
    operation: 'find_products_multi',
    search: { query: 'im oily skin, what products should i use?' },
    metadata: { source: 'shopping' },
  });

  assert.equal(auroraContract.ownership_domain, 'beauty_mainline');
  assert.equal(shoppingContract.ownership_domain, 'beauty_mainline');
  assert.equal(auroraContract.primary_lane, 'beauty_discovery_mainline');
  assert.equal(shoppingContract.primary_lane, 'beauty_discovery_mainline');
  assert.equal(auroraContract.primary_retrieval_contract, 'agent_v1_search_beauty_mainline');
  assert.equal(shoppingContract.primary_retrieval_contract, 'agent_v1_search_beauty_mainline');
  assert.notEqual(auroraContract.source, shoppingContract.source);
});

test('strict constraint requests are the only shop invoke primary lane', () => {
  const contract = buildFindProductsSearchRequestContract({
    surface: 'direct',
    operation: 'find_products_multi',
    search: { query: 'merchant constrained serum' },
    metadata: { source: 'shopping' },
    strictConstraintQuery: true,
  });
  const plan = resolveFindProductsSearchExecutionPlan({
    requestContract: contract,
    pivotaApiBase: 'https://pivota.example',
  });

  assert.equal(contract.ownership_domain, 'strict_shop');
  assert.equal(contract.primary_lane, 'shop_invoke_strict');
  assert.equal(contract.primary_retrieval_contract, 'shop_invoke_strict');
  assert.equal(plan.upstream_method, 'POST');
  assert.equal(plan.upstream_url, 'https://pivota.example/agent/shop/v1/invoke');
  assert.equal(plan.owner_switch_count, 0);
});

test('framework generic contracts expose support recall and external supplement lanes', () => {
  const contract = buildFindProductsSearchRequestContract({
    surface: 'gateway',
    operation: 'find_products_multi',
    search: {
      query: 'oily skin routine',
      allow_external_seed: true,
      semantic_contract: {
        planner_mode: 'framework_generic',
        target_step_family: 'serum',
      },
    },
    metadata: { source: 'public' },
  });

  assert.equal(contract.request_class, 'beauty_discovery');
  assert.equal(contract.target_step_family, 'treatment');
  assert.equal(contract.primary_lane, 'beauty_discovery_mainline');
  assert.deepEqual(
    contract.supplement_lanes,
    ['external_seed_supplement', 'coverage_supplement', 'support_role_recall'],
  );
});

test('beauty discovery primary transport uses search upstream base without changing owner', () => {
  const requestContract = buildFindProductsSearchRequestContract({
    surface: 'direct',
    operation: 'find_products_multi',
    search: { query: 'im oily skin, what products should i use?' },
    metadata: { source: 'aurora-bff' },
  });
  const executionPlan = resolveFindProductsSearchExecutionPlan({
    requestContract,
    pivotaApiBase: 'https://agent-bff.example/',
    searchInvokeBase: 'https://agent-search.example/',
  });

  assert.equal(executionPlan.primary_lane, 'beauty_discovery_mainline');
  assert.equal(executionPlan.primary_retrieval_contract, 'agent_v1_search_beauty_mainline');
  assert.equal(executionPlan.upstream_method, 'GET');
  assert.equal(executionPlan.upstream_url, 'https://agent-search.example/agent/v1/products/search');
  assert.equal(executionPlan.owner_switch_count, 0);
  assert.equal(executionPlan.policy_only_source, true);
});

test('execution trace preserves primary timeout and failure stage without owner switches', () => {
  const requestContract = buildFindProductsSearchRequestContract({
    surface: 'direct',
    operation: 'find_products_multi',
    search: { query: 'oil control sunscreen' },
    metadata: { source: 'public' },
  });
  const executionPlan = resolveFindProductsSearchExecutionPlan({
    requestContract,
    pivotaApiBase: 'https://pivota.example/',
    searchInvokeBase: 'https://fallback.example/',
  });
  const trace = buildFindProductsSearchExecutionTrace({
    requestContract,
    executionPlan,
    primarySearchInitialTimeoutMs: 10000,
    primarySearchFinalTimeoutMs: 10000,
    primarySearchRetryCount: 0,
    primaryFailureStage: 'primary_upstream_timeout',
    supplementsAttempted: ['external_seed_supplement'],
  });

  assert.equal(trace.primary_lane, 'beauty_discovery_mainline');
  assert.equal(trace.primary_retrieval_contract, 'agent_v1_search_beauty_mainline');
  assert.equal(trace.primary_timeout_initial_ms, 10000);
  assert.equal(trace.primary_timeout_final_ms, 10000);
  assert.equal(trace.primary_retry_count, 0);
  assert.equal(trace.primary_failure_stage, 'primary_upstream_timeout');
  assert.equal(trace.owner_switch_count, 0);
  assert.deepEqual(trace.supplements_attempted, ['external_seed_supplement']);
});

test('local mainline child recall keeps beauty surface but bypasses discovery owner', () => {
  const contract = buildFindProductsSearchRequestContract({
    surface: 'direct',
    operation: 'find_products_multi',
    search: {
      query: 'best sunscreen for oily skin',
      catalog_surface: 'beauty',
      local_mainline_child: true,
      semantic_contract: {
        planner_mode: 'step_aware',
        target_step_family: 'sunscreen',
      },
    },
    metadata: {
      source: 'aurora-bff',
      local_mainline_child: true,
    },
    beautyMainlineBypass: {
      bypass: true,
      semanticContract: {
        planner_mode: 'framework_generic',
        target_step_family: 'treatment',
      },
    },
  });
  const plan = resolveFindProductsSearchExecutionPlan({
    requestContract: contract,
    pivotaApiBase: 'https://pivota.example',
  });

  assert.equal(contract.ownership_domain, 'beauty_mainline');
  assert.equal(contract.request_class, 'catalog_child_recall');
  assert.equal(contract.semantic_contract, null);
  assert.equal(contract.primary_lane, 'catalog_child_recall');
  assert.equal(contract.primary_retrieval_contract, 'agent_v2_catalog_child_recall');
  assert.deepEqual(contract.supplement_lanes, []);
  assert.equal(plan.primary_lane, 'catalog_child_recall');
  assert.equal(plan.upstream_method, null);
  assert.equal(plan.upstream_url, null);
  assert.equal(plan.transport_owner, 'pivota_agent_v2_products_search');
});

test('ingress search contract is preferred over execution-time rebuild', () => {
  const ingressContract = buildFindProductsSearchRequestContract({
    surface: 'direct',
    operation: 'find_products_multi',
    search: { query: 'best sunscreen for oily skin' },
    metadata: { source: 'aurora-bff' },
  });

  const selected = selectFindProductsSearchRequestContract({
    ingressContract,
    surface: 'direct',
    operation: 'find_products_multi',
    search: { query: 'best sunscreen for oily skin', catalog_surface: 'agent_api' },
    metadata: { source: 'aurora-bff' },
    strictConstraintQuery: true,
  });

  assert.equal(selected, ingressContract);
  assert.equal(selected.primary_lane, 'beauty_discovery_mainline');
  assert.equal(selected.primary_retrieval_contract, 'agent_v1_search_beauty_mainline');
});

test('invalid ingress search contract is rejected and falls back to rebuild', () => {
  const normalized = normalizeFindProductsSearchRequestContract(
    {
      contract_version: 'search_contract_v999',
      surface: 'direct',
      operation: 'find_products_multi',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
    },
    { surface: 'direct', operation: 'find_products_multi' },
  );

  assert.equal(normalized, null);

  const selected = selectFindProductsSearchRequestContract({
    ingressContract: {
      contract_version: 'search_contract_v999',
      surface: 'direct',
      operation: 'find_products_multi',
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
    },
    surface: 'direct',
    operation: 'find_products_multi',
    search: { query: 'merchant constrained serum' },
    metadata: { source: 'shopping' },
    strictConstraintQuery: true,
  });

  assert.equal(selected.primary_lane, 'shop_invoke_strict');
  assert.equal(selected.primary_retrieval_contract, 'shop_invoke_strict');
});
