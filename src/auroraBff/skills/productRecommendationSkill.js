const {
  buildProductRecommendations,
  buildIngredientProductRecommendationsNeutral,
} = require('../productRecV1');
const { runSkill } = require('./contracts');

function coerceMode(mode) {
  const token = String(mode || '').trim().toLowerCase();
  if (token === 'ingredient_neutral') return 'ingredient_neutral';
  return 'module';
}

async function runProductRecommendationSkill({
  requestContext,
  logger,
  mode = 'module',
  input = {},
} = {}) {
  return runSkill({
    skillName: 'product_recommendation',
    stage: 'product_recommendation',
    provider: 'product_rec_v1',
    requestContext,
    logger,
    run: async () => {
      const resolvedMode = coerceMode(mode);
      if (resolvedMode === 'ingredient_neutral') {
        const out = await buildIngredientProductRecommendationsNeutral(input || {});
        const products = Array.isArray(out && out.products) ? out.products : [];
        return {
          mode: resolvedMode,
          recommendations: products,
          suppressed_reason: out && out.suppressed_reason ? out.suppressed_reason : null,
          products_empty_reason: out && out.products_empty_reason ? out.products_empty_reason : null,
          external_search_ctas: Array.isArray(out && out.external_search_ctas) ? out.external_search_ctas : [],
          debug: out && out.debug && typeof out.debug === 'object' ? out.debug : null,
        };
      }

      const out = buildProductRecommendations(input || {});
      const products = Array.isArray(out && out.products) ? out.products : [];
      return {
        mode: resolvedMode,
        recommendations: products,
        suppressed_reason: out && out.suppressed_reason ? out.suppressed_reason : null,
        debug: out && out.debug && typeof out.debug === 'object' ? out.debug : null,
      };
    },
  });
}

module.exports = {
  runProductRecommendationSkill,
};

