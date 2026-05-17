'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMergeReview,
  normalizeUrlForCompare,
  serializeVariantAxes,
} = require('../../scripts/review-and-merge-same-canonical-external-seed-identities.cjs');

function seed(overrides = {}) {
  return {
    external_product_id: 'ext_a',
    market: 'US',
    domain: 'olehenriksen.com',
    title: 'Detox Drops 2% Salicylic Acid Toner',
    canonical_url: 'https://olehenriksen.com/products/detox-drops-2-salicylic-acid-toner-4oz',
    seed_data: {
      vendor: 'OleHenriksen',
      snapshot: {},
    },
    ...overrides,
  };
}

function identity(overrides = {}) {
  return {
    source_listing_ref: 'external_seed:ext_a',
    product_id: 'ext_a',
    source_tier: 'brand',
    sellable_item_group_id: 'sig_a',
    product_line_id: 'pl_a',
    official_url: 'https://olehenriksen.com/products/detox-drops-2-salicylic-acid-toner-eu',
    variant_axes: { size: '4 oz', volume: '4oz', multi_variant: false },
    ...overrides,
  };
}

test('normalizes URLs and variant axes for reviewed same-canonical comparison', () => {
  assert.equal(
    normalizeUrlForCompare('https://OLEHENRIKSEN.com/products/Detox-Drops?variant=1#reviews'),
    'https://olehenriksen.com/products/detox-drops',
  );
  assert.equal(
    serializeVariantAxes({ multi_variant: false, volume: '4OZ', size: '4 oz' }),
    '{"size":"4 oz","volume":"4oz"}',
  );
});

test('buildMergeReview marks same canonical external seed fragmentation merge-ready', () => {
  const review = buildMergeReview({
    targetExternalProductId: 'ext_b',
    seeds: [
      seed({ external_product_id: 'ext_a' }),
      seed({ external_product_id: 'ext_b' }),
    ],
    identities: [
      identity({ product_id: 'ext_a', source_listing_ref: 'external_seed:ext_a', sellable_item_group_id: 'sig_a' }),
      identity({
        product_id: 'ext_b',
        source_listing_ref: 'external_seed:ext_b',
        sellable_item_group_id: 'sig_b',
        product_line_id: 'pl_b',
        official_url: 'https://olehenriksen.com/products/detox-drops-2-salicylic-acid-toner-4oz',
      }),
    ],
  });

  assert.equal(review.action, 'merge_ready');
  assert.deepEqual(review.blockers, []);
  assert.equal(review.target_sellable_item_group_id, 'sig_b');
  assert.equal(review.target_product_line_id, 'pl_b');
  assert.equal(review.candidates.length, 1);
  assert.equal(review.candidates[0].needs_update, true);
});

test('buildMergeReview holds conflicting variant axes', () => {
  const review = buildMergeReview({
    targetExternalProductId: 'ext_b',
    seeds: [
      seed({ external_product_id: 'ext_a' }),
      seed({ external_product_id: 'ext_b' }),
    ],
    identities: [
      identity({ product_id: 'ext_a', source_listing_ref: 'external_seed:ext_a', variant_axes: { size: '4 oz' } }),
      identity({
        product_id: 'ext_b',
        source_listing_ref: 'external_seed:ext_b',
        sellable_item_group_id: 'sig_b',
        variant_axes: { size: '2 oz' },
      }),
    ],
  });

  assert.equal(review.action, 'hold_manual_review');
  assert.ok(review.blockers.includes('conflicting_variant_axes'));
});
