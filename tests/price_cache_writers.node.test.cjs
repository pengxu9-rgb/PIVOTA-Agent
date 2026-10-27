'use strict';

// EVERY WRITER OF THE SHARED VERIFIED-PRICE CACHE, through the REAL producer (feedback: a guard is tested against
// what the producer emits): the get_offers, get_product / PDP and search UCP readers over a fake merchant UCP
// client, the search `.json` overlay over a fake storefront fetch, and the lookup core's politeness gate. Each
// writes into the real cache (src/services/priceCache.js) over the fake Firestore (tests/_support/fakeFirestore.cjs),
// so the currency rule and the doc shape are the cache's own. The read-mode consumer (the `.json` overlay) and how
// the price line counts its answers are here too. No merchant and no Firestore is contacted.

const test = require('node:test');
const assert = require('node:assert/strict');

// The readers' deadline timers are unref'd; keep the loop alive for the file.
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
test.after(() => clearInterval(keepAlive));

const pc = require('../src/services/priceCache');
const { createFirestorePriceCacheStore } = require('../src/services/priceCacheStore');
const { createFakeFirestore } = require('./_support/fakeFirestore.cjs');
const {
  createUcpLiveOfferReader, createUcpLiveProductReader, createUcpLiveSearchReader, createLookupCore,
} = require('../src/services/ucpLiveOfferRead');
const { overlayLiveMerchantSearchPrices, HOST_BACKOFF_FLAG } = require('../src/services/liveMerchantSearchPrice');
const storefrontProductPage = require('../src/services/storefrontProductPage');
const pv = require('../src/observability/priceVerificationLog');

const RB = 'www.rarebeauty.com';
const BLISS = '43734829564039';
const HOPE = '43734829695111';
const GONE = '43734829000001';
const HANDLE = 'soft-pinch-liquid-blush';

function toolResult(payload) {
  return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}
function variant(id, amount, currency, available) {
  return { id: `gid://shopify/ProductVariant/${id}`, price: { amount, currency }, availability: { available } };
}
/** A merchant UCP store: per country, the variants it answers; it names each id it does not have. */
function fakeClient(store, calls = []) {
  return {
    calls,
    async discoverEndpoint(base) {
      calls.push(['discover', base]);
      if (store.discoverStatus) return { mcpEndpoint: undefined, status: store.discoverStatus };
      return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 };
    },
    async lookupCatalog(endpoint, { ids, context }) {
      calls.push(['lookup', ids, context.address_country]);
      if (store.lookupStatus) return { ok: false, status: store.lookupStatus };
      const variants = (store[context.address_country] || []).filter((v) => ids.includes(v.id));
      const missing = ids.filter((id) => !variants.some((v) => v.id === id));
      return toolResult({
        products: variants.length ? [{ id: 'gid://shopify/Product/1', handle: store.handle || HANDLE, variants }] : [],
        messages: missing.map((id) => ({ type: 'info', code: 'not_found', content: id })),
      });
    },
  };
}
const rareBeauty = {
  US: [variant(BLISS, 2500, 'USD', true), variant(HOPE, 2400, 'USD', false)],
  // A store that does not price for GB answers its own currency, silently.
  GB: [variant(BLISS, 2500, 'USD', true)],
};

/** The real cache over a fake Firestore, and the API object the server hands the writers. */
function cacheHarness({ read = false } = {}) {
  const fake = createFakeFirestore();
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000 });
  const cache = pc.createPriceCache({ store, read: () => read });
  const api = {
    recordVerifiedPrice: (e) => cache.recordVerifiedPrice(e),
    recordVariantGone: (e) => cache.recordVariantGone(e),
    lookupRecentPrices: (keys, o) => cache.lookup(keys, o),
    priceCacheReadEnabled: () => read,
    noteHostRefusal: (h, s) => cache.noteHostRefusal(h, s),
  };
  /** The docs written, as plain objects, after a flush. */
  async function written() {
    await store.flush();
    return [...fake.docs.entries()].map(([path, d]) => ({ path, ...d, read_at: d.read_at && d.read_at.toMillis(), expire_at: d.expire_at && d.expire_at.toMillis() }));
  }
  return { fake, store, cache, api, written };
}
const prices = (docs) => docs.filter((d) => d.path.startsWith('verified_prices/'))
  .map((d) => `${d.host}|${d.market}|${d.variant_id}|${d.currency}|${d.status}|${d.amount}|${d.source}|${d.writer}`).sort();

// ------------------------------------------------------------------------------------------- get_offers

function offer(extra = {}) {
  return {
    offer_id: `of:external_seed:eps_rb:${BLISS}`, merchant_id: RB, price: 25, currency: 'USD', in_stock: true,
    execution_spec: { merchant_domain: RB, variant_id: BLISS, cart_url: `https://${RB}/cart/${BLISS}:1?country=US` },
    ...extra,
  };
}

test('get_offers: a verified read records the offer\'s variant and every option the lookup answered (enforce and shadow)', async () => {
  for (const mode of ['enforce', 'shadow']) {
    const h = cacheHarness();
    const r = createUcpLiveOfferReader({ ucpClient: fakeClient(rareBeauty), mode, priceCache: h.api });
    const out = await r.readOffers([offer({ variants: [{ variant_id: BLISS }, { variant_id: HOPE }] })], { market: 'US', currency: 'USD' });
    if (mode === 'shadow') await new Promise((res) => setTimeout(res, 20));
    assert.equal(out.offers.length, 1);
    assert.deepEqual(prices(await h.written()), [
      `rarebeauty.com|US|${BLISS}|USD|verified|25.00|merchant_ucp|offers`,
      `rarebeauty.com|US|${HOPE}|USD|verified|24.00|merchant_ucp|offers`,
    ], mode);
    const bliss = (await h.written()).find((d) => d.variant_id === BLISS);
    assert.equal(bliss.available, true);
    assert.equal(bliss.handle, HANDLE);
    assert.equal(bliss.expire_at - bliss.read_at, 60 * 60 * 1000);
  }
});

test('get_offers: a currency mismatch, no declared market, or a skipped read writes nothing; variant_gone writes a tombstone', async () => {
  const h = cacheHarness();
  const r = createUcpLiveOfferReader({ ucpClient: fakeClient(rareBeauty), mode: 'enforce', priceCache: h.api });
  await r.readOffers([offer()], { market: 'GB', currency: 'GBP' });
  await r.readOffers([offer()], {});
  await r.readOffers([offer({ execution_spec: {}, merchant_id: 'merch_x' })], { market: 'US', currency: 'USD' });
  assert.deepEqual(prices(await h.written()), []);
  await r.readOffers([offer({ execution_spec: { merchant_domain: RB, variant_id: GONE } })], { market: 'US', currency: 'USD' });
  const docs = await h.written();
  assert.deepEqual(prices(docs), [`rarebeauty.com|US|${GONE}|USD|variant_gone|null|merchant_ucp|offers`]);
  assert.equal(docs[0].expire_at - docs[0].read_at, 10 * 60 * 1000);
  assert.equal(docs[0].available, false);
});

test('THE MERCHANT\'S currency is what is recorded: an option (get_offers) or a card (search) answered in another currency is never written', async () => {
  // One lookup, mixed currencies: the offer's own variant in USD (a verified read), an option in CAD.
  const mixed = { US: [variant(BLISS, 2500, 'USD', true), variant(HOPE, 3300, 'CAD', true)] };
  const h = cacheHarness();
  const r = createUcpLiveOfferReader({ ucpClient: fakeClient(mixed), mode: 'enforce', priceCache: h.api });
  const out = await r.readOffers([offer({ variants: [{ variant_id: BLISS }, { variant_id: HOPE }] })], { market: 'US', currency: 'USD' });
  assert.equal(out.offers[0].live_read.status, 'verified');
  assert.deepEqual(prices(await h.written()), [`rarebeauty.com|US|${BLISS}|USD|verified|25.00|merchant_ucp|offers`]);

  const s = cacheHarness();
  const sr = createUcpLiveSearchReader({ ucpClient: fakeClient(mixed), mode: 'enforce', priceCache: s.api });
  const reads = await sr.readCards([card(BLISS), card(HOPE)], { market: 'US' });
  assert.equal(reads.get(1).status, 'currency_mismatch');
  assert.deepEqual(prices(await s.written()), [`rarebeauty.com|US|${BLISS}|USD|verified|25.00|merchant_ucp|search`]);

  const p = cacheHarness();
  const pr = createUcpLiveProductReader({ ucpClient: fakeClient(mixed), mode: 'enforce', priceCache: p.api });
  await pr.readProduct(pdp({ variants: [{ variant_id: BLISS }, { variant_id: HOPE }] }), { market: 'US' });
  assert.deepEqual(prices(await p.written()), [], 'a product read answered in two currencies is a mismatch: nothing written');
});

test('get_offers: without a priceCache dep the reader is exactly as before (no record, same answer)', async () => {
  const h = cacheHarness();
  const withCache = createUcpLiveOfferReader({ ucpClient: fakeClient(rareBeauty), mode: 'enforce', priceCache: h.api, now: () => 1e12 });
  const without = createUcpLiveOfferReader({ ucpClient: fakeClient(rareBeauty), mode: 'enforce', now: () => 1e12 });
  const a = await withCache.readOffers([offer()], { market: 'US', currency: 'USD' });
  const b = await without.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.deepEqual(a, b);
});

// ----------------------------------------------------------------------------------- get_product / PDP

function pdp(extra = {}) {
  return {
    product: {
      product_id: 'sig_rb', destination_url: `https://${RB}/products/${HANDLE}`, default_variant_id: BLISS, currency: 'USD',
      variants: [{ variant_id: BLISS, price: { current: { amount: 22, currency: 'USD' } } }, { variant_id: HOPE }, { variant_id: GONE }],
      ...extra,
    },
  };
}

test('get_product / PDP: every variant the read answered is recorded (writer product, or pdp); a not_found id is a tombstone', async () => {
  for (const writer of [undefined, 'pdp']) {
    const h = cacheHarness();
    const r = createUcpLiveProductReader({ ucpClient: fakeClient(rareBeauty), mode: 'enforce', priceCache: h.api, ...(writer ? { priceCacheWriter: writer } : {}) });
    await r.readProduct(pdp(), { market: 'US' });
    const w = writer || 'product';
    assert.deepEqual(prices(await h.written()), [
      `rarebeauty.com|US|${GONE}|USD|variant_gone|null|merchant_ucp|${w}`,
      `rarebeauty.com|US|${BLISS}|USD|verified|25.00|merchant_ucp|${w}`,
      `rarebeauty.com|US|${HOPE}|USD|verified|24.00|merchant_ucp|${w}`,
    ].sort());
  }
});

test('get_product / PDP: the PDP refresh path (readLive, as pdp_live_read calls it) records too; no market, none', async () => {
  const h = cacheHarness();
  const r = createUcpLiveProductReader({ ucpClient: fakeClient(rareBeauty), mode: 'shadow', priceCache: h.api, priceCacheWriter: 'pdp' });
  await r.readLive(pdp().product, {});
  assert.deepEqual(prices(await h.written()), [], 'no declared market: no read, no write');
  await r.readLive(pdp().product, { market: 'GB' });
  assert.deepEqual(prices(await h.written()), [], 'GB answered in USD: a currency mismatch, nothing written');
  await r.readLive(pdp().product, { market: 'US' });
  assert.equal(prices(await h.written()).length, 3);
});

// ----------------------------------------------------------------------------------------- search (UCP)

function card(vid, extra = {}) {
  return { product_id: `sig_${vid}`, price: 22, currency: 'USD', source_variant_id: vid, destination_url: `https://${RB}/products/${HANDLE}`, ...extra };
}

test('search UCP read: a verified card is recorded (enforce and shadow); another product\'s answer is not; a not_found id is a tombstone', async () => {
  for (const mode of ['enforce', 'shadow']) {
    const h = cacheHarness();
    const r = createUcpLiveSearchReader({ ucpClient: fakeClient(rareBeauty), mode, priceCache: h.api });
    const cards = [card(BLISS), card(HOPE, { destination_url: `https://${RB}/products/another-product` }), card(GONE)];
    await r.readCards(cards, { market: 'US' });
    if (mode === 'shadow') await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(prices(await h.written()), [
      `rarebeauty.com|US|${GONE}|USD|variant_gone|null|merchant_ucp|search`,
      `rarebeauty.com|US|${BLISS}|USD|verified|25.00|merchant_ucp|search`,
    ].sort(), mode);
  }
});

// ---------------------------------------------------------------------- the lookup core's politeness gate

test('lookup core: a gate refusal sends nothing and fails as host_busy (the readers\' existing "not checked")', async () => {
  const calls = [];
  const asked = [];
  const core = createLookupCore({
    ucpClient: fakeClient(rareBeauty, calls), now: () => Date.now(), endpointTtlMs: 60000, memoTtlMs: 30000,
    readClass: 'offers', hostGate: { admit: (host, klass) => { asked.push([host, klass]); return 'host_budget'; }, noteRefusal() {} },
  });
  const r = createUcpLiveOfferReader({ ucpClient: fakeClient(rareBeauty, calls), mode: 'enforce', core });
  const out = await r.readOffers([offer()], { market: 'US', currency: 'USD' });
  assert.equal(out.offers[0].live_read.status, 'error');
  assert.deepEqual(asked, [[RB, 'offers']]);
  assert.equal(calls.filter((c) => c[0] === 'lookup').length, 0, 'the lookup was never sent');
  const p = createUcpLiveProductReader({ ucpClient: fakeClient(rareBeauty, calls), mode: 'enforce', core });
  const prod = await p.readProduct(pdp(), { market: 'US' });
  assert.equal(prod.product.live_read.reason, 'host_busy', 'the PDP releases its claim on host_busy');
});

test('lookup core: a memoized lookup is not asked again; an admitting gate changes nothing', async () => {
  const asked = [];
  const calls = [];
  const core = createLookupCore({
    ucpClient: fakeClient(rareBeauty, calls), now: () => Date.now(), endpointTtlMs: 60000, memoTtlMs: 30000,
    readClass: 'search', hostGate: { admit: (host, klass) => { asked.push(klass); return null; }, noteRefusal() {} },
  });
  const ep = await core.endpointFor(RB);
  await Promise.all([core.lookup(RB, ep, [BLISS], 'US'), core.lookup(RB, ep, [BLISS], 'US')]);
  assert.deepEqual(asked, ['search']);
  assert.equal(calls.filter((c) => c[0] === 'lookup').length, 1);
});

test('lookup core: a 429 / 5xx lookup and a 429 / 5xx discovery are reported to the gate; a 404 discovery is not', async () => {
  for (const [store, want] of [
    [{ ...rareBeauty, lookupStatus: 429 }, [[RB, 429]]],
    [{ ...rareBeauty, lookupStatus: 503 }, [[RB, 503]]],
    [{ ...rareBeauty, lookupStatus: 400 }, []],
    [{ ...rareBeauty, discoverStatus: 503 }, [[RB, 503]]],
    [{ ...rareBeauty, discoverStatus: 429 }, [[RB, 429]]],
    [{ ...rareBeauty, discoverStatus: 404 }, []],
  ]) {
    const noted = [];
    const core = createLookupCore({
      ucpClient: fakeClient(store), now: () => Date.now(), endpointTtlMs: 60000, memoTtlMs: 30000,
      hostGate: { admit: () => null, noteRefusal: (h, s) => noted.push([h, s]) },
    });
    const r = createUcpLiveOfferReader({ ucpClient: fakeClient(store), mode: 'enforce', core });
    await r.readOffers([offer()], { market: 'US', currency: 'USD' });
    assert.deepEqual(noted, want, JSON.stringify(store.lookupStatus || store.discoverStatus));
  }
});

// ------------------------------------------------------------------------------ search `.json` overlay

let seq = 0;
function jsonCards(n, extra = {}) {
  seq += 1;
  return Array.from({ length: n }, (_, i) => ({
    product_id: `sig_j${seq}_${i}`, price: 28, currency: 'USD', source_variant_id: String(9000 + i),
    destination_url: `https://shop-${seq}.example.com/products/p-${i}`, ...extra,
  }));
}
function storefront({ status = 200, currency = 'USD', price = '30.00' } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const i = Number(new URL(url).pathname.match(/p-(\d+)/)[1]);
    if (status !== 200) return { ok: false, status, headers: new Map() };
    return {
      ok: true, status: 200,
      json: async () => ({ product: { variants: [{ id: 9000 + i, price, price_currency: currency, compare_at_price: '40.00', available: true }, { id: 8000 + i, price: '35.00', price_currency: currency }] } }),
    };
  };
  return { calls, fetchImpl };
}

test('.json overlay: a fresh verified read records the card\'s variant (merchant_storefront, writer search, its handle)', async () => {
  const h = cacheHarness();
  const products = jsonCards(2);
  const out = await overlayLiveMerchantSearchPrices({ products }, { fetchImpl: storefront().fetchImpl, env: {}, market: 'US', priceCache: h.api });
  assert.equal(out.metadata.live_merchant_price.verified_count, 2);
  const docs = await h.written();
  assert.deepEqual(prices(docs), [
    `shop-${seq}.example.com|US|9000|USD|verified|30.00|merchant_storefront|search`,
    `shop-${seq}.example.com|US|9001|USD|verified|30.00|merchant_storefront|search`,
  ]);
  assert.equal(docs[0].compare_at, '40.00');
  assert.equal(docs[0].available, true);
  assert.deepEqual(docs.map((d) => d.handle).sort(), ['p-0', 'p-1']);
  assert.equal('shared_cache_hit_count' in out.metadata.live_merchant_price, false, 'write mode adds nothing to the answer');
});

test('.json overlay: a card with no variant id is recorded for every variant only when all agree (each variant priced alike)', async () => {
  const h = cacheHarness();
  const products = jsonCards(1, { source_variant_id: undefined });
  const agree = async () => ({ ok: true, status: 200, json: async () => ({ product: { variants: [{ id: 1, price: '30.00', price_currency: 'USD' }, { id: 2, price: '30.00', price_currency: 'USD' }] } }) });
  await overlayLiveMerchantSearchPrices({ products }, { fetchImpl: agree, env: {}, market: 'US', priceCache: h.api });
  assert.deepEqual(prices(await h.written()).map((p) => p.split('|')[2]), ['1', '2']);
});

test('.json overlay: nothing is recorded without a declared market, in another currency, on a failed read, or from this instance\'s cache', async () => {
  const h = cacheHarness();
  const a = jsonCards(1);
  await overlayLiveMerchantSearchPrices({ products: a }, { fetchImpl: storefront().fetchImpl, env: {}, priceCache: h.api });
  assert.deepEqual(prices(await h.written()), [], 'no market: verified on the page, never recorded');
  await overlayLiveMerchantSearchPrices({ products: a }, { fetchImpl: storefront().fetchImpl, env: {}, market: 'US', priceCache: h.api });
  assert.deepEqual(prices(await h.written()), [], 'served from the per-instance cache: already recorded when read');
  await overlayLiveMerchantSearchPrices({ products: jsonCards(1) }, { fetchImpl: storefront().fetchImpl, env: {}, market: 'GB', priceCache: h.api });
  assert.deepEqual(prices(await h.written()), [], 'a USD answer is never a GB price');
  await overlayLiveMerchantSearchPrices({ products: jsonCards(1, { currency: 'EUR' }) }, { fetchImpl: storefront().fetchImpl, env: {}, market: 'FR', priceCache: h.api });
  assert.deepEqual(prices(await h.written()), [], 'the card is EUR, the store answered USD: not verified');
  await overlayLiveMerchantSearchPrices({ products: jsonCards(1) }, { fetchImpl: storefront({ status: 503 }).fetchImpl, env: {}, market: 'US', priceCache: h.api });
  assert.deepEqual(prices(await h.written()), []);
});

test('.json overlay: a 429 / 430 / 5xx is reported to the fleet backoff whatever SEARCH_OVERLAY_HOST_BACKOFF says; a 404 is not', async () => {
  for (const [status, env, want] of [[429, {}, 1], [430, { [HOST_BACKOFF_FLAG]: 'on' }, 1], [502, {}, 1], [404, {}, 0]]) {
    const noted = [];
    const products = jsonCards(1);
    await overlayLiveMerchantSearchPrices({ products }, {
      fetchImpl: storefront({ status }).fetchImpl, env, market: 'US',
      hostGate: { admit: () => null, noteRefusal: (h, s) => noted.push([h, s]) },
    });
    assert.equal(noted.length, want, String(status));
    if (want) assert.deepEqual(noted[0], [`shop-${seq}.example.com`, status]);
  }
});

test('.json overlay: a read the gate refuses is not sent, not counted as attempted, and keeps the stored price (host_budget)', async () => {
  const sf = storefront();
  const asked = [];
  const products = jsonCards(2);
  const out = await overlayLiveMerchantSearchPrices({ products }, {
    fetchImpl: sf.fetchImpl, env: {}, market: 'US',
    hostGate: { admit: (host, klass) => { asked.push([host, klass]); return asked.length === 1 ? 'host_budget' : null; }, noteRefusal() {} },
  });
  const m = out.metadata.live_merchant_price;
  assert.deepEqual(asked.map((a) => a[1]), ['search', 'search']);
  assert.equal(sf.calls.length, 1);
  assert.equal(m.fetch_attempt_count, 1);
  assert.deepEqual(m.failure_reasons, { host_budget: 1 });
  assert.equal(out.products.filter((p) => p.price_source === 'catalog_offer').length, 1);
  assert.equal(out.products.find((p) => p.price_source === 'catalog_offer').price, 28);
});

// ------------------------------------------------------------------------- READ MODE: the one consumer

async function seed(h, entry) {
  h.cache.recordVerifiedPrice({ source: 'merchant_storefront', writer: 'search', market: 'US', currency: 'USD', ...entry });
  await h.store.flush();
  h.cache._l1.clear(); // as another instance: only the store knows
}

test('READ MODE: a card the fleet verified within 15 min is served from the cache, before any read, dated when the merchant answered', async () => {
  const h = cacheHarness({ read: true });
  const products = jsonCards(2);
  const host = `shop-${seq}.example.com`;
  const readAt = Date.now() - 5 * 60 * 1000;
  await seed(h, { host, variant_id: '9000', amount: 26, handle: 'p-0', read_at: readAt });
  const sf = storefront();
  const out = await overlayLiveMerchantSearchPrices({ products }, { fetchImpl: sf.fetchImpl, env: {}, market: 'US', priceCache: h.api });
  assert.deepEqual(sf.calls.map((u) => new URL(u).pathname), ['/products/p-1.json'], 'the cached card is not read');
  assert.deepEqual(
    { price: out.products[0].price, price_amount: out.products[0].price_amount, currency: out.products[0].currency, src: out.products[0].price_source, asOf: out.products[0].price_as_of },
    { price: 26, price_amount: 26, currency: 'USD', src: 'merchant_live', asOf: new Date(readAt).toISOString() },
  );
  assert.equal(out.products[1].price, 30);
  const m = out.metadata.live_merchant_price;
  assert.equal(m.shared_cache_hit_count, 1);
  assert.equal(m.verified_count, 2);
  assert.equal(m.eligible_count, 2);
  assert.equal(m.fetch_attempt_count, 1);
  assert.equal(m.drift_count, 2);
});

test('READ MODE: not served from the cache: another product\'s handle, older than 15 min, a tombstone, another currency, no market', async () => {
  const h = cacheHarness({ read: true });
  const products = jsonCards(4);
  const host = `shop-${seq}.example.com`;
  await seed(h, { host, variant_id: '9000', amount: 26, handle: 'another-page' });
  await seed(h, { host, variant_id: '9001', amount: 26, handle: 'p-1', read_at: Date.now() - 16 * 60 * 1000 });
  h.cache.recordVariantGone({ host, market: 'US', variant_id: '9002', handle: 'p-2', source: 'merchant_ucp', writer: 'product' });
  await h.store.flush();
  h.cache._l1.clear();
  await seed(h, { host, variant_id: '9003', amount: 26 });
  const out = await overlayLiveMerchantSearchPrices({ products }, { fetchImpl: storefront().fetchImpl, env: {}, market: 'US', priceCache: h.api });
  assert.equal(out.metadata.live_merchant_price.shared_cache_hit_count, 0);
  assert.deepEqual(out.products.map((p) => p.price), [30, 30, 30, 30], 'every card read from the store itself');
  const none = await overlayLiveMerchantSearchPrices({ products: jsonCards(1) }, { fetchImpl: storefront().fetchImpl, env: {}, priceCache: h.api });
  assert.equal(none.metadata.live_merchant_price.shared_cache_hit_count, 0);
});

test('R11 READ MODE: a page with no declared market is never served from the cache, even with a US/USD answer there', async () => {
  const h = cacheHarness({ read: true });
  const products = jsonCards(1);
  const host = `shop-${seq}.example.com`;
  await seed(h, { host, variant_id: '9000', amount: 26, handle: 'p-0' });
  const us = await overlayLiveMerchantSearchPrices({ products }, { fetchImpl: storefront().fetchImpl, env: {}, market: 'US', priceCache: h.api });
  assert.equal(us.metadata.live_merchant_price.shared_cache_hit_count, 1, 'the doc IS served to a page that declared US');
  const sf = storefront();
  for (const market of [undefined, '', 'USA']) {
    const out = await overlayLiveMerchantSearchPrices({ products: products.map((c) => ({ ...c, product_id: `${c.product_id}_${market}` })) }, { fetchImpl: sf.fetchImpl, env: {}, market, priceCache: h.api });
    assert.equal(out.metadata.live_merchant_price.shared_cache_hit_count, 0, String(market));
    assert.equal(out.products[0].price, 30, `${market}: read from the store, never the US cache answer`);
  }
  assert.equal(sf.calls.length, 1, 'read once, then from this instance\'s own fresh read');
});

test('READ MODE: this instance\'s fresh read and the gone memo come first; a failing store is a miss (fail open)', async () => {
  const h = cacheHarness({ read: true });
  const products = jsonCards(2);
  const host = `shop-${seq}.example.com`;
  await overlayLiveMerchantSearchPrices({ products: [products[0]] }, { fetchImpl: storefront({ price: '31.00' }).fetchImpl, env: {}, market: 'US' });
  await seed(h, { host, variant_id: '9000', amount: 26, handle: 'p-0' });
  storefrontProductPage.noteGone(`https://${host}/products/p-1.json`, 404);
  await seed(h, { host, variant_id: '9001', amount: 26, handle: 'p-1' });
  const out = await overlayLiveMerchantSearchPrices({ products }, { fetchImpl: storefront().fetchImpl, env: {}, market: 'US', priceCache: h.api });
  assert.equal(out.products[0].price, 31, 'this instance\'s own fresh read wins');
  assert.equal(out.products[1].price, 28, 'a page Shopify said is gone is never priced from the cache');
  assert.equal(out.metadata.live_merchant_price.gone_count, 1);
  assert.equal(out.metadata.live_merchant_price.shared_cache_hit_count, 0);

  h.fake.faults.getAllError = new Error('down');
  h.cache._l1.clear();
  const failing = await overlayLiveMerchantSearchPrices({ products: jsonCards(1) }, { fetchImpl: storefront().fetchImpl, env: {}, market: 'US', priceCache: h.api });
  assert.equal(failing.products[0].price, 30, 'read from the store as with the cache off');
});

test('WRITE MODE: the page is byte-identical to the overlay with no cache at all', async () => {
  for (const [label, opts] of [['ok', {}], ['429', { status: 429 }], ['EUR', { currency: 'EUR' }]]) {
    const products = jsonCards(3);
    const h = cacheHarness({ read: false });
    const withCache = await overlayLiveMerchantSearchPrices({ products }, { fetchImpl: storefront(opts).fetchImpl, env: {}, market: 'US', priceCache: h.api, hostGate: { admit: () => null, noteRefusal() {} } });
    storefrontProductPage._resetForTest && storefrontProductPage._resetForTest();
    const again = jsonCards(3).map((c, i) => ({ ...c, product_id: products[i].product_id, destination_url: products[i].destination_url.replace(/shop-\d+/, `shop-x${seq}`) }));
    const plain = await overlayLiveMerchantSearchPrices({ products: again }, { fetchImpl: storefront(opts).fetchImpl, env: {}, market: 'US' });
    const norm = (o) => JSON.parse(JSON.stringify(o).replace(/shop-x?\d+/g, 'shop').replace(/"price_as_of":"[^"]+"/g, '"price_as_of":"<t>"'));
    assert.deepEqual(norm(withCache), norm(plain), label);
    assert.equal(h.fake.calls.getAll.length, 0, `${label}: write mode never reads the cache`);
  }
});

test('READ MODE on the price line: a cache answer is RECENT, never live, even when another instance read it a moment ago', async () => {
  const saved = process.env.PRICE_VERIFICATION_LOG;
  process.env.PRICE_VERIFICATION_LOG = 'on';
  try {
    const h = cacheHarness({ read: true });
    const products = jsonCards(2);
    const host = `shop-${seq}.example.com`;
    const startedAt = Date.now();
    // Another instance answered 200 ms AFTER this request started: by the clock alone it would look live.
    await seed(h, { host, variant_id: '9000', amount: 26, handle: 'p-0', read_at: startedAt + 200 });
    const lines = [];
    await pv.runWithPriceContext({ door: 'rest', started_at_ms: startedAt }, async () => {
      const out = await overlayLiveMerchantSearchPrices({ products }, { fetchImpl: storefront().fetchImpl, env: {}, market: 'US', priceCache: h.api });
      pv.logPriceVerificationServed({ info: (o, msg) => lines.push({ ...o, msg }) }, { surface: 'search', items: out.products });
    });
    const line = lines[0];
    assert.deepEqual([line.live, line.recent, line.stored, line.verified_count, line.total], [1, 1, 0, 2, 2]);
    assert.equal(line.overlay_cache_not_live, 1);
  } finally {
    if (saved === undefined) delete process.env.PRICE_VERIFICATION_LOG;
    else process.env.PRICE_VERIFICATION_LOG = saved;
  }
});

test('a read our own budget refused is named on the price line\'s throttled hosts', async () => {
  const saved = process.env.PRICE_VERIFICATION_LOG;
  process.env.PRICE_VERIFICATION_LOG = 'on';
  try {
    const products = jsonCards(2);
    const lines = [];
    await pv.runWithPriceContext({ door: 'rest' }, async () => {
      const out = await overlayLiveMerchantSearchPrices({ products }, { fetchImpl: storefront().fetchImpl, env: {}, market: 'US', hostGate: { admit: () => 'host_budget', noteRefusal() {} } });
      pv.logPriceVerificationServed({ info: (o, msg) => lines.push({ ...o, msg }) }, { surface: 'search', items: out.products });
    });
    assert.deepEqual(lines[0].overlay_throttled_hosts, { [`shop-${seq}.example.com`]: 2 });
  } finally {
    if (saved === undefined) delete process.env.PRICE_VERIFICATION_LOG;
    else process.env.PRICE_VERIFICATION_LOG = saved;
  }
});
