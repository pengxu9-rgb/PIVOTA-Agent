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
      // Shopify names each id it does not have (live, rarebeauty.com 2026-10-14).
      const missing = ids.filter((id) => !variants.some((v) => v.id === id));
      return toolResult({
        ucp: { version: '2026-08-25' },
        products: variants.length ? [{ id: 'gid://shopify/Product/1', variants }] : [],
        messages: missing.map((id) => ({ type: 'info', code: 'not_found', content: id })),
      });
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
    execution_spec: { merchant_domain: RB, variant_id: BLISS, cart_url: `https://${RB}/cart/${BLISS}:1?country=US` },
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
  assert.equal(o.execution_spec.expected_item_total, 25, 'the cart is pinned to US, so the total is offered');
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
  const gb = offer({ currency: 'GBP', price: 20 });
  // A total the backend had offered for this offer cannot stand beside "could not be compared".
  gb.execution_spec = { ...gb.execution_spec, expected_item_total: 20, expected_currency: 'GBP', expected_quantity: 1 };
  const { offers } = await r.readOffers([gb], { market: 'GB', currency: 'GBP' });
  const [o] = offers;
  assert.equal(o.live_read.status, STATUS.CURRENCY_MISMATCH);
  assert.equal(o.live_read.merchant_currency, 'USD');
  assert.equal(o.merchant_price_verified, false);
  assert.equal(o.price, 20, 'the stored price is not replaced by a price in another currency');
  assert.equal(o.currency, 'GBP');
  assert.equal(o.stock_verified, undefined);
  assert.equal(o.execution_spec.expected_item_total, undefined, 'a mismatch clears any expected total');
});

test('a variant the merchant says it does not have is out of stock, checked', async () => {
  const { r } = reader({ US: [] });
  const { offers } = await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.equal(offers[0].live_read.status, STATUS.VARIANT_GONE);
  assert.equal(offers[0].in_stock, false);
  assert.equal(offers[0].stock_verified, true, 'we asked, and the merchant said it does not have it');
  assert.equal(offers[0].merchant_price_verified, undefined, 'price was not compared');
});

test('a 200 that carries an error, not the variant, is an error, never gone (review of #2438)', async () => {
  const client = {
    async discoverEndpoint(base) { return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; },
    async lookupCatalog() {
      // An error that ALSO lists the variant: the error wins.
      return toolResult({
        ucp: { status: 'error' },
        products: [{ id: 'gid://shopify/Product/1', variants: [variant(BLISS, 100, 'USD', false)] }],
        messages: [{ type: 'error', code: 'rate_limited', content: 'slow down' }],
      });
    },
  };
  const r = createUcpLiveOfferReader({ ucpClient: client, mode: 'enforce' });
  const { offers } = await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.equal(offers[0].live_read.status, STATUS.ERROR);
  assert.equal(offers[0].in_stock, true, 'stock untouched');
  assert.equal(offers[0].stock_verified, undefined);
});

test('an offer naming no variant of its own is not priced from a listed option (review of #2438)', async () => {
  const { r, calls } = reader(rareBeauty);
  const o = offer({ variants: [{ variant_id: HOPE, title: 'Hope' }] });
  delete o.execution_spec.variant_id;
  const { offers } = await r.readOffers([o], { market: 'US', currency: 'USD' });
  assert.equal(offers[0].live_read.status, STATUS.SKIPPED);
  assert.equal(offers[0].price, 25);
  assert.equal(calls.filter((c) => c[0] === 'lookup').length, 0);
});

test('a verified price beside a cart NOT pinned to the market offers no expected total (review of #2438)', async () => {
  const { r } = reader(rareBeauty);
  const o = offer();
  o.execution_spec = { ...o.execution_spec, cart_url: `https://${RB}/cart/${BLISS}:1`, expected_item_total: 22, expected_currency: 'USD' };
  const { offers } = await r.readOffers([o], { market: 'US', currency: 'USD' });
  assert.equal(offers[0].live_read.status, STATUS.VERIFIED);
  assert.equal(offers[0].execution_spec.expected_item_total, undefined);
  assert.equal(offers[0].execution_spec.expected_currency, undefined);
  assert.equal(offers[0].live_read.expected_total_withheld, 'cart_not_pinned_to_market');
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

test('shadow answers at once, untouched and with no stats, and logs the comparison afterwards (review of #2438)', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const slowFirst = fakeClient(rareBeauty);
  const realLookup = slowFirst.lookupCatalog;
  slowFirst.lookupCatalog = async (...args) => { await gate; return realLookup(...args); };
  const logs = [];
  const r = createUcpLiveOfferReader({ ucpClient: slowFirst, mode: 'shadow', log: (e, f) => logs.push({ event: e, ...f }) });
  const input = [offer({ price: 22 })];
  const { offers, stats } = await r.readOffers(input, { market: 'US', currency: 'USD' });
  assert.equal(offers, input, 'answered while the merchant had not replied yet');
  assert.equal(stats, null, 'nothing about the comparison reaches the answer');
  assert.equal(logs.length, 0);
  release();
  for (let i = 0; i < 5 && !logs.length; i += 1) await new Promise((res) => setImmediate(res));
  assert.equal(logs[0].event, 'get_offers_ucp_live_read');
  assert.equal(logs[0].mode, 'shadow');
  assert.equal(logs[0].price_changed, 1);
  assert.deepEqual(logs[0].hosts, [{ host: RB, status: 'verified' }]);
});

test('a failure to ASK the store is not remembered as "not a UCP store" (review of #2438)', async () => {
  let attempts = 0;
  const client = {
    async discoverEndpoint(base) {
      attempts += 1;
      if (attempts === 1) throw new Error('ETIMEDOUT');
      return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 };
    },
    lookupCatalog: fakeClient(rareBeauty).lookupCatalog,
  };
  const r = createUcpLiveOfferReader({ ucpClient: client, mode: 'enforce' });
  const first = await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.equal(first.offers[0].live_read.status, STATUS.ERROR);
  const second = await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.equal(second.offers[0].live_read.status, STATUS.VERIFIED);
});

test('a store answering discovery 429 or 5xx is asked again next time, not remembered as non-UCP', async () => {
  let attempts = 0;
  const client = {
    async discoverEndpoint(base) {
      attempts += 1;
      return attempts === 1 ? { mcpEndpoint: undefined, status: 503 } : { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 };
    },
    lookupCatalog: fakeClient(rareBeauty).lookupCatalog,
  };
  const r = createUcpLiveOfferReader({ ucpClient: client, mode: 'enforce' });
  assert.equal((await r.readOffers([offer()], { market: 'US', currency: 'USD' })).offers[0].live_read.status, STATUS.ERROR);
  assert.equal((await r.readOffers([offer()], { market: 'US', currency: 'USD' })).offers[0].live_read.status, STATUS.VERIFIED);
});

test('a store that ANSWERED with no UCP endpoint is remembered as non-UCP', async () => {
  let attempts = 0;
  const client = {
    async discoverEndpoint() { attempts += 1; return { mcpEndpoint: undefined, status: 404 }; },
    lookupCatalog: fakeClient(rareBeauty).lookupCatalog,
  };
  const r = createUcpLiveOfferReader({ ucpClient: client, mode: 'enforce' });
  await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  const second = await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.equal(second.offers[0].live_read.status, STATUS.NOT_UCP);
  assert.equal(attempts, 1);
});

test('concurrent identical reads share one discovery and one lookup (review of #2438)', async () => {
  const { r, calls } = reader(rareBeauty);
  await Promise.all(Array.from({ length: 5 }, () => r.readOffers([offer()], { market: 'US', currency: 'USD' })));
  assert.equal(calls.filter((c) => c[0] === 'discover').length, 1);
  assert.equal(calls.filter((c) => c[0] === 'lookup').length, 1);
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
  const { stats, offers } = await createUcpLiveOfferReader({ ucpClient: fakeClient(rareBeauty), mode: 'enforce' })
    .readOffers(many, { market: 'US', currency: 'USD' });
  assert.equal(stats.read, 3);
  assert.equal(offers[3].live_read, undefined, 'the 4th offer is not read');
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

// ------------------------------------------------------------- what reaches the agent (review of #2438)

test('the agent sees live_read, the listing variants and a live observed_at', async () => {
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  const { r } = reader(rareBeauty);
  const o = offer({
    updated_at: '2026-09-01T00:00:00Z',
    price: 22,
    variant_count: 2,
    variants: [{ variant_id: BLISS, title: 'Bliss' }, { variant_id: HOPE, title: 'Hope' }],
  });
  const { offers } = await r.readOffers([o], { market: 'US', currency: 'USD' });
  const sig = offerToSignal(offers[0], { productId: 'sig_rb' });
  assert.equal(sig.value.live_read.status, 'verified');
  assert.equal(sig.value.live_read.stored_price, 22);
  assert.ok(sig.value.live_read.checked_at);
  assert.equal(sig.freshness.observed_at, sig.value.live_read.checked_at, 'observed when the merchant answered, not at crawl time');
  assert.equal(sig.value.variant_count, 2);
  assert.deepEqual(sig.value.variants, [
    { variant_id: BLISS, title: 'Bliss', price: 25, currency: 'USD', in_stock: true, live_verified: true },
    { variant_id: HOPE, title: 'Hope', price: 25, currency: 'USD', in_stock: false, live_verified: true },
  ]);
});

test('the agent sees a currency mismatch named, and no total', async () => {
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  const { r } = reader(rareBeauty);
  const { offers } = await r.readOffers([offer({ currency: 'GBP', price: 20 })], { market: 'GB', currency: 'GBP' });
  const sig = offerToSignal(offers[0], {});
  assert.deepEqual({ status: sig.value.live_read.status, merchant_currency: sig.value.live_read.merchant_currency }, { status: 'currency_mismatch', merchant_currency: 'USD' });
  assert.equal(sig.value.merchant_price_verified, false);
});

test('get_offers: a named variant_id reaches the backend as the product sku_id', async () => {
  let fetched;
  const getOffers = makeGetOffers({
    fetchOffers: async (args) => { fetched = args; return { offers: [backendOffer()] }; },
  });
  await getOffers({ payload: { product_id: 'sig_rb', variant_id: HOPE, market: 'US' } });
  assert.equal(fetched.variant_id, HOPE);
  await getOffers({ payload: { product_id: 'sig_rb' } });
  assert.equal('variant_id' in fetched, false, 'absent, the fetch is unchanged');
});

// ------------------------------------------------------------- review of #2438, round 2

test('get_offers variant_id: only offers whose cart IS that variant; the seed fallback copy is withheld', async () => {
  const seedFallback = backendOffer({ execution_spec: { merchant_domain: 'other.com', variant_id: null }, source: { variant_id: HOPE } });
  const wrongInternal = backendOffer({ merchant_id: 'm_int', execution_spec: {}, internal_checkout_items: [{ variant_id: 'v_first' }] });
  const right = backendOffer({ execution_spec: { merchant_domain: RB, variant_id: HOPE } });
  const getOffers = makeGetOffers({ fetchOffers: async () => ({ offers: [seedFallback, wrongInternal, right] }) });
  const res = await getOffers({ payload: { product_id: 'sig_rb', variant_id: HOPE } });
  assert.equal(res.signals.length, 1);
  assert.equal(res.best_offer.value.execution_spec.variant_id, HOPE);
  assert.equal(res.metadata.withheld_other_variant_count, 2);
  const none = await makeGetOffers({ fetchOffers: async () => ({ offers: [seedFallback] }) })({ payload: { product_id: 'sig_rb', variant_id: HOPE } });
  assert.equal(none.metadata.reason, 'variant_not_offered');
});

test('a listed shade whose stock the merchant did not state is not marked live-verified', async () => {
  const store = { US: [variant(BLISS, 2500, 'USD', true), { ...variant(HOPE, 2500, 'USD', true), availability: {} }] };
  const { r } = reader(store);
  const o = offer({ variants: [{ variant_id: BLISS, title: 'Bliss' }, { variant_id: HOPE, title: 'Hope' }] });
  const { offers } = await r.readOffers([o], { market: 'US', currency: 'USD' });
  const hope = offers[0].variants.find((v) => v.variant_id === HOPE);
  assert.equal(hope.live_verified, undefined);
});

test('get_offers variant_id: the backend marking an offer variant_match exact keeps it with no cart (round 3)', async () => {
  // A sold-out or non-Shopify seller of the variant: no cart, but the backend matched the variant.
  const exactNoCart = backendOffer({ execution_spec: { merchant_domain: 'other.com', variant_id: null }, source: { variant_id: HOPE, variant_match: 'exact' } });
  const fallback = backendOffer({ execution_spec: { merchant_domain: 'third.com', variant_id: null }, source: { variant_id: HOPE, variant_match: 'fallback' } });
  const res = await makeGetOffers({ fetchOffers: async () => ({ offers: [exactNoCart, fallback] }) })({ payload: { product_id: 'sig_rb', variant_id: HOPE } });
  assert.equal(res.signals.length, 1);
  assert.equal(res.metadata.withheld_other_variant_count, 1);
});

test('get_offers variant_id: a cart for ANOTHER shade is withheld even when the backend says exact (round 4)', async () => {
  // An attached seed builds its cart from the operator's attached shade whatever was asked (backend repro).
  const wrongCart = backendOffer({
    execution_spec: { merchant_domain: RB, variant_id: BLISS, cart_url: `https://${RB}/cart/${BLISS}:1` },
    source: { variant_id: HOPE, variant_match: 'exact' },
  });
  const res = await makeGetOffers({ fetchOffers: async () => ({ offers: [wrongCart] }) })({ payload: { product_id: 'sig_rb', variant_id: HOPE } });
  assert.equal(res.signals.length, 0);
  assert.equal(res.metadata.reason, 'variant_not_offered');
});
