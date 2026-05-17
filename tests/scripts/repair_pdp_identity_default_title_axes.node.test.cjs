const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRepair,
  defaultTitleAxisRemoved,
  hasDefaultTitleAxis,
} = require('../../scripts/repair-pdp-identity-default-title-axes.cjs');

test('hasDefaultTitleAxis detects legacy shade default-title pollution', () => {
  assert.equal(hasDefaultTitleAxis({ shade: 'default title', multi_variant: false }), true);
  assert.equal(hasDefaultTitleAxis(['variant_axes:shade:default title']), true);
  assert.equal(hasDefaultTitleAxis({ multi_variant: false }), false);
});

test('defaultTitleAxisRemoved requires before pollution and clean rebuilt axes', () => {
  assert.equal(
    defaultTitleAxisRemoved(
      { shade: 'default title', multi_variant: false },
      ['official_url:https://example.com/products/a', 'variant_axes:shade:default title'],
      { multi_variant: false },
      ['official_url:https://example.com/products/a'],
    ),
    true,
  );
  assert.equal(
    defaultTitleAxisRemoved(
      { shade: 'default title', multi_variant: false },
      ['variant_axes:shade:default title'],
      { shade: 'default title', multi_variant: false },
      ['variant_axes:shade:default title'],
    ),
    false,
  );
});

test('buildRepair preserves existing sig ids while cleaning rebuilt axes and match basis', () => {
  const repair = buildRepair({
    source_listing_ref: 'external_seed:ext_roundlab_ampoule',
    merchant_id: 'external_seed',
    product_id: 'ext_roundlab_ampoule',
    source_kind: 'external_seed',
    sellable_item_group_id: 'sig_existing',
    product_line_id: 'pl_existing',
    review_family_id: 'rf_existing',
    variant_axes: { shade: 'default title', multi_variant: false },
    match_basis: [
      'official_url:https://roundlab.com/products/1025-dokdo-ampoule',
      'variant_axes:shade:default title',
    ],
    source_payload: {
      product_id: 'ext_roundlab_ampoule',
      merchant_id: 'external_seed',
      title: '1025 Dokdo Ampoule',
      brand: 'ROUND LAB',
      source_url: 'https://roundlab.com/products/1025-dokdo-ampoule',
      canonical_url: 'https://roundlab.com/products/1025-dokdo-ampoule',
      variants: [
        {
          variant_id: 'v_single',
          title: 'Single item',
          options: [{ name: 'Format', value: 'Single item', axis_kind: 'format' }],
          axis_kind: 'format',
        },
      ],
    },
  });

  assert.equal(repair.status, 'candidate');
  assert.deepEqual(repair.preserve_group_ids, {
    sellable_item_group_id: 'sig_existing',
    product_line_id: 'pl_existing',
    review_family_id: 'rf_existing',
  });
  assert.deepEqual(repair.after.variant_axes, { multi_variant: false });
  assert.deepEqual(repair.after.match_basis, [
    'official_url:https://roundlab.com/products/1025-dokdo-ampoule',
  ]);
});
