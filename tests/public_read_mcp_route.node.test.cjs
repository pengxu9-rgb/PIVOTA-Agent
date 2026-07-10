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
  // Annotations flow through tools/list end-to-end (OpenAI's most-cited rejection cause).
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} readOnlyHint`);
    assert.equal(t.annotations.openWorldHint, false, `${t.name} openWorldHint`);
    assert.match(t.description, /read-only\.?$/i);
  }
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

test('POST /public/mcp rejects oversized bodies (Content-Length path)', async () => {
  await supertest(app)
    .post('/public/mcp')
    .send(rpc('tools/list', { padding: 'x'.repeat(64 * 1024) }, 7))
    .expect(413);
});

test('POST /public/mcp rejects oversized CHUNKED bodies (no Content-Length)', async () => {
  // Raw request that writes chunks without setting Content-Length → Node uses chunked transfer-encoding, so
  // the route's header check can't catch it and the early STREAM guard must. Accept 413 or a connection
  // reset (the guard destroys the request past the cap) — both mean "not accepted / no large parse".
  const http = require('http');
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const big = JSON.stringify(rpc('tools/list', { padding: 'y'.repeat(64 * 1024) }, 8));
  const outcome = await new Promise((resolve) => {
    const req = http.request(
      { port, path: '/public/mcp', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    req.on('error', () => resolve('reset'));
    req.write(big.slice(0, 40000));
    req.write(big.slice(40000));
    req.end();
  });
  server.close();
  assert.ok(outcome === 413 || outcome === 'reset', `expected 413 or reset, got ${outcome}`);
});

test('rate limiter keys on the trusted (right-most) XFF hop, not the spoofable left-most', async () => {
  // Same real client (right-most), rotating a forged left-most XFF must NOT mint fresh buckets.
  // Drain the bucket (burst default 20) then confirm the 429 still fires despite rotating forged IPs.
  let sawLimit = false;
  for (let i = 0; i < 40; i += 1) {
    const res = await supertest(app)
      .post('/public/mcp')
      .set('X-Forwarded-For', `10.0.0.${i}, 203.0.113.7`) // forged left, constant real right
      .send(rpc('tools/list', undefined, 100 + i));
    if (res.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'rotating the forged left-most XFF should not bypass the per-client limit');
});
