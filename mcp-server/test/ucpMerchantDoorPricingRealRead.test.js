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

import { sellerVariantGidOf, priceOnMerchantDoor, MERCHANT_PRICING_FLAG } from '../src/ucpMerchantDoorPricing.js';
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
  const p = liveRead(seed('f', { url: 'https://brand-f.com/products/cream', variants: [{ id: '44012345678971', price: '20.00' }] }));
  const calls = [];
  const payload = { id: 'gid://shopify/Cart/c1', currency: 'USD', continue_url: 'https://brand-f.com/cart/c/1',
    line_items: [{ item: { id: GID('44012345678971'), title: 'P f', price: 2000 }, quantity: 1 }],
    totals: [{ type: 'subtotal', amount: 2000 }, { type: 'total', amount: 2000 }] };
  const merchantDoor = {
    endpointFor: async () => 'https://brand-f.com/api/ucp/mcp',
    createCart: async (ep, args) => { calls.push(args); return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } }; },
    getCart: async () => null,
  };
  const out = await priceOnMerchantDoor({
    items: [{ product_id: p.product_id, quantity: 1 }], rows: new Map([[p.product_id, p]]), sellerHost: 'brand-f.com', market: 'US',
    env: { [MERCHANT_PRICING_FLAG]: '1' }, merchantDoor,
  });
  assert.deepEqual(calls[0].lineItems, [{ item: { id: GID('44012345678971') }, quantity: 1 }]);
  assert.ok(out, 'priced');
});
