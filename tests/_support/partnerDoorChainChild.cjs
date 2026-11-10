'use strict';

// THE PARTNER PATH ON THE REAL /mcp DOOR, offline, in its own process (PARTNER_DOOR_ONE_PRODUCT_ID is read when
// the tool surface loads): search_catalog -> get_product -> get_offers -> get_product, each call passing ONLY
// ids taken from the previous answer, then the refusals. Prints one JSON line. Driven by
// tests/partner_door_one_product_id_chain.node.test.cjs.
//
// REAL: the /mcp route, the JSON-RPC adapter, the door's view of the surface, the tool surface (schema guard,
// allowlist, sanitizer), the canonical executor, the gateway's kernel dispatcher (invokeCommerceKernelRawUpstream:
// lane choice, and the connected merchant's signature -> platform id translation), the upstream error mapping,
// get_offers (makeGetOffers), and get_pdp_v2 itself for an id nothing below answers (no database: it answers
// MISSING_MERCHANT_CONTEXT).
//
// STUBBED, because no database or backend is reachable here:
//   - the search page (the loopback find_products_multi): three rows shaped as the search lane stamps them
//     (src/server.js: `id` = `product_id`, pivota_signature_id / signature_id, sellable_item_group_id /
//     product_group_id, canonical_product_ref, other_seller_listings);
//   - get_pdp_v2's SERVED answer for the fixture signatures (the canonical module's product, with the implicit
//     default variant pdpBuilder gives a product: `variant_id` = `sku_id` = the product's own id);
//   - get_pdp_v2's refusals, replayed from tests/fixtures/partner_door_pdp_v2_refusals.json, which
//     tests/integration/partner_door_pdp_v2_refusal_shape.test.js records from the real route;
//   - the backend: offers.resolve, and the connected merchant's per-merchant detail, which answers the PLATFORM
//     id it is asked by (as the real backend does) and knows no signature;
//   - the database: tests/_support/partnerDoorFixture.cjs answers the door's group lookup and statements and the
//     translation's statement, and tests/integration/partner_door_group_member_signature_postgres.test.js
//     requires the real lookup and PostgreSQL to agree with it.
//
// Usage: node tests/_support/partnerDoorChainChild.cjs <port>   (env: PARTNER_DOOR_ONE_PRODUCT_ID or nothing)

const nock = require('nock');
const supertest = require('supertest');
const { IDS, fixtureQuery, groupLookup } = require('./partnerDoorFixture.cjs');
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
// THE CONNECTED MERCHANT'S TRANSLATION RUNS FOR REAL. The kernel hop turns (merchant, signature) into the
// merchant's platform id before asking the backend (resolveMerchantScopedSourceProductId), and only with a
// database. Here the real function runs with the fixture as its database: installed before the server loads
// (which binds the function then), with DATABASE_URL present only while the function reads it.
const catalogEntityResolution = require('../../src/services/catalogEntityResolution');
const realTranslate = catalogEntityResolution.resolveMerchantScopedSourceProductId;
catalogEntityResolution.resolveMerchantScopedSourceProductId = (args) => {
  process.env.DATABASE_URL = 'postgres://partner-door.test/none';
  try {
    return realTranslate({ ...args, queryFn: fixtureQuery });
  } finally {
    delete process.env.DATABASE_URL;
  }
};
const app = require('../../src/server');
let merchantCalls = 0;
app._debug.useUcpLiveClientForTest({
  async discoverEndpoint() { merchantCalls += 1; return { status: 404 }; },
  async lookupCatalog() { merchantCalls += 1; return { ok: false, status: 500 }; },
});
// The database stand-in for the door's own lookups. (Guarded so this file also runs, unchanged, on a tree from
// before the flag: that is how the flag-off answers are compared with origin/main's.)
try {
  const partnerDoor = require('../../src/services/partnerDoorOneProductId');
  partnerDoor.usePartnerDoorQueryForTest(fixtureQuery);
  partnerDoor.usePartnerDoorGroupLookupForTest(groupLookup);
} catch (_) {
  /* a tree without the module has no lookup to answer */
}

// The three products search serves, and two more only get_pdp_v2 knows.
const PRODUCTS = {
  [IDS.SIG_MINTED]: { seller: IDS.SELLER_MINTED, group: IDS.GROUP_MINTED, title: 'Calm Serum', brand: 'Brand X', price: 30, seed: IDS.SEED_MINTED },
  [IDS.SIG_MIRROR]: { seller: IDS.SELLER_MIRROR, group: IDS.GROUP_MIRROR, title: 'Barrier Cream', brand: 'Brand Y', price: 22, seed: IDS.SEED_MIRROR },
  [IDS.SIG_CONNECTED]: { seller: IDS.SELLER_CONNECTED, group: IDS.GROUP_CONNECTED, title: 'Day Lotion', brand: 'Shop A', price: 18, seed: IDS.SOURCE_CONNECTED },
};
const SEARCHED = Object.keys(PRODUCTS);
// One product, two sellers: the brand's listing is the group's canonical member; the retailer is in the group.
PRODUCTS[IDS.SIG_SHARED_BRAND] = {
  seller: IDS.SELLER_SHARED_BRAND, group: IDS.GROUP_SHARED, title: 'Eye Gel', brand: 'Brand W', price: 26, seed: IDS.SEED_SHARED_BRAND,
  others: [{ merchant_id: IDS.SELLER_CONNECTED, product_id: IDS.SOURCE_SHARED_RETAILER, pivota_signature_id: IDS.SIG_SHARED_RETAILER }],
};
// The canonical-group fallback: the signature's catalog row is one seller's, and get_pdp_v2 answers another's.
PRODUCTS[IDS.SIG_FALLBACK] = { seller: IDS.SELLER_FALLBACK_CANONICAL, group: null, title: 'Hand Cream', brand: 'Brand V', price: 12, seed: IDS.SEED_FALLBACK };

// A search row as the search lane stamps it: the signature under four names, the group id under two, and the
// product's other sellers each under THEIR own signature.
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
    other_seller_listings: [{ merchant_id: IDS.SELLER_OTHER_CONNECTED, pivota_signature_id: `sig_${'0'.repeat(32)}`, product_key: 'prod::shop-b::1' }],
  };
};

// get_pdp_v2's canonical product for a served signature: the row's seller and the group id, as prod answers,
// the group's members, and the implicit default variant (src/pdpBuilder.js: variant_id = sku_id = product_id).
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
    ...(p.group ? { product_group_id: p.group, sellable_item_group_id: p.group } : {}),
    default_variant_id: signature,
    variants: [{ variant_id: signature, sku_id: signature, title: 'Default', price: { current: { amount: p.price, currency: 'USD' } }, availability: { in_stock: true } }],
    group_members: [{ merchant_id: p.seller, product_id: p.seed, pivota_signature_id: signature }, ...(p.others || [])],
  };
};

const SIG_NO_CONTENT = `sig_${'4'.repeat(32)}`;
const upstream = [];
const isOp = (operation) => (body) => body && body.operation === operation;
nock(LOOPBACK, { allowUnmocked: true }).persist()
  .post('/agent/shop/v1/invoke', isOp('find_products_multi'))
  .reply(200, () => ({ status: 'success', success: true, products: SEARCHED.map(searchRow), total: 3 }));
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
  .post('/agent/shop/v1/invoke', (body) => isOp('get_pdp_v2')(body) && body.payload?.product_ref?.product_id === SIG_NO_CONTENT)
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
// The backend. Per-merchant detail is keyed by the PLATFORM product id and answers that id; it does not know a
// signature (FastAPI's not-found for anything else).
nock(BACKEND).persist()
  .post('/agent/shop/v1/invoke', isOp('get_product_detail'))
  .reply((_uri, body) => {
    const product = body.payload?.product || {};
    upstream.push({ op: 'get_product_detail', merchant_id: product.merchant_id, product_id: product.product_id });
    if (product.merchant_id === IDS.SELLER_CONNECTED && product.product_id === IDS.SOURCE_CONNECTED) {
      const p = PRODUCTS[IDS.SIG_CONNECTED];
      return [200, { status: 'success', product: {
        product_id: IDS.SOURCE_CONNECTED, merchant_id: p.seller, title: p.title, brand: p.brand, price: p.price, currency: 'USD', in_stock: true,
        pivota_signature_id: IDS.SIG_CONNECTED, product_group_id: p.group,
        variants: [{ variant_id: 'v-9001-1', sku_id: 'v-9001-1', title: 'Default', price: p.price }],
      } }];
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
      gp_group_connected_with_seller: await gp({ merchant_id: IDS.SELLER_CONNECTED, product_id: IDS.GROUP_CONNECTED }),
      gp_group_shared: await gp({ product_id: IDS.GROUP_SHARED }),
      gp_group_unsigned: await gp({ product_id: IDS.GROUP_UNSIGNED }),
      gp_group_unknown: await gp({ product_id: IDS.GROUP_UNKNOWN }),
      go_group_minted: await go({ product_id: IDS.GROUP_MINTED }),
      go_group_shared: await go({ product_id: IDS.GROUP_SHARED }),
      go_group_unsigned: await go({ product_id: IDS.GROUP_UNSIGNED }),
      go_group_argument: await go({ product_group_id: IDS.GROUP_MINTED }),
      // A seller that is not the product's.
      gp_wrong_observed_seller: await gp({ merchant_id: IDS.SELLER_OTHER_OBSERVED, product_id: IDS.SIG_MINTED }),
      gp_wrong_connected_seller: await gp({ merchant_id: IDS.SELLER_OTHER_CONNECTED, product_id: IDS.SIG_MINTED }),
      gp_wrong_seller_of_connected: await gp({ merchant_id: IDS.SELLER_OTHER_CONNECTED, product_id: IDS.SIG_CONNECTED }),
      gp_shared_seed_seller_of_connected: await gp({ merchant_id: 'external_seed', product_id: IDS.SIG_CONNECTED }),
      // A seller the product IS known under, though get_pdp_v2 answered another: the signature's own row seller
      // (the canonical-group fallback), and a seller the answered product's group names.
      gp_fallback_row_seller: await gp({ merchant_id: IDS.SELLER_FALLBACK_ROW, product_id: IDS.SIG_FALLBACK }),
      gp_fallback_canonical_seller: await gp({ merchant_id: IDS.SELLER_FALLBACK_CANONICAL, product_id: IDS.SIG_FALLBACK }),
      gp_fallback_shared_seed_seller: await gp({ merchant_id: 'external_seed', product_id: IDS.SIG_FALLBACK }),
      gp_fallback_other_seller: await gp({ merchant_id: IDS.SELLER_OTHER_OBSERVED, product_id: IDS.SIG_FALLBACK }),
      // One fact per code.
      gp_not_servable: await gp({ product_id: IDS.SIG_NOT_SERVABLE }),
      gp_resolved_no_content: await gp({ product_id: SIG_NO_CONTENT }),
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
