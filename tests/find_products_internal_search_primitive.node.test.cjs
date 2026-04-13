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

test('internal products search primitive applies beauty step and semantic filters to noisy cache results', async () => {
  const runtime = createFindProductsInternalSearchPrimitiveRuntime({
    normalizeAgentProductsListResponse: (body) => body,
    searchCrossMerchantFromCache: async () => ({
      products: [
        {
          product_id: 'p_keep',
          title: 'Oil Control Serum',
          description: 'A mattifying niacinamide serum for oily skin.',
          product_type: 'Serum',
          merchant_id: 'm1',
        },
        {
          product_id: 'p_drop_lingerie',
          title: 'Sweet Lace lingerie set 4020',
          description: 'Soft lace set against skin.',
          product_type: 'Apparel',
          merchant_id: 'm2',
        },
        {
          product_id: 'p_drop_pet',
          title: 'Warm Fall Utility Overalls for Dogs & Cats',
          description: 'Pet outfit for cold weather.',
          product_type: 'Pet Apparel',
          merchant_id: 'm3',
        },
        {
          product_id: 'p_drop_wrong_semantic',
          title: 'Soothing Repair Serum',
          description: 'A calming serum for barrier support.',
          product_type: 'Serum',
          merchant_id: 'm4',
        },
        {
          product_id: 'p_drop_wrong_step',
          title: 'Oil-Free Gel Cream',
          description: 'A lightweight moisturizer for oily skin.',
          product_type: 'Moisturizer',
          merchant_id: 'm5',
        },
      ],
      total: 5,
      retrieval_sources: [{ source: 'lexical_cache', used: true, count: 5 }],
      query_terms: ['oil', 'control', 'serum'],
      beauty_query_bucket: 'skincare',
    }),
    getDefaultTimeoutMs: () => 4800,
  });

  const req = {
    body: {
      query: 'oil control serum',
      limit: 6,
      catalog_surface: 'beauty',
      target_step_family: 'serum',
      semantic_family: 'oil_control_treatment',
      query_step_strength: 'strong_goal_family',
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

  assert.equal(statusCode, 200);
  assert.deepEqual(
    responseBody.products.map((row) => row.product_id),
    ['p_keep'],
  );
  assert.equal(responseBody.total, 1);
  assert.equal(responseBody.metadata.post_filter_applied, true);
  assert.equal(responseBody.metadata.post_filter_rejected_count, 4);
  assert.equal(responseBody.metadata.post_filter_target_step_family, 'serum');
  assert.equal(responseBody.metadata.post_filter_semantic_family, 'oil_control');
  assert.equal(responseBody.metadata.post_filter_query_step_strength, 'strong_goal_family');
});

test('internal products search primitive rejects pet apparel when beauty text lives in alternate display fields', async () => {
  const runtime = createFindProductsInternalSearchPrimitiveRuntime({
    normalizeAgentProductsListResponse: (body) => body,
    searchCrossMerchantFromCache: async () => ({
      products: [
        {
          product_id: 'p_keep_moisturizer',
          title: 'Oil-Free Gel Moisturizer',
          description: 'A lightweight oil-free moisturizer for oily skin.',
          product_type: 'Moisturizer',
          merchant_id: 'm1',
        },
        {
          product_id: 'p_drop_pet_vest',
          displayName: 'Everyday Fall/Winter Padded Winter Vest for Dogs & Cats',
          categoryName: 'Pet Apparel',
          category_path: ['Pets', 'Dog Apparel', 'Winter Vest'],
          search_aliases: ['padded winter vest', 'dog clothing'],
          merchant_id: 'm2',
        },
      ],
      total: 2,
      retrieval_sources: [{ source: 'lexical_cache', used: true, count: 2 }],
      query_terms: ['oil', 'free', 'moisturizer'],
      beauty_query_bucket: 'skincare',
    }),
    getDefaultTimeoutMs: () => 4800,
  });

  const req = {
    body: {
      query: 'oil free moisturizer',
      limit: 6,
      catalog_surface: 'beauty',
      target_step_family: 'moisturizer',
      semantic_family: 'oil_control',
      query_step_strength: 'supportive_family',
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

  assert.equal(statusCode, 200);
  assert.deepEqual(
    responseBody.products.map((row) => row.product_id),
    ['p_keep_moisturizer'],
  );
  assert.equal(responseBody.total, 1);
  assert.equal(responseBody.metadata.post_filter_applied, true);
  assert.equal(responseBody.metadata.post_filter_rejected_count, 1);
  assert.equal(responseBody.metadata.post_filter_target_step_family, 'moisturizer');
  assert.equal(responseBody.metadata.post_filter_semantic_family, 'oil_control');
  assert.equal(responseBody.metadata.post_filter_query_step_strength, 'supportive_family');
});

test('internal products search primitive does not drop beauty tools for generic beauty queries without step or semantic gating', async () => {
  const runtime = createFindProductsInternalSearchPrimitiveRuntime({
    normalizeAgentProductsListResponse: (body) => body,
    searchCrossMerchantFromCache: async () => ({
      products: [
        {
          product_id: 'tool_keep',
          title: 'Foundation Brush',
          description: 'A beauty tool for liquid foundation application.',
          product_type: 'Beauty Tool',
          merchant_id: 'm_tool',
        },
        {
          product_id: 'noise_drop',
          title: 'Sweet Lace lingerie set 4020',
          description: 'Soft lace set.',
          product_type: 'Apparel',
          merchant_id: 'm_noise',
        },
      ],
      total: 2,
      retrieval_sources: [{ source: 'lexical_cache', used: true, count: 2 }],
      query_terms: ['foundation', 'brush'],
      beauty_query_bucket: 'base_makeup',
    }),
    getDefaultTimeoutMs: () => 4800,
  });

  const req = {
    body: {
      query: 'foundation brush',
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

  assert.equal(statusCode, 200);
  assert.deepEqual(
    responseBody.products.map((row) => row.product_id),
    ['tool_keep'],
  );
  assert.equal(responseBody.metadata.post_filter_applied, true);
  assert.equal(responseBody.metadata.post_filter_rejected_count, 1);
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
