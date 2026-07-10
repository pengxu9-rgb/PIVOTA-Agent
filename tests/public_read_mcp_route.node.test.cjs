'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
// The public read tier must be reachable with the checkout kill-switch OFF — that independence is the point.
delete process.env.AGENT_CHECKOUT_STRICT;
process.env.PUBLIC_READ_MCP_ENABLED = '1';
process.env.PUBLIC_READ_MCP_HOSTS = 'mcp.pivota.cc';

const app = require('../src/server');

const PUBLIC_READ_TOOLS = ['search_catalog', 'get_product', 'get_intel', 'get_alternatives'];

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}

test('POST /public/mcp initialize works unauthenticated with AGENT_CHECKOUT_STRICT off', async () => {
  const resp = await supertest(app)
    .post('/public/mcp')
    .send(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }))
    .expect(200);
  assert.equal(resp.body.result.serverInfo.name, 'pivota');
  assert.equal(resp.body.result.protocolVersion, '2025-06-18');
});

test('POST /public/mcp tools/list returns exactly the four read tools', async () => {
  const resp = await supertest(app).post('/public/mcp').send(rpc('tools/list', undefined, 2)).expect(200);
  const tools = resp.body.result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), [...PUBLIC_READ_TOOLS].sort());
  // Input-collapse shipped: get_product resolves by the single public sig id, merchant_id not required.
  const getProduct = tools.find((t) => t.name === 'get_product');
  assert.deepEqual(getProduct.inputSchema.required, ['product_id']);
});

test('POST /mcp dispatches to the public tier for a public app host', async () => {
  const resp = await supertest(app)
    .post('/mcp')
    .set('Host', 'mcp.pivota.cc')
    .send(rpc('tools/list', undefined, 3))
    .expect(200);
  assert.deepEqual(
    resp.body.result.tools.map((t) => t.name).sort(),
    [...PUBLIC_READ_TOOLS].sort()
  );
});

test('POST /mcp on a non-public host keeps the commerce gating (404 with strict off)', async () => {
  await supertest(app).post('/mcp').send(rpc('tools/list', undefined, 4)).expect(404);
});

test('POST /public/mcp is dark (404) when PUBLIC_READ_MCP_ENABLED is off', async () => {
  delete process.env.PUBLIC_READ_MCP_ENABLED;
  try {
    await supertest(app).post('/public/mcp').send(rpc('tools/list', undefined, 5)).expect(404);
    await supertest(app)
      .post('/mcp')
      .set('Host', 'mcp.pivota.cc')
      .send(rpc('tools/list', undefined, 6))
      .expect(404);
  } finally {
    process.env.PUBLIC_READ_MCP_ENABLED = '1';
  }
});

test('POST /public/mcp rejects oversized bodies', async () => {
  await supertest(app)
    .post('/public/mcp')
    .send(rpc('tools/list', { padding: 'x'.repeat(64 * 1024) }, 7))
    .expect(413);
});
