'use strict';

// THE PARTNER PATH ON THE REAL /mcp DOOR, offline, in its own process (PARTNER_DOOR_ONE_PRODUCT_ID is read when
// the tool surface loads): search_catalog -> get_product -> get_offers -> get_product, each call passing ONLY
// ids taken from the previous answer, then the refusals. Prints one JSON line. Driven by
// tests/partner_door_one_product_id_chain.node.test.cjs.
//
// REAL: the /mcp route, the JSON-RPC adapter, the tool surface (schema guard, allowlist, sanitizer), the
// canonical executor, the gateway's kernel dispatcher (invokeCommerceKernelRawUpstream: lane choice, the group
// id resolver, the seller check), the upstream error mapping, get_offers (makeGetOffers), and get_pdp_v2 itself
// for an id nothing below answers (no database: it answers MISSING_MERCHANT_CONTEXT).
//
// STUBBED, because no database or backend is reachable here:
//   - the search page (the loopback find_products_multi): three rows shaped as the search lane stamps them
//     (src/server.js: `id` = `product_id`, pivota_signature_id / signature_id, sellable_item_group_id /
//     product_group_id, canonical_product_ref);
//   - get_pdp_v2's SERVED answer for the three fixture signatures (the canonical module's product);
//   - get_pdp_v2's refusals, replayed from tests/fixtures/partner_door_pdp_v2_refusals.json, which
//     tests/integration/partner_door_pdp_v2_refusal_shape.test.js records from the real route;
//   - the backend: offers.resolve, and the per-merchant get_product_detail of the connected merchant;
//   - the database, for the door's two statements only: tests/_support/partnerDoorFixture.cjs answers them, and
//     tests/integration/partner_door_group_member_signature_postgres.test.js requires PostgreSQL to agree.
//
// Usage: node tests/_support/partnerDoorChainChild.cjs <port>   (env: PARTNER_DOOR_ONE_PRODUCT_ID or nothing)

const nock = require('nock');
const supertest = require('supertest');
const { IDS, fixtureQuery } = require('./partnerDoorFixture.cjs');
const REFUSALS = require('../fixtures/partner_door_pdp_v2_refusals.json');

const PORT = String(Number(process.argv[2]) || 4390);
const LOOPBACK = `http://127.0.0.1:${PORT}`;
const BACKEND = 'http://backend.partner-door.test';

Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT,
  AGENT_CHECKOUT_STRICT: '1',
  AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1',
  PIVOTA_API_BASE: BACKEND,
  PIVOTA_API_KEY: 'test-token',
  CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789',
  PAYMENT_WEBHOOK_SECRET: 'strict-webhook-secret-0123456789',
  COMMERCE_READ_CACHE_ENABLED: '0',
  SELF_INVOKE_TIMEOUT_MS: '6000',
  // get_product declares `market` only while the live product read is on. Shadow: no answer is changed by it,
  // and no merchant is asked here (the fixture products name no store; the client below counts any call).
  UCP_LIVE_PRODUCT_READ: 'shadow',
});
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'DATABASE_URL',
  'UCP_LIVE_OFFER_READ', 'GET_OFFERS_VARIANT_ID', 'PRICE_VERIFICATION_LOG']) delete process.env[k];
for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`COMMERCE_MCP_HEARTBEAT_${suffix}`];

const logger = require('../../src/logger');
logger.level = 'silent';
const app = require('../../src/server');
let merchantCalls = 0;
app._debug.useUcpLiveClientForTest({
  async discoverEndpoint() { merchantCalls += 1; return { status: 404 }; },
  async lookupCatalog() { merchantCalls += 1; return { ok: false, status: 500 }; },
});
// The database stand-in, for the door's two statements only. (Guarded so this file also runs, unchanged, on a
// tree from before the flag: that is how the flag-off answers are compared with origin/main's.)
try {
  require('../../src/services/partnerDoorOneProductId').usePartnerDoorQueryForTest(fixtureQuery);
} catch (_) {
  /* a tree without the module has no statement to answer */
}

const PRODUCTS = {
  [IDS.SIG_MINTED]: { seller: IDS.SELLER_MINTED, group: IDS.GROUP_MINTED, title: 'Calm Serum', brand: 'Brand X', price: 30, seed: IDS.SEED_MINTED },
  [IDS.SIG_MIRROR]: { seller: IDS.SELLER_MIRROR, group: IDS.GROUP_MIRROR, title: 'Barrier Cream', brand: 'Brand Y', price: 22, seed: IDS.SEED_MIRROR },
  [IDS.SIG_CONNECTED]: { seller: IDS.SELLER_CONNECTED, group: IDS.GROUP_CONNECTED, title: 'Day Lotion', brand: 'Shop A', price: 18, seed: '9001' },
};

// A search row as the search lane stamps it: the signature under four names, the group id under two.
const searchRow = (signature) => {
  const p = PRODUCTS[signature];
  return {
    id: signature,
    product_id: signature,
    merchant_id: p.seller,
    title: p.title,
    brand: p.brand,
    price: p.price,
    currency: 'USD',
    in_stock: true,
    pivota_signature_id: signature,
    signature_id: signature,
    sellable_item_group_id: p.group,
    product_group_id: p.group,
    canonical_product_ref: { merchant_id: p.seller, product_id: p.seed },
  };
};

// get_pdp_v2's canonical product for a served signature: the row's seller and the group id, as prod answers.
const pdpProduct = (signature) => {
  const p = PRODUCTS[signature];
  return {
    product_id: signature,
    merchant_id: p.seller,
    title: p.title,
    brand: { name: p.brand },
    price: { current: { amount: p.price, currency: 'USD' } },
    availability: { in_stock: true, available_quantity: 3 },
    pivota_signature_id: signature,
    product_group_id: p.group,
    sellable_item_group_id: p.group,
    variants: [{ variant_id: 'v1', title: 'Default', price: { current: { amount: p.price, currency: 'USD' } }, availability: { in_stock: true } }],
  };
};

const upstream = [];
const isOp = (operation) => (body) => body && body.operation === operation;
nock(LOOPBACK, { allowUnmocked: true }).persist()
  .post('/agent/shop/v1/invoke', isOp('find_products_multi'))
  .reply(200, () => ({ status: 'success', success: true, products: Object.keys(PRODUCTS).map(searchRow), total: 3 }));
nock(LOOPBACK, { allowUnmocked: true }).persist()
  .post('/agent/shop/v1/invoke', (body) => isOp('get_pdp_v2')(body) && Boolean(PRODUCTS[body.payload?.product_ref?.product_id]))
  .reply(200, (_uri, body) => {
    upstream.push({ op: 'get_pdp_v2', product_id: body.payload.product_ref.product_id });
    return { status: 'success', modules: [{ type: 'canonical', data: { pdp_payload: { product: pdpProduct(body.payload.product_ref.product_id) } } }] };
  });
nock(LOOPBACK, { allowUnmocked: true }).persist()
  .post('/agent/shop/v1/invoke', (body) => isOp('get_pdp_v2')(body) && body.payload?.product_ref?.product_id === IDS.SIG_NOT_SERVABLE)
  .reply(REFUSALS.not_servable.status, REFUSALS.not_servable.body);
nock(LOOPBACK, { allowUnmocked: true }).persist()
  .post('/agent/shop/v1/invoke', (body) => isOp('get_pdp_v2')(body) && body.payload?.product_ref?.product_id === IDS.SIG_SECOND_OF_SEVERAL)
  .reply(REFUSALS.not_found.status, REFUSALS.not_found.body);
// A product get_pdp_v2 serves with its money withheld (no price it may show this buyer), and a read it cannot
// answer right now (its own bounded-failure body, src/server.js `TEMPORARY_UNAVAILABLE`).
const SIG_UNPRICED = `sig_${'6'.repeat(32)}`;
const SIG_UNAVAILABLE = `sig_${'7'.repeat(32)}`;
nock(LOOPBACK, { allowUnmocked: true }).persist()
  .post('/agent/shop/v1/invoke', (body) => isOp('get_pdp_v2')(body) && body.payload?.product_ref?.product_id === SIG_UNPRICED)
  .reply(200, { status: 'success', modules: [{ type: 'canonical', data: { pdp_payload: { product: { product_id: SIG_UNPRICED, merchant_id: IDS.SELLER_MIRROR, title: 'Night Balm', brand: { name: 'Brand Y' }, price: null } } } }] });
nock(LOOPBACK, { allowUnmocked: true }).persist()
  .post('/agent/shop/v1/invoke', (body) => isOp('get_pdp_v2')(body) && body.payload?.product_ref?.product_id === SIG_UNAVAILABLE)
  .reply(503, { error: 'TEMPORARY_UNAVAILABLE', message: 'Product is temporarily unavailable. Please retry shortly.', reason_code: 'CATALOG_SIGNATURE_RESOLVE_TIMEOUT' });
// The backend. Per-merchant detail: the connected merchant's own row, and FastAPI's not-found for anything else.
nock(BACKEND).persist()
  .post('/agent/shop/v1/invoke', isOp('get_product_detail'))
  .reply((_uri, body) => {
    const product = body.payload?.product || {};
    upstream.push({ op: 'get_product_detail', merchant_id: product.merchant_id, product_id: product.product_id });
    if (product.merchant_id === IDS.SELLER_CONNECTED && product.product_id === IDS.SIG_CONNECTED) {
      const p = PRODUCTS[IDS.SIG_CONNECTED];
      return [200, { status: 'success', product: { product_id: IDS.SIG_CONNECTED, merchant_id: p.seller, title: p.title, brand: p.brand, price: p.price, currency: 'USD', in_stock: true, product_group_id: p.group } }];
    }
    return [404, { detail: 'PRODUCT_NOT_FOUND' }];
  });
nock(BACKEND).persist()
  .post('/agent/shop/v1/invoke', isOp('offers.resolve'))
  .reply(200, (_uri, body) => {
    const product = body.payload?.product || {};
    upstream.push({ op: 'offers.resolve', merchant_id: product.merchant_id ?? null, product_id: product.product_id });
    const p = PRODUCTS[product.product_id];
    if (!p) return { offers: [] };
    return {
      offers: [{ offer_id: `of:${p.seller}:1`, merchant_id: p.seller, price: p.price, currency: 'USD', in_stock: true }],
      product_group_id: p.group,
    };
  });

const rpc = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
async function call(name, args) {
  upstream.length = 0;
  const resp = await supertest(app).post('/mcp').send(rpc(name, args));
  const result = resp.body && resp.body.result;
  const text = result && Array.isArray(result.content) && result.content[0] ? result.content[0].text : null;
  let value = null;
  try { value = JSON.parse(text); } catch (_) { value = null; }
  return { args, http: resp.status, isError: Boolean(result && result.isError), value, upstream: upstream.slice() };
}

(async () => {
  const server = await new Promise((resolve) => { const s = app.listen(Number(PORT), '127.0.0.1', () => resolve(s)); });
  const out = { flag: process.env.PARTNER_DOOR_ONE_PRODUCT_ID || null, chains: [], cases: {} };
  try {
    const tools = await supertest(app).post('/mcp').send({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    out.tools = Object.fromEntries((tools.body.result.tools || [])
      .filter((t) => ['get_product', 'get_offers'].includes(t.name))
      .map((t) => [t.name, { description: t.description, required: t.inputSchema.required || [], properties: Object.keys(t.inputSchema.properties) }]));

    // THE CHAIN. Every argument below is read out of the previous answer; nothing comes from the fixture.
    const search = await call('search_catalog', { query: 'calm serum', market: 'US' });
    out.search = search;
    for (const row of (search.value && search.value.products) || []) {
      const chain = { row };
      chain.get_product = await call('get_product', { merchant_id: row.merchant_id, product_id: row.product_id, market: 'US' });
      const served = chain.get_product.value && chain.get_product.value.product;
      if (served) {
        chain.get_offers = await call('get_offers', { merchant_id: served.merchant_id, product_id: served.product_id, market: 'US' });
        chain.get_product_again = await call('get_product', { merchant_id: served.merchant_id, product_id: served.product_id, market: 'US' });
        chain.get_product_no_merchant = await call('get_product', { product_id: served.product_id, market: 'US' });
      }
      out.chains.push(chain);
    }

    const gp = (args) => call('get_product', { market: 'US', ...args });
    const go = (args) => call('get_offers', { market: 'US', ...args });
    Object.assign(out.cases, {
      // The shared seed seller name beside a seed product's signature: the id pair get_product has always taken.
      gp_shared_seed_seller: await gp({ merchant_id: 'external_seed', product_id: IDS.SIG_MINTED }),
      // A group id where a product id belongs.
      gp_group_minted: await gp({ product_id: IDS.GROUP_MINTED }),
      gp_group_minted_with_seller: await gp({ merchant_id: IDS.SELLER_MINTED, product_id: IDS.GROUP_MINTED }),
      gp_group_several: await gp({ product_id: IDS.GROUP_SEVERAL }),
      gp_group_unknown: await gp({ product_id: IDS.GROUP_UNKNOWN }),
      go_group_minted: await go({ product_id: IDS.GROUP_MINTED }),
      go_group_several: await go({ product_id: IDS.GROUP_SEVERAL }),
      go_group_argument: await go({ product_group_id: IDS.GROUP_MINTED }),
      // A seller that is not the product's.
      gp_wrong_observed_seller: await gp({ merchant_id: IDS.SELLER_OTHER_OBSERVED, product_id: IDS.SIG_MINTED }),
      gp_wrong_connected_seller: await gp({ merchant_id: IDS.SELLER_OTHER_CONNECTED, product_id: IDS.SIG_MINTED }),
      gp_wrong_seller_of_connected: await gp({ merchant_id: IDS.SELLER_OTHER_CONNECTED, product_id: IDS.SIG_CONNECTED }),
      gp_shared_seed_seller_of_connected: await gp({ merchant_id: 'external_seed', product_id: IDS.SIG_CONNECTED }),
      // One fact per code.
      gp_not_servable: await gp({ product_id: IDS.SIG_NOT_SERVABLE }),
      gp_resolved_no_content: await gp({ product_id: IDS.SIG_SECOND_OF_SEVERAL }),
      gp_unknown_signature: await gp({ product_id: `sig_${'f'.repeat(32)}` }),
      gp_unknown_at_connected: await gp({ merchant_id: IDS.SELLER_CONNECTED, product_id: 'no-such-product' }),
      go_unknown_signature: await go({ product_id: `sig_${'f'.repeat(32)}` }),
      gp_unpriced: await gp({ product_id: SIG_UNPRICED }),
      gp_temporarily_unavailable: await gp({ product_id: SIG_UNAVAILABLE }),
    });
    await new Promise((r) => setTimeout(r, 50));
    out.merchant_calls = merchantCalls;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    nock.cleanAll();
  }
  process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
})().catch((e) => {
  process.stderr.write(`${e && e.stack}\n`);
  process.exit(1);
});
