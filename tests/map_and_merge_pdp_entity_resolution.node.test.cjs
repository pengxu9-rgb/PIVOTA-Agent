'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildClusterReport,
  deriveProductGroupId,
  serializeVariantAxes,
} = require('../scripts/map-and-merge-pdp-entity-resolution.js');

function row(overrides = {}) {
  return {
    content_key: 'ck_1234567890abcdef1234567890abcdef',
    product_key: 'product_a',
    merchant_id: 'merchant_a',
    merchant_name: 'Merchant A',
    platform: 'shopify',
    source_product_id: 'prod_a',
    title: 'Same Product',
    brand: 'Brand',
    pivota_signature_id: 'sig_11111111111111111111111111111111',
    pivota_signature_minted_at: '2026-01-01T00:00:00Z',
    pdp_lifecycle_stage: 'published',
    offer_count: 1,
    sku_count: 1,
    source_listing_ref: 'merchant_a:prod_a',
    sellable_item_group_id: 'sig_11111111111111111111111111111111',
    strong_identity: {},
    variant_axes: {},
    official_url: 'https://merchant-a.example/products/same',
    internal_product_group_id: null,
    is_primary: false,
    ...overrides,
  };
}

test('buildClusterReport marks cross-merchant content_key fragmentation as auto-merge ready', () => {
  const report = buildClusterReport('ck_1234567890abcdef1234567890abcdef', [
    row(),
    row({
      product_key: 'product_b',
      merchant_id: 'merchant_b',
      merchant_name: 'Merchant B',
      source_product_id: 'prod_b',
      pivota_signature_id: 'sig_22222222222222222222222222222222',
      source_listing_ref: 'merchant_b:prod_b',
      sellable_item_group_id: 'sig_22222222222222222222222222222222',
      official_url: 'https://merchant-b.example/products/same',
      pdp_lifecycle_stage: 'validated',
    }),
  ]);

  assert.equal(report.action, 'auto_merge_ready');
  assert.equal(report.canonical_sig_id, 'sig_11111111111111111111111111111111');
  assert.equal(report.product_group_id, deriveProductGroupId(report.content_key));
  assert.equal(report.identity_alias_updates.length, 1);
  assert.equal(report.identity_alias_updates[0].needs_update, true);
  assert.deepEqual(report.blockers, []);
  assert.match(report.warnings.join(','), /conflicting_official_url_ignored/);
});

test('buildClusterReport holds sibling variants with conflicting axes', () => {
  const report = buildClusterReport('ck_1234567890abcdef1234567890abcdef', [
    row({ variant_axes: { size: '30ml' } }),
    row({
      product_key: 'product_b',
      merchant_id: 'merchant_b',
      source_product_id: 'prod_b',
      pivota_signature_id: 'sig_22222222222222222222222222222222',
      source_listing_ref: 'merchant_b:prod_b',
      sellable_item_group_id: 'sig_22222222222222222222222222222222',
      variant_axes: { size: '50ml' },
    }),
  ]);

  assert.equal(report.action, 'hold_manual_review');
  assert.ok(report.blockers.includes('conflicting_variant_axes'));
});

test('buildClusterReport holds clusters already split across product groups', () => {
  const report = buildClusterReport('ck_1234567890abcdef1234567890abcdef', [
    row({ internal_product_group_id: 'pg_a', is_primary: true }),
    row({
      product_key: 'product_b',
      merchant_id: 'merchant_b',
      source_product_id: 'prod_b',
      pivota_signature_id: 'sig_22222222222222222222222222222222',
      source_listing_ref: 'merchant_b:prod_b',
      sellable_item_group_id: 'sig_22222222222222222222222222222222',
      internal_product_group_id: 'pg_b',
    }),
  ]);

  assert.equal(report.action, 'hold_manual_review');
  assert.ok(report.blockers.includes('split_product_group_members'));
});

test('serializeVariantAxes treats false multi_variant as empty but preserves real axes', () => {
  assert.equal(serializeVariantAxes({ multi_variant: false }), '');
  assert.equal(serializeVariantAxes({ size: '30ML', multi_variant: false }), '{"size":"30ml"}');
});
