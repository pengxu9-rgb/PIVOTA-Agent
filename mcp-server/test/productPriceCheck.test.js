// UNDER UCP_LIVE_PRODUCT_READ=enforce, A STORED FALLBACK MUST NOT PASS FOR A MERCHANT-CONFIRMED PRICE on the doors
// whose answer shape drops the native `live_read` / `price_as_of` / `price_source`: the UCP get_product shaper and
// the public projection. Products come from the REAL product reader (src/services/ucpLiveOfferRead) on the shape
// the detail lane serves, and go through the REAL shaper and projector. Without a live_read (read off, or shadow)
// both answers are exactly what they were.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { productPriceCheck } from '../src/productPriceCheck.js';
import { shapeUcpGetProductResponse } from '../src/ucpResponseShaper.js';
import { projectPublicReadResult, DENYLIST_FIELDS } from '../src/publicReadProjection.js';

const require = createRequire(import.meta.url);
const { createUcpLiveProductReader } = require('../../src/services/ucpLiveOfferRead.js');

// The readers' deadline timers are unref'd; keep the loop alive for the file's duration.
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
test.after(() => clearInterval(keepAlive));

const NOW = Date.parse('2026-10-27T09:00:00.000Z');
const ROSE = '43734829564039';
const PLUM = '43734829564040';
const gid = (id) => `gid://shopify/ProductVariant/${id}`;

function stored(extra = {}) {
  return {
    product: {
      product_id: 'sig_pr5_tint',
      title: 'Tint',
      brand: 'Brand T',
      description: 'A lip tint.',
      price: 25,
      currency: 'USD',
      availability: 'in_stock',
      in_stock: true,
      destination_url: 'https://store.pr5.test/products/tint',
      default_variant_id: ROSE,
      variants: [
        { variant_id: ROSE, title: 'Rose', price: { current: { amount: 25, currency: 'USD' } }, availability: { in_stock: true } },
        { variant_id: PLUM, title: 'Plum', price: { current: { amount: 27, currency: 'USD' } }, availability: { in_stock: true } },
      ],
      ...extra,
    },
  };
}
const answer = (payload) => ({ ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
const v = (id, minor, currency) => ({ id: gid(id), price: { amount: minor, currency }, availability: { available: true } });

async function enforced(lookup, ctx = { market: 'US' }, extra = {}) {
  const reader = createUcpLiveProductReader({
    mode: 'enforce',
    now: () => NOW,
    log: () => {},
    ucpClient: {
      async discoverEndpoint(base) { return { mcpEndpoint: `${base}/api/ucp/mcp`, status: 200 }; },
      async lookupCatalog(endpoint, { ids }) { return lookup(ids); },
    },
  });
  return reader.readProduct(stored(extra), ctx);
}

const VERIFIED = () => answer({ products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants: [v(ROSE, 2300, 'USD'), v(PLUM, 2500, 'USD')] }], messages: [] });
const ONLY_PLUM = () => answer({ products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants: [v(PLUM, 2500, 'USD')] }], messages: [] });
const THROWS = () => { throw new Error('ECONNRESET at 10.0.0.1:443 secret-ish detail'); };
const priceMessages = (shaped) => (shaped.messages || []).filter((m) => /^price\./.test(m.code));

test('no live_read (read off or shadow): the UCP and public answers are exactly what they were', () => {
  const raw = stored();
  assert.equal(productPriceCheck(raw.product), null);
  const ucp = shapeUcpGetProductResponse(raw, {});
  assert.equal(ucp.messages, undefined, 'no messages were added');
  const pub = projectPublicReadResult('get_product', raw);
  assert.equal('price_check' in pub, false);
});

test('verified headline: UCP says the merchant price and when; public says confirmed, undated', async () => {
  const out = await enforced(VERIFIED);
  assert.deepEqual(productPriceCheck(out.product), { live: true, market: 'US', as_of: '2026-10-27T09:00:00.000Z' });
  const ucp = shapeUcpGetProductResponse(out, {});
  assert.equal(ucp.product.price_range.min.amount, 2300);
  assert.deepEqual(priceMessages(ucp), [{
    type: 'info',
    code: 'price.merchant_verified',
    path: '$.product.price_range',
    content: "The price was read from the merchant's own catalog for US at 2026-10-27T09:00:00.000Z.",
    content_type: 'plain',
  }]);
  const pub = projectPublicReadResult('get_product', out);
  assert.equal(pub.price.amount, 23);
  assert.deepEqual(pub.price_check, { confirmed_with_merchant: true, market: 'US' });
});

const FALLBACKS = [
  ['no_market', () => enforced(() => assert.fail('never'), {}), 'no_market', null],
  ['market_not_priced', () => enforced(() => assert.fail('never'), { market: 'ZZ' }), 'market_not_priced', null],
  ['timeout', () => {
    const reader = createUcpLiveProductReader({
      mode: 'enforce', budgetMs: 30, log: () => {},
      ucpClient: { async discoverEndpoint(b) { return { mcpEndpoint: `${b}/u`, status: 200 }; }, lookupCatalog: () => new Promise(() => {}) },
    });
    return reader.readProduct(stored(), { market: 'US' });
  }, 'timeout', 'US'],
  ['lookup throws (free-text error)', () => enforced(THROWS), 'error', 'US'],
  ['merchant error', () => enforced(() => answer({ ucp: { status: 'error' }, products: [{ id: 'p', handle: 'tint', variants: [v(ROSE, 100, 'USD')] }], messages: [{ type: 'error', code: 'rate_limited' }] })), 'merchant_error', 'US'],
  ['currency_mismatch', () => enforced(() => answer({ products: [{ id: 'p', handle: 'tint', variants: [v(ROSE, 3200, 'SGD'), v(PLUM, 3400, 'SGD')] }], messages: [] })), 'currency_mismatch', 'US'],
  ['verified, headline not read', () => enforced(ONLY_PLUM), 'headline_not_read', 'US'],
  ['stale merchant_live card, headline not read', () => enforced(ONLY_PLUM, { market: 'US' }, { price_source: 'merchant_live' }), 'headline_not_read', 'US'],
  ['reader_error', async () => {
    const reader = createUcpLiveProductReader({
      mode: 'enforce', now: () => NOW, log: () => { throw new Error('sink down'); },
      ucpClient: { async discoverEndpoint(b) { return { mcpEndpoint: `${b}/u`, status: 200 }; }, async lookupCatalog() { return VERIFIED(); } },
    });
    return reader.readProduct(stored(), { market: 'US' });
  }, 'reader_error', null],
];

for (const [name, run, reason, market] of FALLBACKS) {
  test(`fallback (${name}): UCP warns price.stored with a fixed reason; public says not confirmed`, async () => {
    const out = await run();
    assert.equal(out.product.price, 25, 'the stored price is served');
    const check = productPriceCheck(out.product);
    assert.equal(check.live, false);
    assert.equal(check.reason, reason);
    assert.equal(check.market, market);
    const ucp = shapeUcpGetProductResponse(out, {});
    assert.equal(ucp.product.price_range.min.amount, 2500);
    const [msg, ...more] = priceMessages(ucp);
    assert.equal(more.length, 0);
    assert.equal(msg.type, 'warning');
    assert.equal(msg.code, 'price.stored');
    assert.equal(msg.path, '$.product.price_range');
    assert.match(msg.content, /Pivota's stored price; it was not confirmed with the merchant/);
    assert.ok(msg.content.includes(`(${reason})`), msg.content);
    assert.match(msg.content, /get_offers/);
    if (market) assert.ok(msg.content.includes(`for ${market}`));
    assert.doesNotMatch(msg.content, /ECONNRESET|10\.0\.0\.1|secret/, 'a free-text error never reaches the buyer');
    const pub = projectPublicReadResult('get_product', out);
    assert.equal(pub.price.amount, 25);
    assert.deepEqual(pub.price_check, { confirmed_with_merchant: false, ...(market ? { market } : {}), reason });
  });
}

test('public price_check carries no timestamp and no denylisted key', async () => {
  for (const out of [await enforced(VERIFIED), await enforced(() => assert.fail('never'), {})]) {
    const text = JSON.stringify(projectPublicReadResult('get_product', out));
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'no ISO timestamp on the public tier');
    for (const k of Object.keys(projectPublicReadResult('get_product', out).price_check)) assert.ok(!DENYLIST_FIELDS.includes(k), k);
  }
});

test('an unpriced public product gets no price_check (nothing to label)', async () => {
  const out = await enforced(() => assert.fail('never'), {}, { price: null, currency: null, variants: [] });
  const pub = projectPublicReadResult('get_product', out);
  assert.equal(pub.price, undefined);
  assert.equal('price_check' in pub, false);
});

test('productPriceCheck: an unknown reason or status is dropped, never echoed; a non-ISO-2 market is null', () => {
  assert.deepEqual(productPriceCheck({ live_read: { status: 'error', reason: 'socket hang up', market: 'US' } }), { live: false, market: 'US', reason: 'error' });
  assert.deepEqual(productPriceCheck({ live_read: { status: 'weird', reason: 'free text' } }), { live: false, market: null });
  assert.deepEqual(productPriceCheck({ live_read: { status: 'verified', market: 'USA', checked_at: 'x' }, price_as_of: 'x' }), { live: true, market: null, as_of: 'x' });
  assert.deepEqual(productPriceCheck({ live_read: { status: 'verified', checked_at: 'a' }, price_as_of: 'b' }), { live: false, market: null, reason: 'headline_not_read' });
  assert.equal(productPriceCheck({ live_read: 'verified' }), null);
  assert.equal(productPriceCheck(null), null);
});
