'use strict';

// CAFE24 GLOBAL CATALOG LANE (src/services/cafe24GlobalCatalog.js): search-only, shadow-only, never buyable.
//
// FIXTURES ARE CONSTRUCTED, NOT CAPTURED. No answer from mcp-catalog.cafe24.com has been seen from a Pivota runtime.
// The shapes below follow the UCP 2026-04-08 catalog contract this gateway already reads from other UCP servers
// (products[].variants[].price {amount minor, currency}, availability.available, media[], seller). A live answer that
// differs is exactly what the lane's schema_mismatch / unparseable reasons exist to report.
//
// No test reaches the network: every lane is built with a fake fetch, and the server test patches the lane itself.

const test = require('node:test');
const assert = require('node:assert/strict');

const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
test.after(() => clearInterval(keepAlive));

const lane = require('../src/services/cafe24GlobalCatalog');
const {
  createCafe24CatalogLane,
  normalizeCatalogProduct,
  classifyCallOutcome,
  parseSseRaw,
  readMode,
  REASON,
  ALWAYS_BLOCKED,
  CATALOG_HOST,
} = lane;

const PROFILE = 'https://agent-profile.example.test/.well-known/ucp-agent';
const ENDPOINT = 'https://mcp-catalog.cafe24.com/api/ucp/mcp';
// An opaque, prefixed id of the kind the brief describes. The lane must keep it byte-for-byte and never split it.
const OPAQUE_PRODUCT_ID = 'cafe24:examplemall:1:0042';
const OPAQUE_VARIANT_A = 'cafe24:examplemall:1:0042:P000000A000A';
const OPAQUE_VARIANT_B = 'cafe24:examplemall:1:0042:P000000A000B';

function businessProfile(overrides = {}) {
  return {
    ucp: {
      version: '2026-04-08',
      services: { 'dev.ucp.shopping': [{ transport: 'mcp', endpoint: ENDPOINT }] },
      capabilities: {
        'dev.ucp.shopping.catalog.search': [{ version: '2026-04-08' }],
        'dev.ucp.shopping.catalog.lookup': [{ version: '2026-04-08' }],
      },
      ...overrides,
    },
  };
}

function toolsList(names = ['search_catalog', 'get_product', 'lookup_catalog']) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: names.map((name) => ({ name, inputSchema: { type: 'object', properties: { meta: {}, catalog: {} } } })),
    },
  };
}

function product(overrides = {}) {
  return {
    id: OPAQUE_PRODUCT_ID,
    title: 'Example Cushion Foundation',
    url: 'https://examplemall.example.test/product/detail.html?product_no=42',
    media: [{ type: 'image', url: 'https://img.example.test/a.jpg' }, { type: 'video', url: 'https://img.example.test/v.mp4' }],
    seller: { name: 'Example Mall', domain: 'examplemall.example.test', id: 'seller-opaque-1' },
    variants: [
      {
        id: OPAQUE_VARIANT_A,
        title: '21 Light',
        price: { amount: 2499, currency: 'USD' },
        availability: { available: true },
        selected_options: [{ name: 'Shade', value: '21 Light' }],
      },
      {
        id: OPAQUE_VARIANT_B,
        title: '23 Medium',
        price: { amount: 2499, currency: 'USD' },
        availability: { available: false },
        selected_options: [{ name: 'Shade', value: '23 Medium' }],
      },
    ],
    ...overrides,
  };
}

function toolText(payload) {
  return { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * A fake Cafe24 catalog. `onCall(body)` answers tools/call; discovery and tools/list answer from options.
 * Records every request (url, headers, parsed body).
 */
function fakeCatalog({ profile = businessProfile(), tools = toolsList(), onCall, discoveryStatus = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, headers: { ...(init.headers || {}) }, body });
    if (url === 'https://mcp-catalog.cafe24.com/.well-known/ucp') {
      return discoveryStatus === 200 ? jsonResponse(profile) : new Response('no', { status: discoveryStatus });
    }
    if (body && body.method === 'tools/list') return jsonResponse(tools);
    if (body && body.method === 'tools/call') {
      if (!onCall) return jsonResponse(toolText({ products: [product()] }));
      return onCall(body);
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl, requests, calls: () => requests.filter((r) => r.body && r.body.method === 'tools/call') };
}

function clock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function makeLane(catalog, { env = {}, now, logger } = {}) {
  return createCafe24CatalogLane({
    fetchImpl: catalog.fetchImpl,
    profileUrl: PROFILE,
    env: { CAFE24_CATALOG_SEARCH: 'shadow', ...env },
    ...(now ? { now } : {}),
    ...(logger ? { logger } : {}),
  });
}

// ---- switch -------------------------------------------------------------------------------------------------

test('mode: off by default; only `shadow` turns it on; `enforce` is not a mode; the deny flag wins', () => {
  assert.equal(readMode({}), 'off');
  assert.equal(readMode({ CAFE24_CATALOG_SEARCH: 'shadow' }), 'shadow');
  assert.equal(readMode({ CAFE24_CATALOG_SEARCH: ' Shadow ' }), 'shadow');
  assert.equal(readMode({ CAFE24_CATALOG_SEARCH: 'enforce' }), 'off');
  assert.equal(readMode({ CAFE24_CATALOG_SEARCH: 'on' }), 'off');
  assert.equal(readMode({ CAFE24_CATALOG_SEARCH: 'shadow', CAFE24_CATALOG_DENY: 'true' }), 'off');
});

// ---- normalization --------------------------------------------------------------------------------------------

test('normalize: ids are kept byte-for-byte and never split into mall / product_no / variant_code', () => {
  const c = normalizeCatalogProduct(product(), { market: 'US', answeredAtMs: 5 });
  assert.equal(c.product_id, OPAQUE_PRODUCT_ID);
  assert.deepEqual(c.variants.map((v) => v.variant_id), [OPAQUE_VARIANT_A, OPAQUE_VARIANT_B]);
  const flat = JSON.stringify(c);
  for (const inferred of ['mall_id', 'product_no', 'variant_code']) {
    assert.equal(flat.includes(`"${inferred}"`), false, `no inferred ${inferred} field`);
  }
  assert.equal(c.merchant.platform_seller_id, 'seller-opaque-1');
});

test('normalize: exact variants and their options are kept; nothing is substituted', () => {
  const c = normalizeCatalogProduct(product(), { market: 'US' });
  assert.deepEqual(c.variants[0].selected_options, [{ name: 'Shade', value: '21 Light' }]);
  assert.equal(c.variants[0].in_stock, true);
  assert.equal(c.variants[1].in_stock, false);
  assert.equal(c.in_stock, true, 'one available variant makes the listing in stock; each variant keeps its own flag');
});

test('normalize: minor units follow each currency exponent (USD 2, KRW 0, JPY 0); nothing is divided by 100 blindly', () => {
  const usd = normalizeCatalogProduct(product(), { market: 'US' });
  assert.equal(usd.price, 24.99);
  assert.equal(usd.currency, 'USD');
  const krw = normalizeCatalogProduct(product({
    variants: [{ id: 'k1', price: { amount: 25000, currency: 'KRW' }, availability: { available: true } }],
  }), { market: 'KR' });
  assert.equal(krw.price, 25000);
  assert.equal(krw.currency, 'KRW');
  assert.equal(krw.variants[0].priced_for_market, true);
  const jpy = normalizeCatalogProduct(product({
    variants: [{ id: 'j1', price: { amount: 3300, currency: 'JPY' }, availability: { available: true } }],
  }), { market: 'JP' });
  assert.equal(jpy.price, 3300);
});

test('normalize: a price in another currency is a mismatch, never converted; the listing says so', () => {
  const c = normalizeCatalogProduct(product({
    variants: [{ id: 'k1', price: { amount: 25000, currency: 'KRW' }, availability: { available: true } }],
  }), { market: 'US' });
  assert.equal(c.price, 25000);
  assert.equal(c.currency, 'KRW');
  assert.equal(c.variants[0].priced_for_market, false);
  assert.ok(c.execution.blockers.includes('currency_not_market'));
});

test('normalize: variants at different prices leave no product-level price (a minimum is not an offer)', () => {
  const p = product();
  p.variants[1].price = { amount: 2999, currency: 'USD' };
  const c = normalizeCatalogProduct(p, { market: 'US' });
  assert.equal(c.price, null);
  assert.equal(c.currency, null);
  assert.equal(c.price_varies_by_variant, true);
  assert.deepEqual(c.variants.map((v) => v.price), [24.99, 29.99]);
});

test('normalize: an unreadable amount is no price (zero, negative, fractional minor units, hex strings, no currency)', () => {
  for (const price of [{ amount: 0, currency: 'USD' }, { amount: -5, currency: 'USD' }, { amount: 24.5, currency: 'USD' },
    { amount: '0x10', currency: 'USD' }, { amount: 2499 }, { amount: 2499, currency: 'XXQ' }, null]) {
    const c = normalizeCatalogProduct(product({ variants: [{ id: 'v', price, availability: { available: true } }] }), { market: 'US' });
    assert.equal(c.variants[0].price, null, JSON.stringify(price));
    assert.ok(c.execution.blockers.includes('price_unreadable'), JSON.stringify(price));
  }
});

test('normalize: every candidate is non-buyable with the standing blockers, a catalog list price, and no storage', () => {
  const c = normalizeCatalogProduct(product(), { market: 'US', answeredAtMs: 77 });
  assert.equal(c.buyable, false);
  assert.equal(c.execution.eligible, false);
  for (const b of ALWAYS_BLOCKED) assert.ok(c.execution.blockers.includes(b), b);
  assert.equal(c.price_kind, 'catalog_list');
  assert.equal(c.source, 'cafe24_global_catalog');
  assert.equal(c.provenance.attribution, 'Cafe24 Global Catalog');
  assert.equal(c.provenance.stored, false);
  assert.equal(c.provenance.answered_at_ms, 77);
  assert.equal(c.provenance.ucp_version, '2026-04-08');
});

test('normalize: missing pieces become named blockers or nulls, never guesses', () => {
  assert.equal(normalizeCatalogProduct({ title: 'no id' }, { market: 'US' }), null);
  assert.equal(normalizeCatalogProduct({ id: '' }, { market: 'US' }), null);
  assert.equal(normalizeCatalogProduct({ id: 'x'.repeat(600) }, { market: 'US' }), null);
  const bare = normalizeCatalogProduct({ id: 'p1' }, { market: 'US' });
  assert.equal(bare.merchant, null);
  for (const b of ['merchant_unresolved', 'variants_missing', 'price_unreadable', 'availability_unknown']) {
    assert.ok(bare.execution.blockers.includes(b), b);
  }
  const unsafe = normalizeCatalogProduct(product({
    url: 'http://examplemall.example.test/p',
    media: [{ type: 'image', url: 'javascript:alert(1)' }, { url: 'https://user:pw@img.example.test/x.jpg' }],
  }), { market: 'US' });
  assert.equal(unsafe.url, null);
  assert.deepEqual(unsafe.images, []);
});

test('normalize: a seller named only on a variant still resolves the merchant', () => {
  const p = product({ seller: undefined });
  p.variants[0].seller = { name: 'Variant Seller', url: 'https://seller.example.test/' };
  const c = normalizeCatalogProduct(p, { market: 'US' });
  assert.equal(c.merchant.name, 'Variant Seller');
  assert.equal(c.merchant.domain, 'seller.example.test');
  assert.equal(c.variants[0].seller, undefined, 'seller detail stays on the merchant, not repeated per variant');
});

// ---- outcome classification (HTTP 200 alone is never success) -------------------------------------------------

test('classify: transport, timeout, HTTP, JSON-RPC, tool, UCP-business and schema failures are separate outcomes', () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(classifyCallOutcome({ thrown: abort }).reason, REASON.TIMEOUT);
  assert.equal(classifyCallOutcome({ thrown: new TypeError('fetch failed') }).reason, REASON.TRANSPORT_ERROR);
  const call = (status, response) => classifyCallOutcome({ callResult: { status, response } });
  assert.equal(call(401, { raw: 'unauthorized' }).reason, REASON.HTTP_401);
  assert.equal(call(403, { raw: '<html>blocked</html>' }).reason, REASON.HTTP_403);
  assert.equal(call(429, { raw: 'slow down' }).reason, REASON.HTTP_429);
  assert.equal(call(503, { raw: 'down' }).reason, REASON.HTTP_5XX);
  assert.equal(call(404, { raw: 'nope' }).reason, REASON.HTTP_4XX);
  assert.equal(call(400, { raw: 'Bad Request: No valid session ID provided' }).reason, REASON.MCP_SESSION_REQUIRED);
  assert.equal(call(200, { jsonrpc: '2.0', error: { code: -32000, message: 'Session not initialized' } }).reason,
    REASON.MCP_SESSION_REQUIRED);
  const invalid = call(200, { jsonrpc: '2.0', error: { code: -32602, message: 'Invalid params' } });
  assert.equal(invalid.reason, REASON.MCP_ERROR);
  assert.equal(invalid.mcp_error_code, -32602);
  assert.equal(call(200, { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' } }).reason, REASON.TOOL_NOT_LISTED);
  assert.equal(call(422, { jsonrpc: '2.0', error: { code: -32001, message: 'x', data: { code: 'profile_unreachable' } } }).reason,
    REASON.PROFILE_REFUSED);
  assert.equal(call(200, { jsonrpc: '2.0', result: { isError: true, content: [{ type: 'text', text: 'boom' }] } }).reason,
    REASON.TOOL_ERROR);
  const biz = call(200, toolText({ ucp: { status: 'error' }, messages: [{ type: 'error', code: 'unsupported_country' }] }));
  assert.equal(biz.reason, REASON.UCP_BUSINESS_ERROR);
  assert.equal(biz.ucp_error_code, 'unsupported_country');
  assert.equal(call(200, toolText({ items: [] })).reason, REASON.SCHEMA_MISMATCH);
  assert.equal(call(200, { jsonrpc: '2.0', id: 1 }).reason, REASON.SCHEMA_MISMATCH);
  assert.equal(call(200, { raw: '<html>hello</html>' }).reason, REASON.UNPARSEABLE);
  assert.equal(call(200, toolText({ products: [] })).reason, REASON.OK);
});

test('classify: an SSE (text/event-stream) answer is read from its last JSON-RPC data line', () => {
  const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: JSON.stringify({ products: [product()] }) }] } })}\n\n`;
  assert.equal(parseSseRaw(sse).id, 9);
  const out = classifyCallOutcome({ callResult: { status: 200, response: { raw: sse } } });
  assert.equal(out.reason, REASON.OK);
  assert.equal(out.payload.products.length, 1);
  assert.equal(parseSseRaw('data: not json\n'), null);
});

// ---- the lane end to end against a fake catalog ---------------------------------------------------------------

test('search: discovery -> tools/list -> one search_catalog call with our profile, the market, and a bounded page', async () => {
  const cat = fakeCatalog();
  const result = await makeLane(cat).search({ query: 'cushion foundation', market: 'us', limit: 50 });
  assert.equal(result.reason, REASON.OK);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].product_id, OPAQUE_PRODUCT_ID);
  const [call] = cat.calls();
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.body.params.name, 'search_catalog');
  const args = call.body.params.arguments;
  assert.equal(args.meta['ucp-agent'].profile, PROFILE);
  assert.equal(args.catalog.query, 'cushion foundation');
  assert.deepEqual(args.catalog.context, { address_country: 'US' });
  assert.equal(args.catalog.pagination.limit, 10, 'never more than one 10-product page');
  for (const r of cat.requests) assert.equal(new URL(r.url).hostname, CATALOG_HOST, 'no other host is contacted');
});

test('search: no Shopify Bearer token, client credentials or signature ever reaches Cafe24', async () => {
  const saved = {};
  const keys = ['UCP_AGENT_CREDENTIAL', 'UCP_AGENT_CLIENT_ID', 'UCP_AGENT_CLIENT_SECRET'];
  for (const k of keys) { saved[k] = process.env[k]; }
  process.env.UCP_AGENT_CREDENTIAL = 'static-bearer-for-another-lane';
  process.env.UCP_AGENT_CLIENT_ID = 'client-id-for-another-lane';
  process.env.UCP_AGENT_CLIENT_SECRET = 'client-secret-for-another-lane';
  try {
    const cat = fakeCatalog();
    const result = await makeLane(cat).search({ query: 'lip tint', market: 'US' });
    assert.equal(result.reason, REASON.OK);
    for (const r of cat.requests) {
      const flat = JSON.stringify(r);
      assert.equal(flat.includes('another-lane'), false, `credential leaked to ${r.url}`);
      assert.equal(Object.keys(r.headers).some((h) => /^(authorization|signature|signature-input)$/i.test(h)), false);
    }
    assert.equal(cat.requests.some((r) => r.url.includes('api.shopify.com')), false, 'no token exchange');
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('search: nothing is sent without a query, a market, a market we price, or a profile URL', async () => {
  for (const [args, reason] of [
    [{ query: '', market: 'US' }, REASON.NO_QUERY],
    [{ query: 'toner' }, REASON.NO_MARKET],
    [{ query: 'toner', market: 'usa' }, REASON.NO_MARKET],
    [{ query: 'toner', market: 'DE' }, REASON.MARKET_NOT_PRICED],
  ]) {
    const cat = fakeCatalog();
    const result = await makeLane(cat).search(args);
    assert.equal(result.reason, reason, JSON.stringify(args));
    assert.equal(cat.requests.length, 0);
  }
  const cat = fakeCatalog();
  const saved = process.env.UCP_AGENT_PROFILE_URL;
  delete process.env.UCP_AGENT_PROFILE_URL;
  try {
    const noProfile = createCafe24CatalogLane({ fetchImpl: cat.fetchImpl, env: { CAFE24_CATALOG_SEARCH: 'shadow' } });
    const result = await noProfile.search({ query: 'toner', market: 'US' });
    assert.equal(result.reason, REASON.NO_PROFILE_URL);
    assert.equal(cat.requests.length, 0);
  } finally {
    if (saved !== undefined) process.env.UCP_AGENT_PROFILE_URL = saved;
  }
});

test('discovery: a different UCP version, a foreign endpoint host, a missing capability or tool stops the lane before search', async () => {
  const cases = [
    [{ profile: businessProfile({ version: '2026-09-01' }) }, REASON.UCP_VERSION_UNSUPPORTED],
    [{ profile: businessProfile({ services: { 'dev.ucp.shopping': [{ transport: 'mcp', endpoint: 'https://elsewhere.example.test/mcp' }] } }) },
      REASON.ENDPOINT_HOST_REFUSED],
    [{ profile: businessProfile({ capabilities: { 'dev.ucp.shopping.catalog.lookup': [{ version: '2026-04-08' }] } }) },
      REASON.CAPABILITY_NOT_ADVERTISED],
    [{ tools: toolsList(['get_product']) }, REASON.TOOL_NOT_LISTED],
    [{ discoveryStatus: 404 }, REASON.DISCOVERY_FAILED],
  ];
  for (const [opts, reason] of cases) {
    const cat = fakeCatalog(opts);
    const result = await makeLane(cat).search({ query: 'toner', market: 'US' });
    assert.equal(result.reason, reason);
    assert.equal(result.phase, 'discovery');
    assert.equal(cat.calls().length, 0, `${reason}: no search_catalog call`);
    assert.equal(cat.requests.some((r) => r.url.includes('elsewhere.example.test')), false);
  }
});

test('discovery is memoised: a second search reuses it; a failed one is retried only after its window', async () => {
  const c = clock();
  const cat = fakeCatalog();
  const l = makeLane(cat, { now: c.now });
  await l.search({ query: 'a', market: 'US' });
  await l.search({ query: 'b', market: 'US' });
  assert.equal(cat.requests.filter((r) => r.url.endsWith('/.well-known/ucp')).length, 1);

  const bad = fakeCatalog({ discoveryStatus: 500 });
  const lb = makeLane(bad, { now: c.now });
  await lb.search({ query: 'a', market: 'US' });
  await lb.search({ query: 'b', market: 'US' });
  assert.equal(bad.requests.filter((r) => r.url.endsWith('/.well-known/ucp')).length, 1);
  c.advance(5 * 60 * 1000 + 1);
  await lb.search({ query: 'c', market: 'US' });
  assert.equal(bad.requests.filter((r) => r.url.endsWith('/.well-known/ucp')).length, 2);
});

// ---- bounds ---------------------------------------------------------------------------------------------------

test('bounds: the per-minute ceiling refuses before sending; the window resets', async () => {
  const c = clock();
  const cat = fakeCatalog();
  const l = makeLane(cat, { now: c.now, env: { CAFE24_CATALOG_SHADOW_PER_MIN: '2' } });
  assert.equal((await l.search({ query: 'a', market: 'US' })).reason, REASON.OK);
  assert.equal((await l.search({ query: 'b', market: 'US' })).reason, REASON.OK);
  assert.equal((await l.search({ query: 'c', market: 'US' })).reason, REASON.LOCAL_RATE_LIMIT);
  assert.equal(cat.calls().length, 2);
  c.advance(60 * 1000);
  assert.equal((await l.search({ query: 'd', market: 'US' })).reason, REASON.OK);
  assert.equal(lane.perMinuteCeiling({ CAFE24_CATALOG_SHADOW_PER_MIN: '9999' }), 60);
  assert.equal(lane.perMinuteCeiling({ CAFE24_CATALOG_SHADOW_PER_MIN: 'x' }), 10);
});

test('bounds: at most two calls in flight; a third is refused without a request', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const cat = fakeCatalog({ onCall: async () => { await gate; return jsonResponse(toolText({ products: [] })); } });
  const l = makeLane(cat);
  // Prime discovery so the in-flight calls are search calls.
  const first = l.search({ query: 'a', market: 'US' });
  const second = l.search({ query: 'b', market: 'US' });
  const third = await l.search({ query: 'c', market: 'US' });
  assert.equal(third.reason, REASON.IN_FLIGHT_CAP);
  release();
  assert.equal((await first).reason, REASON.OK);
  assert.equal((await second).reason, REASON.OK);
  assert.equal(l.stateForTest().inFlight, 0);
});

test('bounds: three 5xx answers open the breaker; while open nothing is sent; it closes after the window', async () => {
  const c = clock();
  let status = 503;
  const cat = fakeCatalog({ onCall: async () => new Response('down', { status }) });
  const l = makeLane(cat, { now: c.now, env: { CAFE24_CATALOG_SHADOW_PER_MIN: '60' } });
  for (let i = 0; i < 3; i += 1) assert.equal((await l.search({ query: `q${i}`, market: 'US' })).reason, REASON.HTTP_5XX);
  const before = cat.calls().length;
  assert.equal((await l.search({ query: 'q', market: 'US' })).reason, REASON.BREAKER_OPEN);
  assert.equal(cat.calls().length, before);
  c.advance(60 * 1000);
  status = 200;
  const after = await l.search({ query: 'q', market: 'US' });
  assert.equal(after.reason, REASON.UNPARSEABLE, 'the breaker closed; a 200 whose body is not JSON-RPC is not success');
});

test('bounds: a 429 with Retry-After holds the lane for that long, capped at an hour', async () => {
  const c = clock();
  const cat = fakeCatalog({ onCall: async () => new Response('slow', { status: 429, headers: { 'retry-after': '120' } }) });
  const l = makeLane(cat, { now: c.now, env: { CAFE24_CATALOG_SHADOW_PER_MIN: '60' } });
  assert.equal((await l.search({ query: 'a', market: 'US' })).reason, REASON.HTTP_429);
  c.advance(119 * 1000);
  assert.equal((await l.search({ query: 'b', market: 'US' })).reason, REASON.BREAKER_OPEN);
  c.advance(2 * 1000);
  assert.equal((await l.search({ query: 'c', market: 'US' })).reason, REASON.HTTP_429);
  assert.equal(lane.retryAfterMs('999999', 0), 60 * 60 * 1000);
  assert.equal(lane.retryAfterMs('soon', 0), null);
});

test('search: a timeout is a timeout, and a transport failure is a transport failure (no retry, no new request)', async () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const t = fakeCatalog({ onCall: async () => { throw abort; } });
  assert.equal((await makeLane(t).search({ query: 'a', market: 'US' })).reason, REASON.TIMEOUT);
  assert.equal(t.calls().length, 1);
  const n = fakeCatalog({ onCall: async () => { throw new TypeError('fetch failed'); } });
  assert.equal((await makeLane(n).search({ query: 'a', market: 'US' })).reason, REASON.TRANSPORT_ERROR);
  assert.equal(n.calls().length, 1);
});

test('search: products that are all unusable are a schema mismatch, not an empty success', async () => {
  const cat = fakeCatalog({ onCall: async () => jsonResponse(toolText({ products: [{ title: 'no id' }, 'junk'] })) });
  assert.equal((await makeLane(cat).search({ query: 'a', market: 'US' })).reason, REASON.SCHEMA_MISMATCH);
});

// ---- shadow ---------------------------------------------------------------------------------------------------

test('shadow: off sends nothing and logs nothing', async () => {
  const cat = fakeCatalog();
  const lines = [];
  const l = makeLane(cat, { env: { CAFE24_CATALOG_SEARCH: 'off' }, logger: { info: (o) => lines.push(o) } });
  const out = await l.observeSearch({ query: 'toner', market: 'US', servedCount: 3 });
  assert.equal(out.reason, REASON.OFF);
  assert.equal(cat.requests.length, 0);
  assert.equal(lines.length, 0);
});

test('shadow: logs counts only (no query, id, title, url or price) and never rejects', async () => {
  const cat = fakeCatalog({
    onCall: async () => jsonResponse(toolText({
      products: [product(), product({ id: 'p2', seller: { name: 'Other' }, variants: [{ id: 'v9', price: { amount: 9900, currency: 'KRW' }, availability: { available: true } }] })],
    })),
  });
  const lines = [];
  const l = makeLane(cat, { logger: { info: (o) => lines.push(o) } });
  const out = await l.observeSearch({ query: 'secret buyer words', market: 'US', servedCount: 4 });
  assert.equal(out.reason, REASON.OK);
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.event, 'cafe24_catalog_shadow');
  assert.equal(line.products, 2);
  assert.equal(line.variants, 3);
  assert.equal(line.priced_in_market, 1);
  assert.equal(line.currency_mismatch, 1);
  assert.equal(line.sellers, 2);
  assert.equal(line.served_count, 4);
  const flat = JSON.stringify(line);
  for (const secret of ['secret buyer words', OPAQUE_PRODUCT_ID, 'Example Cushion', 'examplemall.example.test', '24.99']) {
    assert.equal(flat.includes(secret), false, secret);
  }

  const throwingLog = makeLane(fakeCatalog(), { logger: { info: () => { throw new Error('log down'); } } });
  await assert.doesNotReject(throwingLog.observeSearch({ query: 'x', market: 'US' }));
});

// ---- the server hook: every served search page passes through it, and it never changes the page ----------------

let app = null;
function server() {
  if (app) return app;
  process.env.NODE_ENV = 'test';
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
  app = require('../src/server');
  return app;
}

function servedPage() {
  return {
    status: 'success',
    products: [{ product_id: 'p1', merchant_id: 'm1', title: 'Served', price: 10, currency: 'USD' }],
    metadata: { query_source: 'test' },
  };
}

test('server: in shadow the served search overlay starts one Cafe24 observation and returns the page unchanged', async () => {
  const a = server();
  const saved = { mode: process.env.CAFE24_CATALOG_SEARCH, serve: process.env.SERVE_LIVE_MERCHANT_PRICE, lane: lane.defaultLane };
  const seen = [];
  lane.defaultLane = () => ({ observeSearch: async (args) => { seen.push(args); return { reason: 'ok', candidates: [{ title: 'never served' }] }; } });
  delete process.env.SERVE_LIVE_MERCHANT_PRICE;
  try {
    process.env.CAFE24_CATALOG_SEARCH = 'shadow';
    const out = await a._debug.maybeOverlayLiveSearchPrice(servedPage(), { query: 'serum', market: 'US' }, { buyerMarket: 'US' });
    assert.deepEqual(out.products, servedPage().products);
    assert.equal(JSON.stringify(out).includes('never served'), false);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { query: 'serum', market: 'US', servedCount: 1 });

    await a._debug.maybeOverlayLiveSearchPrice(servedPage(), { query: 'serum', market: 'US', page: 2 }, { buyerMarket: 'US' });
    assert.equal(seen.length, 1, 'page 2 is not observed');

    process.env.CAFE24_CATALOG_SEARCH = 'off';
    await a._debug.maybeOverlayLiveSearchPrice(servedPage(), { query: 'serum', market: 'US' }, { buyerMarket: 'US' });
    assert.equal(seen.length, 1, 'off starts nothing');

    process.env.CAFE24_CATALOG_SEARCH = 'shadow';
    lane.defaultLane = () => { throw new Error('lane broke'); };
    const survived = await a._debug.maybeOverlayLiveSearchPrice(servedPage(), { query: 'serum', market: 'US' }, { buyerMarket: 'US' });
    assert.deepEqual(survived.products, servedPage().products, 'a broken lane never reaches the page');
    lane.defaultLane = () => ({ observeSearch: () => Promise.reject(new Error('rejected')) });
    const rejected = await a._debug.maybeOverlayLiveSearchPrice(servedPage(), { query: 'serum', market: 'US' }, { buyerMarket: 'US' });
    assert.deepEqual(rejected.products, servedPage().products);
  } finally {
    lane.defaultLane = saved.lane;
    if (saved.mode === undefined) delete process.env.CAFE24_CATALOG_SEARCH; else process.env.CAFE24_CATALOG_SEARCH = saved.mode;
    if (saved.serve !== undefined) process.env.SERVE_LIVE_MERCHANT_PRICE = saved.serve;
  }
});
