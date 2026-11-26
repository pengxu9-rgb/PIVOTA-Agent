'use strict';

/**
 * PARTNER SANDBOX marks on the HEARTBEAT path: a slow tools/call whose 200 is committed early and whose body the
 * heartbeat writes raw (res.end), past the res.json middleware. Modelled on tests/commerce_mcp_route_heartbeat
 * (forced 1 ms delay, a slow loopback upstream, the test-runtime invoke-auth bypass).
 *
 * In the sandbox the committed body still carries the marks (result `_meta.sandbox`, the answer's `sandbox: true`)
 * and the response the header; outside it, the same committed body carries none of them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const supertest = require('supertest');

const ORIGINAL_ENV = { ...process.env };
let upstream;
let app;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ products: [], items: [], results: [] }));
    }, 60);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  process.env.NODE_ENV = 'test';
  process.env.AURORA_BFF_USE_MOCK = 'true';
  process.env.AGENT_CHECKOUT_STRICT = '1';
  process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
  process.env.PIVOTA_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
  process.env.PIVOTA_API_KEY = 'test-token';
  process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
  process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
  delete process.env.PIVOTA_ENV;
  app = require('../src/server');
});

test.after(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  process.env = { ...ORIGINAL_ENV };
});

function rawParser(res, cb) {
  let raw = '';
  res.on('data', (chunk) => { raw += chunk; });
  res.on('end', () => cb(null, raw));
}

async function slowToolCall(env) {
  Object.assign(process.env, { COMMERCE_MCP_HEARTBEAT_DELAY_MS: '1', COMMERCE_MCP_HEARTBEAT_INTERVAL_MS: '5', ...env });
  try {
    return await supertest(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'get_product', arguments: { product_id: 'sig_probe', merchant_id: 'm1' } } })
      .buffer(true)
      .parse(rawParser)
      .expect(200);
  } finally {
    delete process.env.COMMERCE_MCP_HEARTBEAT_DELAY_MS;
    delete process.env.COMMERCE_MCP_HEARTBEAT_INTERVAL_MS;
    delete process.env.PIVOTA_ENV;
  }
}

test('sandbox: a heartbeat-committed tools/call body still carries the marks, and the response the header', async () => {
  const resp = await slowToolCall({ PIVOTA_ENV: 'sandbox' });
  assert.match(resp.body, /^\s/, 'the heartbeat committed the response (leading whitespace)');
  const parsed = JSON.parse(resp.body);
  assert.equal(parsed.id, 21);
  assert.ok(parsed.result, JSON.stringify(parsed));
  assert.deepEqual(parsed.result._meta, { sandbox: true });
  assert.equal(resp.headers['x-pivota-env'], 'sandbox');
});

test('outside the sandbox: the same heartbeat-committed body has no mark and no header', async () => {
  const resp = await slowToolCall({});
  assert.match(resp.body, /^\s/);
  const parsed = JSON.parse(resp.body);
  assert.equal(parsed.id, 21);
  assert.equal(parsed.result?._meta, undefined);
  assert.equal(JSON.stringify(parsed).includes('"sandbox":true'), false);
  assert.equal(resp.headers['x-pivota-env'], undefined);
});
