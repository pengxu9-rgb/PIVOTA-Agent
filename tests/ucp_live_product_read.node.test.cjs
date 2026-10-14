'use strict';

// UCP LIVE PRODUCT READ (get_product variants). The Laneige case, 2026-10-14: get_product served every
// flavour `current_own_offer_status: unavailable` with no price, while the merchant's lookup_catalog
// answered them in stock at $24. The fake answers in the live response shape and the real unwrap reads it.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createUcpLiveProductReader,
  productHost,
  productVariantIds,
  STATUS,
} = require('../src/services/ucpLiveOfferRead');

const LEMON = '48087970185268';
const BERRY = '31760703160372';
const VANILLA = '31760703258676';

function toolResult(payload) {
  return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}
function variant(id, amount, currency, available) {
  return { id: `gid://shopify/ProductVariant/${id}`, price: { amount, currency }, availability: { available } };
}
function fakeClient(byCountry, calls = [], { quiet = false } = {}) {
  return {
    calls,
    async discoverEndpoint(base) { calls.push(['discover', base]); return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; },
    async lookupCatalog(endpoint, { ids, context }) {
      calls.push(['lookup', ids.length, context.address_country]);
      const wanted = new Set(ids);
      const vs = (byCountry[context.address_country] || []).filter((v) => wanted.has(v.id));
      // Shopify names each id it does not have; `quiet` is a merchant that answers nothing about them.
      const missing = quiet ? [] : ids.filter((id) => !vs.some((v) => v.id === id));
      return toolResult({
        products: vs.length ? [{ id: 'gid://shopify/Product/1', variants: vs }] : [],
        messages: missing.map((id) => ({ type: 'info', code: 'not_found', content: id })),
      });
    },
  };
}
const laneigeUS = { US: [variant(LEMON, 2400, 'USD', true), variant(BERRY, 2400, 'USD', true), variant(VANILLA, 2400, 'USD', false)] };

function storedVariant(id, title) {
  return { variant_id: id, title, current_own_offer_status: 'unavailable', availability: { in_stock: false } };
}
function laneigePdp(extra = {}) {
  return {
    product: {
      product_id: 'sig_130c8e7a',
      destination_url: 'https://us.laneige.com/products/lip-sleeping-mask',
      url: 'https://agent.pivota.cc/products/sig_130c8e7a',
      default_variant_id: LEMON,
      price: null,
      currency: null,
      availability: { in_stock: false },
      variants: [storedVariant(LEMON, 'Lemon Sorbet'), storedVariant(BERRY, 'Berry'), storedVariant(VANILLA, 'Vanilla')],
      ...extra,
    },
  };
}
function reader(byCountry, opts = {}) {
  const calls = [];
  const logs = [];
  const r = createUcpLiveProductReader({
    ucpClient: fakeClient(byCountry, calls, { quiet: opts.quiet === true }),
    mode: opts.mode || 'enforce',
    log: (e, f) => logs.push({ event: e, ...f }),
    ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}),
  });
  return { r, calls, logs };
}

test('the Laneige PDP: each flavour gets the merchant price and stock, the stale verdict goes', async () => {
  const { r } = reader(laneigeUS);
  const out = await r.readProduct(laneigePdp(), { market: 'US' });
  const p = out.product;
  assert.equal(p.price, 24);
  assert.equal(p.currency, 'USD');
  assert.equal(p.price_source, 'merchant_live');
  assert.deepEqual(p.availability, { in_stock: true });
  assert.deepEqual(
    p.variants.map((v) => [v.title, v.price.current.amount, v.availability.in_stock, v.live_read.status, v.current_own_offer_status]),
    [['Lemon Sorbet', 24, true, 'verified', undefined], ['Berry', 24, true, 'verified', undefined], ['Vanilla', 24, false, 'verified', undefined]],
  );
  assert.equal(p.live_read.status, STATUS.VERIFIED);
  assert.equal(p.live_read.market, 'US');
  assert.equal(p.live_read.verified, 3);
  assert.equal(p.url, 'https://agent.pivota.cc/products/sig_130c8e7a', 'only merchant facts change');
});

test('no declared market (USD, EUR, or no currency): nothing is read', async () => {
  const { r, calls } = reader(laneigeUS);
  const eur = laneigePdp({ currency: 'EUR' });
  const out = await r.readProduct(eur, {});
  assert.equal(out.product.live_read.status, STATUS.SKIPPED);
  assert.equal(out.product.price, null);
  assert.equal(calls.length, 0);
});

test('a store that answers another currency for the market changes nothing', async () => {
  const { r } = reader({ SG: [variant(LEMON, 2400, 'USD', true), variant(BERRY, 2400, 'USD', true)] });
  const out = await r.readProduct(laneigePdp(), { market: 'SG' });
  const p = out.product;
  assert.equal(p.live_read.status, STATUS.CURRENCY_MISMATCH);
  assert.equal(p.live_read.merchant_currency, 'USD');
  assert.equal(p.price, null);
  assert.equal(p.variants[0].current_own_offer_status, 'unavailable');
  assert.equal(p.variants[0].live_read, undefined);
});

test('a flavour the merchant says it does not have, among ones it does, is out of stock', async () => {
  const { r } = reader({ US: [variant(LEMON, 2400, 'USD', true)] });
  const pdp = laneigePdp();
  pdp.product.variants[1].availability = { in_stock: true };
  const out = await r.readProduct(pdp, { market: 'US' });
  const berry = out.product.variants.find((v) => v.variant_id === BERRY);
  assert.equal(berry.live_read.status, STATUS.VARIANT_GONE);
  assert.equal(berry.availability.in_stock, false);
  assert.equal(out.product.live_read.gone, 2);
});

test('silence is not evidence: an answer that names no variant and says nothing changes nothing', async () => {
  const { r } = reader({ US: [] }, { quiet: true });
  const pdp = laneigePdp();
  pdp.product.variants[0].availability = { in_stock: true };
  const out = await r.readProduct(pdp, { market: 'US' });
  assert.equal(out.product.live_read.status, STATUS.ERROR);
  assert.equal(out.product.variants[0].availability.in_stock, true);
  assert.equal(out.product.variants[0].live_read, undefined);
});

test('a variant the merchant does not name, while it answers others and is silent on this one, is untouched', async () => {
  const { r } = reader({ US: [variant(LEMON, 2400, 'USD', true)] }, { quiet: true });
  const pdp = laneigePdp();
  pdp.product.variants[1].availability = { in_stock: true };
  const out = await r.readProduct(pdp, { market: 'US' });
  const berry = out.product.variants.find((v) => v.variant_id === BERRY);
  assert.equal(berry.live_read, undefined);
  assert.equal(berry.availability.in_stock, true);
});

test('a 200 that carries a merchant error changes nothing', async () => {
  const client = {
    async discoverEndpoint(base) { return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; },
    async lookupCatalog() {
      return toolResult({
        ucp: { status: 'error' },
        products: [{ id: 'gid://shopify/Product/1', variants: [variant(LEMON, 100, 'USD', true)] }],
        messages: [{ type: 'error', code: 'rate_limited' }],
      });
    },
  };
  const r = createUcpLiveProductReader({ ucpClient: client, mode: 'enforce' });
  const out = await r.readProduct(laneigePdp(), { market: 'US' });
  assert.equal(out.product.live_read.status, STATUS.ERROR);
  assert.equal(out.product.variants[0].current_own_offer_status, 'unavailable');
});

test('shadow serves the stored product at once and logs the comparison afterwards', async () => {
  const { r, logs } = reader(laneigeUS, { mode: 'shadow' });
  const out = await r.readProduct(laneigePdp(), { market: 'US' });
  assert.equal(out, null, 'null = serve the result unchanged');
  for (let i = 0; i < 10 && !logs.length; i += 1) await new Promise((res) => setImmediate(res));
  assert.equal(logs[0].event, 'get_product_ucp_live_read');
  assert.equal(logs[0].status, 'verified');
  assert.equal(logs[0].stock_changed, 2);
});

test('shadow answers before the merchant replies', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const client = fakeClient(laneigeUS);
  const real = client.lookupCatalog;
  client.lookupCatalog = async (...a) => { await gate; return real(...a); };
  const logs = [];
  const r = createUcpLiveProductReader({ ucpClient: client, mode: 'shadow', log: (e, f) => logs.push(f) });
  assert.equal(await r.readProduct(laneigePdp(), { market: 'US' }), null);
  assert.equal(logs.length, 0, 'answered while the merchant had not replied');
  release();
  for (let i = 0; i < 10 && !logs.length; i += 1) await new Promise((res) => setImmediate(res));
  assert.equal(logs[0].status, 'verified');
});

test('off reads nothing', async () => {
  const { r, calls } = reader(laneigeUS, { mode: 'off' });
  assert.equal(await r.readProduct(laneigePdp(), { market: 'US' }), null);
  assert.equal(calls.length, 0);
});

test('more than 10 variants are read in parallel chunks of 10, at most 30', async () => {
  const many = Array.from({ length: 35 }, (_, i) => String(400000000 + i));
  const { r, calls } = reader({ US: many.map((id) => variant(id, 1000, 'USD', true)) });
  const pdp = laneigePdp({ default_variant_id: many[0], variants: many.map((id) => storedVariant(id, id)) });
  const out = await r.readProduct(pdp, { market: 'US' });
  assert.deepEqual(calls.filter((c) => c[0] === 'lookup').map((c) => c[1]), [10, 10, 10]);
  assert.equal(out.product.live_read.verified, 30);
  // Five were never asked: they keep what they had, and the product is in stock because some are.
  assert.equal(out.product.variants[34].live_read, undefined);
  assert.equal(out.product.availability.in_stock, true);
});

test('a slow merchant costs the read, not the product', async () => {
  const slow = { async discoverEndpoint(b) { return { mcpEndpoint: `${b}/api/ucp/mcp` }; }, lookupCatalog: () => new Promise(() => {}) };
  const r = createUcpLiveProductReader({ ucpClient: slow, mode: 'enforce', budgetMs: 30 });
  const out = await r.readProduct(laneigePdp(), { market: 'US' });
  assert.equal(out.product.live_read.status, STATUS.TIMEOUT);
  assert.equal(out.product.price, null);
});

test('helpers: the merchant host is never our own, ids are numeric', () => {
  assert.equal(productHost({ url: 'https://agent.pivota.cc/p/1', destination_url: 'https://us.laneige.com/products/x' }), 'us.laneige.com');
  assert.equal(productHost({ destination_url: 'https://agent.pivota.cc/p/1' }), null);
  assert.deepEqual(productVariantIds({ default_variant_id: BERRY, variants: [{ variant_id: LEMON }, { variant_id: 'SKU-1' }, { variant_id: BERRY }] }), [BERRY, LEMON]);
});

// ------------------------------------------------------------- review of #2438, round 2

test('STRUCTURAL: only the agent get_product tool call opts into the live read', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'src', 'commerceToolSurface.js'), 'utf8');
  const start = src.indexOf('    case "get_product":');
  const block = src.slice(start, start + 900);
  assert.match(block, /live_read: true,/);
  assert.equal((src.match(/live_read: true/g) || []).length, 1, 'no other tool opts in');
});

test('a product whose commerce the PDP blocked is never read or un-blocked', async () => {
  const { r, calls, logs } = reader(laneigeUS);
  const blocked = { ...laneigePdp(), actions: [] };
  blocked.product.availability = { in_stock: false, available_quantity: 0 };
  assert.equal(await r.readProduct(blocked, { market: 'US' }), null);
  assert.equal(calls.length, 0);
  assert.equal(logs[0].reason, 'commerce_blocked');
  const held = laneigePdp({ transaction_ready: false });
  assert.equal(await r.readProduct(held, { market: 'US' }), null);
});

test('stale siblings of a live value go: quantity, compare-at, inventory count', async () => {
  const { r } = reader(laneigeUS);
  const pdp = laneigePdp();
  pdp.product.availability = { in_stock: false, available_quantity: 0 };
  pdp.product.variants[0] = {
    ...pdp.product.variants[0],
    price: { current: { amount: 20, currency: 'USD' }, compare_at: { amount: 30, currency: 'USD' } },
    availability: { in_stock: false, available_quantity: 0 },
    inventory_quantity: 0,
  };
  const out = await r.readProduct(pdp, { market: 'US' });
  const lemon = out.product.variants[0];
  assert.deepEqual(lemon.price, { current: { amount: 24, currency: 'USD' } });
  assert.deepEqual(lemon.availability, { in_stock: true });
  assert.equal(lemon.inventory_quantity, undefined);
  assert.deepEqual(out.product.availability, { in_stock: true });
});

test('a scalar variant price stays a scalar', async () => {
  const { r } = reader(laneigeUS);
  const pdp = laneigePdp();
  pdp.product.variants[0] = { ...pdp.product.variants[0], price: '20.00', currency: 'USD' };
  const out = await r.readProduct(pdp, { market: 'US' });
  assert.equal(out.product.variants[0].price, 24);
  assert.equal(out.product.variants[0].currency, 'USD');
});

test('a declared market Pivota does not price is refused, never swapped for the home market', async () => {
  const { r, calls } = reader(laneigeUS);
  const out = await r.readProduct(laneigePdp({ currency: 'USD' }), { market: 'DE' });
  assert.equal(out.product.live_read.status, STATUS.SKIPPED);
  assert.equal(out.product.live_read.reason, 'market_not_priced');
  assert.equal(calls.length, 0);
});

test('ADR-026: no declared market, no live read -- never a market inferred from the listing currency', async () => {
  const { r, calls } = reader(laneigeUS);
  const declared = await r.readProduct(laneigePdp(), { market: 'US' });
  assert.equal(declared.product.live_read.market_basis, 'declared');
  const before = calls.length;
  const none = await r.readProduct(laneigePdp({ currency: 'USD' }), {});
  assert.equal(none.product.live_read.status, STATUS.SKIPPED);
  assert.equal(none.product.live_read.reason, 'no_market');
  assert.equal(calls.length, before, 'no merchant call');
  assert.equal(none.product.price, laneigePdp({ currency: 'USD' }).product.price, 'nothing re-stamped');
});

test('re-pricing in another currency covers every variant or none (no mixed-currency page)', async () => {
  const many = Array.from({ length: 35 }, (_, i) => String(500000000 + i));
  const { r, calls } = reader({ SG: many.map((id) => variant(id, 3700, 'SGD', true)) });
  const pdp = laneigePdp({ currency: 'USD', default_variant_id: many[0], variants: many.map((id) => storedVariant(id, id)) });
  const out = await r.readProduct(pdp, { market: 'SG' });
  assert.equal(out.product.live_read.status, STATUS.SKIPPED);
  assert.equal(out.product.live_read.reason, 'too_many_variants_to_reprice');
  assert.equal(calls.length, 0);
});

test('a gone variant is named variant_gone, like the offer read', async () => {
  const { r } = reader({ US: [variant(LEMON, 2400, 'USD', true)] });
  const out = await r.readProduct(laneigePdp(), { market: 'US' });
  assert.equal(out.product.variants.find((v) => v.variant_id === BERRY).live_read.status, STATUS.VARIANT_GONE);
});

test('a product with no variants list keeps none', async () => {
  const { r } = reader(laneigeUS);
  const pdp = laneigePdp();
  delete pdp.product.variants;
  pdp.product.default_variant_id = LEMON;
  const out = await r.readProduct(pdp, { market: 'US' });
  assert.equal('variants' in out.product, false);
});

test('at most MAX_CONCURRENT_LOOKUPS lookups are in flight at once', async () => {
  const { createLookupCore } = require('../src/services/ucpLiveOfferRead');
  let inFlight = 0;
  let peak = 0;
  const client = {
    async discoverEndpoint(base) { return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; },
    async lookupCatalog() {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight -= 1;
      return toolResult({ products: [] });
    },
  };
  const core = createLookupCore({ ucpClient: client, now: () => Date.now(), endpointTtlMs: 1000, memoTtlMs: 1, maxConcurrent: 2 });
  await Promise.all(Array.from({ length: 6 }, (_, i) => core.lookup('h.com', 'https://h.com/api/ucp/mcp', [String(600000000 + i)], 'US')));
  assert.equal(peak, 2);
});

// ------------------------------------------------------------- review of #2438, round 3

test('THROUGH THE REAL PRODUCER: a product pdpBuilder suppressed is never read or un-blocked', async () => {
  const { buildPdpPayload } = require('../src/pdpBuilder');
  const base = {
    product_id: 'ext_lsm', merchant_id: 'external_seed', source: 'external_seed', title: 'Lip Sleeping Mask',
    image_url: 'https://cdn.example/lsm.jpg', price: { amount: 24, currency: 'USD' }, currency: 'USD',
    destination_url: 'https://us.laneige.com/products/lip-sleeping-mask',
    variants: [{ variant_id: LEMON, title: 'Lemon Sorbet', price: { amount: 24, currency: 'USD' } }],
  };
  const blocked = buildPdpPayload({ product: { ...base, transaction_ready: false }, relatedProducts: [], entryPoint: 'agent' });
  assert.equal(blocked.product.commerce_suppressed, true, 'the producer states its verdict on the product');
  // What get_product actually returns: the detail normalizer keeps `product` only (no `actions`).
  const { r, calls } = reader(laneigeUS);
  assert.equal(await r.readProduct({ product: blocked.product }, { market: 'US' }), null);
  assert.equal(calls.length, 0);
  const open = buildPdpPayload({ product: base, relatedProducts: [], entryPoint: 'agent' });
  assert.equal(open.product.commerce_suppressed, undefined, 'an open product carries no flag');
});

test('re-pricing into another currency with ANY variant unanswered changes nothing (no mixed page)', async () => {
  const { r } = reader({ SG: [variant(LEMON, 3700, 'SGD', true), variant(BERRY, 3700, 'SGD', true)] }, { quiet: true });
  const pdp = laneigePdp({ currency: 'USD', price: 24 });
  pdp.product.variants = pdp.product.variants.map((v) => ({ ...v, price: { current: { amount: 24, currency: 'USD' } } }));
  const out = await r.readProduct(pdp, { market: 'SG' });
  assert.equal(out.product.live_read.status, STATUS.SKIPPED);
  assert.equal(out.product.live_read.reason, 'incomplete_reprice');
  assert.deepEqual(out.product.variants.map((v) => v.price.current.currency), ['USD', 'USD', 'USD']);
  assert.equal(out.product.price, 24);
});

test('the lookup queue refuses a waiter that outlived every budget, and refuses at once when full', async () => {
  const { createLookupCore } = require('../src/services/ucpLiveOfferRead');
  let t = 0;
  const pending = [];
  const client = {
    async discoverEndpoint(base) { return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; },
    lookupCatalog: () => new Promise((res) => pending.push(() => res(toolResult({ products: [] })))),
  };
  const core = createLookupCore({ ucpClient: client, now: () => t, endpointTtlMs: 1e9, memoTtlMs: 0, maxConcurrent: 1 });
  const first = core.lookup('h.com', 'https://h.com/api/ucp/mcp', ['700000001'], 'US');
  const stale = core.lookup('h.com', 'https://h.com/api/ucp/mcp', ['700000002'], 'US');
  await new Promise((res) => setImmediate(res));
  t += 4000; // the queued caller's budget is long gone
  pending.shift()();
  await first;
  // Bounded wait: a guard that lets the stale waiter run leaves it pending (its lookup is never answered here).
  const outcome = await Promise.race([
    stale.then(() => 'ran', (e) => e.code),
    new Promise((res) => setTimeout(() => res('still_pending'), 50)),
  ]);
  assert.equal(outcome, 'timeout');
  assert.equal(pending.length, 0, 'the stale lookup was never sent');
});
