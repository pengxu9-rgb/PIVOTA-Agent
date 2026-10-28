// THE get_product DETAIL LANE'S STOCK REACHES THE UCP AND PUBLIC DOORS. pdpBuilder (the lane get_product's
// unscoped detail reads) writes stock only as an availability OBJECT, `{ in_stock, available_quantity }`, on the
// product and on each variant, with no top-level `in_stock`. Both doors used to read only an availability STRING
// or a top-level `in_stock`, so every get_product answer they served carried no stock at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { shapeUcpGetProductResponse } from '../src/ucpResponseShaper.js';
import { projectPublicReadResult } from '../src/publicReadProjection.js';

const require = createRequire(import.meta.url);
const { buildPdpPayload } = require('../../src/pdpBuilder.js');

// What get_product_detail's normalizer serves: the canonical product, price flattened, `in_stock` from an
// availability STRING or a top-level boolean only (src/server.js normalizePdpV2ToProductDetail).
function detailOf(raw) {
  const p = buildPdpPayload({ product: raw, relatedProducts: [], entryPoint: 'agent' }).product;
  const text = typeof p.availability === 'string' ? p.availability.toLowerCase() : '';
  return {
    product: {
      ...p,
      brand: p.brand && typeof p.brand === 'object' ? (p.brand.name || null) : (p.brand ?? null),
      price: p.price && p.price.current ? p.price.current.amount : null,
      currency: p.price && p.price.current ? p.price.current.currency : null,
      in_stock: text ? /in.?stock|available/.test(text) : typeof p.in_stock === 'boolean' ? p.in_stock : undefined,
    },
  };
}

const raw = (over = {}) => ({
  product_id: 'sig_stock', merchant_id: 'm', title: 'Tint', brand: 'Brand T', price: 25, currency: 'USD',
  in_stock: true, inventory_quantity: 4,
  variants: [
    { variant_id: '1', title: 'Rose', price: 25, currency: 'USD', in_stock: true, inventory_quantity: 3 },
    { variant_id: '2', title: 'Plum', price: 27, currency: 'USD', in_stock: false, inventory_quantity: 0 },
  ],
  ...over,
});

test('the lane really is object-only: pdpBuilder emits availability objects and no top-level in_stock', () => {
  const { product } = detailOf(raw());
  assert.deepEqual(product.availability, { in_stock: true, available_quantity: 4 });
  assert.equal(product.in_stock, undefined, 'the normalizer finds no string and no boolean');
  assert.deepEqual(product.variants.map((v) => v.availability), [{ in_stock: true, available_quantity: 3 }, { in_stock: false, available_quantity: 0 }]);
});

test('UCP: each variant carries its own stock from the object', () => {
  const ucp = shapeUcpGetProductResponse(detailOf(raw()), {});
  assert.deepEqual(ucp.product.variants.map((v) => v.availability), [
    { available: true, status: 'in_stock' },
    { available: false, status: 'out_of_stock' },
  ]);
});

test('public: the product reads its stock from the object, never "unknown" when the lane knows', () => {
  assert.equal(projectPublicReadResult('get_product', detailOf(raw())).availability, 'in_stock');
  assert.equal(projectPublicReadResult('get_product', detailOf(raw({ in_stock: false, inventory_quantity: 0 }))).availability, 'out_of_stock');
});

test('an object with no in_stock is still unknown: UCP omits it, public says unknown', () => {
  const detail = detailOf(raw());
  detail.product.availability = { available_quantity: 2 };
  for (const v of detail.product.variants) v.availability = {};
  assert.equal(projectPublicReadResult('get_product', detail).availability, 'unknown');
  const ucp = shapeUcpGetProductResponse(detail, {});
  for (const v of ucp.product.variants) assert.equal('availability' in v, false);
});

test('precedence: an availability STRING still wins; the object outranks a top-level in_stock', () => {
  const p = (over) => ({ product: { ...detailOf(raw()).product, ...over } });
  // A string (search rows, older lanes) is read first, exactly as before.
  assert.equal(projectPublicReadResult('get_product', p({ availability: 'out_of_stock' })).availability, 'out_of_stock');
  // The object is the lane's own answer (and the one the live reader rewrites); a top-level boolean beside it
  // is the older, separately derived flag.
  assert.equal(projectPublicReadResult('get_product', p({ availability: { in_stock: false }, in_stock: true })).availability, 'out_of_stock');
  const ucp = shapeUcpGetProductResponse({ product: { ...detailOf(raw()).product, variants: [
    { ...detailOf(raw()).product.variants[0], availability: { in_stock: false }, in_stock: true },
    detailOf(raw()).product.variants[1],
  ] } }, {});
  assert.deepEqual(ucp.product.variants[0].availability, { available: false, status: 'out_of_stock' });
});
