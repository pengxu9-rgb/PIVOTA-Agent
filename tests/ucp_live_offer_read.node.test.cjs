'use strict';

// UCP LIVE OFFER READ (get_offers, decision time). The merchant's own `lookup_catalog`, asked for the
// buyer's declared market, decides price and stock for the offers an answer returns.
//
// The fake client answers in the SHAPE live Shopify stores answered on 2026-10-14 (20-store probe:
// `{ result: { content: [{ type: 'text', text: '<json>' }] } }`, prices in minor units, variants keyed
// `gid://shopify/ProductVariant/<n>`), and the real `unwrapToolPayload` unwraps it.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createUcpLiveOfferReader,
  lookupIdsFor,
  numericVariantId,
  readMode,
  STATUS,
} = require('../src/services/ucpLiveOfferRead');
const { makeGetOffers } = require('../src/agentSignals/intelligenceReads');

const RB = 'www.rarebeauty.com';
const BLISS = '43734829564039';
const HOPE = '43734829695111';

function toolResult(payload) {
  return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}

function variant(id, amount, currency, available, title = 'Shade') {
  return { id: `gid://shopify/ProductVariant/${id}`, title, sku: `SKU${id}`, price: { amount, currency }, availability: { available } };
}

/** A store: per country, the variants it answers. `discover` false = no UCP endpoint. */
function fakeClient(store, { discover = true, calls = [] } = {}) {
  return {
    calls,
    async discoverEndpoint(base) {
      calls.push(['discover', base]);
      return discover ? { mcpEndpoint: `${base}/api/ucp/mcp` } : { mcpEndpoint: undefined, status: 404 };
    },
    async lookupCatalog(endpoint, { ids, context }) {
      calls.push(['lookup', endpoint, ids, context]);
      const byCountry = store[context.address_country] || store['*'] || [];
      const wanted = new Set(ids);
      const variants = byCountry.filter((v) => wanted.has(v.id));
      return toolResult({ products: variants.length ? [{ id: 'gid://shopify/Product/1', variants }] : [] });
    },
  };
}

const rareBeauty = {
  US: [variant(BLISS, 2500, 'USD', true, 'Bliss'), variant(HOPE, 2500, 'USD', false, 'Hope')],
  SG: [variant(BLISS, 3700, 'SGD', true, 'Bliss'), variant(HOPE, 3700, 'SGD', true, 'Hope')],
  // A store that does not price for GB answers its own currency, silently (fentybeauty.com, live).
  GB: [variant(BLISS, 2500, 'USD', true, 'Bliss')],
};

function offer(extra = {}) {
  return {
    offer_id: 'of:external_seed:eps_rb:' + BLISS,
    merchant_id: RB,
    price: 25,
    currency: 'USD',
    in_stock: true,
    execution_spec: { merchant_domain: RB, variant_id: BLISS, cart_url: `https://${RB}/cart/${BLISS}:1` },
    ...extra,
  };
}

function reader(store, opts = {}) {
  const calls = [];
  const logs = [];
  const r = createUcpLiveOfferReader({
    ucpClient: fakeClient(store, { calls, discover: opts.discover !== false }),
    mode: opts.mode || 'enforce',
    log: (event, fields) => logs.push({ event, ...fields }),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { r, calls, logs };
}

test('readMode: off unless shadow or enforce is named', () => {
  assert.equal(readMode({}), 'off');
  assert.equal(readMode({ UCP_LIVE_OFFER_READ: 'ENFORCE' }), 'enforce');
  assert.equal(readMode({ UCP_LIVE_OFFER_READ: 'shadow' }), 'shadow');
  assert.equal(readMode({ UCP_LIVE_OFFER_READ: 'yes' }), 'off');
});

test('the merchant price and stock replace the stored ones, and both flags say we asked', async () => {
  const { r, calls } = reader(rareBeauty);
  const { offers, stats } = await r.readOffers([offer({ price: 22 })], { market: 'US', currency: 'USD' });
  const [o] = offers;
  assert.equal(o.live_read.status, STATUS.VERIFIED);
  assert.equal(o.price, 25);
  assert.equal(o.live_read.stored_price, 22);
  assert.equal(o.in_stock, true);
  assert.equal(o.stock_verified, true);
  assert.equal(o.merchant_price_verified, true);
  assert.equal(o.execution_spec.expected_item_total, 25);
  assert.equal(o.execution_spec.expected_currency, 'USD');
  assert.equal(o.execution_spec.expected_quantity, 1);
  assert.ok(Date.parse(o.execution_spec.expected_total_expires_at) > Date.now());
  // Asked for the buyer's country, by variant GID, on the host's discovered endpoint.
  const lookup = calls.find((c) => c[0] === 'lookup');
  assert.deepEqual(lookup[2], [`gid://shopify/ProductVariant/${BLISS}`]);
  assert.deepEqual(lookup[3], { address_country: 'US' });
  assert.equal(stats.price_changed, 1);
});

test('the SG buyer gets the merchant SGD price for each listed shade', async () => {
  const { r } = reader(rareBeauty);
  const o = offer({ currency: 'SGD', price: 30, variants: [{ variant_id: BLISS, title: 'Bliss' }, { variant_id: HOPE, title: 'Hope' }] });
  const { offers } = await r.readOffers([o], { market: 'SG', currency: 'SGD' });
  assert.equal(offers[0].price, 37);
  assert.deepEqual(offers[0].variants.map((v) => [v.price, v.currency, v.in_stock, v.live_verified]), [
    [37, 'SGD', true, true],
    [37, 'SGD', true, true],
  ]);
});

test('a merchant that answers another currency for the market is not a verified price', async () => {
  const { r } = reader(rareBeauty);
  const { offers } = await r.readOffers([offer({ currency: 'GBP', price: 20 })], { market: 'GB', currency: 'GBP' });
  const [o] = offers;
  assert.equal(o.live_read.status, STATUS.CURRENCY_MISMATCH);
  assert.equal(o.live_read.merchant_currency, 'USD');
  assert.equal(o.merchant_price_verified, false);
  assert.equal(o.price, 20, 'the stored price is not replaced by a price in another currency');
  assert.equal(o.currency, 'GBP');
  assert.equal(o.stock_verified, undefined);
});

test('a variant the merchant no longer returns is out of stock, checked', async () => {
  const { r } = reader({ US: [] });
  const { offers } = await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.equal(offers[0].live_read.status, STATUS.VARIANT_GONE);
  assert.equal(offers[0].in_stock, false);
  assert.equal(offers[0].stock_verified, false);
  assert.equal(offers[0].merchant_price_verified, undefined, 'price was not compared');
});

test('a store with no UCP endpoint changes nothing', async () => {
  const { r } = reader(rareBeauty, { discover: false });
  const { offers } = await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.equal(offers[0].live_read.status, STATUS.NOT_UCP);
  assert.equal(offers[0].price, 25);
  assert.equal(offers[0].stock_verified, undefined);
});

test('no declared market: nothing is read', async () => {
  const { r, calls } = reader(rareBeauty);
  const input = [offer()];
  const { offers, stats } = await r.readOffers(input, {});
  assert.equal(offers, input);
  assert.equal(stats, null);
  assert.equal(calls.length, 0);
});

test('shadow reads and logs what enforce would change, and returns the offers untouched', async () => {
  const { r, logs } = reader(rareBeauty, { mode: 'shadow' });
  const input = [offer({ price: 22 })];
  const { offers, stats } = await r.readOffers(input, { market: 'US', currency: 'USD' });
  assert.equal(offers, input);
  assert.equal(stats.mode, 'shadow');
  assert.deepEqual(stats.by_status, { verified: 1 });
  assert.equal(stats.price_changed, 1);
  assert.equal(logs[0].event, 'get_offers_ucp_live_read');
  assert.deepEqual(logs[0].hosts, [{ host: RB, status: 'verified' }]);
});

test('off reads nothing', async () => {
  const { r, calls } = reader(rareBeauty, { mode: 'off' });
  const { stats } = await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.equal(stats, null);
  assert.equal(calls.length, 0);
});

test('discovery is remembered per host; a lookup is coalesced for seconds only', async () => {
  let t = 1_000_000;
  const { r, calls } = reader(rareBeauty, { now: () => t });
  await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.equal(calls.filter((c) => c[0] === 'discover').length, 1);
  assert.equal(calls.filter((c) => c[0] === 'lookup').length, 1);
  t += 31_000;
  await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.equal(calls.filter((c) => c[0] === 'discover').length, 1, 'discovery memo is an hour');
  assert.equal(calls.filter((c) => c[0] === 'lookup').length, 2, 'a price is never served from memo past 30s');
});

test('a slow merchant costs the read, not the answer', async () => {
  const slow = {
    async discoverEndpoint(base) { return { mcpEndpoint: `${base}/api/ucp/mcp` }; },
    lookupCatalog: () => new Promise(() => {}),
  };
  const r = createUcpLiveOfferReader({ ucpClient: slow, mode: 'enforce', budgetMs: 30 });
  const { offers } = await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.equal(offers[0].live_read.status, STATUS.TIMEOUT);
  assert.equal(offers[0].price, 25);
});

test('only the first maxOffers offers are read', async () => {
  const { r, calls } = reader(rareBeauty);
  const many = Array.from({ length: 5 }, () => offer());
  await r.readOffers(many, { market: 'US', currency: 'USD' });
  // Same host+ids coalesce; the bound is on what is ATTEMPTED (3 by default).
  const { stats } = await createUcpLiveOfferReader({ ucpClient: fakeClient(rareBeauty), mode: 'shadow' })
    .readOffers(many, { market: 'US', currency: 'USD' });
  assert.equal(stats.read, 3);
  assert.ok(calls.length >= 1);
});

test('lookup ids: the offer variant first, listed options next, numeric only, at most 10', () => {
  const ids = lookupIdsFor({
    execution_spec: { variant_id: '111111111' },
    variants: [
      { variant_id: '111111111' },
      { variant_id: 'SKU-30ML' },
      ...Array.from({ length: 12 }, (_, i) => ({ variant_id: String(222222200 + i) })),
    ],
  });
  assert.equal(ids[0], '111111111');
  assert.equal(ids.length, 10);
  assert.ok(!ids.includes('SKU-30ML'));
  assert.equal(numericVariantId('gid://shopify/ProductVariant/43734829564039'), '43734829564039');
  assert.equal(numericVariantId('SKU-30ML'), null);
});

// ------------------------------------------------------------- makeGetOffers: where the read is applied

function backendOffer(extra = {}) {
  return { ...offer(), purchase_route: 'affiliate_outbound', affiliate_url: 'https://api.pivota.cc/r?token=x', ...extra };
}

test('get_offers: a declared market answers with the merchant live price and both flags', async () => {
  const { r } = reader(rareBeauty);
  const getOffers = makeGetOffers({
    fetchOffers: async () => ({ offers: [backendOffer({ price: 22 })] }),
    readOffersLive: (offers, ctx) => r.readOffers(offers, ctx),
  });
  const res = await getOffers({ payload: { product_id: 'sig_rb', market: 'US' } });
  const v = res.best_offer.value;
  assert.equal(v.price, 25);
  assert.equal(v.stock_verified, true);
  assert.equal(v.merchant_price_verified, true);
  assert.equal(res.metadata.live_read.by_status.verified, 1);
});

test('get_offers: no market reads nothing and the answer is unchanged', async () => {
  let asked = 0;
  const getOffers = makeGetOffers({
    fetchOffers: async () => ({ offers: [backendOffer({ price: 22 })] }),
    readOffersLive: async (offers) => { asked += 1; return { offers, stats: {} }; },
  });
  const res = await getOffers({ payload: { product_id: 'sig_rb' } });
  assert.equal(asked, 0);
  assert.equal(res.best_offer.value.price, 22);
  assert.equal(res.metadata.live_read, undefined);
});

test('get_offers: a reader that throws costs the live read, never the answer', async () => {
  const getOffers = makeGetOffers({
    fetchOffers: async () => ({ offers: [backendOffer({ price: 22 })] }),
    readOffersLive: async () => { throw new Error('boom'); },
  });
  const res = await getOffers({ payload: { product_id: 'sig_rb', market: 'US' } });
  assert.equal(res.best_offer.value.price, 22);
  assert.deepEqual(res.metadata.live_read, { error: 'live_read_failed' });
});

test('listed shades priced in another currency are never relabelled as the buyer currency', async () => {
  // The offer's own variant is gone, and the store answers its siblings in USD for an SG buyer.
  const { r } = reader({ SG: [variant(HOPE, 2500, 'USD', true, 'Hope')] });
  const o = offer({ currency: 'SGD', price: 30, variants: [{ variant_id: BLISS, title: 'Bliss' }, { variant_id: HOPE, title: 'Hope' }] });
  const { offers } = await r.readOffers([o], { market: 'SG', currency: 'SGD' });
  assert.equal(offers[0].live_read.status, STATUS.VARIANT_GONE);
  const hope = offers[0].variants.find((v) => v.variant_id === HOPE);
  assert.equal(hope.live_verified, undefined, 'a USD answer is not an SGD price');
  assert.equal(hope.price, undefined);
});
