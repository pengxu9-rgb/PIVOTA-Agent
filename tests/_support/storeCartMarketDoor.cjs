'use strict';

// THE STORE-CART-BY-MARKET DOOR FIXTURE: the real gateway app, offline, with a product catalog, a backend and seller
// storefronts to answer it. Used by tests/store_cart_currency_follows_market_door.node.test.cjs and
// tests/store_cart_market_currency_table.node.test.cjs (in process), and by
// tests/_support/storeCartMarketDoorChild.cjs (one process per run of THE REQUEST SET, for differentials).
//
// REAL: the routes (`/mcp`, `/ucp/mcp`, `/public/mcp`, the invoke route), the JSON-RPC adapter, the tool surface and
// its per-call product-read memo, the canonical executor, the gateway's kernel dispatcher and its unscoped detail hop
// (src/services/pdpDetailHop.js), the storefront escalation, the merchant-door pricing, the warm-handoff endpoint
// discovery, the UCP buyer-agent client (its request building and its answer parsing), the purchasability gate client.
//
// STUBBED, because no database, backend or store is reachable here:
//   - get_pdp_v2's SERVED answer for the fixture signatures, built by the REAL producers in the order the handler
//     runs them: externalSeedProducts.buildExternalSeedProduct -> servingCurrencyGuard.withholdOffMarketMoney for the
//     serving currency servingCurrencyGuard.servingCurrencyFor reads from THIS request's payload (so a request that
//     carries a market is judged for that market, one that carries none for the deployment's) -> pdpBuilder
//     .buildPdpPayload. Then it carries the identity the catalog identity layer stamps, and, when the guard withheld
//     money, `metadata.serving_currency_guard.withheld_currencies` exactly as the handler reports it. Every
//     get_pdp_v2 request is recorded with the market it carried. A row marked `unguarded` skips the money guard: the
//     handler has pages that guard does not cover, and the door must hold its own rule on a row that still states
//     another currency. With `realPdpLiveSeam` (bootDoor option) the stub also calls, with the request's own payload,
//     the two things the real handler does to a served page that can reach a store: the handler's own
//     `shadowPdpLiveRead` (the background store read) and `livePdpOverlay`, keyed by the handler's own
//     `offersGateBuyerMarket`. The store's catalog client behind them is a recording fake (`liveReads`);
//   - the backend: the connected merchant's per-merchant detail, its quote, offers.resolve, the purchasability route.
//     The quote answers in USD, or in the currency a test sets (`setQuoteCurrency`): the pricing engine answers in the
//     currency the merchant's store is priced in, whatever the request says. Every quote request body is recorded
//     (`quotes`), so a test can say which market the quote carried;
//   - the SELLER STOREFRONTS: the buyer-agent client's transport (`fetchImpl`, its own test seam) is answered in
//     process: `/.well-known/ucp` and the store's MCP endpoint (`create_cart`, `get_cart`). Every request a store
//     receives is recorded, so a test can say what was sent and that nothing else was.
// Every name is a placeholder.

const path = require('node:path');
const http = require('node:http');
const nock = require('nock');

const sig = (c) => `sig_${String(c).repeat(32)}`;
const gid = (n) => `gid://shopify/ProductVariant/${n}`;

const HOST = Object.freeze({
  A: 'store-a.example', // priced in USD; its storefront answers in USD
  G: 'store-g.example', // priced in GBP; answers in GBP
  H: 'store-h.example', // priced in GBP; its storefront answers in USD
  S: 'store-s.example', // priced in SGD; answers in SGD
  E: 'store-e.example', // priced in EUR; answers in EUR
  U: 'store-u.example', // priced in USD, served by a page the money guard does not cover; answers in USD
  V: 'store-v.example', // priced in GBP, served by a page the money guard does not cover; answers in GBP
});
// The currency each storefront answers a cart in.
const STORE_CURRENCY = Object.freeze({ [HOST.A]: 'USD', [HOST.G]: 'GBP', [HOST.H]: 'USD', [HOST.S]: 'SGD', [HOST.E]: 'EUR', [HOST.U]: 'USD', [HOST.V]: 'GBP' });

const IDS = Object.freeze({
  SIG_USD: sig('a'), SIG_USD_SECOND: sig('b'), SIG_GBP: sig('c'), SIG_GBP_USD_STORE: sig('d'), SIG_SGD: sig('e'),
  SIG_EUR: sig('f'), SIG_USD_UNGUARDED: sig('9'), SIG_GBP_UNGUARDED: sig('8'),
  SIG_CONNECTED: sig('1'), SOURCE_CONNECTED: '9001',
  SELLER_A: 'merch_obs_000000000000000a', SELLER_G: 'merch_obs_000000000000000b', SELLER_H: 'merch_obs_000000000000000c',
  SELLER_S: 'merch_obs_000000000000000d', SELLER_E: 'merch_obs_000000000000000e', SELLER_U: 'merch_obs_000000000000000f', SELLER_V: 'merch_obs_0000000000000010',
  SELLER_CONNECTED: 'merch_shop_a',
  VARIANT_USD: '44000000000001', VARIANT_USD_SECOND: '44000000000002', VARIANT_GBP: '44000000000003',
  VARIANT_GBP_USD_STORE: '44000000000004', VARIANT_SGD: '44000000000005', VARIANT_EUR: '44000000000006',
  VARIANT_USD_UNGUARDED: '44000000000007', VARIANT_GBP_UNGUARDED: '44000000000008', VARIANT_CONNECTED: 'v-9001-1',
});

// What each storefront charges per variant (minor units). It differs from the catalog price so a test can tell
// whose price an answer carries: the catalog says 25.00 for VARIANT_USD, the store 27.50.
const STORE_PRICE = Object.freeze({
  [IDS.VARIANT_USD]: 2750, [IDS.VARIANT_USD_SECOND]: 1200, [IDS.VARIANT_GBP]: 2100, [IDS.VARIANT_GBP_USD_STORE]: 2600,
  [IDS.VARIANT_SGD]: 3300, [IDS.VARIANT_EUR]: 1900, [IDS.VARIANT_USD_UNGUARDED]: 2750, [IDS.VARIANT_GBP_UNGUARDED]: 2100,
});

// A seed row as the crawl stores it (every one in the 'US' partition, as production's are), for the real producers.
const seedRow = (externalId, title, host, slug, variant, price, currency) => ({
  status: 'active', market: 'US', tool: '*', id: externalId, external_product_id: externalId,
  destination_url: `https://${host}/products/${slug}?variant=${variant}`, canonical_url: `https://${host}/products/${slug}?variant=${variant}`,
  price_currency: currency,
  seed_data: { title, snapshot: { variants: [{ id: variant, title: 'Default Title', price }] } },
});

const CATALOG = Object.freeze({
  [IDS.SIG_USD]: { seller: IDS.SELLER_A, host: HOST.A, currency: 'USD', seed: seedRow('ext_00000000000000000000a0a0', 'Calm Serum', HOST.A, 'calm-serum', IDS.VARIANT_USD, '25.00', 'USD') },
  [IDS.SIG_USD_SECOND]: { seller: IDS.SELLER_A, host: HOST.A, currency: 'USD', seed: seedRow('ext_00000000000000000000a0a1', 'Night Cream', HOST.A, 'night-cream', IDS.VARIANT_USD_SECOND, '12.00', 'USD') },
  [IDS.SIG_GBP]: { seller: IDS.SELLER_G, host: HOST.G, currency: 'GBP', seed: seedRow('ext_00000000000000000000b0b0', 'Barrier Cream', HOST.G, 'barrier-cream', IDS.VARIANT_GBP, '20.00', 'GBP') },
  [IDS.SIG_GBP_USD_STORE]: { seller: IDS.SELLER_H, host: HOST.H, currency: 'GBP', seed: seedRow('ext_00000000000000000000c0c0', 'Eye Gel', HOST.H, 'eye-gel', IDS.VARIANT_GBP_USD_STORE, '22.00', 'GBP') },
  [IDS.SIG_SGD]: { seller: IDS.SELLER_S, host: HOST.S, currency: 'SGD', seed: seedRow('ext_00000000000000000000d0d0', 'Hand Cream', HOST.S, 'hand-cream', IDS.VARIANT_SGD, '32.00', 'SGD') },
  [IDS.SIG_EUR]: { seller: IDS.SELLER_E, host: HOST.E, currency: 'EUR', seed: seedRow('ext_00000000000000000000e0e0', 'Lip Oil', HOST.E, 'lip-oil', IDS.VARIANT_EUR, '18.00', 'EUR') },
  [IDS.SIG_GBP_UNGUARDED]: { seller: IDS.SELLER_V, host: HOST.V, currency: 'GBP', unguarded: true, seed: seedRow('ext_00000000000000000000f0f1', 'Body Balm', HOST.V, 'body-balm', IDS.VARIANT_GBP_UNGUARDED, '20.00', 'GBP') },
  [IDS.SIG_USD_UNGUARDED]: { seller: IDS.SELLER_U, host: HOST.U, currency: 'USD', unguarded: true, seed: seedRow('ext_00000000000000000000f0f0', 'Day Mist', HOST.U, 'day-mist', IDS.VARIANT_USD_UNGUARDED, '25.00', 'USD') },
});

const BUYER = Object.freeze({ 'X-Test-User-Ref': 'buyer-0001', 'X-Test-Acp-Session-Id': 'sess-0001' });
const FLAG = 'AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET';
// The `/mcp` door's storefront path. It requires FLAG: on alone, the door answers as with it off.
const MCP_FLAG = 'AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED';

/**
 * Boot the gateway app from `root` (this repo by default; a differential passes another tree) and answer its
 * upstreams. Sets the process env: call once per process, before anything else loads the server.
 * @param {{ root?:string, port?:number, env?:Record<string,string|undefined> }} [o]
 */
function bootDoor({ root = path.resolve(__dirname, '../..'), port = 4471, env = {}, realPdpLiveSeam = false } = {}) {
  const PORT = String(port);
  const LOOPBACK = `http://127.0.0.1:${PORT}`;
  const BACKEND = 'http://backend.store-cart-market.test';
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT,
    AGENT_CHECKOUT_STRICT: '1',
    AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1',
    AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED: '1',
    AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED: '1',
    AGENT_CHECKOUT_HOSTED_LINK_ENABLED: '1',
    AGENT_CHECKOUT_UCP_ESCALATION_ENABLED: '1',
    AGENT_CHECKOUT_UCP_MERCHANT_PRICING_ENABLED: '1',
    MERCHANT_PURCHASABILITY_GATE_ENABLED: '1',
    PUBLIC_READ_MCP_ENABLED: '1',
    PIVOTA_API_BASE: BACKEND,
    PIVOTA_API_KEY: 'test-token',
    PIVOTA_OPS_ADMIN_TOKEN: 'test-ops-token',
    CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789',
    PAYMENT_WEBHOOK_SECRET: 'strict-webhook-secret-0123456789',
    COMMERCE_READ_CACHE_ENABLED: '0',
    SELF_INVOKE_TIMEOUT_MS: '6000',
    UCP_LIVE_PRODUCT_READ: 'shadow',
  });
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'DATABASE_URL',
    'UCP_LIVE_OFFER_READ', 'GET_OFFERS_VARIANT_ID', 'PRICE_VERIFICATION_LOG', 'MCP_OAUTH_ENABLED', 'REAP_AGENTIC_LANE_ENABLED',
    'AGENT_CHECKOUT_UCP_SELLER_DISCOUNT_CODES_ENABLED', 'AGENT_CHECKOUT_UCP_DEAD_PAGE_CHECK_ENABLED',
    'AGENT_CHECKOUT_UCP_VARIANT_GONE_POLICY_ENABLED', 'MERCHANT_PURCHASABILITY_OIDC_AUDIENCE',
    'PARTNER_DOOR_ONE_PRODUCT_ID', 'GET_OFFERS_EMPTY_REASON', 'CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET', FLAG, MCP_FLAG,
    'UCP_STOREFRONT_HANDOFF_RECORD_ENABLED', 'PARTNER_IDENTITY_FORWARDING_ENABLED', 'CHECKOUT_CANCEL_UPSTREAM_ENABLED']) delete process.env[k];
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`COMMERCE_MCP_HEARTBEAT_${suffix}`];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null || v === '') delete process.env[k];
    else process.env[k] = String(v);
  }

  const fromRoot = (p) => require(path.join(root, p));
  const logger = fromRoot('src/logger');
  logger.level = 'silent';
  // The storefront-pricing log lines (`ucp_merchant_door_pricing`) and the `/mcp` path's "did not run" line
  // (`mcp_storefront_cart_path`), captured whatever the level.
  const logLines = [];
  const realInfo = logger.info.bind(logger);
  logger.info = (first, ...rest) => {
    if (first && typeof first === 'object' && ['ucp_merchant_door_pricing', 'mcp_storefront_cart_path'].includes(first.event)) logLines.push(first);
    return realInfo(first, ...rest);
  };
  // The retry ledger's own lines (`storefront_cart_idempotency`: claimed, replayed, replay_refused and its reason,
  // released, ...), at the two levels it logs at, kept APART from the lines above so that nothing that compares
  // `log` moves. An answer carries the ones its call produced as `ledger`.
  const ledgerLines = [];
  const noteLedger = (first) => { if (first && typeof first === 'object' && first.event === 'storefront_cart_idempotency') ledgerLines.push(first); };
  const pricingInfo = logger.info.bind(logger);
  logger.info = (first, ...rest) => { noteLedger(first); return pricingInfo(first, ...rest); };
  const realWarn = logger.warn.bind(logger);
  logger.warn = (first, ...rest) => { noteLedger(first); return realWarn(first, ...rest); };

  // ---- the seller storefronts -------------------------------------------------------------------------------
  const storeCalls = [];
  // A test may make one storefront answer its carts in another currency (`setStoreCurrency`); null restores it.
  const storeCurrencyOverride = new Map();
  const carts = new Map();
  let cartSeq = 0;
  const cartFor = (host, lines) => {
    const lineItems = lines.map((l) => {
      const variant = String(l.item.id).replace(/^.*\//, '');
      const unit = STORE_PRICE[variant];
      return { item: { id: l.item.id, title: `Store item ${variant}`, price: unit }, quantity: l.quantity, totals: [{ type: 'subtotal', amount: unit * l.quantity }, { type: 'total', amount: unit * l.quantity }] };
    });
    const subtotal = lineItems.reduce((n, l) => n + l.totals[0].amount, 0);
    cartSeq += 1;
    const id = `cart_${host.split('.')[0]}_${String(cartSeq).padStart(4, '0')}`;
    const cart = { id, currency: storeCurrencyOverride.get(host) || STORE_CURRENCY[host], line_items: lineItems, totals: [{ type: 'subtotal', amount: subtotal }, { type: 'total', amount: subtotal }], continue_url: `https://${host}/cart/c/${id}?key=k0` };
    carts.set(id, cart);
    return cart;
  };
  const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  async function storeFetch(url, init = {}) {
    const u = new URL(String(url));
    const host = u.hostname.replace(/^www\./, '');
    if (u.pathname === '/.well-known/ucp') {
      storeCalls.push({ host, kind: 'profile' });
      if (!STORE_CURRENCY[host]) return jsonResponse(404, { error: 'not_found' });
      return jsonResponse(200, { ucp: { version: '2026-04-08', services: { 'dev.ucp.shopping': [{ transport: 'mcp', endpoint: `https://${host}/api/ucp/mcp` }] } } });
    }
    let body = null;
    try { body = JSON.parse(String(init.body || 'null')); } catch { body = null; }
    const tool = body && body.params && body.params.name;
    const args = (body && body.params && body.params.arguments) || {};
    const { meta: _meta, ...sent } = args;
    storeCalls.push({ host, kind: 'tool', tool, arguments: sent });
    const reply = (payload) => jsonResponse(200, { jsonrpc: '2.0', id: body && body.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
    if (tool === 'create_cart') return reply(cartFor(host, (args.cart && args.cart.line_items) || []));
    if (tool === 'get_cart') {
      const cart = carts.get(args.id);
      return cart ? reply(cart) : jsonResponse(200, { jsonrpc: '2.0', id: body && body.id, result: { isError: true, content: [{ type: 'text', text: 'Cart not found' }] } });
    }
    return jsonResponse(200, { jsonrpc: '2.0', id: body && body.id, error: { code: -32601, message: 'Method not found' } });
  }
  const clientModule = fromRoot('src/services/ucpBuyerAgentClient.js');
  const realCreateClient = clientModule.createUcpBuyerAgentClient;
  clientModule.createUcpBuyerAgentClient = (options = {}) => realCreateClient({ ...options, fetchImpl: storeFetch });

  // ---- the catalog (get_pdp_v2's served answer), from the real producers, judged for the request's market ----
  const { buildExternalSeedProduct } = fromRoot('src/services/externalSeedProducts.js');
  const { buildPdpPayload } = fromRoot('src/pdpBuilder.js');
  const { withholdOffMarketMoney, servingCurrencyFor } = fromRoot('src/services/servingCurrencyGuard.js');
  const pdpPage = (signature, payload) => {
    const row = CATALOG[signature];
    const seedProduct = buildExternalSeedProduct(row.seed);
    const servingCurrency = servingCurrencyFor({ payload, metadata: undefined });
    const guarded = row.unguarded ? { product: seedProduct, withheld: [] } : withholdOffMarketMoney(seedProduct, servingCurrency);
    const built = buildPdpPayload({ product: guarded.product }).product;
    const product = { ...built, product_id: signature, merchant_id: row.seller, source_product_id: row.seed.external_product_id, pivota_signature_id: signature };
    return {
      status: 'success',
      modules: [{ type: 'canonical', data: { pdp_payload: { product } } }],
      // As the handler reports a guard that withheld money (src/server.js, `serving_currency_guard`).
      ...(guarded.withheld.length ? { metadata: { serving_currency_guard: { withheld_currencies: guarded.withheld } } } : {}),
    };
  };
  const searchRow = (signature) => {
    const row = CATALOG[signature];
    return { id: signature, product_id: signature, merchant_id: row.seller, title: row.seed.seed_data.title, price: Number(row.seed.seed_data.snapshot.variants[0].price), currency: row.currency, in_stock: true, pivota_signature_id: signature, signature_id: signature };
  };

  const upstream = [];
  const isOp = (operation) => (body) => body && body.operation === operation;
  nock(LOOPBACK, { allowUnmocked: true }).persist()
    .post('/agent/shop/v1/invoke', isOp('find_products_multi'))
    .reply(200, () => ({ status: 'success', success: true, products: [searchRow(IDS.SIG_USD)], total: 1 }));
  // The connected merchant's product, as the unscoped read serves a product Pivota transacts: no storefront link.
  nock(LOOPBACK, { allowUnmocked: true }).persist()
    .post('/agent/shop/v1/invoke', (body) => isOp('get_pdp_v2')(body) && body.payload?.product_ref?.product_id === IDS.SIG_CONNECTED)
    .reply(200, (_uri, body) => {
      upstream.push({ op: 'get_pdp_v2', product_id: IDS.SIG_CONNECTED, market: Object.prototype.hasOwnProperty.call(body.payload, 'market') ? body.payload.market : null });
      return { status: 'success', modules: [{ type: 'canonical', data: { pdp_payload: { product: {
        product_id: IDS.SIG_CONNECTED, merchant_id: IDS.SELLER_CONNECTED, title: 'Day Lotion', brand: 'Shop A', pivota_signature_id: IDS.SIG_CONNECTED,
        source_product_id: IDS.SOURCE_CONNECTED, purchase_route: 'internal_checkout', price: { current: { amount: 18, currency: 'USD' } },
        variants: [{ variant_id: IDS.VARIANT_CONNECTED, sku_id: IDS.VARIANT_CONNECTED, title: 'Default', price: { current: { amount: 18, currency: 'USD' } } }],
      } } } }] };
    });
  nock(LOOPBACK, { allowUnmocked: true }).persist()
    .post('/agent/shop/v1/invoke', (body) => isOp('get_pdp_v2')(body) && Boolean(CATALOG[body.payload?.product_ref?.product_id]))
    .reply(200, (_uri, body) => {
      const askedId = body.payload.product_ref.product_id;
      // The market the request carried, exactly as sent (null = it carried none), and the whole payload as sent.
      upstream.push({ op: 'get_pdp_v2', product_id: askedId, market: Object.prototype.hasOwnProperty.call(body.payload, 'market') ? body.payload.market : null, payload: JSON.stringify(body.payload) });
      const page = pdpPage(askedId, body.payload);
      if (!realPdpLiveSeam) return page;
      // What the real handler does with a served page (src/server.js get_pdp_v2): the background store read, then the
      // live overlay, both keyed by the market the REQUEST carried. Run here on the handler's own functions.
      const debug = app._debug;
      const market = fromRoot('src/offers/offersPriority.js').offersGateBuyerMarket(body.payload, body.metadata);
      pdpSeamCalls.push({ product_id: askedId, market: market === undefined ? null : market, started: debug.shadowPdpLiveRead(page, { market, pageState: 'served', random: () => 0 }) });
      return debug.livePdpOverlay(page, { market });
    });
  const pdpSeamCalls = [];

  // ---- the backend ------------------------------------------------------------------------------------------
  const connectedProduct = () => ({
    product_id: IDS.SOURCE_CONNECTED, merchant_id: IDS.SELLER_CONNECTED, title: 'Day Lotion', brand: 'Shop A', price: 18, currency: 'USD', in_stock: true,
    pivota_signature_id: IDS.SIG_CONNECTED,
    variants: [{ variant_id: IDS.VARIANT_CONNECTED, sku_id: IDS.VARIANT_CONNECTED, title: 'Default', price: 18 }],
  });
  nock(BACKEND).persist()
    .post('/agent/shop/v1/invoke')
    .reply((_uri, body) => {
      const operation = body && body.operation;
      const product = (body && body.payload && body.payload.product) || {};
      upstream.push({ op: operation, merchant_id: product.merchant_id ?? body?.payload?.quote?.merchant_id ?? null, product_id: product.product_id ?? null });
      if (operation === 'get_product_detail') {
        return product.merchant_id === IDS.SELLER_CONNECTED && [IDS.SOURCE_CONNECTED, IDS.SIG_CONNECTED].includes(product.product_id)
          ? [200, { status: 'success', product: { ...connectedProduct(), product_id: product.product_id } }]
          : [404, { detail: 'PRODUCT_NOT_FOUND' }];
      }
      if (operation === 'offers.resolve') return [200, { offers: [] }];
      return [404, { detail: 'NOT_FOUND' }];
    });
  // The currency the connected merchant's store is priced in: USD, as its product rows above are, until a test sets
  // another (`setQuoteCurrency`). The amounts are the merchant's own and are the same digits in any currency:
  // nothing here converts.
  const CONNECTED_STORE_CURRENCY = 'USD';
  let quoteCurrency = CONNECTED_STORE_CURRENCY;
  const quotes = [];
  nock(BACKEND).persist()
    .post('/agent/v2/quotes/preview')
    .reply((_uri, body) => {
      upstream.push({ op: 'quotes.preview', merchant_id: (body && body.merchant_id) || null });
      quotes.push(JSON.parse(JSON.stringify(body || null)));
      if (!body || body.merchant_id !== IDS.SELLER_CONNECTED) return [422, { detail: { code: 'MERCHANT_NOT_CONNECTED' } }];
      return [200, {
        quote_id: 'q_connected_0001', currency: quoteCurrency,
        pricing: { subtotal: '18.00', shipping_fee: '0.00', tax: '0.00', total: '18.00' },
        line_items: [{ product_id: IDS.SOURCE_CONNECTED, variant_id: IDS.VARIANT_CONNECTED, quantity: 1, unit_price_effective: '18.00' }],
        expires_at: '2099-01-01T00:00:00Z',
      }];
    });
  // The purchasability ops route: every seller purchasable for every market that is named. Enforcing by default
  // (a request with no market to key on is then declined); `setGateEnforced(false)` answers as a backend that does
  // not enforce yet, where such a request is answered as it was before the gate.
  const gateCalls = [];
  let gateEnforced = true;
  nock(BACKEND).persist()
    .get('/ops/merchant-purchasability')
    .query(true)
    .reply(200, (uri) => {
      const q = new URL(uri, BACKEND).searchParams;
      gateCalls.push({ domain: q.get('domain'), market: q.get('market') });
      const tier = q.get('market') ? 'purchase' : 'browse_only';
      return { domain: q.get('domain'), market: q.get('market'), tier, human_handoff_tier: tier, enforced: gateEnforced, sweep_enabled: true, ...(q.get('market') ? {} : { reason: 'market_unknown' }) };
    });

  const app = fromRoot('src/server');
  // The store catalog client behind every live read (get_product's, get_pdp_v2's): answers nothing, records every
  // call it receives, so a test can say no store was looked up.
  const liveReads = [];
  if (app._debug && typeof app._debug.useUcpLiveClientForTest === 'function') {
    app._debug.useUcpLiveClientForTest({
      async discoverEndpoint(base) { liveReads.push({ kind: 'discover', base: String(base) }); return { status: 404 }; },
      async lookupCatalog(endpoint) { liveReads.push({ kind: 'lookup_catalog', endpoint: String(endpoint) }); return { ok: false, status: 500 }; },
    });
  }

  function send(doorPath, body, headers) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: Number(PORT), method: 'POST', path: doorPath, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': payload.length, connection: 'close', ...headers },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { parsed = null; }
          resolve({ status: res.statusCode, text, body: parsed });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  const rpc = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const mark = () => ({ store: storeCalls.length, upstream: upstream.length, gate: gateCalls.length, log: logLines.length, ledger: ledgerLines.length, quotes: quotes.length });
  const since = (m) => ({ store: storeCalls.slice(m.store), upstream: upstream.slice(m.upstream), gate: gateCalls.slice(m.gate), log: logLines.slice(m.log), ledger: ledgerLines.slice(m.ledger), quotes: quotes.slice(m.quotes) });
  /** Make the connected merchant's quote answer in `currency` (null: in its own again). */
  const setQuoteCurrency = (currency) => { quoteCurrency = currency === null || currency === undefined ? CONNECTED_STORE_CURRENCY : currency; };
  /** Make `host`'s storefront answer its carts in `currency` (null: in its own again). */
  const setStoreCurrency = (host, currency) => { if (currency) storeCurrencyOverride.set(host, currency); else storeCurrencyOverride.delete(host); };
  /** tools/call on `door`. `raw` is the response body as the door sent it, byte for byte. */
  async function call(door, name, args, { buyer = BUYER } = {}) {
    const before = mark();
    const resp = await send(door, rpc(name, args), buyer || {});
    const result = resp.body && resp.body.result;
    const text = result && Array.isArray(result.content) && result.content[0] ? result.content[0].text : null;
    let value = null;
    try { value = JSON.parse(text); } catch { value = null; }
    return { http: resp.status, isError: Boolean(result && result.isError), value, raw: resp.text, ...since(before) };
  }
  async function post(door, body, { buyer = BUYER } = {}) {
    const before = mark();
    const resp = await send(door, body, buyer || {});
    return { http: resp.status, raw: resp.text, body: resp.body, ...since(before) };
  }
  /** The stores forget their carts (so cart ids repeat) and the gate forgets its answers. */
  const reset = () => {
    carts.clear();
    cartSeq = 0;
    fromRoot('src/services/merchantPurchasabilityClient.js').resetMerchantPurchasabilityClientForTest();
  };
  const setGateEnforced = (on) => { gateEnforced = on !== false; reset(); };
  let server = null;
  const listen = () => new Promise((resolve) => { server = app.listen(Number(PORT), '127.0.0.1', () => resolve()); });
  const close = async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    nock.cleanAll();
  };
  /** Run `fn` with the currency rule on (or off), restoring the env after. The flag is read per call. */
  async function withFlag(on, fn) {
    const before = process.env[FLAG];
    if (on) process.env[FLAG] = '1'; else delete process.env[FLAG];
    try { return await fn(); } finally {
      if (before === undefined) delete process.env[FLAG]; else process.env[FLAG] = before;
    }
  }
  /** Run `fn` with the `/mcp` storefront switch and the currency rule each on or off, restoring the env after. */
  async function withFlags({ mcp = false, currency = false } = {}, fn) {
    const before = [process.env[MCP_FLAG], process.env[FLAG]];
    if (mcp) process.env[MCP_FLAG] = '1'; else delete process.env[MCP_FLAG];
    if (currency) process.env[FLAG] = '1'; else delete process.env[FLAG];
    try { return await fn(); } finally {
      for (const [i, name] of [MCP_FLAG, FLAG].entries()) { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; }
    }
  }
  return { app, call, post, listen, close, reset, setGateEnforced, setStoreCurrency, setQuoteCurrency, withFlag, withFlags, storeCalls, upstream, gateCalls, logLines, liveReads, pdpSeamCalls, quotes, root };
}

const UCP_META = Object.freeze({ 'ucp-agent': { profile: 'https://agent.example/profile' } });
const idem = (n) => `idem-store-cart-market-${String(n).padStart(4, '0')}`;
/** UCP create_checkout arguments. `market` undefined = the request names none. */
const ucpCreate = (items, market, n = 1) => ({
  meta: { ...UCP_META, 'idempotency-key': idem(n) },
  checkout: {
    line_items: items.map(([id, quantity]) => ({ item: { id }, quantity })),
    buyer: { email: 'buyer@example.test' },
    ...(market !== undefined ? { context: { address_country: market } } : {}),
  },
});
const ucpGet = (id) => ({ meta: UCP_META, id });
const escId = (body) => `esc_${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}`;
const decodeEscId = (id) => JSON.parse(Buffer.from(String(id).slice(4), 'base64url').toString('utf8'));
const nativeCreate = (merchantId, items, n, extra = {}) => ({
  idempotency_key: idem(n),
  quote: { merchant_id: merchantId, items: items.map(([product_id, quantity, variant_id]) => ({ product_id, quantity, ...(variant_id ? { variant_id } : {}) })), customer_email: 'buyer@example.test' },
  ...extra,
});

/**
 * THE REQUEST SET: every door, in one fixed order. Returns `{ key: answer }`. The differential runs it over this
 * tree and over the base tree, with the currency rule off and on, and compares the bytes and the traffic.
 * Keys are `<door>.<name>`; a `/ucp/mcp` storefront request also says its market and the row's currency.
 */
async function runRequests(door) {
  const out = {};
  const mcp = async (key, name, args, o) => { out[key] = await door.call('/mcp', name, args, o); return out[key]; };
  const ucp = async (key, name, args, o) => { out[key] = await door.call('/ucp/mcp', name, args, o); return out[key]; };
  const raw = async (key, p, body, o) => { out[key] = await door.post(p, body, o); return out[key]; };
  const idOf = (answer) => (answer.value && typeof answer.value.id === 'string' ? answer.value.id : 'esc_bm90LWFuLWlk');

  // ---- /ucp/mcp ----
  await raw('ucp.tools_list', '/ucp/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/list' });
  await ucp('ucp.search', 'search_catalog', { meta: UCP_META, catalog: { query: 'serum', context: { address_country: 'US' } } });
  await ucp('ucp.get_product', 'get_product', { meta: UCP_META, catalog: { id: IDS.SIG_USD } });
  // US market, USD rows.
  const usPriced = await ucp('ucp.us_usd.create', 'create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'US', 1));
  await ucp('ucp.us_usd.get', 'get_checkout', ucpGet(idOf(usPriced)));
  const usTwo = await ucp('ucp.us_usd.create_two_lines', 'create_checkout', ucpCreate([[IDS.SIG_USD, 2], [IDS.SIG_USD_SECOND, 3]], 'US', 2));
  await ucp('ucp.us_usd.get_two_lines', 'get_checkout', ucpGet(idOf(usTwo)));
  await ucp('ucp.us_usd.create_lowercase_market', 'create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'us', 3));
  await ucp('ucp.us_usd.create_no_buyer', 'create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'US', 4), { buyer: null });
  await ucp('ucp.us_usd.get_catalog_id', 'get_checkout', ucpGet(escId({ v: 1, i: [[IDS.SIG_USD, 1]], m: 'US' })));
  await ucp('ucp.us_usd.update', 'update_checkout', { meta: { ...UCP_META, 'idempotency-key': idem(5) }, id: idOf(usPriced), checkout: { line_items: [{ item: { id: IDS.SIG_USD }, quantity: 2 }] } });
  await ucp('ucp.us_usd.complete', 'complete_checkout', { meta: { ...UCP_META, 'idempotency-key': idem(6) }, id: idOf(usPriced), checkout: { payment: { instruments: [] } } });
  // No market named (answered as US, labelled), USD row.
  const assumed = await ucp('ucp.none_usd.create', 'create_checkout', ucpCreate([[IDS.SIG_USD, 1]], undefined, 7));
  await ucp('ucp.none_usd.get', 'get_checkout', ucpGet(idOf(assumed)));
  // A connected merchant's product (the kernel prices it), US and GB.
  await ucp('ucp.us_connected.create', 'create_checkout', ucpCreate([[IDS.SIG_CONNECTED, 1]], 'US', 8));
  await ucp('ucp.gb_connected.create', 'create_checkout', ucpCreate([[IDS.SIG_CONNECTED, 1]], 'GB', 9));
  // US market, rows priced in other currencies.
  await ucp('ucp.us_gbp.create', 'create_checkout', ucpCreate([[IDS.SIG_GBP, 1]], 'US', 10));
  await ucp('ucp.none_gbp.create', 'create_checkout', ucpCreate([[IDS.SIG_GBP, 1]], undefined, 11));
  // Other markets.
  await ucp('ucp.gb_usd.create', 'create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'GB', 12));
  const gbGbp = await ucp('ucp.gb_gbp.create', 'create_checkout', ucpCreate([[IDS.SIG_GBP, 1]], 'GB', 13));
  await ucp('ucp.gb_gbp.get', 'get_checkout', ucpGet(idOf(gbGbp)));
  await ucp('ucp.gb_gbp_usd_store.create', 'create_checkout', ucpCreate([[IDS.SIG_GBP_USD_STORE, 1]], 'GB', 14));
  await ucp('ucp.sg_sgd.create', 'create_checkout', ucpCreate([[IDS.SIG_SGD, 1]], 'SG', 15));
  await ucp('ucp.sg_usd.create', 'create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'SG', 16));
  await ucp('ucp.de_usd.create', 'create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'DE', 17));
  await ucp('ucp.de_eur.create', 'create_checkout', ucpCreate([[IDS.SIG_EUR, 1]], 'DE', 18));
  await ucp('ucp.zz_usd.create', 'create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'ZZ', 19));
  await ucp('ucp.malformed_usd.create', 'create_checkout', ucpCreate([[IDS.SIG_USD, 1]], 'USA', 20));
  // Ids from before the rule: for a market whose currency the rows are not in, for no market, for a market unknown.
  await ucp('ucp.gb_usd.get_old_id', 'get_checkout', ucpGet(escId({ v: 1, i: [[IDS.SIG_USD, 1]], m: 'GB' })));
  await ucp('ucp.legacy_usd.get_v1_no_market', 'get_checkout', ucpGet(escId({ v: 1, i: [[IDS.SIG_USD, 1]] })));
  await ucp('ucp.legacy_usd.get_v2_no_market', 'get_checkout', ucpGet(escId({ v: 2, i: [[IDS.SIG_USD, 1]], c: 'cart_store-a_0001', h: HOST.A })));
  await ucp('ucp.de_usd.get_old_id', 'get_checkout', ucpGet(escId({ v: 1, i: [[IDS.SIG_USD, 1]], m: 'DE' })));
  await ucp('ucp.forged.get', 'get_checkout', ucpGet('esc_bm90LWFuLWlk'));

  // ---- /mcp ----
  await raw('mcp.initialize', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'door-test', version: '0' } } });
  await raw('mcp.tools_list', '/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/list' });
  await mcp('mcp.search', 'search_catalog', { query: 'serum', market: 'US' });
  await mcp('mcp.search_no_market', 'search_catalog', { query: 'serum' });
  await mcp('mcp.get_product_us', 'get_product', { merchant_id: IDS.SELLER_A, product_id: IDS.SIG_USD, market: 'US' });
  await mcp('mcp.get_product_gb', 'get_product', { product_id: IDS.SIG_USD, market: 'GB' });
  await mcp('mcp.get_product_no_market', 'get_product', { product_id: IDS.SIG_GBP });
  await mcp('mcp.get_offers', 'get_offers', { product_id: IDS.SIG_USD, market: 'US' });
  await mcp('mcp.create_storefront_seller', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 31));
  await mcp('mcp.create_connected', 'create_checkout_session', nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], 32));
  await mcp('mcp.get_esc_id', 'get_checkout_session', { session_id: idOf(usPriced) });
  await mcp('mcp.get_esc_id_gb', 'get_checkout_session', { session_id: escId({ v: 1, i: [[IDS.SIG_USD, 1]], m: 'GB' }) });
  await mcp('mcp.get_kernel_unknown', 'get_checkout_session', { session_id: 'q_00000000-0000-0000-0000-000000000000' });
  await mcp('mcp.complete_esc_id', 'complete_checkout_session', { idempotency_key: idem(33), session_id: idOf(usPriced), payment_authorization: { type: 'none' } });
  // The native door's storefront checkout, naming its market (an argument only while that path is on).
  const sessionOf = (answer) => (answer.value && typeof answer.value.session_id === 'string' && answer.value.session_id.startsWith('esc_') ? answer.value.session_id : 'esc_bm90LWFuLWlk');
  const mcpUs = await mcp('mcp.us_usd.create', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 51, { market: 'US' }));
  await mcp('mcp.us_usd.get', 'get_checkout_session', { session_id: sessionOf(mcpUs) });
  await mcp('mcp.us_usd.create_two_lines', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 2], [IDS.SIG_USD_SECOND, 1]], 52, { market: 'US' }));
  await mcp('mcp.gb_usd.create', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 53, { market: 'GB' }));
  const mcpGb = await mcp('mcp.gb_gbp.create', 'create_checkout_session', nativeCreate(IDS.SELLER_G, [[IDS.SIG_GBP, 1]], 54, { market: 'GB' }));
  await mcp('mcp.gb_gbp.get', 'get_checkout_session', { session_id: sessionOf(mcpGb) });
  await mcp('mcp.sg_usd.create', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 55, { market: 'SG' }));
  await mcp('mcp.de_usd.create', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 56, { market: 'DE' }));
  await mcp('mcp.zz_usd.create', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 57, { market: 'ZZ' }));
  await mcp('mcp.malformed_usd.create', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 58, { market: 'USA' }));
  await mcp('mcp.us_connected.create', 'create_checkout_session', nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], 59, { market: 'US' }));
  await mcp('mcp.update_esc_id', 'update_checkout_session', { idempotency_key: idem(60), session_id: idOf(usPriced), quote: { merchant_id: IDS.SELLER_A, items: [{ product_id: IDS.SIG_USD, quantity: 2 }], customer_email: 'buyer@example.test' } });
  await mcp('mcp.cancel_esc_id', 'cancel_checkout_session', { idempotency_key: idem(61), session_id: idOf(usPriced) });
  await mcp('mcp.get_de_old_id', 'get_checkout_session', { session_id: escId({ v: 1, i: [[IDS.SIG_USD, 1]], m: 'DE' }) });
  await mcp('mcp.get_legacy_id', 'get_checkout_session', { session_id: escId({ v: 1, i: [[IDS.SIG_USD, 1]] }) });

  // ---- /public/mcp ----
  await raw('public.tools_list', '/public/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/list' }, { buyer: null });
  await raw('public.search', '/public/mcp', { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'search_catalog', arguments: { query: 'serum' } } }, { buyer: null });
  await raw('public.get_product', '/public/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_product', arguments: { product_id: IDS.SIG_USD, market: 'GB' } } }, { buyer: null });
  await raw('public.create_checkout_session', '/public/mcp', { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'create_checkout_session', arguments: nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 41) } }, { buyer: null });

  // ---- the invoke route ----
  const invoke = (key, body) => raw(key, '/agent/shop/v1/invoke', body);
  await invoke('invoke.preview_quote_storefront_seller', { operation: 'preview_quote', payload: { quote: { merchant_id: IDS.SELLER_A, items: [{ product_id: IDS.SIG_USD, variant_id: IDS.VARIANT_USD, quantity: 1 }], customer_email: 'buyer@example.test' } } });
  await invoke('invoke.preview_quote_connected', { operation: 'preview_quote', payload: { quote: { merchant_id: IDS.SELLER_CONNECTED, items: [{ product_id: IDS.SOURCE_CONNECTED, variant_id: IDS.VARIANT_CONNECTED, quantity: 1 }], customer_email: 'buyer@example.test' } } });
  await invoke('invoke.get_product_detail_connected', { operation: 'get_product_detail', payload: { product: { merchant_id: IDS.SELLER_CONNECTED, product_id: IDS.SOURCE_CONNECTED } } });
  await invoke('invoke.get_product_detail_unscoped_gb', { operation: 'get_product_detail', payload: { product: { product_id: IDS.SIG_USD }, market: 'GB' } });
  await invoke('invoke.unknown_operation', { operation: 'create_checkout_session', payload: nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 42) });
  // The creator invoke address: the same handler chain as the shop address, under another path.
  const creator = (key, body) => raw(key, '/agent/creator/v1/invoke', body);
  await creator('invoke_creator.preview_quote_storefront_seller', { operation: 'preview_quote', payload: { quote: { merchant_id: IDS.SELLER_A, items: [{ product_id: IDS.SIG_USD, variant_id: IDS.VARIANT_USD, quantity: 1 }], customer_email: 'buyer@example.test' } } });
  await creator('invoke_creator.preview_quote_connected', { operation: 'preview_quote', payload: { quote: { merchant_id: IDS.SELLER_CONNECTED, items: [{ product_id: IDS.SOURCE_CONNECTED, variant_id: IDS.VARIANT_CONNECTED, quantity: 1 }], customer_email: 'buyer@example.test' } } });
  await creator('invoke_creator.get_product_detail_connected', { operation: 'get_product_detail', payload: { product: { merchant_id: IDS.SELLER_CONNECTED, product_id: IDS.SOURCE_CONNECTED } } });
  await creator('invoke_creator.get_product_detail_unscoped_gb', { operation: 'get_product_detail', payload: { product: { product_id: IDS.SIG_USD }, market: 'GB' } });
  await creator('invoke_creator.unknown_operation', { operation: 'create_checkout_session', payload: nativeCreate(IDS.SELLER_A, [[IDS.SIG_USD, 1]], 43) });
  return out;
}

module.exports = { IDS, HOST, STORE_CURRENCY, STORE_PRICE, CATALOG, BUYER, FLAG, MCP_FLAG, UCP_META, gid, escId, decodeEscId, bootDoor, ucpCreate, ucpGet, nativeCreate, idem, runRequests };
