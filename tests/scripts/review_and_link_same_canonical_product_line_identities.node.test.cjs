'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProductLineReview,
  normalizeProductLineTitleKey,
  normalizeUrlForCompare,
  serializeVariantAxes,
} = require('../../scripts/review-and-link-same-canonical-product-line-identities.cjs');

function seed(overrides = {}) {
  return {
    external_product_id: 'ext_a',
    market: 'US',
    domain: 'skin1004.com',
    title: 'Hyalu-Cica Water-Fit Sun Serum UV 50ml',
    canonical_url: 'https://skin1004.com/products/hyalu-cica-water-fit-sun-serum',
    seed_data: {
      vendor: 'SKIN1004',
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
    sellable_item_group_id: 'sig_50ml',
    product_line_id: 'pl_a',
    review_family_id: 'pl_a',
    official_url: 'https://skin1004.com/products/hyalu-cica-water-fit-sun-serum',
    variant_axes: { size: '50ml', volume: '50ml', multi_variant: false },
    ...overrides,
  };
}

test('normalizes URLs, titles, and variant axes for product-line review', () => {
  assert.equal(
    normalizeUrlForCompare('https://SKIN1004.com/products/Hyalu-Cica?variant=1#reviews'),
    'https://skin1004.com/products/hyalu-cica',
  );
  assert.equal(
    normalizeProductLineTitleKey('Hyalu-Cica Water-Fit Sun Serum UV 50 ml'),
    'hyalu cica water fit sun serum uv',
  );
  assert.equal(
    serializeVariantAxes({ multi_variant: false, volume: '50ML', size: '50ml' }),
    '{"size":"50ml","volume":"50ml"}',
  );
});

test('buildProductLineReview links same canonical siblings without merging sellable groups', () => {
  const review = buildProductLineReview({
    targetExternalProductId: 'ext_a',
    seeds: [
      seed({ external_product_id: 'ext_a', title: 'Hyalu-Cica Water-Fit Sun Serum UV 50ml' }),
      seed({ external_product_id: 'ext_b', title: 'Hyalu-Cica Water-Fit Sun Serum UV 15ml' }),
    ],
    identities: [
      identity({ product_id: 'ext_a', source_listing_ref: 'external_seed:ext_a' }),
      identity({
        product_id: 'ext_b',
        source_listing_ref: 'external_seed:ext_b',
        sellable_item_group_id: 'sig_15ml',
        product_line_id: 'pl_b',
        review_family_id: 'pl_b',
        variant_axes: { size: '15ml', volume: '15ml' },
      }),
    ],
  });

  assert.equal(review.action, 'link_ready');
  assert.deepEqual(review.blockers, []);
  assert.ok(review.warnings.includes('raw_titles_differ_by_variant_axis'));
  assert.equal(review.target_product_line_id, 'pl_a');
  assert.equal(review.candidates.length, 1);
  assert.equal(review.candidates[0].source_sellable_item_group_id, 'sig_15ml');
  assert.equal(review.candidates[0].target_product_line_id, 'pl_a');
  assert.equal(review.candidates[0].needs_update, true);
});

test('buildProductLineReview holds identical variant axes that require exact merge review', () => {
  const review = buildProductLineReview({
    targetExternalProductId: 'ext_a',
    seeds: [
      seed({ external_product_id: 'ext_a', title: 'Hyalu-Cica Water-Fit Sun Serum UV 50ml' }),
      seed({ external_product_id: 'ext_b', title: 'Hyalu-Cica Water-Fit Sun Serum UV 50ml' }),
    ],
    identities: [
      identity({ product_id: 'ext_a', source_listing_ref: 'external_seed:ext_a' }),
      identity({
        product_id: 'ext_b',
        source_listing_ref: 'external_seed:ext_b',
        sellable_item_group_id: 'sig_duplicate_50ml',
        product_line_id: 'pl_b',
        review_family_id: 'pl_b',
        variant_axes: { size: '50ml', volume: '50ml' },
      }),
    ],
  });

  assert.equal(review.action, 'hold_manual_review');
  assert.ok(review.blockers.includes('exact_merge_review_required'));
});

test('buildProductLineReview holds conflicting product title cores', () => {
  const review = buildProductLineReview({
    targetExternalProductId: 'ext_a',
    seeds: [
      seed({ external_product_id: 'ext_a', title: 'Hyalu-Cica Water-Fit Sun Serum UV 50ml' }),
      seed({ external_product_id: 'ext_b', title: 'Madagascar Centella Ampoule 55ml' }),
    ],
    identities: [
      identity({ product_id: 'ext_a', source_listing_ref: 'external_seed:ext_a' }),
      identity({
        product_id: 'ext_b',
        source_listing_ref: 'external_seed:ext_b',
        sellable_item_group_id: 'sig_ampoule',
        product_line_id: 'pl_b',
        variant_axes: { size: '55ml' },
      }),
    ],
  });

  assert.equal(review.action, 'hold_manual_review');
  assert.ok(review.blockers.includes('conflicting_title_core'));
});
