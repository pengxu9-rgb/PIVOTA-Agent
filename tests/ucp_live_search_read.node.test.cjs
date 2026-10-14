'use strict';

// UCP LIVE SEARCH-CARD READ. Search's overlay used to read `/products/<handle>.json` with no country and
// change PRICE only; the merchant's own lookup_catalog now settles price AND stock for the buyer's market,
// batched per store, before that fallback. Fakes answer in the live response shape (not_found messages).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUcpLiveSearchReader, STATUS } = require('../src/services/ucpLiveOfferRead');
const { overlayLiveMerchantSearchPrices } = require('../src/services/liveMerchantSearchPrice');

const BERRY = '31760703160372';
const BLISS = '43734829564039';
const LAN = 'https://us.laneige.com/products/lip-sleeping-mask';
const RB = 'https://www.rarebeauty.com/products/soft-pinch-liquid-blush';

function toolResult(payload) {
  return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}
function variant(id, amount, currency, available) {
  return { id: `gid://shopify/ProductVariant/${id}`, price: { amount, currency }, availability: { available } };
}
/** stores: host -> country -> variants */
function fakeClient(stores, calls = [], { quiet = false } = {}) {
  return {
    calls,
    async discoverEndpoint(base) {
      calls.push(['discover', base]);
      const host = new URL(base).hostname;
      return stores[host] ? { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 } : { mcpEndpoint: undefined, status: 404 };
    },
    async lookupCatalog(endpoint, { ids, context }) {
      const host = new URL(endpoint).hostname;
      calls.push(['lookup', host, ids.length, context.address_country]);
      const vs = ((stores[host] || {})[context.address_country] || []).filter((v) => ids.includes(v.id));
      const missing = quiet ? [] : ids.filter((id) => !vs.some((v) => v.id === id));
      return toolResult({
        products: vs.length ? [{ id: 'gid://shopify/Product/1', variants: vs }] : [],
        messages: missing.map((id) => ({ type: 'info', code: 'not_found', content: id })),
      });
    },
  };
}
const stores = {
  'us.laneige.com': { US: [variant(BERRY, 2400, 'USD', true)], SG: [variant(BERRY, 2400, 'USD', true)] },
  'www.rarebeauty.com': { US: [variant(BLISS, 2500, 'USD', false)], SG: [variant(BLISS, 3700, 'SGD', true)] },
};
function card(dest, vid, extra = {}) {
  return { title: 't', price: 22, currency: 'USD', in_stock: true, availability: 'in_stock', destination_url: dest, source_variant_id: vid, ...extra };
}
function reader(mode = 'enforce', calls = [], logs = []) {
  return createUcpLiveSearchReader({ ucpClient: fakeClient(stores, calls), mode, log: (e, f) => logs.push({ event: e, ...f }) });
}
// The `.json` fallback, for cards UCP did not settle: answers a fixed product page.
function jsonFetch(price = '30.00', seen = []) {
  return async (url) => {
    seen.push(url);
    return { ok: true, status: 200, headers: new Map(), async json() { return { product: { variants: [{ id: 1, price, price_currency: 'USD' }] } }; } };
  };
}

test('a verified card takes the merchant price AND stock; the old path never fetches it', async () => {
  const seen = [];
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(RB, BLISS)] },
    { ucpSearchReader: reader(), market: 'US', fetchImpl: jsonFetch('30.00', seen) },
  );
  const c = out.products[0];
  assert.equal(c.price, 25);
  assert.equal(c.in_stock, false, 'stock comes from the merchant too, which the old overlay never touched');
  assert.equal(c.availability, 'out_of_stock');
  assert.equal(c.price_source, 'merchant_live');
  assert.equal(c.live_read.status, STATUS.VERIFIED);
  assert.equal(c.live_read.market_basis, 'declared');
  assert.equal(seen.length, 0);
  assert.deepEqual(out.metadata.live_merchant_price.ucp, { verified_count: 1, variant_gone_count: 0, drift_count: 1, stock_changed_count: 1 });
});

test('cards from one store are read in ONE lookup; each store once', async () => {
  const calls = [];
  const BLISS2 = '43734829695111';
  const twoStores = {
    ...stores,
    'www.rarebeauty.com': { US: [variant(BLISS, 2500, 'USD', true), variant(BLISS2, 2500, 'USD', true)] },
  };
  const r = createUcpLiveSearchReader({ ucpClient: fakeClient(twoStores, calls), mode: 'enforce' });
  await r.readCards([card(RB, BLISS), card(RB, BLISS2), card(LAN, BERRY)], { market: 'US' });
  const lookups = calls.filter((c) => c[0] === 'lookup');
  assert.equal(lookups.length, 2);
  assert.deepEqual(lookups.find((c) => c[1] === 'www.rarebeauty.com').slice(2), [2, 'US']);
});

test('a variant the merchant says it does not have shows out of stock, not dropped', async () => {
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(LAN, '99999999999')] },
    { ucpSearchReader: reader(), market: 'US', fetchImpl: jsonFetch() },
  );
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].in_stock, false);
  assert.equal(out.products[0].live_read.status, STATUS.VARIANT_GONE);
});

test('a store answering another currency for the market leaves the card to the old path', async () => {
  const seen = [];
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(LAN, BERRY, { currency: 'SGD', price: 30 })] },
    { ucpSearchReader: reader(), market: 'SG', fetchImpl: jsonFetch('30.00', seen) },
  );
  assert.equal(out.products[0].live_read, undefined);
  assert.equal(seen.length, 1, 'the .json read still runs for it');
});

test('cards with no variant id, or a store with no UCP endpoint, take the old path unchanged', async () => {
  const seen = [];
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(RB, ''), card('https://nostore.example/products/x', '123456789')] },
    { ucpSearchReader: reader(), market: 'US', fetchImpl: jsonFetch('30.00', seen) },
  );
  assert.equal(seen.length, 2);
  assert.equal(out.products[0].price, 30);
  assert.equal(out.products[0].live_read, undefined);
});

test('no declared market: each card is checked in its own home market', async () => {
  const calls = [];
  const reads = await reader('enforce', calls).readCards([card(RB, BLISS)], {});
  assert.equal(reads.get(0).market_basis, 'listing_home');
  assert.deepEqual(calls.find((c) => c[0] === 'lookup').slice(3), ['US']);
});

test('a declared market Pivota does not price reads nothing', async () => {
  const calls = [];
  const reads = await reader('enforce', calls).readCards([card(RB, BLISS)], { market: 'DE' });
  assert.equal(reads.size, 0);
  assert.equal(calls.length, 0);
});

test('shadow changes nothing on the page and logs afterwards', async () => {
  const logs = [];
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(RB, BLISS)] },
    { ucpSearchReader: reader('shadow', [], logs), market: 'US', fetchImpl: jsonFetch('22.00') },
  );
  assert.equal(out.products[0].live_read, undefined);
  for (let i = 0; i < 10 && !logs.length; i += 1) await new Promise((res) => setImmediate(res));
  assert.equal(logs[0].event, 'search_ucp_live_read');
  assert.equal(logs[0].price_changed, 1);
});

test('without a reader the overlay is exactly as before (no ucp metadata)', async () => {
  const out = await overlayLiveMerchantSearchPrices({ products: [card(RB, '')] }, { fetchImpl: jsonFetch('30.00') });
  assert.equal(out.metadata.live_merchant_price.ucp, undefined);
  assert.equal(out.products[0].price, 30);
});

test('a reader that throws costs the UCP pass, never the page', async () => {
  const broken = { readCards: async () => { throw new Error('boom'); } };
  const out = await overlayLiveMerchantSearchPrices({ products: [card(RB, '')] }, { ucpSearchReader: broken, market: 'US', fetchImpl: jsonFetch('30.00') });
  assert.equal(out.products[0].price, 30);
});

test('a store silent about a variant is not evidence it is gone: the card takes the old path', async () => {
  const seen = [];
  const quietReader = createUcpLiveSearchReader({ ucpClient: fakeClient(stores, [], { quiet: true }), mode: 'enforce' });
  const out = await overlayLiveMerchantSearchPrices(
    // A handle no other test fetched: the `.json` overlay caches pages per URL across calls.
    { products: [card('https://us.laneige.com/products/water-sleeping-mask', '99999999999')] },
    { ucpSearchReader: quietReader, market: 'US', fetchImpl: jsonFetch('30.00', seen) },
  );
  assert.equal(out.products[0].live_read, undefined);
  assert.equal(out.products[0].in_stock, true);
  assert.equal(seen.length, 1);
});

test('STRUCTURAL: search hands the overlay the UCP reader and the buyer market; all readers share one core', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const start = src.indexOf('function maybeOverlayLiveSearchPrice(');
  const block = src.slice(start, start + 2200);
  assert.match(block, /ucpSearchReader: getUcpLiveSearchReader\(\),/);
  assert.match(block, /market: typeof search\.market === 'string' \? search\.market : undefined,/);
  for (const getter of ['getUcpLiveSearchReader', 'getUcpLiveProductReader', 'getUcpLiveOfferReader']) {
    const i = src.indexOf(`function ${getter}()`);
    assert.ok(i > 0, getter);
    assert.match(src.slice(i, i + 900), /\.\.\.getUcpLiveShared\(\),/, `${getter} uses the shared client and core`);
  }
});
