'use strict';

// FIRST: no test in this directory may reach a non-loopback host (see _net_guard.cjs).
require('./_net_guard.cjs');

// END TO END against the REAL gateway (src/server.js) listening on a local port, driven by the harness CLI over
// real HTTP — the closest thing to a partner run that needs no network. Only the network edge behind the
// gateway is stubbed: the loopback search hop (`find_products_multi` -> this process's own invoke route), with
// nock, as tests/mcp_tool_call_outcome_log does. Every other request (the harness's MCP calls) passes through
// to the real listener (allowUnmocked), so the doors, auth, heartbeat, public projection and caches are the
// production code.
//
// Discovery + consistency only: follow-through tools reach further backends this test does not stub.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const PORT = '3991';
const LOOPBACK = `http://127.0.0.1:${PORT}`;
const SERVICE_KEY = `ak_live_${'d'.repeat(64)}`;

process.env.NODE_ENV = 'test';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.PORT = PORT;
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
delete process.env.AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED;
process.env.PIVOTA_API_BASE = 'http://backend.readiness-eval.test';
process.env.PIVOTA_API_KEY = SERVICE_KEY;
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.INVOKE_AUTH_BYPASS_IN_TEST = '0';
process.env.PUBLIC_READ_MCP_ENABLED = '1';
process.env.PUBLIC_READ_MCP_HOSTS = 'mcp.public-tier.test';
process.env.PUBLIC_READ_MCP_RPM = '60000';
process.env.SELF_INVOKE_TIMEOUT_MS = '6000';
delete process.env.MCP_OAUTH_ENABLED;
delete process.env.DATABASE_URL;
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];

const app = require('../../src/server');
const { main } = require('../../scripts/agent-readiness-eval/run.cjs');

let server;
const searched = [];

test.before(async () => {
  // Nothing leaves this machine: only the local listener is reachable.
  nock.disableNetConnect();
  nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:\d+)?$/);
  server = await new Promise((resolve) => {
    const s = app.listen(Number(PORT), '127.0.0.1', () => resolve(s));
  });
  nock(LOOPBACK, { allowUnmocked: true })
    .persist()
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
    .reply((_uri, body) => {
      const q = String((body && body.payload && body.payload.search && body.payload.search.query) || (body && body.payload && body.payload.query) || '');
      searched.push(q);
      if (/laptop|asdf|mercury/i.test(q)) return [200, { status: 'success', success: true, products: [], total: 0, metadata: { strict_empty_reason: 'no_candidates' } }];
      return [200, {
        status: 'success',
        success: true,
        total: 2,
        products: [
          { product_id: 'sig_rg_1', merchant_id: 'merch_rg', title: `Stub ${q} one`, brand: 'Stubco', category: 'lipstick', price: 12, currency: 'USD', availability: 'in_stock', in_stock: true, pivota_canonical_url: 'https://agent.pivota.cc/products/sig_rg_1' },
          { product_id: 'sig_rg_2', merchant_id: 'merch_rg', title: `Stub ${q} two`, brand: 'Stubco', category: 'lipstick', price: 0, currency: 'USD', availability: 'in_stock', in_stock: true },
        ],
        metadata: { primary_lane: 'stub' },
      }];
    });
});

test.after(async () => {
  nock.cleanAll();
  nock.enableNetConnect();
  await new Promise((r) => server.close(r));
  process.env = { ...ORIGINAL_ENV };
});

function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

test('real gateway, /public/mcp: handshake, tools/list, search_catalog over the real door, scorecard written', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-real-'));
  const io = { out: sink(), err: sink() };
  const code = await main(
    ['--base-url', LOOPBACK, '--tier', 'public', '--journeys', 'discovery,consistency', '--classes', 'makeup_shade,negative_non_beauty,negative_nonsense', '--limit', '20', '--consistency-sample', '3', '--consistency-repeats', '1', '--pacing-ms', '0', '--out', out],
    {},
    io,
  );
  assert.ok([0, 1].includes(code), `exit ${code}: ${io.err.text()}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  const m = report.metrics;
  assert.equal(m.run.handshake.outcome, 'ok', JSON.stringify(m.run.handshake));
  assert.equal(m.run.handshake.server_info.name, 'pivota');
  assert.equal(report.discovery.length, 20);
  assert.equal(m.availability.availability, 1, JSON.stringify(m.availability.by_outcome));
  assert.ok(searched.length > 0, 'the real door reached the (stubbed) search hop');
  // The public projection withholds a zero price rather than serving it: the harness counts it as missing.
  assert.ok(m.rows.search.missing_price > 0);
  assert.equal(m.rows.search.non_positive_price, 0);
  // The public tier builds a canonical pivota_url for every row: well-formed, and never fetched.
  assert.equal(m.rows.search.missing_link, 0);
  assert.ok(m.consistency.sampled > 0);
});

test('real gateway, /mcp with an API key: the commerce door answers the same journey', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-real-'));
  const io = { out: sink(), err: sink() };
  const code = await main(
    ['--base-url', LOOPBACK, '--tier', 'commerce', '--journeys', 'discovery', '--classes', 'makeup_shade', '--limit', '8', '--pacing-ms', '0', '--out', out],
    { READINESS_EVAL_API_KEY: SERVICE_KEY },
    io,
  );
  assert.ok([0, 1].includes(code), `exit ${code}: ${io.err.text()}`);
  const m = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).metrics;
  assert.equal(m.run.handshake.outcome, 'ok', JSON.stringify(m.run.handshake));
  assert.equal(m.run.handshake.server_info.name, 'pivota-commerce-mcp');
  assert.equal(m.by_tool.search_catalog.calls, 8);
  assert.ok(m.run.skipped_tools.some((s) => s.tool === 'complete_checkout_session'), 'the charge tool is listed as never called');
});

test('real gateway, /mcp without credentials: refused at the door and reported as an auth error, not as availability', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-real-'));
  const io = { out: sink(), err: sink() };
  const code = await main(['--base-url', LOOPBACK, '--tier', 'commerce', '--auth', 'none', '--limit', '1', '--out', out], {}, io);
  assert.equal(code, 3, io.err.text());
  const report = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  assert.equal(report.metrics.run.handshake.outcome, 'auth_error');
  assert.match(report.metrics.run.aborted, /initialize failed: auth_error/);
});
