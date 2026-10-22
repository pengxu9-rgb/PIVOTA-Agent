'use strict';

// THE REAL AGENT DOORS, OFFLINE, for the price_verification_served tests:
//   tests/price_verification_log_golden.node.test.cjs    flag off vs on, byte for byte, plus the lines
//   tests/price_verification_log_fixture.node.test.cjs   both against bodies captured BEFORE the log existed
//   tests/price_verification_log_cache.node.test.cjs     the same doors with the read caches on
//
// No store, backend or search pipeline is contacted:
//   - an MCP search reaches find_products_multi as this process calling itself over loopback
//     (invokeCommerceKernelRawUpstream); nock answers that loopback origin, the same interception
//     tests/commerce_ucp_search_shared_cache.node.test.cjs uses, and records the headers it was sent;
//   - recommend_products' price checks (verifyPrice) call get_pdp_v2 over that loopback too, answered the same
//     way; the reco lane itself (routes.__internal.generateProductRecommendations) is a stub;
//   - get_offers' offers.resolve goes to PIVOTA_API_BASE, a nock host;
//   - the merchant's UCP catalog (UCP_LIVE_OFFER_READ=enforce) is a fake client set before any reader is built;
//   - REST search reaches the discovery bridge, whose backend call is a nock host.
// `Date` is frozen (node:test mock timers, Date only, see start()) so a live read stamps the same checked_at on
// every call.
//
// IT MUST RUN UNCHANGED ON A TREE WITHOUT THE PRICE LOG (the fixture is captured on one: see the fixture
// test), so it requires nothing from src/observability/priceVerification*.
//
// Env is read when the server module and its surfaces are built, so call createPriceLogDoors ONCE per test file,
// before anything requires src/server.

const nock = require('nock');

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// The merchant's UCP catalog: one store, one variant, priced in USD for US.
const STORE = 'store.price-log.test';
const VARIANT = '43734829564039';

// One search page, every status and every row a door may drop:
//   noid      live, but no id, title or brand: /mcp serves it; the UCP shaper (no_id) and the public
//             projector (productSummary) drop it. FIRST, so a fact list not aligned to the served rows shifts.
//   live      answered at NOW;  recent: 5 min old;  old: 30 min old (outside the 15-min search window)
//   stored    the catalog's own price;  unpriced: 0 (the not-buyable sentinel, never a price)
//   held      a price flagged for verification: /mcp serves it, UCP and public withhold it
//   nocur     a merchant answer 2 min old with NO currency: /mcp serves the number; UCP (no_price) and public
//             (price withheld, row kept) do not serve a price
const SEARCH_PAGE = {
  status: 'success',
  success: true,
  products: [
    { price: 15, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(NOW) },
    { product_id: 'sig_live', title: 'Live', price: 10, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(NOW) },
    { product_id: 'sig_recent', title: 'Recent', price: 11, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(NOW - 5 * 60e3) },
    { product_id: 'sig_old', title: 'Old', price: 12, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(NOW - 30 * 60e3) },
    { product_id: 'sig_stored', title: 'Stored', price: 13, currency: 'USD', price_source: 'catalog_offer' },
    { product_id: 'sig_unpriced', title: 'Unpriced', price: 0, currency: 'USD' },
    { product_id: 'sig_held', title: 'Held', price: 14, currency: 'USD', commerce_verification: { required: true, price_trusted: false } },
    { product_id: 'sig_nocur', title: 'No currency', price: 16, price_source: 'merchant_live', price_as_of: iso(NOW - 2 * 60e3) },
  ],
  total: 8,
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
    // The backend says verified, but the gateway's own read of it is skipped (no host): the reader stamps a
    // checked_at on it anyway, which must not make it live (only a `verified` read dates a price).
    { offer_id: 'of:merch_b:sku_2', merchant_id: 'merch_b', price: 27, currency: 'USD', in_stock: true, merchant_price_verified: true },
  ],
  product_group_id: 'pg_price_log',
};

// The reco lane's answer (shape: tests/agent_signals_recommend_products.node.test.cjs, from the lane's own output
// schema): two catalog-grounded items, each re-priced by a loopback get_pdp_v2.
const RECO_ITEMS = [
  {
    slot: 'treatment', step: 'treatment', brand: 'Brand A', name: 'Exfoliant A', display_name: 'Exfoliant A',
    reasons: ['clears pores'], sku: { brand: 'Brand A', name: 'Exfoliant A', product_id: 'sig_reco_a', category: 'Exfoliant' },
    merchant_id: 'merch_reco', price: { amount: 35, currency: 'USD', unknown: false }, grounding_status: 'grounded',
  },
  {
    slot: 'moisturizer', step: 'moisturizer', brand: 'Brand B', name: 'Cream B', display_name: 'Cream B',
    reasons: ['supports the barrier'], sku: { brand: 'Brand B', name: 'Cream B', product_id: 'sig_reco_b', category: 'Moisturizer' },
    merchant_id: 'merch_reco', price: { amount: 18, currency: 'USD', unknown: false }, grounding_status: 'grounded',
  },
];
const RECO_PDP_PRICE = { sig_reco_a: 33, sig_reco_b: 18 };

// A search for REAL_LOOPBACK_QUERY is not intercepted: it reaches this process's own invoke route (listening on
// the port, see start()) and runs the real handler. A non-beauty query takes the upstream-proxy lane, whose
// backend call is the nock below; it answers 200 offline (the beauty lanes need a database).
const REAL_LOOPBACK_QUERY = 'usb charging cable';
// A search the invoke door answers from the upstream-proxy lane whose backend page ALREADY carries an overlay
// outcome (metadata.live_merchant_price): the overlay ran, but not in this request.
const OVERLAID_ELSEWHERE_QUERY = 'usb hub overlay probe';

// A secret and a query no line or header may ever carry.
const SECRET = 'secret-token-price-log-probe';
const QUERY = 'tint-query-text-probe';

const rpc = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const AGENT_META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' } };

// The invoke handler stamps fresh random ids (randomUUID) into every search answer, flag or no flag:
// metadata.request_id and metadata.search_trace.trace_id (inside an MCP result they are JSON-escaped), and
// recommend_products mints a recommendation_set_id per call and a recommendation_id per item. The service
// version block carries the process start time (build_id `started-<iso>`, started_at), read from the real clock
// before Date is frozen. Those values are masked; every other byte counts.
const maskIds = (text) => String(text)
  .replace(/(\\?"(?:request_id|trace_id|recommendation_set_id|recommendation_id)\\?":\s*\\?")[0-9A-Za-z_:-]{16,64}/g, '$1<id>')
  .replace(/started-\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, 'started-<iso>')
  .replace(/(\\*"started_at\\*":\s*\\*")\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '$1<iso>');

/**
 * Build the doors. `env` overrides the defaults below (e.g. COMMERCE_READ_CACHE_ENABLED: '1').
 * @returns the app, the recorded lines and loopback headers, the cases, and start/stop for test.before/after.
 */
function createPriceLogDoors({ port, env = {} } = {}) {
  const PORT = String(port);
  const LOOPBACK = `http://127.0.0.1:${PORT}`;
  const BACKEND = 'http://backend.price-log.test';
  const ORIGINAL_ENV = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    AURORA_BFF_USE_MOCK: 'true',
    AURORA_CHAT_RESPONSE_FORMAT: 'legacy',
    PORT,
    AGENT_CHECKOUT_STRICT: '1',
    AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED: '1',
    AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1',
    PIVOTA_API_BASE: BACKEND,
    PIVOTA_API_KEY: 'test-token',
    CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789',
    PAYMENT_WEBHOOK_SECRET: 'strict-webhook-secret-0123456789',
    COMMERCE_READ_CACHE_ENABLED: '0',
    PUBLIC_READ_CACHE_ENABLED: '0',
    PUBLIC_READ_MCP_ENABLED: '1',
    PUBLIC_READ_MCP_HOSTS: 'mcp.pivota.cc',
    UCP_LIVE_OFFER_READ: 'enforce',
    SERVE_LIVE_MERCHANT_PRICE: 'on',
    SELF_INVOKE_TIMEOUT_MS: '6000',
    AURORA_BFF_RECOMMEND_PRODUCTS_AGENT_ENABLED: '1',
    ...env,
  });
  delete process.env.PRICE_VERIFICATION_LOG;
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
  for (const prefix of ['COMMERCE_MCP', 'PUBLIC_READ_MCP']) {
    for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`${prefix}_HEARTBEAT_${suffix}`];
  }

  const logger = require('../../src/logger');
  const app = require('../../src/server');

  // Every info line, as the logger was handed it; nothing is printed. (pino's level setter rebinds its methods,
  // so the level is set BEFORE the spy is installed.)
  const lines = [];
  const originalLevel = logger.level;
  const originalInfo = logger.info;
  logger.level = 'silent';
  logger.info = (obj, msg) => {
    if (obj && typeof obj === 'object') lines.push({ ...obj, msg });
  };

  // Every argument the merchant's UCP client was handed (JSON), so a test can show no price context reaches it.
  const merchantCalls = [];
  app._debug.useUcpLiveClientForTest({
    async discoverEndpoint(base, ...rest) {
      merchantCalls.push(JSON.stringify([base, ...rest]));
      return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 };
    },
    async lookupCatalog(endpoint, { ids }, ...rest) {
      merchantCalls.push(JSON.stringify([endpoint, { ids }, ...rest]));
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

  // The reco lane: the commerce adapter reads routes.__internal.generateProductRecommendations at call time.
  const auroraInternal = require('../../src/auroraBff/routes').__internal;
  const originalGenerate = auroraInternal.generateProductRecommendations;
  auroraInternal.generateProductRecommendations = async () => ({
    norm: {
      payload: {
        recommendations: RECO_ITEMS.map((item) => JSON.parse(JSON.stringify(item))),
        confidence: 0.72,
        missing_info: [],
        warnings: [],
        grounding_status: 'grounded',
        recommendation_meta: { source_mode: 'catalog_grounded' },
      },
    },
  });

  // The headers each intercepted loopback call carried, in order: { operation, price_context }.
  const loopbackHeaders = [];
  // X-Pivota-Price-Context as each BACKEND call carried it (null: absent). Only a loopback may carry it.
  const backendHeaders = [];
  const backendReply = (route, body) => function reply() {
    backendHeaders.push({ route, price_context: this.req.headers['x-pivota-price-context'] || null });
    return [200, typeof body === 'function' ? body() : body];
  };
  nock(LOOPBACK, { allowUnmocked: true }).persist()
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi'
      && body.payload?.search?.query !== REAL_LOOPBACK_QUERY)
    .reply(function reply() {
      loopbackHeaders.push({ operation: 'find_products_multi', price_context: this.req.headers['x-pivota-price-context'] || null });
      return [200, SEARCH_PAGE];
    });
  nock(LOOPBACK, { allowUnmocked: true }).persist()
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'get_pdp_v2'
      && Object.prototype.hasOwnProperty.call(RECO_PDP_PRICE, body.payload?.product_ref?.product_id))
    .reply(function reply(uri, body) {
      loopbackHeaders.push({ operation: 'get_pdp_v2', price_context: this.req.headers['x-pivota-price-context'] || null });
      const pid = body.payload.product_ref.product_id;
      const product = { product_id: pid, title: pid, price: RECO_PDP_PRICE[pid], currency: 'USD', in_stock: true };
      return [200, { status: 'success', modules: [{ type: 'canonical', data: { pdp_payload: { product } } }] }];
    });
  nock(BACKEND).persist()
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'offers.resolve')
    .reply(backendReply('offers.resolve', OFFERS));
  nock(BACKEND).persist()
    .post(/^\/agent\/v2\/products\/search/, (body) => JSON.stringify(body || {}).includes(OVERLAID_ELSEWHERE_QUERY))
    .reply(backendReply('v2_search', {
      status: 'success',
      products: [{ product_id: 'p_hub', merchant_id: 'm2', title: 'USB hub', price: 19, currency: 'USD' }],
      total: 1,
      metadata: { live_merchant_price: { attempted: true, eligible_count: 1, verified_count: 1 } },
    }));
  nock(BACKEND).persist()
    .post(/^\/agent\/v2\/products\/search/)
    .reply(backendReply('v2_search', { status: 'success', products: [{ product_id: 'p_usb', merchant_id: 'm2', title: 'USB-C charging cable', price: 9, currency: 'USD' }], total: 1 }));
  nock(BACKEND).persist()
    .get(/^\/agent\/v1\/products\/search/)
    .reply(backendReply('v1_search', { status: 'success', products: [{ product_id: 'p_rest', merchant_id: 'm1', title: 'Serum A', price: 12, currency: 'USD' }], total: 1 }));

  const supertest = require('supertest');
  // EVERY DOOR ANSWER the fixture pins, by name. Each is one request; the same request is sent flag off and on.
  const CASES = {
    mcp_search: () => supertest(app).post('/mcp').set('Authorization', `Bearer ${SECRET}`)
      .send(rpc('search_catalog', { query: QUERY, market: 'US' })),
    ucp_search: () => supertest(app).post('/ucp/mcp').send(rpc('search_catalog', { meta: AGENT_META, catalog: { query: 'tint' } })),
    public_search: () => supertest(app).post('/public/mcp').send(rpc('search_catalog', { query: 'tint' })),
    mcp_get_offers: () => supertest(app).post('/mcp').send(rpc('get_offers', { product_id: 'sig_live', market: 'US' })),
    mcp_recommend: () => supertest(app).post('/mcp').send(rpc('recommend_products', { need: 'gentle exfoliant for oily skin', limit: 2 })),
    rest_search: () => supertest(app).get('/agent/v1/products/search?query=serum'),
    mcp_real_loopback_search: () => supertest(app).post('/mcp').send(rpc('search_catalog', { query: REAL_LOOPBACK_QUERY, market: 'US' })),
    public_tools_list: () => supertest(app).post('/public/mcp').send({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    invoke_overlaid_elsewhere: () => supertest(app).post('/agent/shop/v1/invoke')
      .send({ operation: 'find_products_multi', payload: { search: { query: OVERLAID_ELSEWHERE_QUERY, market: 'US' } } }),
  };

  let server;
  return {
    app,
    logger,
    lines,
    loopbackHeaders,
    backendHeaders,
    merchantCalls,
    CASES,
    LOOPBACK,
    /** test.before: freeze Date, listen on the loopback port. `mockTimers` is node:test's `test.mock.timers`. */
    async start(mockTimers) {
      mockTimers.enable({ apis: ['Date'], now: NOW });
      server = await new Promise((resolve) => { const s = app.listen(Number(PORT), '127.0.0.1', () => resolve(s)); });
    },
    async stop(mockTimers) {
      await new Promise((resolve) => server.close(resolve));
      mockTimers.reset();
      nock.cleanAll();
      logger.level = originalLevel;
      logger.info = originalInfo;
      auroraInternal.generateProductRecommendations = originalGenerate;
      process.env = { ...ORIGINAL_ENV };
    },
    /** Send one request with PRICE_VERIFICATION_LOG set (or unset): its status, body, lines and loopback headers. */
    async send(request, { flag }) {
      if (flag) process.env.PRICE_VERIFICATION_LOG = 'on';
      else delete process.env.PRICE_VERIFICATION_LOG;
      lines.length = 0;
      loopbackHeaders.length = 0;
      backendHeaders.length = 0;
      merchantCalls.length = 0;
      try {
        const resp = await request();
        // Lines written after the answer (shadow reads, finish handlers) land before the next tick settles.
        await new Promise((r) => setImmediate(r));
        return { status: resp.status, text: resp.text, lines: [...lines], headers: [...loopbackHeaders], backend: [...backendHeaders], merchant: [...merchantCalls] };
      } finally {
        delete process.env.PRICE_VERIFICATION_LOG;
      }
    },
  };
}

module.exports = {
  createPriceLogDoors,
  NOW,
  iso,
  SEARCH_PAGE,
  OFFERS,
  RECO_ITEMS,
  REAL_LOOPBACK_QUERY,
  OVERLAID_ELSEWHERE_QUERY,
  SECRET,
  QUERY,
  AGENT_META,
  rpc,
  maskIds,
};
