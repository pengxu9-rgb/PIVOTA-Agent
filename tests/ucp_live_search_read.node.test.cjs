'use strict';

// UCP LIVE SEARCH-CARD READ. Search's overlay reads `/products/<handle>.json` with no country and changes
// PRICE only. The merchant's own lookup_catalog now CONFIRMS or CORRECTS the card's own variant price in
// the card's own currency, and may RAISE a card to in stock. It never lowers or drops a card (one shade's
// answer is not the product's), and every card it does not settle keeps the `.json` read, which for cards
// it never planned starts at once, alongside it. Fakes answer in the live response shape (handle on the
// product, not_found messages; 59/59 probe lookups carried a handle, 2026-10-14).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUcpLiveSearchReader, createLookupCore, searchCardVariantId, searchCardHandle, STATUS } = require('../src/services/ucpLiveOfferRead');
const storefrontProductPage = require('../src/services/storefrontProductPage');
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
    mode: 'enforce', planned_count: 1, settled_count: 1, verified_count: 1, drift_count: 1, stock_raised_count: 0,
    by_status: { verified: 1 },
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

test('ADR-026: no declared market, no live read -- never a market inferred from the card currency', async () => {
  const calls = [];
  const h = uniq('blush');
  const r = reader(storesFor(h), { calls });
  assert.equal(r.plan([card(rbUrl(h), BLISS)], {}).size, 0);
  assert.equal(await r.readCards([card(rbUrl(h), BLISS)], {}), null);
  assert.equal(calls.length, 0);
  const seen = [];
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), BLISS)] },
    { ucpSearchReader: r, fetchImpl: jsonFetch('30.00', seen) },
  );
  assert.equal(out.products[0].live_read, undefined);
  assert.equal(seen.length, 1, 'the .json read, as today');
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
  assert.equal(out.metadata.live_merchant_price.ucp, undefined, 'shadow adds no metadata');
});

test('SHADOW IS PURE: the same cards get a live price before the deadline as with the read off', async () => {
  // PR controller repro: 14 cards on one store, 7 of them plannable, a page deadline that cuts the
  // `.json` reads short. Shadow must not hold the planned cards back, which would let lower-ranked
  // cards take their slots.
  const run = async (ucpSearchReader) => {
    const products = [];
    for (let i = 0; i < 14; i += 1) {
      const h = uniq('pure');
      products.push(card(rbUrl(h), i % 2 === 0 ? BLISS : ''));
    }
    const fetchImpl = async () => {
      await new Promise((res) => setTimeout(res, 25));
      return { ok: true, status: 200, headers: new Map(), async json() { return { product: { variants: JSON_IDS.map((id) => ({ id: Number(id), price: '30.00', price_currency: 'USD' })) } }; } };
    };
    const out = await overlayLiveMerchantSearchPrices({ products }, { ucpSearchReader, market: 'US', fetchImpl, pageDeadlineMs: 70 });
    return { sources: out.products.map((c) => c.price_source || null), meta: out.metadata.live_merchant_price };
  };
  const off = await run(undefined);
  const shadowReader = reader(storesFor('x'), { mode: 'shadow' });
  const shadow = await run(shadowReader);
  assert.ok(off.sources.includes('catalog_offer'), 'the deadline really cut the reads short');
  assert.deepEqual(shadow.sources, off.sources);
  const strip = ({ ucp, ...rest }) => rest;
  assert.deepEqual(Object.keys(strip(shadow.meta)), Object.keys(off.meta));
  assert.equal(shadow.meta.attempted, off.meta.attempted);
  assert.equal(shadow.meta.eligible_count, off.meta.eligible_count);
  assert.equal('ucp' in shadow.meta, false);
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

// ---- review round 2 ----------------------------------------------------------------------------------

test('a held, suppressed, citation or $0 card is never read (it would be raised back to buyable)', () => {
  const r = reader(storesFor('x'));
  const dest = rbUrl('x');
  const held = [
    { price: 0 }, { transaction_ready: false }, { buyable: false }, { commerce_suppressed: true },
    { non_merch_terminal_hold_v1: { status: 'held' } }, { transaction_readiness_blocker_v1: { reason: 'x' } },
    { source_unavailable_v1: { status: 'gone' } }, { catalog_track: 'citation' },
  ];
  for (const extra of held) assert.equal(r.plan([card(dest, BLISS, extra)], { market: 'US' }).size, 0, JSON.stringify(extra));
  assert.equal(r.plan([card(dest, BLISS)], { market: 'US' }).size, 1);
});

test('the real held-card shape stays held through the overlay', async () => {
  const h = uniq('held');
  const heldCard = card(`${rbUrl(h)}?variant=${BLISS}`, '', {
    price: 0, in_stock: false, available: false, availability: 'out_of_stock', inventory_quantity: 0,
    transaction_ready: false, non_merch_terminal_hold_v1: { status: 'held' },
  });
  const out = await overlayLiveMerchantSearchPrices(
    { products: [heldCard] },
    { ucpSearchReader: reader(storesFor(h)), market: 'US', fetchImpl: jsonFetch() },
  );
  assert.equal(out.products[0].in_stock, false);
  assert.equal(out.products[0].price, 0);
  assert.equal(out.products[0].live_read, undefined);
});

test('a raise makes every stock field agree (available, zero quantity)', async () => {
  const h = uniq('blush');
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), BLISS, { in_stock: false, available: false, availability: 'out_of_stock', inventory_quantity: 0 })] },
    { ucpSearchReader: reader(storesFor(h)), market: 'US', fetchImpl: jsonFetch() },
  );
  const c = out.products[0];
  assert.equal(c.in_stock, true);
  assert.equal(c.available, true);
  assert.equal('inventory_quantity' in c, false);
});

test('a page the storefront already said is gone is never confirmed by the catalog; DROP_GONE still drops it', async () => {
  const h = uniq('gone');
  storefrontProductPage.noteGone(`https://www.rarebeauty.com/products/${h}.json`, 404);
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), BLISS)] },
    { ucpSearchReader: reader(storesFor(h)), market: 'US', fetchImpl: jsonFetch(), env: { SERVE_LIVE_MERCHANT_PRICE_DROP_GONE: 'true' } },
  );
  assert.equal(out.products.length, 0);
  assert.equal(out.metadata.live_merchant_price.ucp.verified_count, 0);
  assert.equal(out.metadata.live_merchant_price.gone_count, 1);
});

test('the handle is read from Markets subfolder and collection URLs; no handle on either side is refused', async () => {
  assert.equal(searchCardHandle({ destination_url: 'https://s.example/en-us/products/full-size' }), 'full-size');
  assert.equal(searchCardHandle({ destination_url: 'https://s.example/collections/lips/products/full-size' }), 'full-size');
  assert.equal(searchCardHandle({ destination_url: 'https://s.example/pages/full-size' }), null);
  const h = uniq('full-size');
  // Subfolder card, variant answered under ANOTHER product: refused.
  const r = reader(storesFor('some-other-product-mini'));
  const reads = await r.readCards([card(`https://www.rarebeauty.com/en-us/products/${h}`, BLISS)], { market: 'US' });
  assert.equal(reads.get(0).reason, 'other_product');
  // An answer carrying no handle: refused, never verified.
  const noHandle = reader(storesFor(undefined));
  const reads2 = await noHandle.readCards([card(rbUrl(h), BLISS)], { market: 'US' });
  assert.equal(reads2.get(0).status, STATUS.ERROR);
  assert.equal(reads2.get(0).reason, 'handle_unknown');
  // A card with no handle at all is not planned.
  assert.equal(r.plan([card('https://www.rarebeauty.com/pages/x', BLISS)], { market: 'US' }).size, 0);
});

test('the per-domain .json cap (4) holds across both phases', async () => {
  let active = 0;
  let peak = 0;
  const fetchImpl = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((res) => setTimeout(res, 15));
    active -= 1;
    return { ok: true, status: 200, headers: new Map(), async json() { return { product: { variants: JSON_IDS.map((id) => ({ id: Number(id), price: '30.00', price_currency: 'USD' })) } }; } };
  };
  const products = [];
  // 8 planned cards the merchant does not answer (they fall to .json after UCP) + 8 unplanned cards.
  for (let i = 0; i < 8; i += 1) products.push(card(rbUrl(uniq('miss')), '99999999999'));
  for (let i = 0; i < 8; i += 1) products.push(card(rbUrl(uniq('plain')), ''));
  const slowStores = storesFor('x');
  const slow = createUcpLiveSearchReader({
    ucpClient: { ...fakeClient(slowStores), async lookupCatalog(ep, args) { await new Promise((res) => setTimeout(res, 20)); return fakeClient(slowStores).lookupCatalog(ep, args); } },
    mode: 'enforce',
  });
  const out = await overlayLiveMerchantSearchPrices({ products }, { ucpSearchReader: slow, market: 'US', fetchImpl });
  assert.ok(peak <= 4, `peak ${peak} concurrent .json fetches to one store`);
  assert.equal(out.metadata.live_merchant_price.verified_count, 16);
  assert.equal(out.metadata.live_merchant_price.ucp.settled_count, 0);
});

test('a planned card still waiting on UCP at the page deadline is stamped and counted', async () => {
  const pending = { mode: 'enforce', plan: () => new Map([[0, {}]]), readCards: () => new Promise(() => {}) };
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(uniq('wait')), BLISS)] },
    { ucpSearchReader: pending, market: 'US', fetchImpl: jsonFetch(), pageDeadlineMs: 40 },
  );
  assert.equal(out.products[0].price_source, 'catalog_offer');
  assert.equal(out.metadata.live_merchant_price.failure_reasons.deadline_exceeded, 1);
  assert.equal(out.metadata.live_merchant_price.deadline_exceeded, true);
});

test('a caller sharing a lookup queued under an EARLIER deadline retries on its own', async () => {
  let open;
  const gate = new Promise((res) => { open = res; });
  const calls = [];
  const core = createLookupCore({ ucpClient: fakeClient(storesFor('x'), calls, { gate }), now: () => Date.now(), endpointTtlMs: 60000, memoTtlMs: 5000, maxConcurrent: 1 });
  const ep = await core.endpointFor('www.rarebeauty.com');
  const holder = core.lookup('www.rarebeauty.com', ep, [BERRY], 'US'); // takes the only slot
  const early = core.lookup('www.rarebeauty.com', ep, [BLISS], 'US', { deadline: Date.now() + 30 });
  const late = core.lookup('www.rarebeauty.com', ep, [BLISS], 'US', { deadline: Date.now() + 3000 });
  await assert.rejects(early, (e) => e.code === 'timeout');
  setTimeout(open, 30);
  await holder;
  const payload = await late;
  assert.ok(payload, 'the later caller got its own answer, not the earlier caller\'s timeout');
});

test('a store whose discovery fails to answer is not planned for a minute', async () => {
  let t = 1000;
  const client = { async discoverEndpoint() { return { status: 503 }; }, async lookupCatalog() { throw new Error('unreached'); } };
  const r = createUcpLiveSearchReader({ ucpClient: client, mode: 'enforce', now: () => t });
  const c = [card(rbUrl('x'), BLISS)];
  assert.equal(r.plan(c, { market: 'US' }).size, 1);
  const reads = await r.readCards(c, { market: 'US' });
  assert.equal(reads.get(0).status, STATUS.ERROR);
  assert.equal(r.plan(c, { market: 'US' }).size, 0);
  t += 61 * 1000;
  assert.equal(r.plan(c, { market: 'US' }).size, 1);
});

test('readers share discovery in flight across their own pools', async () => {
  const calls = [];
  let open;
  const gate = new Promise((res) => { open = res; });
  const client = fakeClient(storesFor('x'), calls);
  const slowDiscover = { ...client, async discoverEndpoint(base) { calls.push(['discover', base]); await gate; return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; } };
  const endpoints = new Map();
  const discovering = new Map();
  const mk = (n) => createLookupCore({ ucpClient: slowDiscover, now: () => Date.now(), endpointTtlMs: 60000, memoTtlMs: 1000, maxConcurrent: n, endpointCache: endpoints, discoveryInFlight: discovering });
  const a = mk(16);
  const b = mk(8);
  const pa = a.endpointFor('www.rarebeauty.com');
  const pb = b.endpointFor('www.rarebeauty.com');
  open();
  assert.equal(await pa, await pb);
  assert.equal(calls.filter((c) => c[0] === 'discover').length, 1);
});

test('a planned card handed to .json just as the host queue empties is still read (no lost wakeup)', async () => {
  // A reader that settles nothing within a couple of microtasks, and a .json read with no real I/O: the
  // first phase's worker is exiting exactly when the second phase enqueues on the same host.
  for (const ticks of [0, 1, 2, 3, 4, 6, 8]) {
    const planned = new Map([[1, {}]]);
    const quick = {
      mode: 'enforce',
      plan: () => planned,
      readCards: async () => {
        for (let i = 0; i < ticks; i += 1) await Promise.resolve();
        return new Map([[1, { status: STATUS.NOT_UCP }]]);
      },
    };
    const instant = async () => ({ ok: true, status: 200, headers: new Map(), async json() { return { product: { variants: JSON_IDS.map((id) => ({ id: Number(id), price: '30.00', price_currency: 'USD' })) } }; } });
    const out = await overlayLiveMerchantSearchPrices(
      { products: [card(rbUrl(uniq('first')), ''), card(rbUrl(uniq('second')), BLISS)] },
      { ucpSearchReader: quick, market: 'US', fetchImpl: instant },
    );
    assert.equal(out.products[1].price, 30, `ticks=${ticks}`);
    assert.equal(out.products[1].price_source, 'merchant_live', `ticks=${ticks}`);
    assert.equal(out.metadata.live_merchant_price.verified_count, 2, `ticks=${ticks}`);
  }
});

test('a known-gone card the catalog answered is counted known_gone, not verified', async () => {
  const h = uniq('gone');
  storefrontProductPage.noteGone(`https://www.rarebeauty.com/products/${h}.json`, 404);
  const out = await overlayLiveMerchantSearchPrices(
    { products: [card(rbUrl(h), BLISS)] },
    { ucpSearchReader: reader(storesFor(h)), market: 'US', fetchImpl: jsonFetch() },
  );
  assert.deepEqual(out.metadata.live_merchant_price.ucp.by_status, { known_gone: 1 });
});

test('a slow but healthy discovery that outran the budget does not back the store off once cached', async () => {
  let open;
  const gate = new Promise((res) => { open = res; });
  const client = { ...fakeClient(storesFor('x')), async discoverEndpoint(base) { await gate; return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; } };
  const r = createUcpLiveSearchReader({ ucpClient: client, mode: 'enforce', budgetMs: 20 });
  const c = [card(rbUrl('x'), BLISS)];
  const reads = await r.readCards(c, { market: 'US' });
  assert.equal(reads.get(0).status, STATUS.TIMEOUT);
  assert.equal(r.plan(c, { market: 'US' }).size, 0, 'backed off while discovery is still out');
  open();
  for (let i = 0; i < 10; i += 1) await new Promise((res) => setImmediate(res));
  assert.equal(r.plan(c, { market: 'US' }).size, 1, 'the endpoint is cached now');
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
  assert.match(src.slice(s, s + 900), /\.\.\.ucpLiveReaderDeps\(8\),/);
  for (const getter of ['getUcpLiveProductReader', 'getUcpLiveOfferReader']) {
    const i = src.indexOf(`function ${getter}()`);
    assert.ok(i > 0, getter);
    assert.match(src.slice(i, i + 900), /\.\.\.ucpLiveReaderDeps\(16\),/, `${getter} has its own pool`);
  }
  const d = src.indexOf('function ucpLiveReaderDeps(');
  assert.match(src.slice(d, d + 700), /maxConcurrent, endpointCache: shared\.endpoints, discoveryInFlight: shared\.discovering/);
});
