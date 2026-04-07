const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_RECO_CATALOG_GROUNDED = 'true';
process.env.AURORA_CHATCARDS_RESPONSE_CONTRACT = 'dual';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';
process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'test_key';
process.env.AURORA_PRODUCT_MATCHER_ENABLED = 'false';
process.env.AURORA_INGREDIENT_PLAN_ENABLED = 'false';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.AURORA_BFF_RECO_STEP_AWARE_CATALOG_FIRST_ENABLED = 'true';
process.env.AURORA_BFF_RECO_CENTRALIZED_FAILURE_MAPPING_ENABLED = 'true';
process.env.AURORA_BFF_RECO_STEP_AWARE_SHADOW_COMPARE_ENABLED = 'false';
process.env.AURORA_PURCHASABLE_FALLBACK_ENABLED = 'true';
process.env.AURORA_EXTERNAL_SEED_SUPPLEMENT_ENABLED = 'true';

const {
  buildConcernCandidateText,
  buildConcernFrameworkCandidateText,
} = require('../src/auroraBff/productScopeClassifier');

const ROUTES_MODULE_PATH = require.resolve('../src/auroraBff/routes');
const AURORA_DECISION_CLIENT_MODULE_PATH = require.resolve('../src/auroraBff/auroraDecisionClient');

function loadRoutesFresh() {
  delete require.cache[AURORA_DECISION_CLIENT_MODULE_PATH];
  delete require.cache[ROUTES_MODULE_PATH];
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require('../src/auroraBff/routes');
}

test('external-seed concern candidate text ignores polluted description-only signals', () => {
  const pollutedExternal = {
    merchant_id: 'external_seed',
    source: 'external_seed',
    brand: 'PIXI',
    display_name: 'PIXI Ultimate Skincare Set',
    category: 'beauty',
    short_description: 'A mattifying oil-control serum for oily skin with niacinamide and salicylic acid.',
    description_tokens: ['oil control', 'salicylic acid', 'niacinamide', 'serum'],
    benefit_tags: ['oil control', 'mattifying'],
    tag_tokens: ['serum', 'treatment'],
    ingredient_tokens: ['green tea'],
  };

  const candidateText = buildConcernCandidateText(pollutedExternal);
  const frameworkText = buildConcernFrameworkCandidateText(pollutedExternal);

  assert.match(candidateText, /\bpixi\b/);
  assert.match(candidateText, /\bultimate skincare set\b/);
  assert.doesNotMatch(candidateText, /\bsalicylic acid\b/);
  assert.doesNotMatch(candidateText, /\bniacinamide\b/);
  assert.doesNotMatch(candidateText, /\boil control\b/);
  assert.doesNotMatch(candidateText, /\bserum\b/);
  assert.doesNotMatch(frameworkText, /\bsalicylic acid\b/);
  assert.doesNotMatch(frameworkText, /\bniacinamide\b/);
});

test('framework pool does not let polluted external bundle outrank a role-aligned singleton treatment', () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      __internal.normalizeRecoCatalogProduct({
        product_id: 'ext_bundle_polluted_1',
        merchant_id: 'external_seed',
        source: 'external_seed',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'oil_control_treatment',
        brand: 'PIXI',
        display_name: 'PIXI Ultimate Skincare Set',
        category: 'beauty',
        short_description: 'A mattifying oil-control serum for oily skin with niacinamide and salicylic acid.',
        description_tokens: ['oil control', 'salicylic acid', 'niacinamide', 'serum'],
        benefit_tags: ['oil control', 'mattifying'],
        tag_tokens: ['serum', 'treatment'],
      }),
      __internal.normalizeRecoCatalogProduct({
        product_id: 'int_treatment_singleton_1',
        merchant_id: 'shopify',
        retrieval_source: 'catalog',
        retrieval_role_id: 'oil_control_treatment',
        brand: 'Clarity Lab',
        display_name: 'Clarity Lab Shine Balance Serum',
        category: 'serum',
        product_type: 'serum',
        search_aliases: ['Oil Control Serum'],
        benefit_tags: ['oil control', 'mattifying'],
        short_description: 'A balancing serum for oily skin.',
      }),
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_external_seed_quality',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
            ingredient_hypotheses: ['Niacinamide', 'Zinc PCA'],
            product_type_hypotheses: ['treatment', 'serum'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_recommendations[0]?.product_id, 'int_treatment_singleton_1');
  assert.ok(
    !state.selected_recommendations.some((item) => item?.product_id === 'ext_bundle_polluted_1'),
  );
});
