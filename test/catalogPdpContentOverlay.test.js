'use strict';

// SKU Optimization OS -- overlay reader unit tests (pure merge logic, no DB).
const assert = require('assert');
const {
  mergeMerchantOverlayIntoProduct,
} = require('../src/services/catalogPdpContentFields');

(function overlayOverridesDescription() {
  const product = { pdp_description_raw: 'old synced copy' };
  const out = mergeMerchantOverlayIntoProduct(product, [
    { module_key: 'copy', field_key: 'pdp_description_raw', value: 'approved merchant copy' },
  ]);
  assert.strictEqual(out.pdp_description_raw, 'approved merchant copy', 'overlay must override existing copy');
  assert.deepStrictEqual(out.merchant_overlay_hydration.filled_fields, ['pdp_description_raw']);
  assert.strictEqual(out.merchant_overlay_hydration.source, 'merchant_product_overlay');
})();

(function ignoresUnknownFieldKey() {
  const product = { pdp_description_raw: 'keep me' };
  const out = mergeMerchantOverlayIntoProduct(product, [
    { module_key: 'gallery', field_key: 'media', value: '[]' },
  ]);
  assert.strictEqual(out.pdp_description_raw, 'keep me', 'unknown field_key must not touch product');
  assert.strictEqual(out.merchant_overlay_hydration, undefined, 'no hydration annotation when nothing filled');
})();

(function ignoresEmptyValue() {
  const product = { pdp_description_raw: 'keep me' };
  const out = mergeMerchantOverlayIntoProduct(product, [
    { module_key: 'copy', field_key: 'pdp_description_raw', value: '   ' },
  ]);
  assert.strictEqual(out.pdp_description_raw, 'keep me', 'blank overlay value must be ignored');
})();

(function noOverlaysIsNoop() {
  const product = { pdp_description_raw: 'unchanged' };
  assert.strictEqual(mergeMerchantOverlayIntoProduct(product, []).pdp_description_raw, 'unchanged');
  assert.strictEqual(mergeMerchantOverlayIntoProduct(product, null).pdp_description_raw, 'unchanged');
})();

console.log('catalogPdpContentOverlay.test.js: ALL PASS');
