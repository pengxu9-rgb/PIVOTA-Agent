const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __internal: {
    isSemanticOwnerBundleLikeProduct,
    isSemanticOwnerEligiblePrimaryExternalProduct,
    shouldPreferSemanticOwnerExternalCoverage,
  },
} = require('../src/findProductsInvokeSemanticOwnerExecution');

test('semantic-owner external coverage does not treat bundle-like external seeds as eligible primary treatment products', () => {
  assert.equal(
    isSemanticOwnerBundleLikeProduct({
      merchant_id: 'external_seed',
      display_name: 'Glow Strong Mini Moisturizer + Eye Cream Duo',
      category: 'external',
    }),
    true,
  );
  assert.equal(
    isSemanticOwnerEligiblePrimaryExternalProduct(
      {
        merchant_id: 'external_seed',
        display_name: 'Glow Strong Mini Moisturizer + Eye Cream Duo',
        category: 'external',
      },
      { targetStepFamily: 'treatment' },
    ),
    false,
  );
});

test('semantic-owner external coverage rejects cross-step moisturizer-spf external seeds as treatment replacements', () => {
  assert.equal(
    isSemanticOwnerEligiblePrimaryExternalProduct(
      {
        merchant_id: 'external_seed',
        display_name:
          'Hydra Vizor Refill Invisible Moisturizer Broad Spectrum Spf 30 Sunscreen with Niacinamide + Kalahari Melon',
        category: 'external',
      },
      { targetStepFamily: 'treatment' },
    ),
    false,
  );
});

test('semantic-owner external coverage only prefers external-first when enough step-aligned singleton treatment products exist', () => {
  const sparseInternal = [
    {
      merchant_id: 'shopify',
      product_id: 'internal_1',
      display_name: 'Oil Control Serum',
      category: 'serum',
    },
  ];
  const contaminatedExternal = [
    {
      merchant_id: 'external_seed',
      product_id: 'ext_1',
      display_name: 'Glow Strong Mini Moisturizer + Eye Cream Duo',
      category: 'external',
    },
    {
      merchant_id: 'external_seed',
      product_id: 'ext_2',
      display_name:
        'Hydra Vizor Refill Invisible Moisturizer Broad Spectrum Spf 30 Sunscreen with Niacinamide + Kalahari Melon',
      category: 'external',
    },
    {
      merchant_id: 'external_seed',
      product_id: 'ext_3',
      display_name: 'Ultimate Skincare Set',
      category: 'external',
    },
  ];

  assert.equal(
    shouldPreferSemanticOwnerExternalCoverage({
      primaryProducts: sparseInternal,
      externalProducts: contaminatedExternal,
      externalAdoption: {
        adopt: true,
        hitDecision: {
          hit_quality: 'valid_hit',
          valid_products: contaminatedExternal,
        },
      },
      externalCoverageTrusted: true,
      targetStepFamily: 'treatment',
    }),
    false,
  );

  assert.equal(
    shouldPreferSemanticOwnerExternalCoverage({
      primaryProducts: sparseInternal,
      externalProducts: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_4',
          display_name: 'Niacinamide Oil Control Serum',
          category: 'serum',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_5',
          display_name: 'Salicylic Acid Blemish Treatment',
          category: 'treatment',
        },
      ],
      externalAdoption: {
        adopt: true,
        hitDecision: {
          hit_quality: 'valid_hit',
          valid_products: [{}, {}],
        },
      },
      externalCoverageTrusted: true,
      targetStepFamily: 'treatment',
    }),
    true,
  );
});
