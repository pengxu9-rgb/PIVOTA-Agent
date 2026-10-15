'use strict';

// UCP LIVE PRODUCT READ (get_product variants). The Laneige case, 2026-10-14: get_product served every
// flavour `current_own_offer_status: unavailable` with no price, while the merchant's lookup_catalog
// answered them in stock at $24. The fake answers in the live response shape and the real unwrap reads it.

const test = require('node:test');
const assert = require('node:assert/strict');

// The readers' budget/deadline timers are unref'd (right in prod: they must never hold the process open).
// A test whose only pending work is such a timer would let this file's node:test child exit with the
// promise unresolved, cancelling every later test (cancelledByParent; CI's Node 20). Keep the loop alive
// for the file's duration.
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
require('node:test').after(() => clearInterval(keepAlive));

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
        // A real store answers with the product page the variant is on (lookup_catalog `handle`).
        products: vs.length ? [{ id: 'gid://shopify/Product/1', handle: 'lip-sleeping-mask', variants: vs }] : [],
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

// ------------------------------------------------------------- PR controller review of #2438, round 2

test('flags off, the tool surface is what it was: get_product `market` and the get_offers live_read text are gated', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const url = require('node:url').pathToFileURL(path.join(__dirname, '..', 'mcp-server', 'src', 'commerceToolSurface.js')).href;
  const probe = (extra) => {
    const env = { ...process.env };
    for (const k of ['UCP_LIVE_OFFER_READ', 'UCP_LIVE_PRODUCT_READ', 'UCP_LIVE_SEARCH_READ', 'GET_OFFERS_VARIANT_ID']) delete env[k];
    Object.assign(env, extra);
    const code = `const m = await import(${JSON.stringify(url)});
      const p = m.commerceToolDefinitions.find((d) => d.name === 'get_product');
      const o = m.commerceToolDefinitions.find((d) => d.name === 'get_offers');
      console.log(JSON.stringify({ market: 'market' in p.inputSchema.properties, liveRead: /live_read/.test(o.description) }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  assert.deepEqual(probe({}), { market: false, liveRead: false });
  assert.deepEqual(probe({ UCP_LIVE_PRODUCT_READ: 'shadow', UCP_LIVE_OFFER_READ: 'shadow' }), { market: true, liveRead: false });
  assert.deepEqual(probe({ UCP_LIVE_PRODUCT_READ: 'enforce', UCP_LIVE_OFFER_READ: 'enforce' }), { market: true, liveRead: true });
  assert.deepEqual(probe({ UCP_LIVE_PRODUCT_READ: 'bogus' }), { market: false, liveRead: false });
});

// ------------------------------------------------------------- frontend PDP (get_pdp_v2) shadow read

test('the PDP shadow line has its own name, the caller fields, and counts shown-unavailable-but-in-stock', async () => {
  const logs = [];
  const r = createUcpLiveProductReader({
    ucpClient: fakeClient(laneigeUS), mode: 'shadow', event: 'get_pdp_v2_ucp_live_read',
    log: (e, f) => logs.push({ event: e, ...f }),
  });
  const page = laneigePdp();
  // Berry is already shown in stock: it is not a "shown unavailable" variant, whatever the merchant says.
  page.product.variants[1] = { variant_id: BERRY, title: 'Berry', availability: { in_stock: true } };
  const before = JSON.stringify(page);
  const out = await r.readProduct(page, {
    market: 'US',
    logFields: { surface: 'get_pdp_v2', own_money_gap: 'CURRENT_OWN_OFFER_UNAVAILABLE', leaked: 'https://x.example/?token=1', Bad: 1 },
  });
  assert.equal(out, null, 'shadow never returns a page');
  for (let i = 0; i < 20 && !logs.length; i += 1) await new Promise((res) => setImmediate(res));
  assert.equal(JSON.stringify(page), before, 'the page object is untouched, after the read completed');
  const line = logs[0];
  assert.equal(line.event, 'get_pdp_v2_ucp_live_read');
  assert.equal(line.surface, 'get_pdp_v2');
  assert.equal(line.own_money_gap, 'CURRENT_OWN_OFFER_UNAVAILABLE');
  assert.equal('leaked' in line, false, 'no URL or free text from the caller');
  assert.equal('Bad' in line, false);
  assert.equal(line.own_unavailable_live_in_stock, 1, 'Lemon only: shown unavailable, merchant in stock (Berry was shown in stock)');
});

test('shown unavailable = the own-money verdict OR stored stock OR a read-only page', async () => {
  const count = async (variants, ctx = {}) => {
    const logs = [];
    const r = createUcpLiveProductReader({ ucpClient: fakeClient(laneigeUS), mode: 'shadow', log: (e, f) => logs.push(f) });
    await r.readProduct(laneigePdp({ variants }), { market: 'US', ...ctx });
    for (let i = 0; i < 20 && !logs.length; i += 1) await new Promise((res) => setImmediate(res));
    return logs[0].own_unavailable_live_in_stock;
  };
  // Lemon and Berry are in stock at the merchant (Vanilla is not).
  assert.equal(await count([{ variant_id: LEMON, current_own_offer_status: 'unavailable' }, { variant_id: BERRY }]), 1, 'verdict alone');
  assert.equal(await count([{ variant_id: LEMON, availability: { in_stock: false } }, { variant_id: BERRY }]), 1, 'stored stock alone');
  assert.equal(await count([{ variant_id: LEMON, availability: { in_stock: true } }, { variant_id: BERRY, availability: { in_stock: true } }],
    { pageShowsAllUnavailable: true }), 2, 'a read-only page shows every variant unavailable');
});

test('the agent get_product line keeps its name', async () => {
  const { r, logs } = reader(laneigeUS, { mode: 'shadow' });
  await r.readProduct(laneigePdp(), { market: 'US' });
  for (let i = 0; i < 20 && !logs.length; i += 1) await new Promise((res) => setImmediate(res));
  assert.equal(logs[0].event, 'get_product_ucp_live_read');
});

test('get_pdp_v2 hook: off by default, sampled when on, never changes the page (server)', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const server = path.join(__dirname, '..', 'src', 'server.js');
  const run = (env) => {
    const code = `
      const { shadowPdpLiveRead, ucpLivePdpSample } = require(${JSON.stringify(server)})._debug;
      // A page with no merchant host: the read skips before any network call.
      const page = { modules: [{ type: 'canonical', data: { pdp_payload: { product: {
        product_id: 'sig_x', price: { current: { amount: 24, currency: 'USD' } },
        variants: [{ variant_id: '31760703160372', availability: { in_stock: false }, current_own_offer_status: 'unavailable' }] } } } }] };
      const before = JSON.stringify(page);
      const hit = shadowPdpLiveRead(page, { market: 'US', ownMoneyGap: 'X', random: () => 0 });
      const miss = shadowPdpLiveRead(page, { market: 'US', random: () => 0.99 });
      console.log(JSON.stringify({ hit, miss, sample: ucpLivePdpSample(), same: JSON.stringify(page) === before }));
      setTimeout(() => process.exit(0), 50);`;
    const childEnv = { ...process.env };
    for (const k of ['UCP_LIVE_PDP_READ', 'UCP_LIVE_PDP_READ_SAMPLE', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete childEnv[k];
    Object.assign(childEnv, env);
    const r = spawnSync(process.execPath, ['-e', code], { env: childEnv, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    return JSON.parse(r.stdout.trim().split('\n').find((l) => l.includes('"hit"')));
  };
  assert.deepEqual(run({}), { hit: false, miss: false, sample: 0.1, same: true });
  assert.deepEqual(run({ UCP_LIVE_PDP_READ: 'shadow' }), { hit: true, miss: false, sample: 0.1, same: true });
  assert.deepEqual(run({ UCP_LIVE_PDP_READ: 'enforce', UCP_LIVE_PDP_READ_SAMPLE: '1' }), { hit: true, miss: true, sample: 1, same: true });
});

test('STRUCTURAL: get_pdp_v2 shadow-reads with the buyer market before its own-money projections', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const i = src.indexOf('      const shadowPdpRead = (pageState) => shadowPdpLiveRead(responsePayload, {');
  assert.ok(i > 0);
  assert.match(src.slice(i, i + 260), /market: offersGateBuyerMarket\(payload, metadata\),\s+ownMoneyGap: canonicalOwnMoneyGap \|\| null,\s+pageState,/);
  const block = src.slice(i, src.indexOf('} catch (err) {', i));
  // EVERY success return logs what it shows.
  assert.match(block, /shadowPdpRead\('read_only'\);\s+return res\.json\(projectReadOnlyPdpResponse/);
  assert.match(block, /shadowPdpRead\(verifiedReady \? 'verified' : 'read_only'\);/);
  assert.match(block, /shadowPdpRead\(canonicalOwnMoneyGap \? 'own_money_gap' : 'served'\);\s+return res\.json\(canonicalOwnMoneyGap/);
  const g = src.indexOf('function getUcpLivePdpReader()');
  assert.match(src.slice(g, g + 700), /mode: MODES\.SHADOW,/);
});

// ------------------------------------------------------------- per-store in-flight cap

test('a core with maxPerHost refuses (never queues) a lookup over the cap for that store only', { timeout: 10000 }, async () => {
  const { createLookupCore } = require('../src/services/ucpLiveOfferRead');
  let open;
  const gate = new Promise((res) => { open = res; });
  const client = {
    async discoverEndpoint(base) { return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; },
    async lookupCatalog() { await gate; return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: '{"products":[]}' }] } } }; },
  };
  const core = createLookupCore({ ucpClient: client, now: () => Date.now(), endpointTtlMs: 60000, memoTtlMs: 5000, maxPerHost: 3 });
  const ep = 'https://a.example/api/ucp/mcp';
  try {
    const held = [1, 2, 3].map((i) => core.lookup('a.example', ep, [String(100000 + i)], 'US'));
    assert.equal(core.hostHasRoom('a.example', 1), false);
    await assert.rejects(core.lookup('a.example', ep, ['100009'], 'US'), (e) => e.code === 'host_busy');
    // A coalesced repeat of an in-flight lookup sends nothing, so the cap does not refuse it.
    const repeat = core.lookup('a.example', ep, ['100001'], 'US');
    const other = core.lookup('b.example', 'https://b.example/api/ucp/mcp', ['100001'], 'US');
    open();
    await Promise.all([...held, repeat, other]);
    await new Promise((res) => setImmediate(res));
    assert.equal(core.stats().hostsInFlight, 0, 'slots are released when lookups settle');
    assert.equal(core.hostHasRoom('a.example', 3), true);
  } finally {
    open();
  }
});

test('a lookup that FAILS releases its per-store slot', { timeout: 10000 }, async () => {
  const { createLookupCore } = require('../src/services/ucpLiveOfferRead');
  const client = {
    async discoverEndpoint(base) { return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; },
    async lookupCatalog() { return { ok: false, status: 503 }; },
  };
  const core = createLookupCore({ ucpClient: client, now: () => Date.now(), endpointTtlMs: 60000, memoTtlMs: 1, maxPerHost: 1 });
  await assert.rejects(core.lookup('a.example', 'https://a.example/api/ucp/mcp', ['100001'], 'US'));
  await new Promise((res) => setImmediate(res));
  assert.equal(core.stats().hostsInFlight, 0);
  assert.equal(core.hostHasRoom('a.example', 1), true);
});

test('a capped product read that does not fit sends nothing and is logged skipped host_busy', async () => {
  const many = Array.from({ length: 30 }, (_, i) => String(600000000 + i));
  const calls = [];
  const client = fakeClient({ US: many.map((id) => variant(id, 2400, 'USD', true)) }, calls);
  const core = require('../src/services/ucpLiveOfferRead').createLookupCore({
    ucpClient: client, now: () => Date.now(), endpointTtlMs: 60000, memoTtlMs: 1000, maxPerHost: 2,
  });
  const logs = [];
  const r = createUcpLiveProductReader({ ucpClient: client, mode: 'enforce', core, log: (e, f) => logs.push(f) });
  const out = await r.readProduct(laneigePdp({ currency: 'USD', default_variant_id: many[0], variants: many.map((id) => storedVariant(id, id)) }), { market: 'US' });
  assert.equal(out.product.live_read.status, STATUS.SKIPPED);
  assert.equal(out.product.live_read.reason, 'host_busy');
  assert.equal(calls.filter((c) => c[0] === 'lookup').length, 0, 'no half read: no chunk was sent');
});

test('a full 30-variant product read fits under the PDP cap of 3 (3 chunks of 10)', async () => {
  const many = Array.from({ length: 30 }, (_, i) => String(500000000 + i));
  const r = createUcpLiveProductReader({
    ucpClient: fakeClient({ US: many.map((id) => variant(id, 2400, 'USD', true)) }),
    mode: 'enforce',
    core: require('../src/services/ucpLiveOfferRead').createLookupCore({
      ucpClient: fakeClient({ US: many.map((id) => variant(id, 2400, 'USD', true)) }), now: () => Date.now(),
      endpointTtlMs: 60000, memoTtlMs: 1000, maxPerHost: 3,
    }),
  });
  const out = await r.readProduct(laneigePdp({ currency: 'USD', default_variant_id: many[0], variants: many.map((id) => storedVariant(id, id)) }), { market: 'US' });
  assert.equal(out.product.live_read.status, STATUS.VERIFIED);
  assert.equal(out.product.live_read.verified, 30);
});

test('STRUCTURAL: only the frontend PDP reader is capped per store (3)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const g = src.indexOf('function getUcpLivePdpReader()');
  assert.match(src.slice(g, g + 900), /\.\.\.ucpLiveReaderDeps\(8, \{ maxPerHost: 3 \}\),/);
  for (const getter of ['getUcpLiveProductReader', 'getUcpLiveOfferReader', 'getUcpLiveSearchReader']) {
    const i = src.indexOf(`function ${getter}()`);
    assert.doesNotMatch(src.slice(i, i + 900), /maxPerHost/, getter);
  }
});

test('a second viewer of a product being read shares its lookups and is not refused', { timeout: 10000 }, async () => {
  const many = Array.from({ length: 30 }, (_, i) => String(700000000 + i));
  let open;
  const gate = new Promise((res) => { open = res; });
  const calls = [];
  const base = fakeClient({ US: many.map((id) => variant(id, 2400, 'USD', true)) }, calls);
  const client = { ...base, async lookupCatalog(...a) { await gate; return base.lookupCatalog(...a); } };
  const core = require('../src/services/ucpLiveOfferRead').createLookupCore({
    ucpClient: client, now: () => Date.now(), endpointTtlMs: 60000, memoTtlMs: 5000, maxPerHost: 3,
  });
  const r = createUcpLiveProductReader({ ucpClient: client, mode: 'enforce', core });
  const pdp = () => laneigePdp({ currency: 'USD', default_variant_id: many[0], variants: many.map((id) => storedVariant(id, id)) });
  try {
    const first = r.readProduct(pdp(), { market: 'US' });
    for (let i = 0; i < 20 && calls.filter((c) => c[0] === 'lookup').length < 3; i += 1) await new Promise((res) => setImmediate(res));
    const second = r.readProduct(pdp(), { market: 'US' });
    open();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.product.live_read.status, STATUS.VERIFIED);
    assert.equal(b.product.live_read.status, STATUS.VERIFIED, 'not host_busy');
    assert.equal(calls.filter((c) => c[0] === 'lookup').length, 3, 'three lookups for both viewers');
  } finally {
    open();
  }
});
