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

// Express routes case-insensitively and tolerates a trailing slash (caseSensitive/strict default off), so
// `/MCP`, `/mcp/`, `/PUBLIC/MCP` and `/public/mcp/` all reach the public read handler. The early body-cap
// middleware must recognize them too. It has to be driven CHUNKED to mean anything: with a Content-Length,
// the route's own header check (handlePublicReadMcp) answers 413 for every spelling, so a Content-Length
// test would pass even with the cap bypassed. Chunked is the case only the middleware can see.
function postChunked(port, { path, host, body }) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.request(
      {
        port,
        path,
        method: 'POST',
        // Fresh socket per probe: the cap DESTROYS the request, and a pooled keep-alive socket carrying
        // that reset would fail the next probe for a reason that has nothing to do with what it asserts.
        agent: false,
        headers: { 'Content-Type': 'application/json', ...(host ? { Host: host } : {}) },
      },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    req.on('error', () => resolve('reset'));
    // Two writes with no Content-Length → Node uses Transfer-Encoding: chunked.
    const half = Math.ceil(body.length / 2);
    req.write(body.slice(0, half));
    req.write(body.slice(half));
    req.end();
  });
}

const PUBLIC_MCP_PATH_SPELLINGS = [
  { path: '/public/mcp' },
  { path: '/PUBLIC/MCP' },
  { path: '/public/mcp/' },
  { path: '/mcp', host: 'mcp.pivota.cc' },
  { path: '/MCP', host: 'mcp.pivota.cc' },
  { path: '/mcp/', host: 'mcp.pivota.cc' },
];

test('every Express spelling of the public MCP paths caps oversized CHUNKED bodies', async () => {
  const http = require('http');
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const big = JSON.stringify(rpc('tools/list', { padding: 'z'.repeat(64 * 1024) }, 20));
  const small = JSON.stringify(rpc('tools/list', undefined, 21));
  const results = [];
  try {
    for (const spelling of PUBLIC_MCP_PATH_SPELLINGS) {
      results.push({
        path: spelling.path,
        // Premise check: this spelling really does reach the public handler, so a capped verdict below is
        // the cap firing and not a 404. 429 also counts — it comes from the route, i.e. past the cap.
        reached: await postChunked(port, { ...spelling, body: small }),
        // The cap itself: 413 from the header-less stream guard, or a reset when it destroys the request.
        capped: await postChunked(port, { ...spelling, body: big }),
      });
    }
  } finally {
    server.close();
  }
  // Report EVERY spelling in one run rather than aborting on the first — the bypass is per-spelling, so
  // which ones leak is the finding.
  const unreached = results.filter((r) => r.reached !== 200 && r.reached !== 429);
  assert.deepEqual(unreached, [], `these spellings did not reach the public read handler: ${JSON.stringify(unreached)}`);
  const leaked = results.filter((r) => r.capped !== 413 && r.capped !== 'reset');
  assert.deepEqual(leaked, [], `these spellings accepted a ${big.length}B chunked body past the 32KB cap: ${JSON.stringify(leaked)}`);
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

test('slow tools/call heartbeats through the REAL route: 200 committed, leading bytes, body still parses', async () => {
  // The guard exists because the Railway edge resets any response whose first BODY byte is later than ~13s
  // (services/publicReadMcpHeartbeat). Force the commit with a 1ms delay so every real tools/call is "slow",
  // and observe the actual wire: heartbeat whitespace first, then a JSON-RPC body that still parses.
  // Fresh right-most XFF hop: the previous test intentionally drained the shared client's rate bucket.
  process.env.PUBLIC_READ_MCP_HEARTBEAT_DELAY_MS = '1';
  process.env.PUBLIC_READ_MCP_HEARTBEAT_INTERVAL_MS = '5';
  try {
    const resp = await supertest(app)
      .post('/public/mcp')
      .set('X-Forwarded-For', '10.9.9.9, 198.51.100.42')
      .send(rpc('tools/call', { name: 'search_catalog', arguments: { query: 'heartbeat wire probe' } }, 9))
      .buffer(true)
      .parse((res, cb) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => cb(null, raw));
      })
      .expect(200);
    const raw = resp.body;
    assert.match(raw, /^\s/, 'expected heartbeat whitespace before the JSON body');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, 9);
    assert.ok(parsed.result || parsed.error, 'expected a JSON-RPC result or error body');
  } finally {
    delete process.env.PUBLIC_READ_MCP_HEARTBEAT_DELAY_MS;
    delete process.env.PUBLIC_READ_MCP_HEARTBEAT_INTERVAL_MS;
  }
});
