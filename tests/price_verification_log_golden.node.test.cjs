'use strict';

// PRICE_VERIFICATION_LOG IS LOG ONLY: every answer an agent gets is byte-identical with the flag off and on,
// through the REAL doors (/mcp, /ucp/mcp, /public/mcp, REST search), and only the log changes.
//
// HARNESS. No store, backend or search pipeline is contacted:
//   - an MCP search reaches find_products_multi as this process calling itself over loopback
//     (invokeCommerceKernelRawUpstream); nock answers that loopback origin, the same interception
//     tests/commerce_ucp_search_shared_cache.node.test.cjs uses, and records the headers it was sent;
//   - get_offers' offers.resolve goes to PIVOTA_API_BASE, a nock host;
//   - the merchant's UCP catalog (UCP_LIVE_OFFER_READ=enforce) is a fake client set before any reader is built;
//   - REST search reaches the discovery bridge, whose backend call is a nock host.
// The read caches are off so both calls of a pair reach the same fixture. `Date` is frozen (node:test mock
// timers, Date only) so a live read stamps the same checked_at on both calls of a pair.

const test = require('node:test');
const assert = require('node:assert/strict');
const nock = require('nock');
const supertest = require('supertest');

const ORIGINAL_ENV = { ...process.env };
const PORT = '3993';
const LOOPBACK = `http://127.0.0.1:${PORT}`;
const BACKEND = 'http://backend.price-log.test';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.PORT = PORT;
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.PIVOTA_API_BASE = BACKEND;
process.env.PIVOTA_API_KEY = 'test-token';
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.COMMERCE_READ_CACHE_ENABLED = '0';
process.env.PUBLIC_READ_CACHE_ENABLED = '0';
process.env.PUBLIC_READ_MCP_ENABLED = '1';
process.env.PUBLIC_READ_MCP_HOSTS = 'mcp.pivota.cc';
process.env.UCP_LIVE_OFFER_READ = 'enforce';
process.env.SERVE_LIVE_MERCHANT_PRICE = 'on';
process.env.SELF_INVOKE_TIMEOUT_MS = '6000';
delete process.env.PRICE_VERIFICATION_LOG;
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`${prefix}_HEARTBEAT_${suffix}`];
}

const logger = require('../src/logger');
const app = require('../src/server');

// Every info line, as the logger was handed it; nothing is printed. (pino's level setter rebinds its methods,
// so the level is set BEFORE the spy is installed.)
const lines = [];
const originalLevel = logger.level;
const originalInfo = logger.info;
logger.level = 'silent';
logger.info = (obj, msg) => {
  if (obj && typeof obj === 'object') lines.push({ ...obj, msg });
};

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// The merchant's UCP catalog: one store, one variant, priced in USD for US.
const STORE = 'store.price-log.test';
const VARIANT = '43734829564039';
app._debug.useUcpLiveClientForTest({
  async discoverEndpoint(base) {
    return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 };
  },
  async lookupCatalog(endpoint, { ids }) {
    const variants = ids.includes(`gid://shopify/ProductVariant/${VARIANT}`)
      ? [{ id: `gid://shopify/ProductVariant/${VARIANT}`, price: { amount: 2300, currency: 'USD' }, availability: { available: true } }]
      : [];
    return {
      ok: true,
      status: 200,
      response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify({ products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants }], messages: [] }) }] } },
    };
  },
});

// One search page, every status: live (answered at NOW), recent (5 min old), stored (30 min old, older than the
// 15-min search window), the catalog's own price, an unpriced card and a price withheld for verification.
const SEARCH_PAGE = {
  status: 'success',
  success: true,
  products: [
    { product_id: 'sig_live', title: 'Live', price: 10, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(NOW) },
    { product_id: 'sig_recent', title: 'Recent', price: 11, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(NOW - 5 * 60e3) },
    { product_id: 'sig_old', title: 'Old', price: 12, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(NOW - 30 * 60e3) },
    { product_id: 'sig_stored', title: 'Stored', price: 13, currency: 'USD', price_source: 'catalog_offer' },
    { product_id: 'sig_unpriced', title: 'Unpriced', price: 0, currency: 'USD' },
    { product_id: 'sig_held', title: 'Held', price: 14, currency: 'USD', commerce_verification: { required: true, price_trusted: false } },
  ],
  total: 6,
  metadata: {
    live_merchant_price: {
      attempted: true, eligible_count: 3, fetch_attempt_count: 2, cache_hit_count: 1, verified_count: 2,
      drift_count: 1, failure_reasons: { http_429: 1 }, deadline_exceeded: false, gone_count: 0, dropped_gone_count: 0,
    },
  },
};

const OFFERS = {
  offers: [
    {
      offer_id: `of:external_seed:eps_t:${VARIANT}`, merchant_id: STORE, price: 25, currency: 'USD', in_stock: true,
      execution_spec: { merchant_domain: STORE, variant_id: VARIANT, cart_url: `https://${STORE}/cart/${VARIANT}:1?country=US` },
    },
    { offer_id: 'of:merch_b:sku_2', merchant_id: 'merch_b', price: 27, currency: 'USD', in_stock: true },
  ],
  product_group_id: 'pg_price_log',
};

const loopbackHeaders = [];
// A search for REAL_LOOPBACK_QUERY is not intercepted: it reaches this process's own invoke route (listening on
// PORT, see test.before) and runs the real handler. A non-beauty query takes the upstream-proxy lane, whose
// backend call is the nock below; it answers 200 offline (the beauty lanes need a database).
const REAL_LOOPBACK_QUERY = 'usb charging cable';
nock(LOOPBACK, { allowUnmocked: true }).persist()
  .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi'
    && body.payload?.search?.query !== REAL_LOOPBACK_QUERY)
  .reply(function reply() {
    loopbackHeaders.push(this.req.headers['x-pivota-price-context'] || null);
    return [200, SEARCH_PAGE];
  });
nock(BACKEND).persist()
  .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'offers.resolve')
  .reply(200, OFFERS);
nock(BACKEND).persist()
  .post(/^\/agent\/v2\/products\/search/)
  .reply(200, { status: 'success', products: [{ product_id: 'p_usb', merchant_id: 'm2', title: 'USB-C charging cable', price: 9, currency: 'USD' }], total: 1 });
nock(BACKEND).persist()
  .get(/^\/agent\/v1\/products\/search/)
  .reply(200, { status: 'success', products: [{ product_id: 'p_rest', merchant_id: 'm1', title: 'Serum A', price: 12, currency: 'USD' }], total: 1 });

let server;
test.before(async () => {
  test.mock.timers.enable({ apis: ['Date'], now: NOW });
  server = await new Promise((resolve) => { const s = app.listen(Number(PORT), '127.0.0.1', () => resolve(s)); });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  test.mock.timers.reset();
  nock.cleanAll();
  logger.level = originalLevel;
  logger.info = originalInfo;
  process.env = { ...ORIGINAL_ENV };
});

const rpc = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const AGENT_META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' } };

/** The same request with the flag off, then on: the bodies, and the lines each one wrote. */
async function offThenOn(send) {
  const run = async (flag) => {
    if (flag) process.env.PRICE_VERIFICATION_LOG = 'on';
    else delete process.env.PRICE_VERIFICATION_LOG;
    lines.length = 0;
    loopbackHeaders.length = 0;
    const resp = await send();
    // Lines written after the answer (shadow reads, finish handlers) land before the next tick settles.
    await new Promise((r) => setImmediate(r));
    return { status: resp.status, text: resp.text, lines: [...lines], headers: [...loopbackHeaders] };
  };
  const off = await run(false);
  const on = await run(true);
  delete process.env.PRICE_VERIFICATION_LOG;
  return { off, on };
}

const served = (ls) => ls.filter((l) => l.event === 'price_verification_served');

// The invoke handler stamps fresh random ids (randomUUID) into every search answer, flag or no flag:
// metadata.request_id and metadata.search_trace.trace_id (inside an MCP result they are JSON-escaped). Those
// two values are masked; every other byte is compared.
const maskRequestId = (text) => text.replace(/(\\?"(?:request_id|trace_id)\\?":\s*\\?")[0-9a-f-]{36}/g, '$1<uuid>');

function assertGolden({ off, on }, label) {
  assert.equal(off.status, 200, `${label}: ${off.text.slice(0, 300)}`);
  assert.equal(on.status, off.status, `${label}: same status`);
  assert.equal(maskRequestId(on.text), maskRequestId(off.text), `${label}: the answer must be byte-identical with PRICE_VERIFICATION_LOG on`);
  assert.deepEqual(served(off.lines), [], `${label}: flag off writes no price line`);
  for (const l of off.lines) {
    for (const k of ['door', 'request_id', 'http_status']) {
      if (String(l.event || '').endsWith('_ucp_live_read')) assert.equal(l[k], undefined, `${label}: off, ${l.event} carries no ${k}`);
    }
  }
}

test('MCP /mcp search_catalog: byte-identical; one line counting the native page live / recent / stored', async () => {
  const pair = await offThenOn(() => supertest(app).post('/mcp').send(rpc('search_catalog', { query: 'tint', market: 'US' })));
  assertGolden(pair, '/mcp search');
  assert.deepEqual(pair.off.headers, [null], 'off: the loopback call carries no price context header');
  assert.match(pair.on.headers[0], /^door=mcp;tier=authenticated;/, 'on: the loopback names its door and caller');
  const [line, ...more] = served(pair.on.lines);
  assert.equal(more.length, 0, 'exactly one line per answer: the loopback invoke writes none of its own');
  assert.equal(line.msg, 'price_verification_served');
  assert.equal(line.surface, 'search');
  assert.equal(line.door, 'mcp');
  assert.equal(line.tier, 'authenticated');
  assert.equal(line.market, 'US');
  assert.deepEqual(
    { live: line.live, recent: line.recent, stored: line.stored, verified_count: line.verified_count, total: line.total },
    { live: 1, recent: 1, stored: 2, verified_count: 2, total: 4 },
    'unpriced and verification-held cards are not served prices',
  );
  assert.equal(line.overlay_ran, true);
  assert.equal(line.overlay_verified, 2);
  assert.deepEqual(line.overlay_failure_reasons, { http_429: 1 });
  assert.equal(line.cache_hit, undefined, 'the read cache is off here');
  assert.match(line.request_id, /^[0-9a-f]{16}$/);
  assert.ok(pair.on.headers[0].includes(`request_id=${line.request_id}`), 'the loopback carries the door line\'s request id');
});

test('MCP /ucp/mcp search_catalog: byte-identical; counted from the native value the UCP shaper strips', async () => {
  const pair = await offThenOn(() => supertest(app).post('/ucp/mcp').send(rpc('search_catalog', { meta: AGENT_META, catalog: { query: 'tint' } })));
  assertGolden(pair, '/ucp/mcp search');
  const lines_ = served(pair.on.lines);
  assert.equal(lines_.length, 1);
  assert.equal(lines_[0].door, 'ucp_mcp');
  assert.equal(lines_[0].live, 1);
  assert.equal(lines_[0].recent, 1);
  assert.equal(lines_[0].total, 4);
});

test('MCP /public/mcp search_catalog: byte-identical; the public tier counts the rows it serves', async () => {
  const pair = await offThenOn(() => supertest(app).post('/public/mcp').send(rpc('search_catalog', { query: 'tint' })));
  assertGolden(pair, '/public/mcp search');
  const [line, ...more] = served(pair.on.lines);
  assert.equal(more.length, 0);
  assert.equal(line.door, 'public_mcp');
  assert.equal(line.tier, 'public');
  const shown = JSON.parse(pair.on.text).result.structuredContent.products.filter((p) => p.price != null).length;
  assert.equal(line.total, shown, 'total = priced rows the agent was shown');
  assert.equal(line.live + line.recent + line.stored, line.total);
});

test('MCP /mcp get_offers (live read enforced): byte-identical; the reader line names the door and request', async () => {
  const pair = await offThenOn(() => supertest(app).post('/mcp').send(rpc('get_offers', { product_id: 'sig_live', market: 'US' })));
  assertGolden(pair, '/mcp get_offers');
  const offLive = pair.off.lines.find((l) => l.event === 'get_offers_ucp_live_read');
  assert.ok(offLive, 'the live read ran with the flag off too');
  const [line, ...more] = served(pair.on.lines);
  assert.equal(more.length, 0);
  assert.equal(line.surface, 'get_offers');
  assert.equal(line.door, 'mcp');
  assert.equal(line.market, 'US');
  assert.equal(line.live, 1, 'the offer the merchant answered during this request');
  assert.equal(line.stored, 1, 'the offer nobody re-read');
  assert.equal(line.total, 2);
  const onLive = pair.on.lines.find((l) => l.event === 'get_offers_ucp_live_read');
  assert.equal(onLive.door, 'mcp');
  assert.equal(onLive.request_id, line.request_id, 'the read line and the served line share the request id');
});

test('REST /agent/v1/products/search: byte-identical; one line at door rest with the lane and the overlay outcome', async () => {
  const pair = await offThenOn(() => supertest(app).get('/agent/v1/products/search?query=serum'));
  assertGolden(pair, 'REST search');
  const [line, ...more] = served(pair.on.lines);
  assert.equal(more.length, 0);
  assert.equal(line.surface, 'search');
  assert.equal(line.door, 'rest');
  assert.equal(line.tier, 'unauthenticated');
  assert.equal(line.total, 1);
  assert.equal(line.stored, 1);
  assert.equal(typeof line.lane, 'string');
  assert.equal(line.overlay_ran, false);
});

test('an MCP search that REALLY loops back into the invoke handler: byte-identical, and one line, not one per hop', async () => {
  const pair = await offThenOn(() => supertest(app).post('/mcp').send(rpc('search_catalog', { query: REAL_LOOPBACK_QUERY, market: 'US' })));
  assertGolden(pair, '/mcp real loopback search');
  const hops = pair.on.lines.filter((l) => l.msg === 'invoke request complete');
  assert.deepEqual(hops.map((l) => [l.status, l.operation, l.caller_loopback]), [[200, 'find_products_multi', true]],
    'the search ran in the real invoke handler, over loopback, and answered 200');
  const all = served(pair.on.lines);
  // Had the loopback not been recognised as this door's (X-Pivota-Price-Context on a loopback self-call), the
  // invoke hop would have written a second line, at door `invoke`.
  assert.equal(all.length, 1, `one line per answer: ${JSON.stringify(all)}`);
  assert.equal(all[0].door, 'mcp');
  assert.equal(all[0].surface, 'search');
  assert.equal(all[0].skipped_reason, 'lane_not_overlaid', 'the upstream-proxy lane never calls the overlay');
});

test('a tools/call that is not priced, and a non-tools/call method, write no price line', async () => {
  const pair = await offThenOn(() => supertest(app).post('/public/mcp').send({ jsonrpc: '2.0', id: 9, method: 'tools/list' }));
  assertGolden(pair, 'tools/list');
  assert.deepEqual(served(pair.on.lines), []);
});

// --- the invoke handler's line (logInvokePriceVerification), from the final body ---------------------------

const pv = require('../src/observability/priceVerificationLog');

test('invoke get_pdp_v2: the card price counted (a cached merchant answer is recent), with its variants', async () => {
  process.env.PRICE_VERIFICATION_LOG = 'on';
  lines.length = 0;
  try {
    const card = {
      product_id: 'ext_lsm', price: 24, currency: 'USD', price_source: 'merchant_live',
      live_read: { status: 'verified', checked_at: iso(NOW - 3 * 60e3) },
      variants: [{ variant_id: '1', live_read: { status: 'verified' } }, { variant_id: '2' }],
    };
    const body = { status: 'success', modules: [{ type: 'canonical', data: { pdp_payload: { product: card } } }] };
    await pv.runWithPriceContext({ door: 'invoke', tier: 'authenticated', started_at_ms: NOW }, async () => {
      app._debug.logInvokePriceVerification({ operation: 'get_pdp_v2', body, statusCode: 200, payload: { market: 'US' }, metadata: {} });
      app._debug.logInvokePriceVerification({ operation: 'get_pdp_v2', body, statusCode: 404 });
    });
    const [line, ...more] = served(lines);
    assert.equal(more.length, 0, 'an error status writes no line');
    assert.deepEqual(
      { surface: line.surface, door: line.door, live: line.live, recent: line.recent, total: line.total, added_ms: line.added_ms, variants_total: line.variants_total, variants_live_read: line.variants_live_read },
      { surface: 'get_pdp_v2', door: 'invoke', live: 0, recent: 1, total: 1, added_ms: 0, variants_total: 2, variants_live_read: 1 },
    );
  } finally {
    delete process.env.PRICE_VERIFICATION_LOG;
  }
});

test('invoke find_products_multi: overlay outcome, lane and bound market; a loopback call writes none and hands its door the market', async () => {
  process.env.PRICE_VERIFICATION_LOG = 'on';
  lines.length = 0;
  try {
    const body = {
      products: [
        { price: 10, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(NOW) },
        { price: 11, currency: 'USD', price_source: 'catalog_offer' },
      ],
      metadata: { query_source: 'beauty_mainline_direct', live_merchant_price: { attempted: true, eligible_count: 2, verified_count: 1, failure_reasons: { timeout: 1 } } },
    };
    const marketRecord = { market_bound: 'US', market_source: 'declared' };
    await pv.runWithPriceContext({ door: 'invoke', tier: 'first_party', started_at_ms: NOW }, async () => {
      pv.trackSearchOverlay(Promise.resolve(body));
      app._debug.logInvokePriceVerification({ operation: 'find_products_multi', body, statusCode: 200, marketRecord });
    });
    const [line] = served(lines);
    assert.deepEqual(
      { door: line.door, tier: line.tier, market: line.market, market_source: line.market_source, lane: line.lane, live: line.live, stored: line.stored, total: line.total, skipped_reason: line.skipped_reason, overlay_verified: line.overlay_verified, overlay_failure_reasons: line.overlay_failure_reasons },
      { door: 'invoke', tier: 'first_party', market: 'US', market_source: 'declared', lane: 'beauty_mainline_direct', live: 1, stored: 1, total: 2, skipped_reason: null, overlay_verified: 1, overlay_failure_reasons: { timeout: 1 } },
    );

    lines.length = 0;
    const door = { door: 'mcp' };
    await pv.runWithPriceContext({ door: 'mcp', via_loopback: true, parent: door }, async () => {
      app._debug.logInvokePriceVerification({ operation: 'find_products_multi', body, statusCode: 200, marketRecord });
      app._debug.logInvokePriceVerification({ operation: 'get_pdp_v2', body: { modules: [] }, statusCode: 200 });
    });
    assert.deepEqual(served(lines), [], 'the door that asked writes the line for its answer');
    assert.equal(door.search_market, 'US');

    lines.length = 0;
    await pv.runWithPriceContext({ door: 'rest' }, async () => {
      app._debug.logInvokePriceVerification({ operation: 'find_products_multi', body: { products: [{ price: 3 }], metadata: {} }, statusCode: 200 });
    });
    assert.equal(served(lines)[0].skipped_reason, 'lane_not_overlaid', 'a lane that never called the overlay says so');
  } finally {
    delete process.env.PRICE_VERIFICATION_LOG;
  }
});
