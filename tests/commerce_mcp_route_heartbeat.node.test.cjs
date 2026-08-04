'use strict';

// Wire-level coverage for the edge-timeout heartbeat on the AUTHENTICATED commerce MCP lane
// (POST /mcp, non-public host) — the commerce twin of tests/public_read_mcp_route.node.test.cjs.
// The Railway edge resets any response whose first BODY byte arrives later than ~13s
// (services/publicReadMcpHeartbeat), so a slow commerce tools/call must commit 200 + heartbeat
// whitespace early, while every non-200 fast path (strict-off 404, missing-key 401) must keep its
// real status because those resolve BEFORE the heartbeat is created.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const supertest = require('supertest');

const ORIGINAL_ENV = { ...process.env };

// Slow mock upstream: answers every request after a delay, so a real commerce tools/call is
// genuinely slow — the heartbeat commit is forced by real elapsed compute, not by luck of module
// import timing.
const UPSTREAM_DELAY_MS = 60;
let upstream;
let app;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ products: [], items: [], results: [] }));
    }, UPSTREAM_DELAY_MS);
  });
  await new Promise((resolve) => upstream.listen(0, resolve));

  process.env.NODE_ENV = 'test'; // per-request invoke-auth test bypass (no introspection config set)
  process.env.AURORA_BFF_USE_MOCK = 'true';
  process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
  process.env.AGENT_CHECKOUT_STRICT = '1';
  process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
  process.env.PIVOTA_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  process.env.PIVOTA_API_KEY = 'test-token';
  process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
  process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
  // Keep /mcp on the commerce lane: the public tier must not capture these requests by host.
  delete process.env.PUBLIC_READ_MCP_ENABLED;
  // Hermetic against a developer machine exporting the prod knobs: an ambient
  // PUBLIC_READ_MCP_HEARTBEAT_ENABLED=0 disables the guard on this lane too and would turn the heartbeat
  // assertions below into failures for a reason that has nothing to do with the code under test.
  for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
    for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) {
      delete process.env[`${prefix}_HEARTBEAT_${suffix}`];
    }
  }

  app = require('../src/server');
});

test.after(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  process.env = { ...ORIGINAL_ENV };
});

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}

function rawParser(res, cb) {
  let raw = '';
  res.on('data', (chunk) => { raw += chunk; });
  res.on('end', () => cb(null, raw));
}

// A REGRESSION LOCK, deliberately not a proof. The gate that keeps this 202 intact
// (isMcpHeartbeatEligibleRequest) is proven in tests/commerce_mcp_heartbeat_gate.node.test.cjs, because no
// route-level test can prove it: everything the handler does before the JSON-RPC dispatch is synchronous, so
// the commit timer never fires here even with the delay forced to 1ms and the gate deleted. What this
// still catches is a future change that makes the pre-dispatch path genuinely async — at which point an
// ungated heartbeat would rewrite this 202 into 200 + a bare "\n" and this test would go red.
test('notifications/initialized answers 202 with an empty body under a forced 1ms delay', async () => {
  process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS = '1';
  process.env.COMMERCE_MCP_HEARTBEAT_INTERVAL_MS = '5';
  try {
    const resp = await supertest(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      .buffer(true)
      .parse(rawParser);
    assert.equal(resp.status, 202, 'a commit would have masked this as 200');
    assert.equal(resp.body, '', 'expected an empty body, not heartbeat whitespace');
  } finally {
    delete process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS;
    delete process.env.COMMERCE_MCP_HEARTBEAT_INTERVAL_MS;
  }
});

test('slow commerce tools/call heartbeats through the REAL route: 200 committed, leading bytes, body still parses', async () => {
  // Force the commit with a 1ms delay (commerce-specific knobs) so the slow upstream call is "slow",
  // then observe the actual wire: heartbeat whitespace first, then a JSON-RPC body that still parses.
  process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS = '1';
  process.env.COMMERCE_MCP_HEARTBEAT_INTERVAL_MS = '5';
  try {
    // get_product (not search_catalog): it always round-trips PIVOTA_API_BASE, so the slow mock upstream
    // makes the call deterministically outlive the 1ms delay — search can answer from local paths in <1ms
    // on a warm adapter and lose the race against the commit timer.
    const resp = await supertest(app)
      .post('/mcp')
      .send(rpc('tools/call', { name: 'get_product', arguments: { product_id: 'sig_probe', merchant_id: 'm1' } }, 11))
      .buffer(true)
      .parse(rawParser)
      .expect(200);
    const raw = resp.body;
    assert.match(raw, /^\s/, 'expected heartbeat whitespace before the JSON body');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, 11);
    assert.ok(parsed.result || parsed.error, 'expected a JSON-RPC result or error body');
  } finally {
    delete process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS;
    delete process.env.COMMERCE_MCP_HEARTBEAT_INTERVAL_MS;
  }
});

test('the PUBLIC_READ_MCP_* knobs govern the commerce lane too (shared edge, shared kill-switch)', async () => {
  process.env.PUBLIC_READ_MCP_HEARTBEAT_DELAY_MS = '1';
  process.env.PUBLIC_READ_MCP_HEARTBEAT_INTERVAL_MS = '5';
  try {
    const resp = await supertest(app)
      .post('/mcp')
      .send(rpc('tools/call', { name: 'get_product', arguments: { product_id: 'sig_probe', merchant_id: 'm1' } }, 12))
      .buffer(true)
      .parse(rawParser)
      .expect(200);
    assert.match(resp.body, /^\s/, 'expected the public-tier knobs to reach the commerce lane');
    assert.equal(JSON.parse(resp.body).id, 12);
  } finally {
    delete process.env.PUBLIC_READ_MCP_HEARTBEAT_DELAY_MS;
    delete process.env.PUBLIC_READ_MCP_HEARTBEAT_INTERVAL_MS;
  }
});

test('fast initialize stays a byte-identical buffered response under default knobs', async () => {
  const resp = await supertest(app)
    .post('/mcp')
    .send(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }, 13))
    .buffer(true)
    .parse(rawParser)
    .expect(200);
  assert.match(resp.body, /^\{/, 'fast path must not emit heartbeat bytes');
  const parsed = JSON.parse(resp.body);
  assert.equal(parsed.result.serverInfo.name, 'pivota-commerce-mcp');
});

test('strict-off 404 keeps its status even with a 1ms heartbeat delay (heartbeat created after the gate)', async () => {
  process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS = '1';
  delete process.env.AGENT_CHECKOUT_STRICT;
  try {
    await supertest(app).post('/mcp').send(rpc('tools/list', undefined, 14)).expect(404);
  } finally {
    process.env.AGENT_CHECKOUT_STRICT = '1';
    delete process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS;
  }
});

test('missing-key 401 keeps its status even with a 1ms heartbeat delay', async () => {
  process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS = '1';
  process.env.INVOKE_AUTH_BYPASS_IN_TEST = '0';
  try {
    const resp = await supertest(app).post('/mcp').send(rpc('tools/list', undefined, 15)).expect(401);
    assert.equal(resp.body.error, 'UNAUTHORIZED');
  } finally {
    delete process.env.INVOKE_AUTH_BYPASS_IN_TEST;
    delete process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS;
  }
});

test('a blocked money op answers buffered, ahead of the heartbeat, even with a 1ms delay', async () => {
  // complete_checkout_session is refused while AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED is off. That
  // refusal is decided from the body alone and returns BEFORE the heartbeat is constructed, so it must be a
  // plain buffered JSON body — no heartbeat whitespace — however small the delay is.
  process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS = '1';
  try {
    const resp = await supertest(app)
      .post('/mcp')
      .send(rpc('tools/call', { name: 'complete_checkout_session', arguments: {} }, 16))
      .buffer(true)
      .parse(rawParser)
      .expect(200);
    assert.match(resp.body, /^\{/, 'a refused money op must not ride a committed heartbeat wire');
    const parsed = JSON.parse(resp.body);
    assert.equal(parsed.id, 16);
    assert.equal(parsed.result.isError, true);
    assert.match(parsed.result.content[0].text, /OPERATION_NOT_ALLOWED/);
    assert.match(parsed.result.content[0].text, /submit_payment is disabled/);
  } finally {
    delete process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS;
  }
});
