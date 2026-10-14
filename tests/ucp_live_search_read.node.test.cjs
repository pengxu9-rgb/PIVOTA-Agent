'use strict';

// UCP LIVE SEARCH-CARD READ. Search's overlay reads `/products/<handle>.json` with no country and changes
// PRICE only. The merchant's own lookup_catalog now CONFIRMS or CORRECTS the card's own variant price in
// the card's own currency, and may RAISE a card to in stock. It never lowers or drops a card (one shade's
// answer is not the product's), and every card it does not settle keeps the `.json` read, which for cards
// it never planned starts at once, alongside it. Fakes answer in the live response shape (handle on the
// product, not_found messages; 59/59 probe lookups carried a handle, 2026-10-14).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUcpLiveSearchReader, createLookupCore, searchCardVariantId, STATUS } = require('../src/services/ucpLiveOfferRead');
const { overlayLiveMerchantSearchPrices } = require('../src/services/liveMerchantSearchPrice');

const BERRY = '31760703160372';
const BLISS = '43734829564039';
let seq = 0;
// The `.json` overlay caches pages per URL across calls: every test card gets its own handle.
function rbUrl(handle) { return `https://www.rarebeauty.com/products/${handle}`; }
function uniq(base) { seq += 1; return `${base}-${seq}`; }

function toolResult(payload) {
  return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}
function variant(id, amount, currency, available, handle) {
  return { id: `gid://shopify/ProductVariant/${id}`, price: { amount, currency }, availability: { available }, handle };
}
/** stores: host -> country -> variants (each tagged with its product handle) */
function fakeClient(stores, calls = [], { quiet = false, gate = null } = {}) {
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
      if (gate) await gate;
      const vs = ((stores[host] || {})[context.address_country] || []).filter((v) => ids.includes(v.id));
      const missing = quiet ? [] : ids.filter((id) => !vs.some((v) => v.id === id));
      const byHandle = new Map();
      for (const { handle, ...v } of vs) {
        if (!byHandle.has(handle)) byHandle.set(handle, []);
        byHandle.get(handle).push(v);
      }
      return toolResult({
        products: [...byHandle].map(([handle, variants], i) => ({ id: `gid://shopify/Product/${i + 1}`, handle, variants })),
        messages: missing.map((id) => ({ type: 'info', code: 'not_found', content: id })),
      });
    },
  };
}
function storesFor(handle, { us = [2500, 'USD', true], sg = [3700, 'SGD', true] } = {}) {
  return {
    'www.rarebeauty.com': {
      US: [variant(BLISS, us[0], us[1], us[2], handle)],
      SG: [variant(BLISS, sg[0], sg[1], sg[2], handle)],
    },
  };
}
function card(dest, vid, extra = {}) {
  return { title: 't', price: 22, currency: 'USD', in_stock: true, availability: 'in_stock', destination_url: dest, source_variant_id: vid, ...extra };
}
function reader(stores, { mode = 'enforce', calls = [], logs = [], quiet = false, gate = null } = {}) {
  return createUcpLiveSearchReader({ ucpClient: fakeClient(stores, calls, { quiet, gate }), mode, log: (e, f) => logs.push({ event: e, ...f }) });
}
// The `.json` read: answers a fixed product page carrying every variant id these tests name.
const JSON_IDS = [1, BLISS, BERRY, '99999999999', '123456789'];
function jsonFetch(price = '30.00', seen = []) {
  return async (url) => {
    seen.push(url);
    const variants = JSON_IDS.map((id) => ({ id: Number(id), price, price_currency: 'USD' }));
    return { ok: true, status: 200, headers: new Map(), async json() { return { product: { variants } }; } };
  };
}

test('a verified card takes the merchant price; the .json read never fetches it', async () => {
  const h = uniq('blush');
  const seen = [];
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), BLISS)] },
    { ucpSearchReader: reader(storesFor(h)), market: 'US', fetchImpl: jsonFetch('30.00', seen) },
  );
  const c = out.products[0];
  assert.equal(c.price, 25);
  assert.equal(c.price_amount, 25);
  assert.equal(c.currency, 'USD');
  assert.equal(c.price_source, 'merchant_live');
  assert.equal(c.live_read.status, STATUS.VERIFIED);
  assert.equal(c.live_read.market_basis, 'declared');
  assert.equal(seen.length, 0);
  assert.deepEqual(out.metadata.live_merchant_price.ucp, {
    mode: 'enforce', planned_count: 1, verified_count: 1, drift_count: 1, stock_raised_count: 0,
  });
  assert.equal(out.metadata.live_merchant_price.attempted, true);
});

test('the merchant saying the variant is available RAISES an out-of-stock card', async () => {
  const h = uniq('blush');
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), BLISS, { in_stock: false, availability: 'out_of_stock' })] },
    { ucpSearchReader: reader(storesFor(h)), market: 'US', fetchImpl: jsonFetch() },
  );
  assert.equal(out.products[0].in_stock, true);
  assert.equal(out.products[0].availability, 'in_stock');
  assert.equal(out.metadata.live_merchant_price.ucp.stock_raised_count, 1);
});

test('the merchant saying unavailable leaves an out-of-stock card out of stock', async () => {
  const h = uniq('blush');
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), BLISS, { in_stock: false, availability: 'out_of_stock' })] },
    { ucpSearchReader: reader(storesFor(h, { us: [2500, 'USD', false] })), market: 'US', fetchImpl: jsonFetch() },
  );
  assert.equal(out.products[0].in_stock, false);
  assert.equal(out.products[0].availability, 'out_of_stock');
  assert.equal(out.metadata.live_merchant_price.ucp.stock_raised_count, 0);
});

test('one shade out of stock NEVER lowers the card: the answer is reported, not written over it', async () => {
  const h = uniq('blush');
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), BLISS)] },
    { ucpSearchReader: reader(storesFor(h, { us: [2500, 'USD', false] })), market: 'US', fetchImpl: jsonFetch() },
  );
  const c = out.products[0];
  assert.equal(c.in_stock, true);
  assert.equal(c.availability, 'in_stock');
  assert.equal(c.live_read.variant_in_stock, false);
  assert.equal(c.price, 25, 'the price is still the merchant\'s');
});

test('cards from one store are read in ONE lookup per country', async () => {
  const calls = [];
  const BLISS2 = '43734829695111';
  const h = uniq('blush');
  const stores = { 'www.rarebeauty.com': { US: [variant(BLISS, 2500, 'USD', true, h), variant(BLISS2, 2500, 'USD', true, h)] } };
  const r = reader(stores, { calls });
  await r.readCards([card(rbUrl(h), BLISS), card(rbUrl(h), BLISS2)], { market: 'US' });
  const lookups = calls.filter((c) => c[0] === 'lookup');
  assert.equal(lookups.length, 1);
  assert.deepEqual(lookups[0].slice(1), ['www.rarebeauty.com', 2, 'US']);
});

test('not_found is not "gone" on a search card: the card is untouched and keeps its .json read', async () => {
  const h = uniq('blush');
  const seen = [];
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), '99999999999')] },
    { ucpSearchReader: reader(storesFor(h)), market: 'US', fetchImpl: jsonFetch('30.00', seen) },
  );
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].in_stock, true);
  assert.equal(out.products[0].live_read, undefined);
  assert.equal(seen.length, 1);
  assert.equal(out.products[0].price, 30);
});

test('a variant answered under ANOTHER product handle is not this card\'s', async () => {
  const h = uniq('blush');
  const seen = [];
  const r = reader(storesFor('soft-pinch-liquid-blush-mini'));
  const reads = await r.readCards([card(rbUrl(h), BLISS)], { market: 'US' });
  assert.equal(reads.get(0).status, STATUS.ERROR);
  assert.equal(reads.get(0).reason, 'other_product');
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), BLISS)] },
    { ucpSearchReader: reader(storesFor('soft-pinch-liquid-blush-mini')), market: 'US', fetchImpl: jsonFetch('30.00', seen) },
  );
  assert.equal(out.products[0].live_read, undefined);
  assert.equal(seen.length, 1);
});

test('the card currency never changes: a store answering another currency leaves it to .json', async () => {
  const h = uniq('blush');
  const seen = [];
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), BLISS, { currency: 'SGD', price: 30 })] },
    { ucpSearchReader: reader(storesFor(h, { sg: [2500, 'USD', true] })), market: 'SG', fetchImpl: jsonFetch('30.00', seen) },
  );
  assert.equal(out.products[0].live_read, undefined);
  assert.equal(out.products[0].currency, 'SGD');
  assert.equal(seen.length, 1);
});

test('a card in another currency than the declared market is never planned', () => {
  const r = reader(storesFor('x'));
  assert.equal(r.plan([card(rbUrl('x'), BLISS, { currency: 'USD' })], { market: 'SG' }).size, 0);
  assert.equal(r.plan([card(rbUrl('x'), BLISS, { currency: 'SGD' })], { market: 'SG' }).size, 1);
});

test('only a real variant id is read: a restated product id or default is skipped, ?variant= is used', () => {
  const dest = rbUrl('x');
  assert.equal(searchCardVariantId(card(dest, '8123456789', { source_product_id: '8123456789' })), null);
  assert.equal(searchCardVariantId(card(dest, 'default')), null);
  // A placeholder is no id: the URL's ?variant= still speaks for the card.
  assert.equal(searchCardVariantId(card(`${dest}?variant=${BLISS}`, 'default')), BLISS);
  assert.equal(searchCardVariantId(card(`${dest}?variant=${BLISS}`, `${BERRY}-default`)), BLISS);
  assert.equal(searchCardVariantId(card(`${dest}?variant=${BLISS}`, '8123456789', { source_product_id: '8123456789' })), BLISS);
  assert.equal(searchCardVariantId(card(dest, BLISS)), BLISS);
  const r = reader(storesFor('x'));
  assert.equal(r.plan([card(dest, '8123456789', { source_product_id: '8123456789' })], { market: 'US' }).size, 0);
});

test('cards UCP never plans start their .json read AT ONCE, alongside the UCP read', async () => {
  const h = uniq('blush');
  let open;
  const gate = new Promise((res) => { open = res; });
  const seen = [];
  const calls = [];
  const overlay = overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), BLISS), card(rbUrl(uniq('nofx')), '')] },
    { ucpSearchReader: reader(storesFor(h), { calls, gate }), market: 'US', fetchImpl: jsonFetch('30.00', seen) },
  );
  for (let i = 0; i < 20 && !(seen.length && calls.some((c) => c[0] === 'lookup')); i += 1) {
    await new Promise((res) => setImmediate(res));
  }
  assert.equal(seen.length, 1, 'the .json read ran while the merchant lookup was still pending');
  assert.ok(calls.some((c) => c[0] === 'lookup'));
  open();
  const out = await overlay;
  assert.equal(out.products[0].price, 25);
  assert.equal(out.products[1].price, 30);
});

test('no variant id, or a store with no UCP endpoint: the .json read, unchanged', async () => {
  const seen = [];
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(uniq('noid')), ''), card(`https://nostore.example/products/${uniq('x')}`, '123456789')] },
    { ucpSearchReader: reader(storesFor('x')), market: 'US', fetchImpl: jsonFetch('30.00', seen) },
  );
  assert.equal(seen.length, 2);
  assert.equal(out.products[0].price, 30);
  assert.equal(out.products[0].live_read, undefined);
  assert.equal(out.products[1].price, 30);
});

test('no declared market: each card is checked in its own home market', async () => {
  const calls = [];
  const h = uniq('blush');
  const reads = await reader(storesFor(h), { calls }).readCards([card(rbUrl(h), BLISS)], {});
  assert.equal(reads.get(0).market_basis, 'listing_home');
  assert.deepEqual(calls.find((c) => c[0] === 'lookup').slice(3), ['US']);
});

test('a declared market Pivota does not price reads nothing', async () => {
  const calls = [];
  const reads = await reader(storesFor('x'), { calls }).readCards([card(rbUrl('x'), BLISS)], { market: 'DE' });
  assert.equal(reads, null);
  assert.equal(calls.length, 0);
});

test('shadow changes nothing on the page and logs against the card as it was served', async () => {
  const h = uniq('blush');
  const logs = [];
  let open;
  const gate = new Promise((res) => { open = res; });
  // The merchant answers 25 only after the `.json` read has rewritten the card to 25 too: the log must
  // still compare against the card as search served it (22).
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), BLISS)] },
    { ucpSearchReader: reader(storesFor(h), { mode: 'shadow', logs, gate }), market: 'US', fetchImpl: jsonFetch('25.00') },
  );
  assert.equal(out.products[0].live_read, undefined);
  assert.equal(out.products[0].price_source, 'merchant_live', 'the .json read, not UCP');
  open();
  for (let i = 0; i < 20 && !logs.length; i += 1) await new Promise((res) => setImmediate(res));
  assert.equal(logs[0].event, 'search_ucp_live_read');
  assert.equal(logs[0].price_changed, 1);
  assert.equal(out.metadata.live_merchant_price.ucp.verified_count, 0);
});

test('without a reader the overlay is exactly as before (no ucp metadata)', async () => {
  const out = await overlayLiveMerchantSearchPrices({ products: [card(rbUrl(uniq('plain')), '')] }, { fetchImpl: jsonFetch('30.00') });
  assert.equal(out.metadata.live_merchant_price.ucp, undefined);
  assert.equal(out.products[0].price, 30);
});

test('a reader that throws (plan or read) costs the UCP pass, never the page', async () => {
  const brokenRead = { mode: 'enforce', plan: () => new Map([[0, {}]]), readCards: async () => { throw new Error('boom'); } };
  const brokenPlan = { mode: 'enforce', plan: () => { throw new Error('boom'); }, readCards: async () => null };
  for (const broken of [brokenRead, brokenPlan]) {
    const out = await overlayLiveMerchantSearchPrices(
      { products: [card(rbUrl(uniq('broken')), BLISS)] },
      { ucpSearchReader: broken, market: 'US', fetchImpl: jsonFetch('30.00') },
    );
    assert.equal(out.products[0].price, 30);
  }
});

test('search\'s own pool shares discovery only, and a waiter gives up at ITS deadline', async () => {
  const calls = [];
  const endpoints = new Map();
  let open;
  const gate = new Promise((res) => { open = res; });
  const client = fakeClient(storesFor('x'), calls, { gate });
  const a = createLookupCore({ ucpClient: client, now: () => Date.now(), endpointTtlMs: 60000, memoTtlMs: 1000, endpointCache: endpoints });
  const b = createLookupCore({ ucpClient: client, now: () => Date.now(), endpointTtlMs: 60000, memoTtlMs: 1000, maxConcurrent: 1, endpointCache: endpoints });
  const ep = await a.endpointFor('www.rarebeauty.com');
  assert.equal(await b.endpointFor('www.rarebeauty.com'), ep);
  assert.equal(calls.filter((c) => c[0] === 'discover').length, 1, 'discovery is shared');
  const first = b.lookup('www.rarebeauty.com', ep, [BLISS], 'US');
  const started = Date.now();
  await assert.rejects(b.lookup('www.rarebeauty.com', ep, [BERRY], 'US', { deadline: Date.now() + 60 }), (e) => e.code === 'timeout');
  assert.ok(Date.now() - started < 1000, 'gave up at its own deadline, not the 3 s stale-waiter cap');
  assert.equal(a.stats().inFlight, 0, 'the other pool is untouched');
  open();
  await first;
  assert.equal(b.stats().inFlight, 0);
  assert.equal(b.stats().waiting, 0);
});

test('STRUCTURAL: search gets its own 8-slot pool and the buyer market the search lane resolved', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const start = src.indexOf('function maybeOverlayLiveSearchPrice(');
  const block = src.slice(start, start + 2600);
  assert.match(block, /buyerMarket = undefined/);
  assert.match(block, /ucpSearchReader: getUcpLiveSearchReader\(\),/);
  assert.match(block, /market: typeof buyerMarket === 'string' && buyerMarket\.trim\(\) \? buyerMarket\.trim\(\)/);
  assert.match(src, /buyerMarket: search\.market \|\| metadata\.market \}/);
  assert.match(src, /buyerMarket: publicBeautySearch\.market \|\| metadata\.market \}/);
  const s = src.indexOf('function getUcpLiveSearchReader()');
  assert.ok(s > 0);
  const sblock = src.slice(s, s + 1400);
  assert.match(sblock, /maxConcurrent: 8, endpointCache: shared\.core\.endpoints/);
  for (const getter of ['getUcpLiveProductReader', 'getUcpLiveOfferReader']) {
    const i = src.indexOf(`function ${getter}()`);
    assert.ok(i > 0, getter);
    assert.match(src.slice(i, i + 900), /\.\.\.getUcpLiveShared\(\),/, `${getter} uses the shared client and core`);
  }
});
