const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeInternalProductsSearchRequest,
  createFindProductsInternalSearchPrimitiveRuntime,
} = require('../src/findProductsInternalSearchPrimitive');

test('internal products search primitive rejects orchestration fields', () => {
  const out = sanitizeInternalProductsSearchRequest({
    query: 'oil control serum',
    limit: 6,
    semantic_contract: { planner_mode: 'framework_generic' },
    primary_lane: 'beauty_discovery_mainline',
  });

  assert.equal(out.ok, false);
  assert.deepEqual(out.forbidden_fields.sort(), ['primary_lane', 'semantic_contract']);
});

test('internal products search primitive uses local cache retrieval instead of upstream orchestrator', async () => {
  const calls = [];
  const runtime = createFindProductsInternalSearchPrimitiveRuntime({
    normalizeAgentProductsListResponse: (body) => body,
    searchCrossMerchantFromCache: async (query, page, limit, options) => {
      calls.push({ query, page, limit, options });
      return {
        products: [
          { product_id: 'p1', title: 'Oil Control Serum', merchant_id: 'm1' },
          { product_id: 'p2', title: 'Niacinamide Serum', merchant_id: 'm2' },
        ],
        total: 2,
        retrieval_sources: [{ source: 'lexical_cache', used: true, count: 2 }],
        query_terms: ['oil', 'control', 'serum'],
        beauty_query_bucket: 'skincare',
      };
    },
    getDefaultTimeoutMs: () => 4800,
  });

  const req = {
    body: {
      query: 'oil control serum',
      limit: 6,
      catalog_surface: 'beauty',
      target_step_family: 'treatment',
    },
    header(name) {
      const headers = {
        'x-trace-id': 'trace-123',
        'x-internal-search-timeout-ms': '4200',
      };
      return headers[String(name || '').toLowerCase()] || null;
    },
  };
  let statusCode = 200;
  let responseBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return body;
    },
  };

  await runtime.handleInternalProductsSearch(req, res);

  assert.equal(statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, 'oil control serum');
  assert.equal(calls[0].page, 1);
  assert.equal(calls[0].limit, 6);
  assert.equal(calls[0].options.inStockOnly, true);
  assert.equal(responseBody.metadata.query_source, 'internal_products_search_primitive_cache');
  assert.equal(responseBody.metadata.endpoint_kind, 'internal_primitive');
  assert.equal(responseBody.metadata.transport_owner, 'internal_products_search_primitive');
  assert.deepEqual(responseBody.metadata.query_terms, ['oil', 'control', 'serum']);
  assert.equal(responseBody.metadata.beauty_query_bucket, 'skincare');
  assert.equal(responseBody.total, 2);
  assert.equal(responseBody.products.length, 2);
});

test('internal products search primitive surfaces local cache failure details', async () => {
  const runtime = createFindProductsInternalSearchPrimitiveRuntime({
    normalizeAgentProductsListResponse: (body) => body,
    searchCrossMerchantFromCache: async () => {
      const err = new Error('cache query failed');
      err.code = 'CACHE_QUERY_FAILED';
      throw err;
    },
    getDefaultTimeoutMs: () => 4800,
  });

  const req = {
    body: {
      query: 'oil control serum',
      limit: 6,
      catalog_surface: 'beauty',
    },
    header() {
      return null;
    },
  };
  let statusCode = 200;
  let responseBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return body;
    },
  };

  await runtime.handleInternalProductsSearch(req, res);

  assert.equal(statusCode, 502);
  assert.equal(responseBody.error, 'INTERNAL_PRODUCTS_SEARCH_UPSTREAM_ERROR');
  assert.equal(responseBody.message, 'cache query failed');
  assert.equal(responseBody.failure_stage, 'local_cache_retrieval');
  assert.equal(responseBody.internal_error_code, 'CACHE_QUERY_FAILED');
});
