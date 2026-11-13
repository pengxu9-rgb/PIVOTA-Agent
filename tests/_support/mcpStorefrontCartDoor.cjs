'use strict';

// THE STOREFRONT-CART DOOR FIXTURE (AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED): the real gateway app,
// offline, with a product catalog, a backend and seller storefronts to answer it. Shared by
//   tests/mcp_storefront_cart_door.node.test.cjs               the `/mcp` door, flag on and flag off
//   tests/mcp_storefront_cart_composition.node.test.cjs        every combination with the other two `/mcp` views
// (each through tests/_support/mcpStorefrontCartDoorChild.cjs: one process per load-time flag combination).
//
// REAL: the routes (`/mcp`, `/ucp/mcp`, `/public/mcp`, the invoke route), the JSON-RPC adapter, the door's views,
// the tool surface, the canonical executor, the gateway's kernel dispatcher, the storefront escalation, the
// merchant-door pricing, the warm-handoff endpoint discovery, the UCP buyer-agent client (its request building
// and its answer parsing), the purchasability gate client.
//
// STUBBED, because no database, backend or store is reachable here:
//   - get_pdp_v2's SERVED answer for the fixture signatures. Each product body is built by the real producers
//     (externalSeedProducts.buildExternalSeedProduct -> pdpBuilder.buildPdpPayload), then carries the identity
//     the catalog identity layer stamps (the signature as `product_id`, the observed seller as `merchant_id`);
//   - the backend: the connected merchant's per-merchant detail, its quote (`preview_quote`), offers.resolve,
//     and the purchasability ops route;
//   - the SELLER STOREFRONTS: the buyer-agent client's transport (`fetchImpl`, its own test seam) is answered
//     in-process by STORES below: `/.well-known/ucp` and the store's MCP endpoint (`create_cart`, `get_cart`).
//     Every request a store receives is recorded, so a test can say what was sent and that nothing else was.
// Every name is a placeholder.

const path = require('node:path');
const http = require('node:http');
const nock = require('nock');

const sig = (c) => `sig_${String(c).repeat(32)}`;

const IDS = Object.freeze({
  // store-a: its storefront prices carts.
  SIG_A: sig('a'),          // one variant, named by the link's own `variant=`
  SIG_A_MULTI: sig('b'),    // three variants, none named by the link: unresolved unless the buyer chooses
  SIG_A_SECOND: sig('c'),   // a second one-variant product of the same seller
  // store-b: its storefront answers with a cart link on another host (rejected: fallback).
  SIG_B: sig('d'),
  // store-c: the purchasability gate declines it for US.
  SIG_C: sig('e'),
  // store-d: another seller (mixed-seller carts); its storefront answers in another currency (rejected: fallback).
  SIG_D: sig('f'),
  // a connected merchant's product (the kernel prices it).
  SIG_CONNECTED: sig('1'),
  SOURCE_CONNECTED: '9001',
  // a product search serves under its group-shaped id (`sig_` + 24 hex), store-a's.
  SIG_EMITTED: sig('3'),
  // store-a again: a product whose catalog link already carries a referral's tracking members.
  SIG_A_STAMPED: sig('5'),
  VARIANT_A_STAMPED: '44000000000071',
  GROUP_EMITTED: `sig_${'7'.repeat(24)}`,
  SELLER_A: 'merch_obs_000000000000000a',
  SELLER_B: 'merch_obs_000000000000000b',
  SELLER_C: 'merch_obs_000000000000000c',
  SELLER_D: 'merch_obs_000000000000000d',
  SELLER_CONNECTED: 'merch_shop_a',
  SHARED_SEED_SELLER: 'external_seed',
  VARIANT_A: '44000000000001',
  VARIANT_A_MULTI: ['44000000000011', '44000000000012', '44000000000013'],
  VARIANT_A_SECOND: '44000000000021',
  VARIANT_B: '44000000000031',
  VARIANT_C: '44000000000041',
  VARIANT_D: '44000000000051',
  VARIANT_EMITTED: '44000000000061',
  VARIANT_CONNECTED: 'v-9001-1',
});

const HOST = Object.freeze({ A: 'store-a.example', B: 'store-b.example', C: 'store-c.example', D: 'store-d.example' });
const gid = (n) => `gid://shopify/ProductVariant/${n}`;

// What each seller's storefront charges per variant (minor units), where it differs from the catalog: the
// catalog says 25.00 for VARIANT_A, the store says 27.50, so a test can tell whose price an answer carries.
const STORE_PRICE = Object.freeze({
  [IDS.VARIANT_A]: 2750,
  [IDS.VARIANT_A_MULTI[1]]: 2600,
  [IDS.VARIANT_A_SECOND]: 1200,
  [IDS.VARIANT_B]: 3000,
  [IDS.VARIANT_D]: 4000,
  [IDS.VARIANT_EMITTED]: 1500,
  [IDS.VARIANT_A_STAMPED]: 1900,
});

// The referral the stamped product's catalog link carries (a click id of the shape the backend mints).
const STAMPED_CLICK_ID = 'clk_0000000000000000000000aa';
const STAMPED_TRACKING = Object.freeze([
  ['utm_source', 'pivota'], ['utm_medium', 'search_catalog'], ['utm_campaign', 'US'],
  ['pvt_click_id', STAMPED_CLICK_ID], ['utm_content', STAMPED_CLICK_ID],
]);
const BACKEND_BASE = 'http://backend.storefront-cart.test';

// A seed row as the crawl stores it, for the real producers.
const seedRow = (externalId, title, url, variants) => ({
  status: 'active', market: 'US', tool: '*', id: externalId, external_product_id: externalId,
  destination_url: url, canonical_url: url, price_currency: 'USD',
  seed_data: { title, snapshot: { variants } },
});

const CATALOG = Object.freeze({
  [IDS.SIG_A]: { seller: IDS.SELLER_A, seed: seedRow('ext_00000000000000000000a0a0', 'Calm Serum', `https://${HOST.A}/products/calm-serum?variant=${IDS.VARIANT_A}`, [{ id: IDS.VARIANT_A, title: 'Default Title', price: '25.00' }]) },
  [IDS.SIG_A_MULTI]: { seller: IDS.SELLER_A, seed: seedRow('ext_00000000000000000000a0a1', 'Body Lotion', `https://${HOST.A}/products/body-lotion`, [
    { id: IDS.VARIANT_A_MULTI[0], title: '30 ml', options: [{ name: 'Size', value: '30 ml' }], price: '18.00' },
    { id: IDS.VARIANT_A_MULTI[1], title: '50 ml', options: [{ name: 'Size', value: '50 ml' }], price: '24.00' },
    { id: IDS.VARIANT_A_MULTI[2], title: '100 ml', options: [{ name: 'Size', value: '100 ml' }], price: '36.00' },
  ]) },
  [IDS.SIG_A_SECOND]: { seller: IDS.SELLER_A, seed: seedRow('ext_00000000000000000000a0a2', 'Night Cream', `https://${HOST.A}/products/night-cream?variant=${IDS.VARIANT_A_SECOND}`, [{ id: IDS.VARIANT_A_SECOND, title: 'Default Title', price: '12.00' }]) },
  [IDS.SIG_B]: { seller: IDS.SELLER_B, seed: seedRow('ext_00000000000000000000b0b0', 'Barrier Cream', `https://${HOST.B}/products/barrier-cream?variant=${IDS.VARIANT_B}`, [{ id: IDS.VARIANT_B, title: 'Default Title', price: '30.00' }]) },
  [IDS.SIG_C]: { seller: IDS.SELLER_C, seed: seedRow('ext_00000000000000000000c0c0', 'Eye Gel', `https://${HOST.C}/products/eye-gel?variant=${IDS.VARIANT_C}`, [{ id: IDS.VARIANT_C, title: 'Default Title', price: '22.00' }]) },
  [IDS.SIG_D]: { seller: IDS.SELLER_D, seed: seedRow('ext_00000000000000000000d0d0', 'Hand Cream', `https://${HOST.D}/products/hand-cream?variant=${IDS.VARIANT_D}`, [{ id: IDS.VARIANT_D, title: 'Default Title', price: '40.00' }]) },
  [IDS.SIG_A_STAMPED]: { seller: IDS.SELLER_A, seed: seedRow('ext_00000000000000000000a0a5', 'Day Cream', `https://${HOST.A}/products/day-cream?variant=${IDS.VARIANT_A_STAMPED}&${STAMPED_TRACKING.map(([k, v]) => `${k}=${v}`).join('&')}`, [{ id: IDS.VARIANT_A_STAMPED, title: 'Default Title', price: '19.00' }]) },
  [IDS.SIG_EMITTED]: { seller: IDS.SELLER_A, emittedAs: IDS.GROUP_EMITTED, seed: seedRow('ext_00000000000000000000e0e0', 'Lip Oil', `https://${HOST.A}/products/lip-oil?variant=${IDS.VARIANT_EMITTED}`, [{ id: IDS.VARIANT_EMITTED, title: 'Default Title', price: '15.00' }]) },
});
const EMITTED = Object.freeze({ [IDS.GROUP_EMITTED]: IDS.SIG_EMITTED });

const BUYER = Object.freeze({ 'X-Test-User-Ref': 'buyer-0001', 'X-Test-Acp-Session-Id': 'sess-0001' });
const OTHER_BUYER = Object.freeze({ 'X-Test-User-Ref': 'buyer-0002', 'X-Test-Acp-Session-Id': 'sess-0002' });

/**
 * Boot the gateway app from `root` (this repo by default; the differential harness passes another tree) and
 * answer its upstreams. Sets the process env: call once per process, before anything else loads the server.
 * @param {{ root?:string, port?:number, env?:Record<string,string|undefined> }} [o]
 */
function bootDoor({ root = path.resolve(__dirname, '../..'), port = 4396, env = {} } = {}) {
  const PORT = String(port);
  const LOOPBACK = `http://127.0.0.1:${PORT}`;
  const BACKEND = BACKEND_BASE;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT,
    AGENT_CHECKOUT_STRICT: '1',
    AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1',
    AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED: '1',
    // On in production: with either off, complete / create_payment_link are refused before the tool surface.
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
    'AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED', 'PARTNER_DOOR_ONE_PRODUCT_ID', 'GET_OFFERS_EMPTY_REASON',
    'AGENT_CHECKOUT_UCP_CART_REFERRAL_ENABLED', 'AGENT_CHECKOUT_UCP_CART_ATTRIBUTION_ENABLED',
    'PARTNER_IDENTITY_FORWARDING_ENABLED', 'UCP_STOREFRONT_HANDOFF_RECORD_ENABLED',
    'AGENT_CHECKOUT_STORE_CART_IDEMPOTENCY_ENABLED', 'AGENT_CHECKOUT_STORE_CART_ID_BINDING']) delete process.env[k];
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`COMMERCE_MCP_HEARTBEAT_${suffix}`];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null || v === '') delete process.env[k];
    else process.env[k] = String(v);
  }

  const fromRoot = (p) => require(path.join(root, p));
  fromRoot('src/logger').level = 'silent';

  // ---- the seller storefronts -------------------------------------------------------------------------------
  const storeCalls = [];
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
    // store-b hands back a cart link on a host that is not its own: the door must reject that answer.
    const linkHost = host === HOST.B ? 'elsewhere.example' : host;
    // store-d prices in another currency than the catalog holds for its products: rejected too.
    const cart = { id, currency: host === HOST.D ? 'EUR' : 'USD', line_items: lineItems, totals: [{ type: 'subtotal', amount: subtotal }, { type: 'total', amount: subtotal }], continue_url: `https://${linkHost}/cart/c/${id}?key=k0` };
    carts.set(id, cart);
    return cart;
  };
  const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  async function storeFetch(url, init = {}) {
    const u = new URL(String(url));
    const host = u.hostname.replace(/^www\./, '');
    if (u.pathname === '/.well-known/ucp') {
      storeCalls.push({ host, kind: 'profile' });
      if (![HOST.A, HOST.B, HOST.C, HOST.D].includes(host)) return jsonResponse(404, { error: 'not_found' });
      return jsonResponse(200, { ucp: { version: '2026-04-08', services: { 'dev.ucp.shopping': [{ transport: 'mcp', endpoint: `https://${host}/api/ucp/mcp` }] } } });
    }
    let body = null;
    try { body = JSON.parse(String(init.body || 'null')); } catch { body = null; }
    const tool = body && body.params && body.params.name;
    const args = (body && body.params && body.params.arguments) || {};
    // What the store was sent, minus the agent-profile pointer: a test asserts on exactly this.
    const { meta: _meta, ...sent } = args;
    storeCalls.push({ host, kind: 'tool', tool, arguments: sent, has_authorization: Boolean(init.headers && (init.headers.authorization || init.headers.Authorization)) });
    const reply = (payload) => jsonResponse(200, { jsonrpc: '2.0', id: body && body.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
    if (tool === 'create_cart') return reply(cartFor(host, (args.cart && args.cart.line_items) || []));
    if (tool === 'get_cart') {
      const cart = carts.get(args.id);
      return cart ? reply(cart) : jsonResponse(200, { jsonrpc: '2.0', id: body && body.id, result: { isError: true, content: [{ type: 'text', text: 'Cart not found' }] } });
    }
    return jsonResponse(200, { jsonrpc: '2.0', id: body && body.id, error: { code: -32601, message: 'Method not found' } });
  }
  // The buyer-agent client's own test seam (`fetchImpl`), set for every client the process builds, before the
  // server (and the merchant door, which builds its client on first use) loads.
  const clientModule = fromRoot('src/services/ucpBuyerAgentClient.js');
  const realCreateClient = clientModule.createUcpBuyerAgentClient;
  clientModule.createUcpBuyerAgentClient = (options = {}) => realCreateClient({ ...options, fetchImpl: storeFetch });

  // ---- the catalog (get_pdp_v2's served answer), from the real producers ------------------------------------
  const { buildExternalSeedProduct } = fromRoot('src/services/externalSeedProducts.js');
  const { buildPdpPayload } = fromRoot('src/pdpBuilder.js');
  const pdpProduct = (signature, askedId = signature) => {
    const row = CATALOG[signature];
    const built = buildPdpPayload({ product: buildExternalSeedProduct(row.seed) }).product;
    return {
      ...built,
      product_id: askedId,
      ...(askedId !== signature ? { canonical_entity_id: askedId } : {}),
      merchant_id: row.seller,
      source_product_id: row.seed.external_product_id,
      pivota_signature_id: signature,
    };
  };
  const searchRow = (signature) => {
    const row = CATALOG[signature];
    const p = pdpProduct(signature);
    const publicId = row.emittedAs || signature;
    return {
      id: publicId, product_id: publicId, merchant_id: row.seller, title: p.title, price: p.price.current.amount, currency: 'USD', in_stock: true,
      pivota_signature_id: signature, signature_id: signature,
    };
  };

  const upstream = [];
  const isOp = (operation) => (body) => body && body.operation === operation;
  const SEARCHED = [IDS.SIG_A, IDS.SIG_A_MULTI, IDS.SIG_EMITTED];
  nock(LOOPBACK, { allowUnmocked: true }).persist()
    .post('/agent/shop/v1/invoke', isOp('find_products_multi'))
    .reply(200, () => ({ status: 'success', success: true, products: SEARCHED.map(searchRow), total: SEARCHED.length }));
  nock(LOOPBACK, { allowUnmocked: true }).persist()
    .post('/agent/shop/v1/invoke', (body) => isOp('get_pdp_v2')(body) && Boolean(CATALOG[body.payload?.product_ref?.product_id] || EMITTED[body.payload?.product_ref?.product_id]))
    .reply(200, (_uri, body) => {
      const askedId = body.payload.product_ref.product_id;
      upstream.push({ op: 'get_pdp_v2', product_id: askedId });
      return { status: 'success', modules: [{ type: 'canonical', data: { pdp_payload: { product: pdpProduct(EMITTED[askedId] || askedId, askedId) } } }] };
    });

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
  // The quote. The backend prices a connected merchant's cart and no other seller's (as in production: a seller
  // Pivota is not connected to has no pricing engine behind it).
  nock(BACKEND).persist()
    .post('/agent/v2/quotes/preview')
    .reply((_uri, body) => {
      upstream.push({ op: 'quotes.preview', merchant_id: (body && body.merchant_id) || null, offer_refs: (body && body.offer_refs) || [] });
      if (!body || body.merchant_id !== IDS.SELLER_CONNECTED) return [422, { detail: { code: 'MERCHANT_NOT_CONNECTED' } }];
      return [200, {
        quote_id: 'q_connected_0001', currency: 'USD',
        pricing: { subtotal: '18.00', shipping_fee: '0.00', tax: '0.00', total: '18.00' },
        line_items: [{ product_id: IDS.SOURCE_CONNECTED, variant_id: IDS.VARIANT_CONNECTED, quantity: 1, unit_price_effective: '18.00' }],
        expires_at: '2099-01-01T00:00:00Z',
      }];
    });
  // The purchasability ops route: enforcing; store-c is browse-only for every market, everyone else purchasable.
  const gateCalls = [];
  nock(BACKEND).persist()
    .get('/ops/merchant-purchasability')
    .query(true)
    .reply(200, (uri) => {
      const q = new URL(uri, BACKEND).searchParams;
      gateCalls.push({ domain: q.get('domain'), market: q.get('market') });
      const tier = q.get('domain') === HOST.C || !q.get('market') ? 'browse_only' : 'purchase';
      return { domain: q.get('domain'), market: q.get('market'), tier, human_handoff_tier: tier, enforced: true, sweep_enabled: true, ...(q.get('market') ? {} : { reason: 'market_unknown' }) };
    });

  const app = fromRoot('src/server');
  if (app._debug && typeof app._debug.useUcpLiveClientForTest === 'function') {
    app._debug.useUcpLiveClientForTest({
      // get_product's own live read (UCP_LIVE_PRODUCT_READ=shadow), not part of any checkout: answered "no door".
      async discoverEndpoint() { return { status: 404 }; },
      async lookupCatalog() { return { ok: false, status: 500 }; },
    });
  }

  // ONE request = one fresh connection to the app's own listening server (`listen()` below), closed after the
  // answer. Not an ephemeral server per request: tearing one down while the interceptor that every http request
  // in this process passes through (nock) is still replaying its answer resets the connection now and then.
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
  const parse = (resp) => {
    const result = resp.body && resp.body.result;
    const text = result && Array.isArray(result.content) && result.content[0] ? result.content[0].text : null;
    let value = null;
    try { value = JSON.parse(text); } catch { value = null; }
    // `raw` is the response body as the door sent it, byte for byte.
    return { http: resp.status, isError: Boolean(result && result.isError), value, raw: resp.text };
  };
  /** tools/call on `door`. `buyer`: identity headers (BUYER by default; null = a caller with no verified buyer). */
  async function call(door, name, args, { buyer = BUYER } = {}) {
    const before = { store: storeCalls.length, upstream: upstream.length, gate: gateCalls.length };
    const out = parse(await send(door, rpc(name, args), buyer || {}));
    return { ...out, store: storeCalls.slice(before.store), upstream: upstream.slice(before.upstream), gate: gateCalls.slice(before.gate) };
  }
  async function post(door, body, { buyer = BUYER } = {}) {
    const before = { store: storeCalls.length, upstream: upstream.length, gate: gateCalls.length };
    const resp = await send(door, body, buyer || {});
    return { http: resp.status, raw: resp.text, body: resp.body, store: storeCalls.slice(before.store), upstream: upstream.slice(before.upstream), gate: gateCalls.slice(before.gate) };
  }
  const listTools = async (door) => (await post(door, { jsonrpc: '2.0', id: 7, method: 'tools/list' })).body.result.tools;
  /** Between phases: the stores forget their carts (so cart ids repeat) and the gate forgets its answers. */
  /** The gate forgets its answers (it caches one per seller and market), so the next call asks again. */
  const resetGate = () => fromRoot('src/services/merchantPurchasabilityClient.js').resetMerchantPurchasabilityClientForTest();
  const reset = () => {
    carts.clear();
    cartSeq = 0;
    resetGate();
  };
  let server = null;
  const listen = () => new Promise((resolve) => { server = app.listen(Number(PORT), '127.0.0.1', () => resolve()); });
  const close = async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    nock.cleanAll();
  };
  return { app, call, post, listTools, listen, close, reset, resetGate, storeCalls, upstream, gateCalls, root };
}

const idem = (n) => `idem-storefront-${String(n).padStart(4, '0')}`;
/** Native create_checkout_session arguments. */
const nativeCreate = (merchantId, items, extra = {}, quoteExtra = {}) => ({
  idempotency_key: idem(extra.n || 1),
  quote: { merchant_id: merchantId, items: items.map(([product_id, quantity, variant_id]) => ({ product_id, quantity, ...(variant_id ? { variant_id } : {}) })), customer_email: 'buyer@example.test', ...quoteExtra },
  ...(extra.market !== undefined ? { market: extra.market } : {}),
});
/** UCP create_checkout arguments. */
const ucpCreate = (items, market) => ({
  meta: { 'ucp-agent': { profile: 'https://agent.example/profile' }, 'idempotency-key': idem(9) },
  checkout: {
    line_items: items.map(([id, quantity]) => ({ item: { id }, quantity })),
    buyer: { email: 'buyer@example.test' },
    ...(market ? { context: { address_country: market } } : {}),
  },
});

const UCP_META = Object.freeze({ 'ucp-agent': { profile: 'https://agent.example/profile' } });
const escId = (body) => `esc_${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}`;
// An escalation id from before ids recorded their market (v1, no `m`), and one nobody minted.
const LEGACY_ESC_ID = escId({ v: 1, i: [[IDS.SIG_A, 1]] });
const FORGED_ESC_ID = 'esc_bm90LWFuLWlk';

/**
 * THE REQUEST SET: every door, every checkout tool, in one fixed order. Returns `{ key: answer }`. Used three
 * ways: the door tests assert on its answers; the composition test compares it across flag combinations; the
 * flag-off differential runs it over this tree and over the base tree and compares the bytes.
 * Escalation ids for the re-read / update / complete / cancel requests come from the UCP door's own creates
 * (it mints them with every flag of this change off), so the same ids exist whatever the `/mcp` flag says.
 */
async function runRequests(door) {
  const out = {};
  const mcp = async (key, name, args, o) => { out[key] = await door.call('/mcp', name, args, o); return out[key]; };
  const ucp = async (key, name, args, o) => { out[key] = await door.call('/ucp/mcp', name, args, o); return out[key]; };
  const raw = async (key, path, body, o) => { out[key] = await door.post(path, body, o); return out[key]; };
  const create = (key, merchantId, items, extra, quoteExtra, o) => mcp(key, 'create_checkout_session', nativeCreate(merchantId, items, extra, quoteExtra), o);

  // ---- /ucp/mcp ----
  await raw('ucp.tools_list', '/ucp/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/list' });
  await ucp('ucp.search', 'search_catalog', { meta: UCP_META, catalog: { query: 'serum', context: { address_country: 'US' } } });
  await ucp('ucp.get_product', 'get_product', { meta: UCP_META, catalog: { id: IDS.SIG_A } });
  const ucpPriced = await ucp('ucp.create_priced', 'create_checkout', ucpCreate([[IDS.SIG_A, 1]], 'US'));
  const ucpAssumed = await ucp('ucp.create_no_market', 'create_checkout', ucpCreate([[IDS.SIG_A, 1]]));
  const ucpChosen = await ucp('ucp.create_chosen_variant', 'create_checkout', ucpCreate([[`${IDS.SIG_A_MULTI}::v::${IDS.VARIANT_A_MULTI[1]}`, 1]], 'US'));
  await ucp('ucp.create_unresolved_variant', 'create_checkout', ucpCreate([[IDS.SIG_A_MULTI, 1]], 'US'));
  const ucpFallback = await ucp('ucp.create_fallback', 'create_checkout', ucpCreate([[IDS.SIG_B, 1]], 'US'));
  await ucp('ucp.create_declined', 'create_checkout', ucpCreate([[IDS.SIG_C, 1]], 'US'));
  await ucp('ucp.create_mixed_sellers', 'create_checkout', ucpCreate([[IDS.SIG_A, 1], [IDS.SIG_D, 1]], 'US'));
  await ucp('ucp.create_connected', 'create_checkout', ucpCreate([[IDS.SIG_CONNECTED, 1]], 'US'));
  await ucp('ucp.create_no_buyer', 'create_checkout', ucpCreate([[IDS.SIG_A, 1]], 'US'), { buyer: null });
  const pricedId = (ucpPriced.value && ucpPriced.value.id) || FORGED_ESC_ID;
  const chosenId = (ucpChosen.value && ucpChosen.value.id) || FORGED_ESC_ID;
  const fallbackId = (ucpFallback.value && ucpFallback.value.id) || FORGED_ESC_ID;
  await ucp('ucp.get_priced', 'get_checkout', { meta: UCP_META, id: pricedId });
  await ucp('ucp.get_fallback', 'get_checkout', { meta: UCP_META, id: fallbackId });
  // The id the UCP door minted for a create that named no market (it carries the assumed-market mark).
  const assumedId = (ucpAssumed.value && ucpAssumed.value.id) || FORGED_ESC_ID;
  await ucp('ucp.get_assumed_id', 'get_checkout', { meta: UCP_META, id: assumedId });
  await ucp('ucp.update_esc', 'update_checkout', { meta: { ...UCP_META, 'idempotency-key': idem(21) }, id: pricedId, checkout: { line_items: [{ item: { id: IDS.SIG_A }, quantity: 2 }] } });
  await ucp('ucp.complete_esc', 'complete_checkout', { meta: { ...UCP_META, 'idempotency-key': idem(22) }, id: pricedId, checkout: { payment: { instruments: [] } } });

  // ---- /mcp: handshake and reads ----
  await raw('mcp.initialize', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'door-test', version: '0' } } });
  await raw('mcp.tools_list', '/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/list' });
  await mcp('mcp.search', 'search_catalog', { query: 'serum', market: 'US' });
  await mcp('mcp.search_no_market', 'search_catalog', { query: 'serum' });
  await mcp('mcp.get_product', 'get_product', { merchant_id: IDS.SELLER_A, product_id: IDS.SIG_A, market: 'US' });
  await mcp('mcp.get_product_emitted', 'get_product', { merchant_id: IDS.SELLER_A, product_id: IDS.GROUP_EMITTED, market: 'US' });
  await mcp('mcp.get_offers', 'get_offers', { product_id: IDS.SIG_A, market: 'US' });
  const searchRows = (out['mcp.search'].value && out['mcp.search'].value.products) || [];
  // The row search serves under a group-shaped id (re-stamped to its signature by the partner-door view).
  const emittedRow = searchRows.find((row) => row && row.title === 'Lip Oil') || { merchant_id: IDS.SELLER_A, product_id: IDS.GROUP_EMITTED };

  // ---- /mcp: create ----
  // The UCP requests above already asked the gate about these sellers; asked again, so each answer below
  // shows its own gate read.
  door.resetGate();
  const priced = await create('mcp.create_priced', IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: 'US', n: 1 });
  await create('mcp.create_no_market', IDS.SELLER_A, [[IDS.SIG_A, 1]], { n: 2 });
  await create('mcp.create_null_market', IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: null, n: 51 });
  await create('mcp.create_blank_market', IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: '  ', n: 52 });
  await create('mcp.create_no_market_unknown_variant', IDS.SELLER_A, [[IDS.SIG_A_MULTI, 1, 'no-such-variant']], { n: 53 });
  await create('mcp.create_no_market_shared_seed_name', IDS.SHARED_SEED_SELLER, [[IDS.SIG_A, 1]], { n: 54 });
  await create('mcp.create_two_products', IDS.SELLER_A, [[IDS.SIG_A, 2], [IDS.SIG_A_SECOND, 3]], { market: 'US', n: 3 });
  await create('mcp.create_unresolved_variant', IDS.SELLER_A, [[IDS.SIG_A_MULTI, 1]], { market: 'US', n: 4 });
  await create('mcp.create_chosen_variant', IDS.SELLER_A, [[IDS.SIG_A_MULTI, 1, IDS.VARIANT_A_MULTI[1]]], { market: 'US', n: 5 });
  await create('mcp.create_unknown_variant', IDS.SELLER_A, [[IDS.SIG_A_MULTI, 1, 'no-such-variant']], { market: 'US', n: 6 });
  await create('mcp.create_fallback', IDS.SELLER_B, [[IDS.SIG_B, 1]], { market: 'US', n: 7 });
  await create('mcp.create_store_answers_other_currency', IDS.SELLER_D, [[IDS.SIG_D, 1]], { market: 'US', n: 28 });
  await create('mcp.create_declined', IDS.SELLER_C, [[IDS.SIG_C, 1]], { market: 'US', n: 8 });
  await create('mcp.create_declined_no_market', IDS.SELLER_C, [[IDS.SIG_C, 1]], { n: 9 });
  await create('mcp.create_mixed_sellers_shared_name', IDS.SHARED_SEED_SELLER, [[IDS.SIG_A, 1], [IDS.SIG_D, 1]], { market: 'US', n: 10 });
  // No `market` on the next two: with the flag off the argument itself is refused, which would hide that these
  // carts are answered the same either way.
  await create('mcp.create_mixed_sellers_named_seller', IDS.SELLER_A, [[IDS.SIG_A, 1], [IDS.SIG_D, 1]], { n: 11 });
  await create('mcp.create_other_sellers_product', IDS.SELLER_D, [[IDS.SIG_A, 1]], { n: 12 });
  await create('mcp.create_shared_seed_name', IDS.SHARED_SEED_SELLER, [[IDS.SIG_A, 1]], { market: 'US', n: 13 });
  await create('mcp.create_discount_codes', IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: 'US', n: 14 }, { discount_codes: ['CODE10'] });
  await create('mcp.create_emitted_id', IDS.SELLER_A, [[IDS.GROUP_EMITTED, 1]], { market: 'US', n: 15 });
  // The ids exactly as this door's own search returned them, whatever their shape.
  await create('mcp.create_from_search_row', emittedRow.merchant_id, [[emittedRow.product_id, 1]], { market: 'US', n: 27 });
  await create('mcp.create_no_buyer', IDS.SELLER_A, [[IDS.SIG_A, 1]], { n: 16 }, {}, { buyer: null });
  await create('mcp.create_malformed_market', IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: 'USA', n: 17 });
  await create('mcp.create_lowercase_market', IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: 'us', n: 18 });
  await create('mcp.create_empty_cart', IDS.SELLER_A, [], { market: 'US', n: 19 });
  await create('mcp.create_bad_quantity', IDS.SELLER_A, [[IDS.SIG_A, 0]], { n: 20 });
  await create('mcp.create_unknown_product', IDS.SELLER_A, [[`sig_${'9'.repeat(32)}`, 1]], { n: 21 });
  await mcp('mcp.create_undeclared_argument', 'create_checkout_session', { ...nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 1]], { n: 22 }), buyer_market: 'US' });
  // The connected merchant (the kernel prices it).
  await create('mcp.create_connected', IDS.SELLER_CONNECTED, [[IDS.SIG_CONNECTED, 1]], { n: 23 });
  await create('mcp.create_connected_variant', IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], { n: 24 });
  await create('mcp.create_connected_with_market', IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], { market: 'US', n: 25 });
  await create('mcp.create_connected_seller_storefront_product', IDS.SELLER_CONNECTED, [[IDS.SIG_A, 1]], { n: 26 });

  // ---- /mcp: an existing session ----
  const ownId = priced.value && typeof priced.value.session_id === 'string' && priced.value.session_id.startsWith('esc_') ? priced.value.session_id : null;
  await mcp('mcp.get_own_created', 'get_checkout_session', { session_id: ownId || pricedId });
  await mcp('mcp.get_priced', 'get_checkout_session', { session_id: pricedId });
  await mcp('mcp.get_chosen_variant', 'get_checkout_session', { session_id: chosenId });
  await mcp('mcp.get_fallback', 'get_checkout_session', { session_id: fallbackId });
  await mcp('mcp.get_no_buyer', 'get_checkout_session', { session_id: pricedId }, { buyer: null });
  await mcp('mcp.get_other_buyer', 'get_checkout_session', { session_id: pricedId }, { buyer: OTHER_BUYER });
  await mcp('mcp.get_assumed_id', 'get_checkout_session', { session_id: assumedId });
  await mcp('mcp.get_legacy_id', 'get_checkout_session', { session_id: LEGACY_ESC_ID });
  await mcp('mcp.get_forged_id', 'get_checkout_session', { session_id: FORGED_ESC_ID });
  await mcp('mcp.get_declined_seller_id', 'get_checkout_session', { session_id: escId({ v: 1, i: [[IDS.SIG_C, 1]], m: 'US' }) });
  await mcp('mcp.get_connected_product_id', 'get_checkout_session', { session_id: escId({ v: 1, i: [[IDS.SIG_CONNECTED, 1]], m: 'US' }) });
  await mcp('mcp.get_kernel_unknown', 'get_checkout_session', { session_id: 'q_00000000-0000-0000-0000-000000000000' });
  await mcp('mcp.update_esc', 'update_checkout_session', { ...nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 2]], { n: 31 }), session_id: pricedId });
  await mcp('mcp.update_kernel_unknown', 'update_checkout_session', { ...nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], { n: 32 }), session_id: 'q_00000000-0000-0000-0000-000000000000' });
  await mcp('mcp.complete_esc', 'complete_checkout_session', { idempotency_key: idem(33), session_id: pricedId, payment_authorization: { type: 'none' } });
  await mcp('mcp.complete_kernel_unknown', 'complete_checkout_session', { idempotency_key: idem(34), session_id: 'q_00000000-0000-0000-0000-000000000000', payment_authorization: { type: 'none' } });
  await mcp('mcp.cancel_esc', 'cancel_checkout_session', { idempotency_key: idem(35), session_id: pricedId });
  await mcp('mcp.cancel_kernel_unknown', 'cancel_checkout_session', { idempotency_key: idem(36), session_id: 'q_00000000-0000-0000-0000-000000000000' });
  await mcp('mcp.payment_link_esc', 'create_payment_link', { idempotency_key: idem(37), session_id: pricedId, customer_email: 'buyer@example.test' });
  await mcp('mcp.payment_link_kernel_unknown', 'create_payment_link', { idempotency_key: idem(38), session_id: 'q_00000000-0000-0000-0000-000000000000', customer_email: 'buyer@example.test' });
  await mcp('mcp.get_order_unknown', 'get_order', { order_id: 'ord_0000000000000000' });
  await mcp('mcp.unknown_tool', 'create_checkout', ucpCreate([[IDS.SIG_A, 1]], 'US'));
  await raw('mcp.arguments_not_an_object', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_checkout_session', arguments: 'x' } });

  // ---- /public/mcp ----
  await raw('public.tools_list', '/public/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/list' }, { buyer: null });
  await raw('public.search', '/public/mcp', { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'search_catalog', arguments: { query: 'serum' } } }, { buyer: null });
  await raw('public.create_checkout_session', '/public/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'create_checkout_session', arguments: nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: 'US', n: 41 }) } }, { buyer: null });

  // ---- the invoke route ----
  const invoke = (key, body) => raw(key, '/agent/shop/v1/invoke', body);
  await invoke('invoke.preview_quote_storefront_seller', { operation: 'preview_quote', payload: { quote: { merchant_id: IDS.SELLER_A, items: [{ product_id: IDS.SIG_A, variant_id: IDS.VARIANT_A, quantity: 1 }], customer_email: 'buyer@example.test' } } });
  await invoke('invoke.preview_quote_connected', { operation: 'preview_quote', payload: { quote: { merchant_id: IDS.SELLER_CONNECTED, items: [{ product_id: IDS.SOURCE_CONNECTED, variant_id: IDS.VARIANT_CONNECTED, quantity: 1 }], customer_email: 'buyer@example.test' } } });
  await invoke('invoke.get_product_detail_connected', { operation: 'get_product_detail', payload: { product: { merchant_id: IDS.SELLER_CONNECTED, product_id: IDS.SOURCE_CONNECTED } } });
  await invoke('invoke.unknown_operation', { operation: 'create_checkout_session', payload: nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: 'US', n: 42 }) });
  return out;
}

module.exports = { BACKEND_BASE, STAMPED_CLICK_ID, STAMPED_TRACKING, IDS, HOST, STORE_PRICE, CATALOG, BUYER, OTHER_BUYER, LEGACY_ESC_ID, FORGED_ESC_ID, gid, escId, bootDoor, nativeCreate, ucpCreate, idem, runRequests };
