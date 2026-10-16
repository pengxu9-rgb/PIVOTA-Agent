'use strict';

// Merchant-load bounds for the live reads (review of #2455):
//   - the lookup core remembers a TRANSIENT discovery failure (429, 5xx, unanswered, a thrown error) for a
//     minute, so a struggling store's /.well-known is not asked by every page; the endpoint memo is otherwise
//     unchanged (an endpoint for its TTL, a store that answered without one for 10 minutes);
//   - a per-store read budget, shared by the server-side PDP read and pdp_live_read.
// No store is contacted: fake clients only.

const test = require('node:test');
const assert = require('node:assert/strict');

const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
require('node:test').after(() => clearInterval(keepAlive));

const { createLookupCore } = require('../src/services/ucpLiveOfferRead');
const { createHostReadBudget, hostReadsPerMinute } = require('../src/services/hostReadBudget');

function clientAnswering(answers) {
  const calls = [];
  return {
    calls,
    async discoverEndpoint(base) {
      calls.push(base);
      const next = answers.length > 1 ? answers.shift() : answers[0];
      if (next instanceof Error) throw next;
      return next(base);
    },
    async lookupCatalog() { return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: '{"products":[]}' }] } } }; },
  };
}
const ok = (base) => ({ mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 });
const status = (code) => () => ({ mcpEndpoint: undefined, status: code });

function core(client, t, extra = {}) {
  return createLookupCore({ ucpClient: client, now: () => t.now, endpointTtlMs: 60 * 60 * 1000, memoTtlMs: 30000, ...extra });
}

test('a 429 / 5xx / unanswered discovery is remembered for a minute AS a failure, then asked again', async () => {
  for (const failing of [status(429), status(503), () => ({}), new Error('ETIMEDOUT')]) {
    const t = { now: 1_000_000 };
    const client = clientAnswering([failing, ok]);
    const c = core(client, t);
    await assert.rejects(c.endpointFor('a.example'));
    t.now += 59_999;
    const again = await c.endpointFor('a.example').then(() => 'resolved', (e) => e);
    assert.notEqual(again, 'resolved');
    assert.equal(again.cached, true);
    assert.equal(client.calls.length, 1, 'not asked again inside the minute');
    assert.equal(c.endpoints.has('a.example'), false, 'never remembered as non-UCP');
    t.now += 2;
    assert.equal(await c.endpointFor('a.example'), 'https://a.example/api/ucp/mcp');
    assert.equal(client.calls.length, 2);
    assert.equal(c.discoveryFailures.has('a.example'), false, 'a lapsed failure is forgotten');
  }
});

test('the cached failure keeps its code and status (a timeout stays a timeout, a 429 a 429)', async () => {
  const t = { now: 1 };
  const c = core(clientAnswering([status(429)]), t);
  await assert.rejects(c.endpointFor('b.example'));
  await assert.rejects(c.endpointFor('b.example'), (e) => e.code === 'discovery_transient' && e.status === 429);
  const c2 = core(clientAnswering([Object.assign(new Error('timeout'), { code: 'timeout' })]), t);
  await assert.rejects(c2.endpointFor('c.example'));
  await assert.rejects(c2.endpointFor('c.example'), (e) => e.code === 'timeout');
});

test('the endpoint memo is otherwise unchanged: an endpoint for its TTL, a store with none for 10 minutes', async () => {
  const t = { now: 1_000_000 };
  const client = clientAnswering([ok]);
  const c = core(client, t);
  await c.endpointFor('d.example');
  t.now += 60 * 60 * 1000 - 1;
  await c.endpointFor('d.example');
  assert.equal(client.calls.length, 1);
  t.now += 2;
  await c.endpointFor('d.example');
  assert.equal(client.calls.length, 2, 'asked again after the endpoint TTL');

  const none = clientAnswering([status(404)]);
  const c2 = core(none, t);
  assert.equal(await c2.endpointFor('e.example'), null);
  t.now += 10 * 60 * 1000 - 1;
  assert.equal(await c2.endpointFor('e.example'), null);
  assert.equal(none.calls.length, 1);
  assert.equal(c2.discoveryFailures.size, 0, 'an answer is not a failure');
  t.now += 2;
  await c2.endpointFor('e.example');
  assert.equal(none.calls.length, 2);
});

test('cores sharing discovery share its failures; a TTL of 0 turns the negative cache off', async () => {
  const t = { now: 1 };
  const shared = { endpointCache: new Map(), discoveryInFlight: new Map(), discoveryFailures: new Map() };
  const client = clientAnswering([status(503), ok]);
  const a = core(client, t, shared);
  const b = core(client, t, shared);
  await assert.rejects(a.endpointFor('f.example'));
  await assert.rejects(b.endpointFor('f.example'));
  assert.equal(client.calls.length, 1, 'the second core did not ask either');

  const off = clientAnswering([status(503), ok]);
  const c = core(off, t, { discoveryFailureTtlMs: 0 });
  await assert.rejects(c.endpointFor('g.example'));
  assert.equal(await c.endpointFor('g.example'), 'https://g.example/api/ucp/mcp');
});

test('the per-store read budget: N reads per host per minute, per host, sliding', () => {
  let t = 0;
  const b = createHostReadBudget({ limit: () => 2, now: () => t });
  assert.equal(b.take('Shop.Example'), true);
  t += 10_000;
  assert.equal(b.take('shop.example'), true);
  assert.equal(b.take('shop.example'), false, 'third read inside the minute');
  assert.equal(b.take('other.example'), true, 'another store has its own budget');
  t += 50_000;
  assert.equal(b.take('shop.example'), true, 'the first read left the window');
  assert.equal(b.take('shop.example'), false);
  assert.equal(b.take(''), true, 'no host, nothing to budget');
  assert.equal(hostReadsPerMinute({}), 30);
  assert.equal(hostReadsPerMinute({ UCP_LIVE_PDP_HOST_READS_PER_MIN: '5' }), 5);
  assert.equal(hostReadsPerMinute({ UCP_LIVE_PDP_HOST_READS_PER_MIN: '0' }), 1);
  assert.equal(hostReadsPerMinute({ UCP_LIVE_PDP_HOST_READS_PER_MIN: '99999' }), 1000);
  assert.equal(hostReadsPerMinute({ UCP_LIVE_PDP_HOST_READS_PER_MIN: '' }), 30);
  assert.equal(hostReadsPerMinute({ UCP_LIVE_PDP_HOST_READS_PER_MIN: 'many' }), 30);
});

test('SERVER: the shadow read and pdp_live_read spend ONE per-store budget; over it, claims are released', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const server = path.join(__dirname, '..', 'src', 'server.js');
  const code = `
    const app = require(${JSON.stringify(server)});
    const d = app._debug;
    let lookups = 0;
    d.useUcpLiveClientForTest({
      async discoverEndpoint(base) { return { mcpEndpoint: base + '/api/ucp/mcp', status: 200 }; },
      async lookupCatalog() { lookups += 1; return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: '{"products":[]}' }] } } }; },
    });
    const { buildPdpPayload } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'pdpBuilder'))});
    const pageOf = (pid, vid) => {
      const pdp = buildPdpPayload({ product: { product_id: pid, merchant_id: 'merch_obs_x', source: 'external_seed', title: 't',
        price: { amount: 26, currency: 'USD' }, currency: 'USD', destination_url: 'https://shop.example.com/products/' + pid,
        default_variant_id: vid, variants: [{ variant_id: vid, title: 'a', price: { amount: 26, currency: 'USD' }, in_stock: true }] },
        relatedProducts: [], entryPoint: 'agent' });
      return { status: 'success', modules: [{ type: 'canonical', data: { pdp_payload: pdp } }] };
    };
    (async () => {
      const first = d.shadowPdpLiveRead(pageOf('p1', '11111111111'), { market: 'US', random: () => 0 });
      const second = d.shadowPdpLiveRead(pageOf('p2', '22222222222'), { market: 'US', random: () => 0 });
      const cache = d.ucpLivePdpCache();
      const released = cache.claimRead('shop.example.com', 'US', ['22222222222']);
      cache.releaseRead('shop.example.com', 'US', ['22222222222']);
      const p3 = pageOf('p3', '33333333333');
      const served = d.withPdpLiveRefreshDescriptor(p3, { optedIn: true, market: 'US', cardListingId: 'p3' });
      const live = await d.pdpLiveRefresh().read({ token: served.live_refresh.token, page: p3, market: 'US' });
      const p3released = cache.claimRead('shop.example.com', 'US', ['33333333333']);
      await new Promise((r) => setTimeout(r, 50));
      console.log(JSON.stringify({ first, second, released, reason: live.body.live_refresh.reason, p3released }));
      process.exit(0);
    })();`;
  const env = { ...process.env, UCP_LIVE_PDP_READ: 'shadow', UCP_LIVE_PDP_HOST_READS_PER_MIN: '1', UCP_LIVE_PDP_REFRESH: 'on',
    UCP_LIVE_PDP_REFRESH_SECRET: 'z'.repeat(40), NODE_ENV: 'test' };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'UCP_LIVE_PDP_READ_SAMPLE']) delete env[k];
  const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const out = JSON.parse(r.stdout.trim().split('\n').find((l) => l.includes('"first"')));
  assert.deepEqual(out, { first: true, second: false, released: true, reason: 'host_busy', p3released: true });
});

test('STRUCTURAL: the server\'s live readers share one discovery-failure memo', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const i = src.indexOf('function ucpLiveReaderDeps(');
  assert.ok(i > 0);
  assert.match(src.slice(i, i + 800), /discoveryInFlight: shared\.discovering,\s+discoveryFailures: shared\.discoveryFailures,/);
  assert.match(src, /_ucpLiveShared = \{ ucpClient, endpoints: new Map\(\), discovering: new Map\(\), discoveryFailures: new Map\(\) \};\n  return _ucpLiveShared;/);
});
