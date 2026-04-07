const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __internal: {
    isSemanticOwnerBundleLikeProduct,
    isSemanticOwnerEligiblePrimaryExternalProduct,
    filterSemanticOwnerCoverageExternalProducts,
    filterSemanticOwnerCoverageSupplementQueries,
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

test('semantic-owner coverage supplement keeps only step-aligned singleton external products for treatment mainline', () => {
  const filtered = filterSemanticOwnerCoverageExternalProducts(
    [
      {
        merchant_id: 'external_seed',
        product_id: 'ext_bundle',
        display_name: 'Glow Strong Mini Moisturizer + Eye Cream Duo',
        category: 'external',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_spf',
        display_name:
          'Hydra Vizor Refill Invisible Moisturizer Broad Spectrum Spf 30 Sunscreen with Niacinamide + Kalahari Melon',
        category: 'external',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_set',
        display_name: 'Ultimate Skincare Set',
        category: 'external',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_treatment',
        display_name: 'Salicylic Acid Oil Control Treatment',
        category: 'treatment',
      },
    ],
    { targetStepFamily: 'treatment' },
  );

  assert.deepEqual(
    filtered.map((product) => product.product_id),
    ['ext_treatment'],
  );
});

test('semantic-owner oil-control treatment coverage requires oil-control aligned singleton products', () => {
  const filtered = filterSemanticOwnerCoverageExternalProducts(
    [
      {
        merchant_id: 'external_seed',
        product_id: 'ext_retinol_oil',
        display_name: 'Overnight Retinol Oil',
        category: 'treatment',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_oil_control',
        display_name: 'Niacinamide Oil Control Serum',
        category: 'serum',
      },
    ],
    { targetStepFamily: 'treatment', semanticFamily: 'oil_control' },
  );

  assert.deepEqual(
    filtered.map((product) => product.product_id),
    ['ext_oil_control'],
  );
});

test('semantic-owner treatment coverage does not spend budget on support-step queries', () => {
  assert.deepEqual(
    filterSemanticOwnerCoverageSupplementQueries(
      [
        'lightweight moisturizer oily skin',
        'oil control sunscreen',
        'salicylic acid treatment',
        'oil control serum',
      ],
      { targetStepFamily: 'treatment' },
    ),
    ['salicylic acid treatment', 'oil control serum'],
  );
});
