'use strict';

// THE INTAKE-BOUNDS DOOR FIXTURE: the real gateway app, offline, with every checkout door lit and something to
// answer each of them. Used by tests/intake_key_minimum_and_quantity_ceiling_door.node.test.cjs, and by a private
// differential harness that boots it over two trees (`root`) and compares answers and outbound traffic.
//
// REAL: the routes (`/mcp`, `/ucp/mcp`, `/public/mcp`, `/acp/checkout_sessions...`), the JSON-RPC adapter, the tool
// surface, the UCP argument adapter, the ACP REST adapter (its signature check and its buyer token verifier), the
// shared intake, the canonical executor, the kernel and its dispatcher, the storefront cart (its product reads, its
// purchasability gate client, the merchant-door pricing and the buyer-agent client's request building).
//
// STUBBED, because no database, backend or store is reachable here, and EVERY request each one receives is
// recorded, so a test can say that a refusal sent nothing anywhere:
//   - the BACKEND (`upstream`): the connected merchant's product detail, the quote, the purchasability route, and
//     a 404 for everything else;
//   - the CATALOG (`upstream`, op `get_pdp_v2`): the served page of a product whose seller Pivota is not connected
//     to, built by the real producers;
//   - the SELLER'S STOREFRONT (`storeCalls`): the buyer-agent client's own transport seam.
// Every name is a placeholder.

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const nock = require('nock');

const sig = (c) => `sig_${String(c).repeat(32)}`;

const IDS = Object.freeze({
  // A product of a seller Pivota is not connected to: its checkout is a cart on the seller's own storefront.
  SIG_STORE: sig('a'),
  SELLER_STORE: 'merch_obs_000000000000000a',
  VARIANT_STORE: '44000000000001',
  // A connected merchant's product: the kernel prices it.
  SIG_CONNECTED: sig('1'),
  SOURCE_CONNECTED: '9001',
  SELLER_CONNECTED: 'merch_shop_a',
  VARIANT_CONNECTED: 'v-9001-1',
  // The same merchant's product with TWO variants: a line must name one, and two lines may name one each.
  SIG_TWO_VARIANTS: sig('2'),
  SOURCE_TWO_VARIANTS: '9002',
  VARIANT_TWO_A: 'v-9002-1',
  VARIANT_TWO_B: 'v-9002-2',
});
const STORE_HOST = 'store-a.example';
const STORE_UNIT_MINOR = 2750;
const CONNECTED_UNIT_MINOR = 1800;
const BACKEND_BASE = 'http://backend.intake-bounds.test';
const BUYER = Object.freeze({ 'X-Test-User-Ref': 'buyer-0001', 'X-Test-Acp-Session-Id': 'sess-0001' });
const ACP_SECRET = 'acp-signing-secret-0123456789abc';
const ACP_BUYER_ISSUER = 'https://buyer-idp.intake-bounds.test';
const ACP_BUYER_AUDIENCE = 'https://agent.intake-bounds.test/acp';

// The buyer credential's key pair is FIXED PER PROCESS PAIR by the caller (`buyerKeys`), so two trees booted by the
// differential harness verify the same token.
async function mintBuyerKeys() {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const pub = await exportJWK(publicKey);
  pub.kid = 'buyer-k1';
  pub.alg = 'ES256';
  const token = await new SignJWT({ email: 'buyer@example.test', email_verified: true })
    .setProtectedHeader({ alg: 'ES256', kid: 'buyer-k1' })
    .setIssuer(ACP_BUYER_ISSUER)
    .setAudience(ACP_BUYER_AUDIENCE)
    .setSubject('buyer-0001')
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(privateKey);
  return { jwks: { keys: [pub] }, token };
}

/**
 * Boot the gateway app from `root` (this repo by default) and answer its upstreams. Sets the process env: call
 * once per process, before anything else loads the server.
 * @param {{ root?:string, port?:number, env?:Record<string,string|undefined>, buyerKeys:{jwks:object, token:string} }} o
 */
function bootDoor({ root = path.resolve(__dirname, '../..'), port = 4476, env = {}, buyerKeys } = {}) {
  const PORT = String(port);
  const LOOPBACK = `http://127.0.0.1:${PORT}`;
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
    AGENT_CHECKOUT_ACP_REST_ENABLED: '1',
    ACP_SIGNING_SECRET: ACP_SECRET,
    IDENTITY_ISSUERS_JSON: JSON.stringify([{ iss: ACP_BUYER_ISSUER, aud: ACP_BUYER_AUDIENCE, jwks: buyerKeys.jwks, algs: ['ES256'] }]),
    MERCHANT_PURCHASABILITY_GATE_ENABLED: '1',
    PUBLIC_READ_MCP_ENABLED: '1',
    PIVOTA_API_BASE: BACKEND_BASE,
    PIVOTA_API_KEY: 'test-token',
    PIVOTA_OPS_ADMIN_TOKEN: 'test-ops-token',
    CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789',
    PAYMENT_WEBHOOK_SECRET: 'strict-webhook-secret-0123456789',
    COMMERCE_READ_CACHE_ENABLED: '0',
    SELF_INVOKE_TIMEOUT_MS: '6000',
  });
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'DATABASE_URL',
    'UCP_LIVE_PRODUCT_READ', 'UCP_LIVE_OFFER_READ', 'GET_OFFERS_VARIANT_ID', 'PRICE_VERIFICATION_LOG', 'MCP_OAUTH_ENABLED',
    'REAP_AGENTIC_LANE_ENABLED', 'AGENT_CHECKOUT_UCP_SELLER_DISCOUNT_CODES_ENABLED',
    'AGENT_CHECKOUT_UCP_DEAD_PAGE_CHECK_ENABLED', 'AGENT_CHECKOUT_UCP_VARIANT_GONE_POLICY_ENABLED',
    'MERCHANT_PURCHASABILITY_OIDC_AUDIENCE', 'PARTNER_DOOR_ONE_PRODUCT_ID', 'GET_OFFERS_EMPTY_REASON',
    'ACP_SPT_GATEWAY_HANDOFF_ENABLED', 'ORCHESTRATED_PURCHASE_TOOL_ENABLED']) delete process.env[k];
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`COMMERCE_MCP_HEARTBEAT_${suffix}`];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null || v === '') delete process.env[k];
    else process.env[k] = String(v);
  }

  const fromRoot = (p) => require(path.join(root, p));
  fromRoot('src/logger').level = 'silent';

  // ---- the seller's storefront ------------------------------------------------------------------------------
  const storeCalls = [];
  let cartSeq = 0;
  const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  async function storeFetch(url, init = {}) {
    const u = new URL(String(url));
    const host = u.hostname.replace(/^www\./, '');
    if (u.pathname === '/.well-known/ucp') {
      storeCalls.push({ host, kind: 'profile' });
      if (host !== STORE_HOST) return jsonResponse(404, { error: 'not_found' });
      return jsonResponse(200, { ucp: { version: '2026-04-08', services: { 'dev.ucp.shopping': [{ transport: 'mcp', endpoint: `https://${host}/api/ucp/mcp` }] } } });
    }
    let body = null;
    try { body = JSON.parse(String(init.body || 'null')); } catch { body = null; }
    const tool = body && body.params && body.params.name;
    const args = (body && body.params && body.params.arguments) || {};
    const { meta: _meta, ...sent } = args;
    storeCalls.push({ host, kind: 'tool', tool, arguments: sent });
    const reply = (payload) => jsonResponse(200, { jsonrpc: '2.0', id: body && body.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
    if (tool === 'create_cart') {
      const lines = (args.cart && args.cart.line_items) || [];
      const lineItems = lines.map((l) => ({
        item: { id: l.item.id, title: 'Store item', price: STORE_UNIT_MINOR }, quantity: l.quantity,
        totals: [{ type: 'subtotal', amount: STORE_UNIT_MINOR * l.quantity }, { type: 'total', amount: STORE_UNIT_MINOR * l.quantity }],
      }));
      const subtotal = lineItems.reduce((n, l) => n + l.totals[0].amount, 0);
      cartSeq += 1;
      const id = `cart_store_a_${String(cartSeq).padStart(4, '0')}`;
      return reply({ id, currency: 'USD', line_items: lineItems, totals: [{ type: 'subtotal', amount: subtotal }, { type: 'total', amount: subtotal }], continue_url: `https://${host}/cart/c/${id}?key=k0` });
    }
    return jsonResponse(200, { jsonrpc: '2.0', id: body && body.id, error: { code: -32601, message: 'Method not found' } });
  }
  const clientModule = fromRoot('src/services/ucpBuyerAgentClient.js');
  const realCreateClient = clientModule.createUcpBuyerAgentClient;
  clientModule.createUcpBuyerAgentClient = (options = {}) => realCreateClient({ ...options, fetchImpl: storeFetch });

  // ---- the catalog (get_pdp_v2's served answer for the storefront product), from the real producers ----------
  const { buildExternalSeedProduct } = fromRoot('src/services/externalSeedProducts.js');
  const { buildPdpPayload } = fromRoot('src/pdpBuilder.js');
  const storeUrl = `https://${STORE_HOST}/products/calm-serum?variant=${IDS.VARIANT_STORE}`;
  const storeSeed = {
    status: 'active', market: 'US', tool: '*', id: 'ext_00000000000000000000a0a0', external_product_id: 'ext_00000000000000000000a0a0',
    destination_url: storeUrl, canonical_url: storeUrl, price_currency: 'USD',
    seed_data: { title: 'Calm Serum', snapshot: { variants: [{ id: IDS.VARIANT_STORE, title: 'Default Title', price: '25.00' }] } },
  };
  const storeProduct = () => ({
    ...buildPdpPayload({ product: buildExternalSeedProduct(storeSeed) }).product,
    product_id: IDS.SIG_STORE,
    merchant_id: IDS.SELLER_STORE,
    source_product_id: storeSeed.external_product_id,
    pivota_signature_id: IDS.SIG_STORE,
  });

  // ---- everything the gateway sends out, in order -------------------------------------------------------------
  const upstream = [];
  const isOp = (operation) => (body) => body && body.operation === operation;
  nock(LOOPBACK, { allowUnmocked: true }).persist()
    .post('/agent/shop/v1/invoke', (body) => isOp('get_pdp_v2')(body) && body.payload?.product_ref?.product_id === IDS.SIG_STORE)
    .reply(200, () => {
      upstream.push({ to: 'catalog', op: 'get_pdp_v2', product_id: IDS.SIG_STORE });
      return { status: 'success', modules: [{ type: 'canonical', data: { pdp_payload: { product: storeProduct() } } }] };
    });
  // The connected merchant's product as the unscoped read serves it (the UCP door names no merchant): one real
  // variant and no storefront link, so the kernel prices it.
  nock(LOOPBACK, { allowUnmocked: true }).persist()
    .post('/agent/shop/v1/invoke', (body) => isOp('get_pdp_v2')(body) && body.payload?.product_ref?.product_id === IDS.SIG_CONNECTED)
    .reply(200, () => {
      upstream.push({ to: 'catalog', op: 'get_pdp_v2', product_id: IDS.SIG_CONNECTED });
      return {
        status: 'success',
        modules: [{ type: 'canonical', data: { pdp_payload: { product: {
          product_id: IDS.SIG_CONNECTED, merchant_id: IDS.SELLER_CONNECTED, pivota_signature_id: IDS.SIG_CONNECTED,
          title: 'Day Lotion', brand: { name: 'Shop A' }, price: { current: { amount: 18, currency: 'USD' } }, availability: 'in_stock',
          variants: [{ variant_id: IDS.VARIANT_CONNECTED, sku_id: IDS.VARIANT_CONNECTED, title: 'Default', price: { current: { amount: 18, currency: 'USD' } } }],
        } } } }],
      };
    });

  // The two-variant product, as the unscoped read and the merchant-scoped read serve it.
  const TWO_VARIANTS = [IDS.VARIANT_TWO_A, IDS.VARIANT_TWO_B];
  nock(LOOPBACK, { allowUnmocked: true }).persist()
    .post('/agent/shop/v1/invoke', (body) => isOp('get_pdp_v2')(body) && body.payload?.product_ref?.product_id === IDS.SIG_TWO_VARIANTS)
    .reply(200, () => {
      upstream.push({ to: 'catalog', op: 'get_pdp_v2', product_id: IDS.SIG_TWO_VARIANTS });
      return {
        status: 'success',
        modules: [{ type: 'canonical', data: { pdp_payload: { product: {
          product_id: IDS.SIG_TWO_VARIANTS, merchant_id: IDS.SELLER_CONNECTED, pivota_signature_id: IDS.SIG_TWO_VARIANTS,
          title: 'Night Lotion', brand: { name: 'Shop A' }, price: { current: { amount: 18, currency: 'USD' } }, availability: 'in_stock',
          variants: TWO_VARIANTS.map((id, i) => ({ variant_id: id, sku_id: id, title: `Size ${i + 1}`, price: { current: { amount: 18, currency: 'USD' } } })),
        } } } }],
      };
    });
  const twoVariantProduct = (askedId) => ({
    product_id: askedId, merchant_id: IDS.SELLER_CONNECTED, title: 'Night Lotion', brand: 'Shop A', price: 18, currency: 'USD', in_stock: true,
    pivota_signature_id: IDS.SIG_TWO_VARIANTS,
    variants: TWO_VARIANTS.map((id, i) => ({ variant_id: id, sku_id: id, title: `Size ${i + 1}`, price: 18 })),
  });

  const connectedProduct = (askedId) => ({
    product_id: askedId, merchant_id: IDS.SELLER_CONNECTED, title: 'Day Lotion', brand: 'Shop A', price: 18, currency: 'USD', in_stock: true,
    pivota_signature_id: IDS.SIG_CONNECTED,
    variants: [{ variant_id: IDS.VARIANT_CONNECTED, sku_id: IDS.VARIANT_CONNECTED, title: 'Default', price: 18 }],
  });
  const major = (minor) => (minor / 100).toFixed(2);
  let quoteSeq = 0;
  // A test may say what the next quote requests are answered with (`quoteScript`, in order): each entry is a
  // function of the request body and the answer the fixture would have given, returning `[status, body]`, or an
  // Error (the request then fails with it and gets no answer), or a promise of either. Empty: answered as below.
  const quoteScript = [];
  nock(BACKEND_BASE).persist()
    .post('/agent/shop/v1/invoke')
    .reply((_uri, body) => {
      const operation = body && body.operation;
      const product = (body && body.payload && body.payload.product) || {};
      upstream.push({ to: 'backend', path: '/agent/shop/v1/invoke', body });
      if (operation === 'get_product_detail' && product.merchant_id === IDS.SELLER_CONNECTED
        && [IDS.SOURCE_CONNECTED, IDS.SIG_CONNECTED].includes(product.product_id)) {
        return [200, { status: 'success', product: connectedProduct(product.product_id) }];
      }
      if (operation === 'get_product_detail' && product.merchant_id === IDS.SELLER_CONNECTED
        && [IDS.SOURCE_TWO_VARIANTS, IDS.SIG_TWO_VARIANTS].includes(product.product_id)) {
        return [200, { status: 'success', product: twoVariantProduct(product.product_id) }];
      }
      if (operation === 'offers.resolve') return [200, { offers: [] }];
      return [404, { detail: 'NOT_FOUND' }];
    });
  // The quote: the backend prices the connected merchant's cart at the quantity it is sent, whatever that is.
  nock(BACKEND_BASE).persist()
    .post('/agent/v2/quotes/preview')
    .reply(async (_uri, body) => {
      upstream.push({ to: 'backend', path: '/agent/v2/quotes/preview', body });
      const scripted = quoteScript.shift();
      if (scripted) {
        const out = await scripted(body, () => priceQuote(body));
        if (out instanceof Error) throw out;
        return out;
      }
      return priceQuote(body);
    });
  function priceQuote(body) {
      const refs = body && Array.isArray(body.offer_refs) ? body.offer_refs : [];
      // Priced when the cart is the connected merchant's: named (the native and ACP doors) or, on the UCP door,
      // which names no merchant, by its product.
      const connected = body && (body.merchant_id === IDS.SELLER_CONNECTED
        || (refs.length > 0 && refs.every((ref) => [IDS.SIG_CONNECTED, IDS.SIG_TWO_VARIANTS].includes(ref.product_id))));
      if (!connected) return [422, { detail: { code: 'MERCHANT_NOT_CONNECTED' } }];
      const subtotal = refs.reduce((n, ref) => n + CONNECTED_UNIT_MINOR * Number(ref.quantity), 0);
      quoteSeq += 1;
      return [200, {
        quote_id: `q_connected_${String(quoteSeq).padStart(4, '0')}`, currency: 'USD',
        pricing: { subtotal: major(subtotal), shipping_fee: '0.00', tax: '0.00', total: major(subtotal) },
        line_items: refs.map((ref) => ({ product_id: ref.product_id, variant_id: ref.variant_id, quantity: ref.quantity, unit_price_effective: major(CONNECTED_UNIT_MINOR) })),
        expires_at: '2099-01-01T00:00:00Z',
      }];
  }
  nock(BACKEND_BASE).persist()
    .get('/ops/merchant-purchasability')
    .query(true)
    .reply(200, (uri) => {
      const q = new URL(uri, BACKEND_BASE).searchParams;
      upstream.push({ to: 'gate', domain: q.get('domain'), market: q.get('market') });
      const tier = q.get('market') ? 'purchase' : 'browse_only';
      return { domain: q.get('domain'), market: q.get('market'), tier, human_handoff_tier: tier, enforced: true, sweep_enabled: true };
    });
  // Anything else the gateway asks the backend for is recorded and answered 404.
  nock(BACKEND_BASE).persist()
    .post(() => true)
    .reply((uri, body) => { upstream.push({ to: 'backend', path: uri, body }); return [404, { detail: 'NOT_FOUND' }]; });
  nock(BACKEND_BASE).persist()
    .get(() => true)
    .reply((uri) => { upstream.push({ to: 'backend', path: uri }); return [404, { detail: 'NOT_FOUND' }]; });

  const app = fromRoot('src/server');

  // ONE request = one fresh connection to the app's own listening server, closed after the answer.
  function send(method, doorPath, payloadText, headers) {
    const payload = payloadText === undefined ? null : Buffer.from(payloadText, 'utf8');
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: Number(PORT), method, path: doorPath, agent: false,
        headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), connection: 'close', ...headers },
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
      req.end(payload || undefined);
    });
  }
  /** Run `fn` and report what the gateway sent out while it ran. */
  async function observed(fn) {
    const before = { store: storeCalls.length, upstream: upstream.length };
    const resp = await fn();
    return { resp, store: storeCalls.slice(before.store), upstream: upstream.slice(before.upstream) };
  }
  /** tools/call on a JSON-RPC door. `buyer`: identity headers (BUYER by default; null = no verified buyer). */
  async function call(door, name, args, { buyer = BUYER } = {}) {
    const { resp, store, upstream: sent } = await observed(() => send('POST', door, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), buyer || {}));
    const result = resp.body && resp.body.result;
    const text = result && Array.isArray(result.content) && result.content[0] ? result.content[0].text : null;
    let value = null;
    try { value = JSON.parse(text); } catch { value = null; }
    // `raw` is the response body as the door sent it, byte for byte.
    return { http: resp.status, isError: Boolean(result && result.isError), value, raw: resp.text, store, upstream: sent };
  }
  async function post(door, body, { buyer = BUYER } = {}) {
    const { resp, store, upstream: sent } = await observed(() => send('POST', door, JSON.stringify(body), buyer || {}));
    return { http: resp.status, raw: resp.text, body: resp.body, store, upstream: sent };
  }
  /**
   * One operation on an invoke route (`/agent/shop/v1/invoke`, or its creator alias). The answer is the route's
   * own JSON body. `strict: false` runs the request with strict checkout off (the route reads the switch per call).
   */
  async function invoke(route, operation, payload, { buyer = BUYER, strict = true } = {}) {
    const saved = process.env.AGENT_CHECKOUT_STRICT;
    if (!strict) delete process.env.AGENT_CHECKOUT_STRICT;
    try {
      const { resp, store, upstream: sent } = await observed(() => send('POST', route, JSON.stringify({ operation, payload }), buyer || {}));
      return { http: resp.status, raw: resp.text, body: resp.body, store, upstream: sent };
    } finally {
      if (saved === undefined) delete process.env.AGENT_CHECKOUT_STRICT;
      else process.env.AGENT_CHECKOUT_STRICT = saved;
    }
  }
  const listTools = async (door) => (await post(door, { jsonrpc: '2.0', id: 7, method: 'tools/list' })).body.result.tools;
  /**
   * A signed ACP REST request. `key`: the Idempotency-Key header (undefined = none). `buyer: false` sends no buyer
   * credential; `signed: false` sends a signature that does not verify.
   */
  async function acp(method, subPath, bodyObj, { key, buyer = true, signed = true } = {}) {
    const rawBody = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const ts = String(Date.now());
    const headers = {
      signature: signed ? crypto.createHmac('sha256', ACP_SECRET).update(`${ts}.${rawBody}`).digest('hex') : '0'.repeat(64),
      timestamp: ts,
      ...(buyer ? { 'x-buyer-authorization': `Bearer ${buyerKeys.token}` } : {}),
      ...(key !== undefined ? { 'idempotency-key': key } : {}),
    };
    const { resp, store, upstream: sent } = await observed(() => send(method, `/acp${subPath}`, bodyObj === undefined ? undefined : rawBody, headers));
    return { http: resp.status, raw: resp.text, body: resp.body, store, upstream: sent };
  }
  const resetGate = () => fromRoot('src/services/merchantPurchasabilityClient.js').resetMerchantPurchasabilityClientForTest();
  let server = null;
  const listen = () => new Promise((resolve) => { server = app.listen(Number(PORT), '127.0.0.1', () => resolve()); });
  const close = async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    nock.cleanAll();
  };
  return { app, call, post, acp, invoke, listTools, listen, close, resetGate, storeCalls, upstream, quoteScript, root };
}

const UCP_META = Object.freeze({ 'ucp-agent': { profile: 'https://agent.example/profile' } });
/** Native create/update arguments for the connected merchant's product. `key` undefined = no key member at all. */
const nativeQuote = (quantity, { product = IDS.SIG_CONNECTED, merchant = IDS.SELLER_CONNECTED, variant = IDS.VARIANT_CONNECTED } = {}) => ({
  merchant_id: merchant,
  items: [{ product_id: product, quantity, ...(variant ? { variant_id: variant } : {}) }],
  customer_email: 'buyer@example.test',
});
const withKey = (key, rest) => (key === undefined ? rest : { idempotency_key: key, ...rest });
/** UCP `meta`, with the key member only when one is given. */
const ucpMeta = (key) => (key === undefined ? { ...UCP_META } : { ...UCP_META, 'idempotency-key': key });
const ucpCheckout = (id, quantity, market = 'US') => ({
  line_items: [{ item: { id }, quantity }],
  buyer: { email: 'buyer@example.test' },
  ...(market ? { context: { address_country: market } } : {}),
});
/** An ACP REST create/update body for the connected merchant's product. */
const acpCart = (quantity) => ({ merchant_id: IDS.SELLER_CONNECTED, items: [{ product_id: IDS.SIG_CONNECTED, variant_id: IDS.VARIANT_CONNECTED, quantity }] });

module.exports = {
  IDS, STORE_HOST, STORE_UNIT_MINOR, CONNECTED_UNIT_MINOR, BACKEND_BASE, BUYER, UCP_META,
  mintBuyerKeys, bootDoor, nativeQuote, withKey, ucpMeta, ucpCheckout, acpCart,
};
