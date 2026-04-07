const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __internal: {
    isSemanticOwnerBundleLikeProduct,
    isSemanticOwnerEligiblePrimaryExternalProduct,
    isSemanticOwnerEligibleSupportRoleProduct,
    filterSemanticOwnerCoverageExternalProducts,
    filterSemanticOwnerCoverageSupplementQueries,
    filterSemanticOwnerSupportRoleProducts,
    buildSemanticOwnerSupportSemanticContractParam,
    getSemanticOwnerSupportSupplementTimeoutMs,
    resolveSemanticOwnerFrameworkSupportQuery,
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

test('semantic-owner framework support query resolver maps support roles to per-step contracts', () => {
  assert.deepEqual(
    resolveSemanticOwnerFrameworkSupportQuery('lightweight moisturizer oily skin'),
    {
      query: 'lightweight moisturizer oily skin',
      targetStepFamily: 'moisturizer',
      roleId: 'lightweight_moisturizer',
      queryStepStrength: 'supportive_family',
    },
  );
  assert.deepEqual(
    resolveSemanticOwnerFrameworkSupportQuery('oil control sunscreen'),
    {
      query: 'oil control sunscreen',
      targetStepFamily: 'sunscreen',
      roleId: 'daily_sunscreen',
      queryStepStrength: 'exact_step',
    },
  );
  assert.equal(resolveSemanticOwnerFrameworkSupportQuery('niacinamide serum'), null);
});

test('semantic-owner framework support query rewrites inherited semantic contract to support step', () => {
  const contract = JSON.parse(
    buildSemanticOwnerSupportSemanticContractParam(
      JSON.stringify({
        version: 'beauty_semantic_contract_v1',
        planner_mode: 'framework_generic',
        target_step_family: 'treatment',
        primary_role_id: 'oil_control_treatment',
        support_role_ids: ['lightweight_moisturizer'],
        allowed_step_families: ['treatment', 'serum', 'moisturizer'],
      }),
      {
        supportContext: resolveSemanticOwnerFrameworkSupportQuery('lightweight moisturizer oily skin'),
        semanticFamily: 'oil_control',
      },
    ),
  );

  assert.equal(contract.planner_mode, 'step_aware');
  assert.equal(contract.request_class, 'support_role');
  assert.equal(contract.target_step_family, 'moisturizer');
  assert.equal(contract.primary_role_id, 'lightweight_moisturizer');
  assert.deepEqual(contract.support_role_ids, []);
  assert.deepEqual(contract.allowed_step_families, ['moisturizer']);
  assert.deepEqual(contract.ingredient_hypotheses, []);
  assert.deepEqual(contract.product_type_hypotheses, ['moisturizer']);
  assert.deepEqual(contract.query_terms, ['lightweight moisturizer oily skin']);
  assert.equal(contract.semantic_family, 'oil_control');
});

test('semantic-owner support role filter keeps only step-aligned singleton face products', () => {
  const filtered = filterSemanticOwnerSupportRoleProducts(
    [
      {
        merchant_id: 'external_seed',
        product_id: 'ext_trio',
        display_name: 'On-the-Glow SHIELD SPF 50 Sunscreen Trio (Set of 3)',
        category: 'external',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_oil',
        display_name: '+C Vit Priming Oil',
        category: 'external',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_body',
        display_name: 'Jumbo Butta Drop Whipped Oil Body Cream',
        category: 'Cream',
      },
      {
        merchant_id: 'external_seed',
        product_id: 'ext_sunscreen',
        display_name: 'Invisible Face Sunscreen SPF 50',
        category: 'Sunscreen',
      },
    ],
    { targetStepFamily: 'sunscreen', roleId: 'daily_sunscreen' },
  );

  assert.deepEqual(
    filtered.map((product) => ({
      product_id: product.product_id,
      retrieval_role_id: product.retrieval_role_id,
      retrieval_step: product.retrieval_step,
    })),
    [
      {
        product_id: 'ext_sunscreen',
        retrieval_role_id: 'daily_sunscreen',
        retrieval_step: 'sunscreen',
      },
    ],
  );
  assert.equal(
    isSemanticOwnerEligibleSupportRoleProduct(
      {
        merchant_id: 'external_seed',
        product_id: 'ext_body_moisturizer',
        display_name: 'Body Cream',
        category: 'Cream',
      },
      { targetStepFamily: 'moisturizer' },
    ),
    false,
  );
});

test('semantic-owner support supplement keeps a small non-blocking timeout budget', () => {
  assert.equal(
    getSemanticOwnerSupportSupplementTimeoutMs({
      remainingBudgetMs: 9000,
      latencyGuardMs: 2000,
    }),
    1800,
  );
  assert.equal(
    getSemanticOwnerSupportSupplementTimeoutMs({
      remainingBudgetMs: 2300,
      latencyGuardMs: 2000,
    }),
    0,
  );
  assert.equal(
    getSemanticOwnerSupportSupplementTimeoutMs({
      remainingBudgetMs: 0,
      latencyGuardMs: 2000,
    }),
    1200,
  );
});
