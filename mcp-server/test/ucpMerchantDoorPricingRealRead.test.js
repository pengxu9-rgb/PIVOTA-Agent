// Merchant-door pricing against product rows built by the REAL producers — the seed product builder and the PDP
// builder that make the live UCP get_product read — never hand-written rows.
//
// Why this file exists: sellerVariantGidOf read a sole variant's `source_variant_id` / `variant_gid`, a shape only the
// test fixtures had. The live read (pdpBuilder.buildVariants) carries `variant_id` / `sku_id` only, so on prod 13,167
// serving storefront rows with a single Shopify variant were unpriceable (variant census, 2026-10-09). A guard is only
// tested if it is tested against what the producer emits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { sellerVariantGidOf, sellerVariantChoiceOf, priceOnMerchantDoor, MERCHANT_PRICING_FLAG, createMerchantDoor, CATALOG_SHOPIFY_VARIANT_COUNT_SQL } from '../src/ucpMerchantDoorPricing.js';
import { escalationTargetOf } from '../src/ucpCheckoutEscalation.js';
import { realVariantsOf } from '../src/ucpVariantIds.js';

const require = createRequire(import.meta.url);
const { buildExternalSeedProduct } = require('../../src/services/externalSeedProducts.js');
const { buildPdpPayload } = require('../../src/pdpBuilder.js');

const GID = (n) => `gid://shopify/ProductVariant/${n}`;
/**
 * The live UCP get_product row for a seed: seed product -> PDP payload -> `pdp_payload.product`, then the gateway's
 * `normalizePdpV2ToProductDetail` (src/server.js:30389, not exported) — reproduced for its two money rules only:
 * `price` becomes `price.current.amount` and `currency` `price.current.currency`. Everything else is spread verbatim.
 */
const liveRead = (row) => {
  const p = buildPdpPayload({ product: buildExternalSeedProduct({ status: 'active', market: 'US', tool: '*', ...row }) }).product;
  const current = p.price && typeof p.price === 'object' && p.price.current && typeof p.price.current === 'object' ? p.price.current : null;
  return { ...p, price: current ? current.amount : (typeof p.price === 'number' ? p.price : null), currency: current ? current.currency : (typeof p.currency === 'string' ? p.currency : null) };
};
const seed = (id, { url, variants, external_product_id = `ext_${id.padEnd(24, 'x')}` } = {}) => ({
  id, external_product_id, destination_url: url, canonical_url: url,
  seed_data: { title: `P ${id}`, ...(variants ? { snapshot: { variants } } : { price_amount: 10 }) },
});

test('the producer really emits variant_id/sku_id and no source_variant_id (the shape this code must read)', () => {
  const p = liveRead(seed('a', { url: 'https://brand-a.com/products/cream', variants: [{ id: '44012345678901', title: 'Default Title', price: '20.00' }] }));
  assert.equal(p.variants.length, 1);
  assert.equal(p.variants[0].variant_id, '44012345678901');
  assert.equal(JSON.stringify(p).includes('source_variant_id'), false);
  assert.ok(escalationTargetOf(p), 'and it is a storefront row');
});

test("a SOLE Shopify variant with no variant= in the link is priced by its own variant_id (the census's 13,167 rows)", () => {
  const p = liveRead(seed('a', { url: 'https://brand-a.com/products/cream', variants: [{ id: '44012345678901', title: 'Default Title', price: '20.00' }] }));
  assert.equal(sellerVariantGidOf(p, 'brand-a.com'), GID('44012345678901'));
});

test('the link and the read agreeing price it; disagreeing names two variants and prices neither', () => {
  const agree = liveRead(seed('b', { url: 'https://brand-b.com/products/serum?variant=44012345678902', variants: [{ id: '44012345678902', price: '30.00' }] }));
  assert.equal(sellerVariantGidOf(agree, 'brand-b.com'), GID('44012345678902'));
  const disagree = liveRead(seed('c', { url: 'https://brand-c.com/products/serum?variant=44012345678999', variants: [{ id: '44012345678903', price: '30.00' }] }));
  assert.equal(sellerVariantGidOf(disagree, 'brand-c.com'), null);
});

test("a row with no variant list never prices by the variant made up from the product's own id — numeric or not", () => {
  for (const external_product_id of ['ext_ccccccccccccccccccccccc', '8012345678901']) {
    const p = liveRead(seed('d', { url: 'https://brand-d.com/p/1', external_product_id }));
    assert.equal(p.variants.length, 1, 'the builder makes one up');
    assert.equal(sellerVariantGidOf(p, 'brand-d.com'), null, external_product_id);
  }
});

test("the canonical door shape (a sig_ identity beside a numeric product_id): the made-up variant is still not a seller id", () => {
  // The UCP door reads by sig_ id, so the row's identity can be its pivota_signature_id while product_id is the numeric
  // store product id the builder made the stand-in variant from. Checkout's own count does not drop that id (it does not
  // restate the sig), so the product-id guard is what refuses it.
  const p = { ...liveRead(seed('g', { url: 'https://brand-g.com/p/1', external_product_id: '8012345678901' })), pivota_signature_id: 'sig_0123456789abcdef0123456789abcdef' };
  assert.equal(p.variants[0].variant_id, '8012345678901');
  assert.equal(sellerVariantGidOf(p, 'brand-g.com'), null);
});

test('several exposed variants: nothing without a choice; each choice maps to its OWN id', () => {
  const p = liveRead(seed('e', { url: 'https://brand-e.com/products/x', variants: [
    { id: '44012345678961', title: '30 ml', option1: '30 ml', price: '10.00' },
    { id: '44012345678962', title: '50 ml', option1: '50 ml', price: '15.00' },
  ] }));
  const real = realVariantsOf(p);
  if (real.length > 1) {
    assert.equal(sellerVariantGidOf(p, 'brand-e.com'), null);
    assert.deepEqual(real.map((r) => sellerVariantGidOf(p, 'brand-e.com', r.id)), [GID('44012345678961'), GID('44012345678962')]);
  } else {
    // The builder collapsed the axis for this shape; then it is a sole variant and must not be mispriced either.
    assert.ok([null, GID('44012345678961'), GID('44012345678962')].includes(sellerVariantGidOf(p, 'brand-e.com')));
  }
});

test('end to end on a real-built row: create_cart is sent the sole variant gid, and the cart prices', async () => {
  // product_key as the catalog identity layer stamps it (src/server.js applyCatalogIdentityToPdpProduct).
  const p = { ...liveRead(seed('f', { url: 'https://brand-f.com/products/cream', variants: [{ id: '44012345678971', price: '20.00' }] })), product_key: 'prod::merch_obs_f::external_seed::f' };
  const calls = [];
  const payload = { id: 'gid://shopify/Cart/c1', currency: 'USD', continue_url: 'https://brand-f.com/cart/c/1',
    line_items: [{ item: { id: GID('44012345678971'), title: 'P f', price: 2000 }, quantity: 1 }],
    totals: [{ type: 'subtotal', amount: 2000 }, { type: 'total', amount: 2000 }] };
  const merchantDoor = {
    endpointFor: async () => 'https://brand-f.com/api/ucp/mcp',
    createCart: async (ep, args) => { calls.push(args); return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } }; },
    getCart: async () => null,
    catalogShopifyVariantCount: async () => 1,
  };
  const out = await priceOnMerchantDoor({
    items: [{ product_id: p.product_id, quantity: 1 }], rows: new Map([[p.product_id, p]]), sellerHost: 'brand-f.com', market: 'US',
    env: { [MERCHANT_PRICING_FLAG]: '1' }, merchantDoor,
  });
  assert.deepEqual(calls[0].lineItems, [{ item: { id: GID('44012345678971') }, quantity: 1 }]);
  assert.ok(out, 'priced');
});

test('two storefront links naming DIFFERENT variants: neither is guessed, even when the read agrees with one', () => {
  const row = seed('h', { url: 'https://brand-h.com/products/x?variant=44012345678901', variants: [{ id: '44012345678901', price: '10.00' }] });
  row.canonical_url = 'https://brand-h.com/products/x?variant=44012345678902';
  assert.equal(sellerVariantGidOf(liveRead(row), 'brand-h.com'), null);
});

test('an id is taken WHOLE: bare digits or exactly a Shopify variant gid — never a gid fished out of a longer string', () => {
  const p = liveRead(seed('i', { url: 'https://brand-i.com/products/x', variants: [{ id: '44012345678901', price: '10.00' }] }));
  const withId = (id) => ({ ...p, variants: [{ ...p.variants[0], variant_id: id, sku_id: id }] });
  assert.equal(sellerVariantGidOf(withId('gid://shopify/ProductVariant/44012345678901'), 'brand-i.com'), GID('44012345678901'));
  assert.equal(sellerVariantGidOf(withId('https://evil.example/?gid://shopify/ProductVariant/44012345678901'), 'brand-i.com'), null);
  assert.equal(sellerVariantGidOf(withId('SKU-44012345678901'), 'brand-i.com'), null);
  assert.equal(sellerVariantGidOf(withId('12345'), 'brand-i.com'), null, 'too short to be a Shopify id');
});

test("the CHOSEN-variant path reads the same way: its own variant_id only (no fallback to id), never a restated product id", () => {
  const base = { product_id: 'p_x', pivota_signature_id: 'sig_0123456789abcdef0123456789abcdef', currency: 'USD', price: 10 };
  // A non-Shopify variant_id does not fall through to a Shopify-shaped `id`: the read's id field is variant_id.
  const row = { ...base, variants: [{ variant_id: 'v_red', id: '44012345678901' }, { variant_id: 'v_blue', id: '44012345678902' }] };
  assert.equal(sellerVariantGidOf(row, 'brand.example', 'v_red'), null);
  // A chosen variant whose id restates the product's own id is not a seller id, even beside a sig identity.
  const restated = { ...base, product_id: '8012345678901', variants: [{ variant_id: '8012345678901' }, { variant_id: '44012345678903' }] };
  assert.equal(sellerVariantGidOf(restated, 'brand.example', '8012345678901'), null);
  assert.equal(sellerVariantGidOf(restated, 'brand.example', '44012345678903'), GID('44012345678903'));
});

// ---- owner decision 2026-10-09: no derived sole-variant id when the catalog knows several Shopify variants ------

const KEY = 'prod::merch_obs_k::external_seed::k';
const stamped = (row) => ({ ...liveRead(row), product_key: KEY });
const cartFor = (gid, price = 2000) => {
  const payload = { id: 'gid://shopify/Cart/c1', currency: 'USD', continue_url: 'https://brand-k.com/cart/c/1',
    line_items: [{ item: { id: gid, title: 'K', price }, quantity: 1 }],
    totals: [{ type: 'subtotal', amount: price }, { type: 'total', amount: price }] };
  return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
};
function doorWith(count, { throws = false } = {}) {
  const calls = { count: [], cart: [] };
  return {
    calls,
    endpointFor: async () => 'https://brand-k.com/api/ucp/mcp',
    createCart: async (ep, args) => { calls.cart.push(args); return cartFor(args.lineItems[0].item.id); },
    getCart: async () => null,
    catalogShopifyVariantCount: async (k) => { calls.count.push(k); if (throws) throw new Error('db'); return count; },
  };
}
const priceRow = (p, door, variant_id) => priceOnMerchantDoor({
  items: [{ product_id: p.product_id, quantity: 1, ...(variant_id ? { variant_id } : {}) }], rows: new Map([[p.product_id, p]]),
  sellerHost: 'brand-k.com', market: 'US', env: { [MERCHANT_PRICING_FLAG]: '1' }, merchantDoor: door,
});
const soleRow = () => stamped(seed('k', { url: 'https://brand-k.com/products/x', variants: [{ id: '44012345678981', price: '20.00' }] }));

test('a DERIVED sole-variant id whose catalog knows SEVERAL Shopify variants is refused — before any seller contact', async () => {
  const p = soleRow();
  assert.equal(sellerVariantChoiceOf(p, 'brand-k.com').source, 'sole_variant_id');
  const door = doorWith(2);
  assert.equal(await priceRow(p, door), null);
  assert.deepEqual(door.calls.count, [KEY], 'counted by the read\'s product_key');
  assert.deepEqual(door.calls.cart, [], 'no seller contacted');
});

test('one or zero catalog Shopify variants: the derived id prices', async () => {
  for (const n of [1, 0]) {
    const door = doorWith(n);
    assert.ok(await priceRow(soleRow(), door), String(n));
    assert.deepEqual(door.calls.cart[0].lineItems, [{ item: { id: GID('44012345678981') }, quantity: 1 }]);
  }
});

test('FAILS CLOSED: no product_key, a failed lookup, a non-count answer, or a door without the lookup — not priced', async () => {
  const noKey = liveRead(seed('k', { url: 'https://brand-k.com/products/x', variants: [{ id: '44012345678981', price: '20.00' }] }));
  assert.equal(await priceRow(noKey, doorWith(1)), null, 'no product_key');
  assert.equal(await priceRow(soleRow(), doorWith(1, { throws: true })), null, 'lookup throws');
  for (const bad of [null, undefined, -1, 1.5, '2']) assert.equal(await priceRow(soleRow(), doorWith(bad)), null, `count ${String(bad)}`);
  const { catalogShopifyVariantCount, ...noLookup } = doorWith(1);
  void catalogShopifyVariantCount;
  assert.equal(await priceRow(soleRow(), noLookup), null, 'a door without the lookup');
});

test('only a DERIVED id is checked: a link naming the variant, or a choice among SEVERAL real variants, prices without the lookup', async () => {
  const linked = stamped(seed('k', { url: 'https://brand-k.com/products/x?variant=44012345678981', variants: [{ id: '44012345678981', price: '20.00' }] }));
  assert.equal(sellerVariantChoiceOf(linked, 'brand-k.com').source, 'url');
  const d1 = doorWith(5);
  assert.ok(await priceRow(linked, d1));
  assert.deepEqual(d1.calls.count, [], 'no lookup for an explicit link');
  // A product the PDP builder EXPOSES as two real variants (an option axis with values) — built by the real producers.
  const multi = { ...liveRead({
    id: 's11', external_product_id: 'ext_kkkkkkkkkkkkkkkkkkkkkkkk', destination_url: 'https://brand-k.com/products/serum',
    seed_data: { title: 'Serum', options: [{ name: 'Size', values: ['30 ml', '50 ml'] }], snapshot: { variants: [
      { id: '44012345678961', title: '30 ml', option_name: 'Size', option_value: '30 ml', option1: '30 ml', price: '20.00' },
      { id: '44012345678962', title: '50 ml', option_name: 'Size', option_value: '50 ml', option1: '50 ml', price: '30.00' },
    ] } },
  }), product_key: KEY };
  const real = realVariantsOf(multi);
  assert.equal(real.length, 2, 'the fixture really exposes two real variants');
  const d2 = doorWith(5);
  const out = await priceOnMerchantDoor({
    items: [{ product_id: multi.product_id, quantity: 1, variant_id: real[1].id }], rows: new Map([[multi.product_id, multi]]),
    sellerHost: 'brand-k.com', market: 'US', env: { [MERCHANT_PRICING_FLAG]: '1' }, merchantDoor: d2,
  });
  assert.ok(out, 'priced');
  assert.deepEqual(d2.calls.count, [], 'no lookup for a real choice among several variants');
  assert.deepEqual(d2.calls.cart[0].lineItems, [{ item: { id: GID('44012345678962') }, quantity: 1 }]);
});

test("a 'choice' of the ONLY real variant (<pid>::v::<sole id>) is counted like a derived id — the bypass is closed", async () => {
  const p = soleRow();
  assert.equal(realVariantsOf(p).length, 1);
  const soleId = realVariantsOf(p)[0].id;
  assert.equal(sellerVariantChoiceOf(p, 'brand-k.com', soleId).source, 'chosen');
  const refused = doorWith(5);
  assert.equal(await priceRow(p, refused, soleId), null, 'catalog knows several -> not priced');
  assert.deepEqual(refused.calls.count, [KEY]);
  assert.deepEqual(refused.calls.cart, [], 'no seller contacted');
  const allowed = doorWith(1);
  assert.ok(await priceRow(p, allowed, soleId), 'catalog knows one -> priced');
});

test('the catalog check runs inside the budget: a lookup that never answers is a refusal, not a hang', async () => {
  const hanging = { ...doorWith(1), catalogShopifyVariantCount: () => new Promise(() => {}) };
  const t0 = Date.now();
  const out = await priceOnMerchantDoor({
    items: [{ product_id: soleRow().product_id, quantity: 1 }], rows: new Map([[soleRow().product_id, soleRow()]]),
    sellerHost: 'brand-k.com', market: 'US', env: { [MERCHANT_PRICING_FLAG]: '1' }, merchantDoor: hanging, budgetMs: 60,
  });
  assert.equal(out, null);
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(hanging.calls.cart, []);
});

test("the default door counts with the census's own SQL, keyed by product_key, within a budget; a string count parses", async () => {
  const seen = [];
  const door = createMerchantDoor({ client: {}, discover: async () => null, catalogQuery: async (text, params, opts) => { seen.push({ text, params, opts }); return { rows: [{ shop_ids: '3' }] }; } });
  assert.equal(await door.catalogShopifyVariantCount(KEY), 3);
  assert.equal(seen[0].text, CATALOG_SHOPIFY_VARIANT_COUNT_SQL);
  assert.deepEqual(seen[0].params, [KEY]);
  assert.ok(seen[0].opts.timeoutMs > 0 && seen[0].opts.timeoutMs <= 1000);
  for (const needle of ["s.product_key = $1", "suppressed_at IS NULL", "suppression_reason IS NULL", "count(DISTINCT s.source_variant_id)", "'^[0-9]{6,}$'", "gid://shopify/ProductVariant/[0-9]+", "'^SHOPIFY-[0-9]{6,}$'"]) {
    assert.ok(CATALOG_SHOPIFY_VARIANT_COUNT_SQL.includes(needle), needle);
  }
  const empty = createMerchantDoor({ client: {}, discover: async () => null, catalogQuery: async () => ({ rows: [] }) });
  assert.equal(await empty.catalogShopifyVariantCount(KEY), null);
});
