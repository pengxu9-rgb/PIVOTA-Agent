const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFindProductsInvokePrimaryExceptionRuntime,
} = require('../src/findProductsInvokePrimaryException');

function createRuntime(overrides = {}) {
  const calls = {
    resolver: 0,
    invokeFallback: 0,
    strictEmpty: 0,
    softFallback: 0,
  };
  const runtime = createFindProductsInvokePrimaryExceptionRuntime({
    detectBrandEntities: () => null,
    extractUpstreamErrorCode: (err) => ({
      code: err?.softCode || null,
      message: err?.softMessage || null,
    }),
    shouldSkipSecondaryFallbackAfterResolverMiss: () => false,
    shouldAllowResolverFallback: () => true,
    shouldAllowSecondaryFallback: () => true,
    shouldAllowInvokeFallback: () => true,
    shouldBypassSecondaryFallbackSkipOnPrimaryException: () => false,
    queryResolveSearchFallback: async () => {
      calls.resolver += 1;
      return null;
    },
    getResolverFallbackAdoptionDecision: () => ({ adopt: false, reason: 'rejected' }),
    buildInvokeResolverFallbackResponse: () => {
      throw new Error('unexpected resolver fallback response');
    },
    queryFindProductsMultiFallback: async () => {
      calls.invokeFallback += 1;
      return null;
    },
    isProxySearchFallbackRelevant: () => true,
    buildProxySearchFallbackMetadataResponse: ({ status = 200, body = {} } = {}) => ({
      status,
      data: body,
    }),
    normalizeAgentProductsListResponse: (body) => body,
    buildProxySearchSoftFallbackResponse: (input = {}) => {
      calls.softFallback += 1;
      return {
        status: 'success',
        metadata: {
          reason: input.reason || null,
          route: input.route || null,
          query_source: input.querySource || null,
        },
      };
    },
    buildStrictEmptyFallbackResponse: (input = {}) => {
      calls.strictEmpty += 1;
      return {
        status: 'success',
        products: [],
        metadata: {
          reason: input.reason || null,
          route: input.route || null,
          upstream_status: input.upstreamStatus || null,
        },
      };
    },
    ...overrides,
  });
  return { runtime, calls };
}

test('beauty discovery mainline primary exception fails closed without owner switch fallbacks', async () => {
  const { runtime, calls } = createRuntime();
  const out = await runtime.handleInvokePrimarySearchException({
    operation: 'find_products_multi',
    err: {
      code: 'ECONNABORTED',
      message: 'timeout of 10000ms exceeded',
    },
    queryParams: { query: 'oil control sunscreen' },
    traceQueryClass: 'query',
    requestContract: {
      primary_lane: 'beauty_discovery_mainline',
    },
    executionPlan: {
      primary_lane: 'beauty_discovery_mainline',
      primary_retrieval_contract: 'agent_v1_search_beauty_mainline',
    },
  });

  assert.equal(out.response?.status, 200);
  assert.deepEqual(out.response?.data?.products, []);
  assert.equal(
    out.response?.data?.metadata?.reason,
    'beauty_discovery_mainline_timeout',
  );
  assert.equal(
    out.response?.data?.metadata?.route,
    'beauty_discovery_mainline_primary_exception',
  );
  assert.equal(calls.strictEmpty, 1);
  assert.equal(calls.resolver, 0);
  assert.equal(calls.invokeFallback, 0);
  assert.equal(calls.softFallback, 0);
});

test('non-beauty search exceptions retain legacy soft fallback behavior', async () => {
  const { runtime, calls } = createRuntime({
    shouldAllowResolverFallback: () => false,
    shouldAllowSecondaryFallback: () => false,
    shouldAllowInvokeFallback: () => false,
  });
  const out = await runtime.handleInvokePrimarySearchException({
    operation: 'find_products_multi',
    err: {
      code: 'ECONNRESET',
      message: 'socket hang up',
    },
    queryParams: { query: 'everyday tote bag' },
    traceQueryClass: 'query',
    requestContract: {
      primary_lane: 'resolver_only',
    },
    executionPlan: {
      primary_lane: 'resolver_only',
      primary_retrieval_contract: 'resolver_only',
    },
  });

  assert.equal(out.response?.status, 200);
  assert.equal(out.response?.data?.metadata?.reason, 'error_soft_fallback');
  assert.equal(out.response?.data?.metadata?.route, 'invoke_exception');
  assert.equal(out.response?.data?.metadata?.query_source, 'agent_products_error_fallback');
  assert.equal(calls.strictEmpty, 0);
  assert.equal(calls.resolver, 0);
  assert.equal(calls.invokeFallback, 0);
  assert.equal(calls.softFallback, 1);
});
