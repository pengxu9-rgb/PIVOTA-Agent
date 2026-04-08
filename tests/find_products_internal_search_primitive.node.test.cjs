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

test('internal products search primitive proxies to thin upstream with timeout retry disabled', async () => {
  const calls = [];
  const runtime = createFindProductsInternalSearchPrimitiveRuntime({
    buildSearchProductsV2Body: ({ search, metadata }) => ({
      operation: 'find_products_multi',
      payload: { search, metadata },
    }),
    normalizeAgentProductsListResponse: (body) => body,
    callUpstreamWithOptionalRetry: async (operation, config, options) => {
      calls.push({ operation, config, options });
      return {
        status: 200,
        data: {
          products: [{ product_id: 'p1', title: 'Oil Control Serum' }],
        },
      };
    },
    buildInvokeUpstreamAuthHeaders: ({ checkoutToken }) =>
      checkoutToken ? { Authorization: `Bearer ${checkoutToken}` } : {},
    getUpstreamUrl: () => 'https://backend.example/agent/v2/products/search',
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
        'x-checkout-token': 'checkout-token',
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
  assert.equal(calls[0].operation, 'find_products_multi');
  assert.equal(calls[0].config.method, 'POST');
  assert.equal(calls[0].config.url, 'https://backend.example/agent/v2/products/search');
  assert.equal(calls[0].config.timeout, 4200);
  assert.equal(calls[0].options.disableTimeoutRetry, true);
  assert.deepEqual(calls[0].config.data, {
    operation: 'find_products_multi',
    payload: {
      search: {
        query: 'oil control serum',
        limit: 6,
        search_all_merchants: true,
        catalog_surface: 'beauty',
        target_step_family: 'treatment',
      },
      metadata: {
        source: 'internal_products_search_primitive',
        trace_id: 'trace-123',
      },
    },
  });
  assert.equal(
    calls[0].config.headers.Authorization,
    'Bearer checkout-token',
  );
  assert.equal(responseBody.metadata.query_source, 'internal_products_search_primitive');
  assert.equal(responseBody.metadata.endpoint_kind, 'internal_primitive');
  assert.equal(responseBody.metadata.transport_owner, 'internal_products_search_primitive');
});
