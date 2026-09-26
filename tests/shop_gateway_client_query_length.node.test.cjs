'use strict';

// The Aurora shop skill's hop to the invoke route cuts a chat-derived query to the route's limit
// instead of sending it and getting 400 QUERY_TOO_LONG (src/findProductsMulti/queryLengthCap.js).

const test = require('node:test');
const assert = require('node:assert/strict');

test('an over-long chat query is cut to the limit before the hop', async () => {
  process.env.PIVOTA_BACKEND_BASE_URL = 'http://gateway.test';
  delete require.cache[require.resolve('../src/auroraBff/clients/shopGatewayClient')];
  const { findProductsMulti } = require('../src/auroraBff/clients/shopGatewayClient');
  const { DEFAULT_MAX_CHARS } = require('../src/findProductsMulti/queryLengthLimit');
  const sent = [];
  const axios = { post: async (url, body) => { sent.push(body); return { status: 200, data: { products: [] } }; } };

  await findProductsMulti({ query: `serum ${'x'.repeat(2000)}`, deps: { axios } });
  await findProductsMulti({ query: 'serum', deps: { axios } });

  assert.equal(sent[0].payload.search.query.length, DEFAULT_MAX_CHARS);
  assert.ok(sent[0].payload.search.query.startsWith('serum '));
  assert.equal(sent[1].payload.search.query, 'serum');
});
