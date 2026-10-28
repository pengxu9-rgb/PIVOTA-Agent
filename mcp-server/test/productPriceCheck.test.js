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
  assert.deepEqual(productPriceCheck(out.product), { live: true, market: 'US', as_of: '2026-10-27T09:00:00.000Z', read_variants: 2, stored_variants: 0 });
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
    // Public: only the reasons an agent can act on; the reader's internals are not diagnostics it serves.
    const publicReason = ['no_market', 'market_not_priced'].includes(reason) ? { reason } : {};
    assert.deepEqual(pub.price_check, { confirmed_with_merchant: false, ...(market ? { market } : {}), ...publicReason });
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
  assert.deepEqual(productPriceCheck({ live_read: { status: 'verified', market: 'USA', checked_at: 'x' }, price_as_of: 'x' }), { live: true, market: null, as_of: 'x', read_variants: 0, stored_variants: 0 });
  assert.deepEqual(productPriceCheck({ live_read: { status: 'verified', checked_at: 'a' }, price_as_of: 'b' }), { live: false, market: null, reason: 'headline_not_read' });
  assert.equal(productPriceCheck({ live_read: 'verified' }), null);
  assert.equal(productPriceCheck(null), null);
});

// ------------------------------------------------------------------------- B3: a partly read product (controller r2)

const ROSE_ONLY = () => answer({ products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants: [v(ROSE, 2300, 'USD')] }], messages: [] });

test('partly read (the merchant answers Rose, is silent on Plum): UCP counts what was read, never claims the whole range', async () => {
  const out = await enforced(ROSE_ONLY);
  assert.equal(out.product.price, 23, 'the headline is the merchant\'s');
  assert.equal(out.product.variants[1].live_read, undefined, 'Plum keeps its stored price');
  assert.deepEqual(productPriceCheck(out.product), { live: true, market: 'US', as_of: '2026-10-27T09:00:00.000Z', read_variants: 1, stored_variants: 1 });
  const ucp = shapeUcpGetProductResponse(out, {});
  assert.deepEqual([ucp.product.price_range.min.amount, ucp.product.price_range.max.amount], [2300, 2700], 'a range of read and stored prices');
  const msgs = priceMessages(ucp);
  assert.equal(msgs.length, 1);
  assert.deepEqual([msgs[0].type, msgs[0].code, msgs[0].path], ['warning', 'price.partially_verified', '$.product.price_range']);
  assert.match(msgs[0].content, /^The merchant's own catalog for US \(at 2026-10-27T09:00:00\.000Z\) confirmed 1 of 2 variants, the default among them; 1 variant shows Pivota's stored price, or the product price where it has none of its own\./);
  assert.ok(!msgs.some((m) => m.code === 'price.merchant_verified'), 'never labelled verified');
  // Public shows the headline only, and the headline was read.
  assert.deepEqual(projectPublicReadResult('get_product', out).price_check, { confirmed_with_merchant: true, market: 'US' });
});

test('more variants than one read covers (30): the unasked ones are stored, so UCP says 30 of 32', async () => {
  const ids = Array.from({ length: 32 }, (_, i) => String(43734829564100 + i));
  const variants = ids.map((id, i) => ({ variant_id: id, title: `Shade ${i}`, price: { current: { amount: 25, currency: 'USD' } }, availability: { in_stock: true } }));
  const asked = [];
  const out = await enforced((idsAsked) => {
    asked.push(...idsAsked);
    return answer({ products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants: idsAsked.map((g) => ({ id: g, price: { amount: 2300, currency: 'USD' }, availability: { available: true } })) }], messages: [] });
  }, { market: 'US' }, { default_variant_id: ids[0], variants });
  assert.equal(asked.length, 30, 'the reader asks for at most 30');
  const check = productPriceCheck(out.product);
  assert.equal(check.live, true);
  assert.deepEqual([check.read_variants, check.stored_variants], [30, 2]);
  const msg = priceMessages(shapeUcpGetProductResponse(out, {}))[0];
  assert.equal(msg.code, 'price.partially_verified');
  assert.match(msg.content, /confirmed 30 of 32 variants, the default among them; 2 variants show Pivota's stored price/);
});

test('every variant read: merchant_verified', async () => {
  const out = await enforced(VERIFIED);
  assert.deepEqual([productPriceCheck(out.product).read_variants, productPriceCheck(out.product).stored_variants], [2, 0]);
  assert.equal(priceMessages(shapeUcpGetProductResponse(out, {}))[0].code, 'price.merchant_verified');
});

// R1 (controller r3): the UCP shaper publishes a variant with no price of its own (null, or the 0 placeholder
// feeds carry) at the PRODUCT price, which is the live headline. A variant the merchant never priced must not
// sit under "read from the merchant's own catalog".
test('R1: unpriced variants never answered are published at the product price, so the product is only partially verified', async () => {
  const ids = [ROSE, '43734829564201', '43734829564202', '43734829564203'];
  const variants = [
    { variant_id: ROSE, title: 'Rose', price: { current: { amount: 25, currency: 'USD' } }, availability: { in_stock: true } },
    ...ids.slice(1).map((id, i) => ({ variant_id: id, title: `Unpriced ${i}`, price: null, availability: { in_stock: true } })),
  ];
  const out = await enforced(() => answer({ products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants: [v(ROSE, 2000, 'USD')] }], messages: [] }), { market: 'US' }, { variants });
  assert.equal(out.product.price, 20);
  const check = productPriceCheck(out.product);
  assert.deepEqual([check.read_variants, check.stored_variants], [1, 3]);
  const ucp = shapeUcpGetProductResponse(out, {});
  const msgs = priceMessages(ucp);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].code, 'price.partially_verified', JSON.stringify(ucp.product.variants.map((x) => x.price)));
  assert.match(msgs[0].content, /confirmed 1 of 4 variants, the default among them; 3 variants show/);
});

test('R1: 35 variants with 0 placeholders, the last 5 never asked: partially verified, never merchant_verified', async () => {
  const ids = Array.from({ length: 35 }, (_, i) => String(43734829564300 + i));
  const variants = ids.map((id, i) => ({ variant_id: id, title: `Shade ${i}`, price: { current: { amount: i === 0 ? 25 : 0, currency: 'USD' } }, availability: { in_stock: true } }));
  const out = await enforced((idsAsked) => answer({
    products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants: idsAsked.map((g) => ({ id: g, price: { amount: 2000, currency: 'USD' }, availability: { available: true } })) }],
    messages: [],
  }), { market: 'US' }, { default_variant_id: ids[0], variants });
  const check = productPriceCheck(out.product);
  assert.deepEqual([check.read_variants, check.stored_variants], [30, 5]);
  const msgs = priceMessages(shapeUcpGetProductResponse(out, {}));
  assert.deepEqual(msgs.map((m) => m.code), ['price.partially_verified']);
  assert.match(msgs[0].content, /confirmed 30 of 35 variants.*5 variants show/);
});

test('a variant the merchant says is gone carries a live_read and is still counted stored (its price was not read)', async () => {
  const out = await enforced(() => answer({
    products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants: [v(ROSE, 2300, 'USD')] }],
    messages: [{ type: 'info', code: 'not_found', content: gid(PLUM) }],
  }));
  assert.equal(out.product.variants[1].live_read.status, 'variant_gone');
  const check = productPriceCheck(out.product);
  assert.deepEqual([check.read_variants, check.stored_variants], [1, 1]);
  assert.equal(priceMessages(shapeUcpGetProductResponse(out, {}))[0].code, 'price.partially_verified');
});

test('a product with no variants list: the headline is the whole claim', async () => {
  const out = await enforced(VERIFIED);
  delete out.product.variants;
  assert.deepEqual([productPriceCheck(out.product).read_variants, productPriceCheck(out.product).stored_variants], [0, 0]);
});

test('public price_check never carries an internal reason token', async () => {
  for (const run of [() => enforced(THROWS), () => enforced(ONLY_PLUM)]) {
    const pc = projectPublicReadResult('get_product', await run()).price_check;
    assert.equal(pc.confirmed_with_merchant, false);
    assert.equal('reason' in pc, false, JSON.stringify(pc));
  }
  assert.deepEqual(projectPublicReadResult('get_product', await enforced(() => assert.fail('never'), {})).price_check, { confirmed_with_merchant: false, reason: 'no_market' });
});

// R2 (controller r4): the merchant answers the default variant's PRICE but not its stock, and Plum in full. The
// default variant keeps its stored price (a variant is re-priced only with both); the headline must agree.
const ROSE_NO_STOCK = () => answer({
  products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants: [
    { id: gid(ROSE), price: { amount: 2300, currency: 'USD' }, availability: { available: null } },
    v(PLUM, 2100, 'USD'),
  ] }],
  messages: [],
});

test('R2: default answered with a price but no stock: the headline stays stored with its variant, and nothing claims the default was read', async () => {
  const out = await enforced(ROSE_NO_STOCK);
  const p = out.product;
  assert.equal(p.variants[0].live_read, undefined, 'Rose is not verified (no stock answer)');
  assert.equal(p.variants[0].price.current.amount, 25);
  assert.equal(p.variants[1].live_read.status, 'verified');
  assert.equal(p.variants[1].price.current.amount, 21);
  assert.equal(p.price, 25, 'the headline agrees with its variant: stored');
  assert.equal(p.price_as_of, undefined, 'and is not dated');
  assert.equal(p.price_source, undefined);
  assert.deepEqual(productPriceCheck(p), { live: false, market: 'US', reason: 'headline_not_read' });
  const msgs = priceMessages(shapeUcpGetProductResponse(out, {}));
  assert.deepEqual(msgs.map((m) => [m.type, m.code]), [['warning', 'price.stored']]);
  assert.doesNotMatch(msgs[0].content, /default among them/);
  assert.deepEqual(projectPublicReadResult('get_product', out).price_check, { confirmed_with_merchant: false, market: 'US' });
});

test('R2 guard: a headline dated by a read while its listed default variant is not verified is never live', () => {
  const p = {
    price: 23, price_as_of: 't', default_variant_id: 1,
    live_read: { status: 'verified', market: 'US', checked_at: 't' },
    variants: [{ variant_id: '1', price: { current: { amount: 25 } } }, { variant_id: '2', live_read: { status: 'verified' } }],
  };
  assert.deepEqual(productPriceCheck(p), { live: false, market: 'US', reason: 'headline_not_read' });
  p.variants[0].live_read = { status: 'verified' };
  assert.equal(productPriceCheck(p).live, true, 'once the default variant is verified, the headline is live');
  delete p.default_variant_id;
  assert.equal(productPriceCheck(p).live, true, 'no default named: the headline stamp decides');
});

// R4 (controller r5): "answered" means the merchant gave a price AND a stock flag, not that the variant is in
// stock. A default variant priced but out of stock was read: it is re-priced, the headline follows it and is
// dated, and the label is merchant_verified. Only a missing stock flag (R2 above) leaves it stored.
const ROSE_SOLD_OUT = () => answer({
  products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants: [
    { id: gid(ROSE), price: { amount: 2300, currency: 'USD' }, availability: { available: false } },
    v(PLUM, 2100, 'USD'),
  ] }],
  messages: [],
});

test('R4: default answered out of stock (available:false) is still read: re-priced, headline dated, merchant_verified', async () => {
  const out = await enforced(ROSE_SOLD_OUT);
  const p = out.product;
  assert.equal(p.variants[0].live_read.status, 'verified', 'Rose was answered in full');
  assert.equal(p.variants[0].price.current.amount, 23);
  assert.equal(p.variants[0].availability.in_stock, false, 'the merchant\'s out-of-stock answer is kept');
  assert.equal(p.price, 23, 'the headline follows its default variant');
  assert.equal(p.price_source, 'merchant_live');
  assert.equal(p.price_as_of, '2026-10-27T09:00:00.000Z');
  assert.deepEqual(p.availability, { in_stock: true }, 'Plum is in stock, so the product stays buyable');
  assert.deepEqual(productPriceCheck(p), { live: true, market: 'US', as_of: '2026-10-27T09:00:00.000Z', read_variants: 2, stored_variants: 0 });
  const msgs = priceMessages(shapeUcpGetProductResponse(out, {}));
  assert.deepEqual(msgs.map((m) => [m.type, m.code]), [['info', 'price.merchant_verified']]);
  assert.deepEqual(projectPublicReadResult('get_product', out).price_check, { confirmed_with_merchant: true, market: 'US' });
});

test('R4: every variant answered out of stock: still verified, and the product reads out of stock', async () => {
  const out = await enforced(() => answer({
    products: [{ id: 'gid://shopify/Product/1', handle: 'tint', variants: [
      { id: gid(ROSE), price: { amount: 2300, currency: 'USD' }, availability: { available: false } },
      { id: gid(PLUM), price: { amount: 2100, currency: 'USD' }, availability: { available: false } },
    ] }],
    messages: [],
  }));
  const p = out.product;
  assert.equal(p.price, 23);
  assert.equal(p.price_as_of, '2026-10-27T09:00:00.000Z');
  assert.equal(p.availability.in_stock, false, 'all asked, none in stock: out of stock');
  assert.equal(productPriceCheck(p).live, true);
  assert.equal(priceMessages(shapeUcpGetProductResponse(out, {}))[0].code, 'price.merchant_verified');
  assert.equal(projectPublicReadResult('get_product', out).price_check.confirmed_with_merchant, true);
});
