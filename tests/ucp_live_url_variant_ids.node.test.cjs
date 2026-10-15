'use strict';

// URL-SHAPED VARIANT IDS. Stored seed entries carry the JSON-LD offer @id as their `variant_id`
// (`/products/<handle>?variant=N#offer`). The live readers took only a gid or bare digits, so those variants
// were never read (a live-verified offer's options came back with price null, gw#2451's golden cross-test)
// and a variant an agent named by number never matched the backend's URL-form `source.variant_id`.
// The parse follows pivota-backend's `url_named_variant_id` (#2627), case for case.

const test = require('node:test');
const assert = require('node:assert/strict');

const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
require('node:test').after(() => clearInterval(keepAlive));

const { createUcpLiveOfferReader, numericVariantId, urlNamedVariantId, STATUS } = require('../src/services/ucpLiveOfferRead');
const { makeGetOffers } = require('../src/agentSignals/intelligenceReads');
const { applyPdpLiveOverlay, createPdpLiveCache } = require('../src/services/pdpLiveOverlay');
const { buildPdpPayload } = require('../src/pdpBuilder');

const VID = '45253610242298';
const VID_B = '45253610242299';
const jsonldId = (vid) => `/products/sweet-violet-grapefruit-hydrating-mist-1?variant=${vid}#offer`;

// ------------------------------------------------------------- the parse (pivota-backend parity)

test('a URL-shaped id names its variant only when unambiguous (pivota-backend url_named_variant_id cases)', () => {
  const cases = [
    [jsonldId(VID), VID],
    [`https://www.jurlique.com/products/x?variant=${VID}`, VID],
    [`/products/x?variant=${VID}&variant=${VID}`, VID],
    ['/products/x?variant=abc', null],
    ['/products/x?variant=', null],
    [`/products/x?variant=${VID}&variant=${VID_B}`, null],
    ['/products/x', null],
    ['114807', null],
    // A subscription offer of the variant is priced at the plan: it names nothing (review of #2627).
    [`/products/x?variant=${VID}&selling_plan=111#offer`, null],
    [`/products/x?selling_plan=&variant=${VID}`, null],
    // Only the `variant` key, and only as many digits as a bare id may have.
    [`/products/x?product_variant=${VID}`, null],
    ['/products/x?variant=123', null],
    [`/products/x?variant=%EF%BC%94${VID}`, null], // a full-width digit is not ASCII
  ];
  for (const [raw, named] of cases) assert.equal(urlNamedVariantId(raw), named, raw);
});

test('every reader id form resolves to the same Shopify variant', () => {
  for (const form of [VID, `gid://shopify/ProductVariant/${VID}`, jsonldId(VID), `https://b.com/products/x?variant=${VID}`]) {
    assert.equal(numericVariantId(form), VID, form);
  }
  assert.equal(numericVariantId('114807'), '114807', 'a bare id keeps its own rule');
  assert.equal(numericVariantId('not-an-id'), null);
});

// ------------------------------------------------------------- the offer reader reads URL-form options

function toolResult(payload) {
  return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}
function fakeClient(variants, calls = []) {
  return {
    async discoverEndpoint(base) { return { mcpEndpoint: `${base}/api/ucp/mcp` }; },
    async lookupCatalog(endpoint, { ids }) {
      calls.push(ids);
      const wanted = new Set(ids);
      const vs = variants.filter((v) => wanted.has(v.id));
      return toolResult({
        products: vs.length ? [{ id: 'gid://shopify/Product/1', handle: 'sweet-violet-grapefruit-hydrating-mist-1', variants: vs }] : [],
        messages: ids.filter((id) => !vs.some((v) => v.id === id)).map((id) => ({ type: 'info', code: 'not_found', content: id })),
      });
    },
  };
}
const gidVariant = (id, amount, available) => ({ id: `gid://shopify/ProductVariant/${id}`, price: { amount, currency: 'USD' }, availability: { available } });
const HOST = 'www.jurlique.com';

test('an offer whose options are stored as JSON-LD offer ids has those options read live', async () => {
  const calls = [];
  const reader = createUcpLiveOfferReader({ ucpClient: fakeClient([gidVariant(VID, 3100, true), gidVariant(VID_B, 4500, false)], calls), mode: 'enforce' });
  const offer = {
    offer_id: `of:external_seed:eps_j:${jsonldId(VID)}`,
    merchant_id: HOST,
    price: 31,
    currency: 'USD',
    in_stock: true,
    execution_spec: { merchant_domain: HOST, variant_id: VID, cart_url: `https://${HOST}/cart/${VID}:1?country=US` },
    variants: [
      { variant_id: jsonldId(VID), title: '100ml', price: 30, currency: 'USD' },
      { variant_id: jsonldId(VID_B), title: '200ml', price: 44, currency: 'USD' },
    ],
  };
  const { offers } = await reader.readOffers([offer], { market: 'US', currency: 'USD' });
  const [o] = offers;
  assert.equal(o.live_read.status, STATUS.VERIFIED);
  assert.deepEqual(calls[0], [`gid://shopify/ProductVariant/${VID}`, `gid://shopify/ProductVariant/${VID_B}`],
    'the URL-form option is asked for (it was skipped before)');
  assert.deepEqual(o.variants.map((v) => [v.price, v.in_stock, v.live_verified]), [[31, true, true], [45, false, true]]);
});

// ------------------------------------------------------------- a named variant matches the URL-form source id

test('get_offers: a variant named by its number matches the backend\'s URL-form source.variant_id', async () => {
  const backendOffer = {
    offer_id: `of:external_seed:eps_j:${jsonldId(VID)}`,
    merchant_id: HOST,
    price: 31,
    currency: 'USD',
    in_stock: true,
    purchase_route: 'affiliate_outbound',
    affiliate_url: 'https://api.pivota.cc/r?token=t',
    // No cart: the backend's own statement decides (variant_match exact), in the stored URL form.
    source: { type: 'external_seed', seed_id: 'eps_j', variant_id: jsonldId(VID), variant_match: 'exact' },
  };
  const getOffers = makeGetOffers({
    variantIdEnabled: true,
    fetchOffers: async () => ({ offers: [backendOffer] }),
  });
  const named = await getOffers({ product_id: 'sig_x', merchant_id: 'external_seed', variant_id: VID, market: 'US' });
  assert.equal(named.metadata.offer_count, 1, JSON.stringify(named.metadata));
  const other = await getOffers({ product_id: 'sig_x', merchant_id: 'external_seed', variant_id: VID_B, market: 'US' });
  assert.equal(other.metadata.offer_count, 0, 'a different number is still not this offer');
  assert.equal(other.metadata.reason, 'variant_not_offered');
  // A cart decides when there is one: a cart on another variant is never the named one, whatever the source says.
  const carted = makeGetOffers({
    variantIdEnabled: true,
    fetchOffers: async () => ({ offers: [{ ...backendOffer, execution_spec: { variant_id: VID_B, cart_url: `https://${HOST}/cart/${VID_B}:1` } }] }),
  });
  assert.equal((await carted({ product_id: 'sig_x', merchant_id: 'external_seed', variant_id: VID, market: 'US' })).metadata.offer_count, 0);
});

// ------------------------------------------------------------- the PDP overlay patches URL-form variants

test('PDP overlay: a card variant stored as a JSON-LD offer id gets the merchant\'s live price', () => {
  const product = {
    product_id: 'ext_j', merchant_id: 'merch_obs_j', source: 'external_seed', title: 'Mist',
    image_url: 'https://cdn.example/m.jpg', price: { amount: 30, currency: 'USD' }, currency: 'USD',
    destination_url: `https://${HOST}/products/sweet-violet-grapefruit-hydrating-mist-1`,
    default_variant_id: jsonldId(VID),
    variants: [{ variant_id: jsonldId(VID), title: '100ml', options: [{ name: 'Size', value: '100ml' }], price: { amount: 30, currency: 'USD' }, in_stock: true }],
  };
  const pdp = buildPdpPayload({ product, relatedProducts: [], entryPoint: 'agent' });
  const page = { modules: [{ type: 'canonical', data: { pdp_payload: pdp } }] };
  const cache = createPdpLiveCache();
  cache.record({
    status: STATUS.VERIFIED, host: HOST, country: 'US', currency: 'USD', askedIds: [VID],
    live: new Map([[VID, { amount: 31, currency: 'USD', available: true, handle: 'sweet-violet-grapefruit-hydrating-mist-1' }]]),
    notFound: new Set(),
  });
  const out = applyPdpLiveOverlay(page, { market: 'US', cache });
  assert.ok(out, 'the URL-form variant is recognised');
  const card = out.payload.modules[0].data.pdp_payload.product;
  assert.equal(card.price.current.amount, 31);
  assert.equal(card.live_read.status, STATUS.VERIFIED);
});
