'use strict';

// UCP LIVE PRODUCT READ (get_product variants). The Laneige case, 2026-10-14: get_product served every
// flavour `current_own_offer_status: unavailable` with no price, while the merchant's lookup_catalog
// answered them in stock at $24. The fake answers in the live response shape and the real unwrap reads it.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createUcpLiveProductReader,
  marketForCurrency,
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

test('no declared market: the listing is checked in its own currency home market', async () => {
  const { r, calls } = reader(laneigeUS);
  const pdp = laneigePdp({ currency: 'USD' });
  const out = await r.readProduct(pdp, {});
  assert.equal(out.product.live_read.market, 'US');
  assert.ok(calls.some((c) => c[0] === 'lookup' && c[2] === 'US'));
});

test('no declared market and no single home market (EUR, or no currency): nothing is read', async () => {
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
  assert.equal(berry.live_read.status, 'gone');
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

test('helpers: the merchant host is never our own, ids are numeric, EUR names no single market', () => {
  assert.equal(productHost({ url: 'https://agent.pivota.cc/p/1', destination_url: 'https://us.laneige.com/products/x' }), 'us.laneige.com');
  assert.equal(productHost({ destination_url: 'https://agent.pivota.cc/p/1' }), null);
  assert.deepEqual(productVariantIds({ default_variant_id: BERRY, variants: [{ variant_id: LEMON }, { variant_id: 'SKU-1' }, { variant_id: BERRY }] }), [BERRY, LEMON]);
  assert.equal(marketForCurrency('USD'), 'US');
  assert.equal(marketForCurrency('EUR'), null);
});
