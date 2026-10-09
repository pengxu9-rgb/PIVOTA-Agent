'use strict';

// THE RE-INVOKES CARRY THE OUTER BUYER MARKET, PROVEN AGAINST THE REAL EDGES. The first cut of
// these tests injected the layer3 fetcher and stubbed the fallback's payload builder, so a mutant
// that dropped `metadata.market` on the real POST survived. These drive the real producers: the
// real layer3 fetcher over a stubbed axios, and the real `buildFindProductsMultiPayloadFromQuery`
// from server.js (under FIND_PRODUCTS_BUYER_MARKET=on, as prod runs it) feeding the real fallback.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.FIND_PRODUCTS_BUYER_MARKET = 'on';
process.env.PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || 'layer3-test-key';
process.env.PIVOTA_API_BASE = 'http://backend.reinvoke.test';
delete process.env.API_MODE;

const axios = require('axios');

test('the REAL layer3 fetcher puts the kit market on the inner invoke, and nothing when there is none', async () => {
  const { getCandidates } = require('../src/layer3/retrieval/getCandidates');
  const sent = [];
  const realPost = axios.post;
  axios.post = async (url, body) => {
    sent.push({ url, body });
    return { status: 200, data: { products: [] } };
  };
  const lookSpec = {
    breakdown: Object.fromEntries(['prep', 'base', 'contour', 'brow', 'eye', 'blush', 'lip'].map((c) => [c, { keyNotes: [] }])),
  };
  try {
    await getCandidates({ lookSpec, market: 'jp', limitPerCategory: 2 });
    assert.ok(sent.length >= 1, 'the real fetcher ran');
    for (const { url, body } of sent) {
      assert.equal(url, 'http://backend.reinvoke.test/agent/shop/v1/invoke');
      assert.equal(body.metadata.market, 'JP');
      assert.equal(body.metadata.source, 'layer3-kit');
      assert.equal(body.metadata.invoked_by, 'layer3.getCandidates');
    }
    sent.length = 0;
    await getCandidates({ lookSpec, market: 'usa', limitPerCategory: 2 });
    assert.ok(sent.length >= 1);
    for (const { body } of sent) assert.equal('market' in body.metadata, false, JSON.stringify(body.metadata));
  } finally {
    axios.post = realPost;
  }
});

test('the real payload builder copies the outer market, and the real fallback POSTs it as metadata.market', async () => {
  const { _debug } = require('../src/server');
  const { createCommerceResolutionRuntime } = require('../src/modules/execution/commerce_resolution');
  assert.equal(typeof _debug.buildFindProductsMultiPayloadFromQuery, 'function');

  const seen = [];
  const runtime = createCommerceResolutionRuntime({
    getProxySearchApiBase: () => 'http://search.reinvoke.test',
    buildFindProductsMultiPayloadFromQuery: _debug.buildFindProductsMultiPayloadFromQuery,
    httpRequest: async (config) => {
      seen.push(config);
      return { status: 200, data: { products: [], metadata: {} } };
    },
    normalizeAgentProductsListResponse: (r) => r,
  });

  // Outer request named `sg` in metadata only: the builder normalises it, the inner POST carries it.
  const keyed = runtime.buildCacheMissResolverFallbackRequest({
    search: { category: 'skincare' },
    metadata: { market: 'sg' },
    cacheQueryText: 'repair serum',
    source: 'shopping_agent',
    resolverTimeoutMs: 500,
  });
  assert.equal(keyed.queryParams.market, 'SG');
  await runtime.queryFindProductsMultiFallback({ ...keyed, reason: 'primary_request_failed' });
  const posts = seen.filter((c) => c.method === 'POST');
  assert.ok(posts.length >= 1, 'the fallback POSTed');
  for (const c of posts) {
    assert.equal(c.data.payload.search.market, 'SG', 'the real builder copied the market');
    assert.equal(c.data.metadata.market, 'SG', 'and the inner metadata carries it');
  }

  // Outer request with no market: the whole chain stays silent.
  seen.length = 0;
  const silent = runtime.buildCacheMissResolverFallbackRequest({
    search: { category: 'skincare' },
    metadata: { source: 'shopping_agent' },
    cacheQueryText: 'repair serum',
    source: 'shopping_agent',
    resolverTimeoutMs: 500,
  });
  assert.equal('market' in silent.queryParams, false);
  await runtime.queryFindProductsMultiFallback({ ...silent, reason: 'primary_request_failed' });
  for (const c of seen.filter((x) => x.method === 'POST')) {
    assert.equal('market' in c.data.payload.search, false);
    assert.equal('market' in c.data.metadata, false);
  }
});
