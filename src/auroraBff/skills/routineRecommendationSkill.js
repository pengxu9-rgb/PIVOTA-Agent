'use strict';

const { runSkill } = require('./contracts');

async function runRoutineRecommendationSkill({
  requestContext,
  logger,
  routineCandidate,
  routineExpert,
  profileSummary,
  lifecycleContext,
  language,
  buildRecommendationsFn,
} = {}) {
  return runSkill({
    skillName: 'routine_recommendation',
    stage: 'routine_recommendation',
    provider: 'routine_reco_v1',
    requestContext,
    logger,
    timeoutMs: 8000,
    run: async () => {
      const lang = language === 'CN' ? 'CN' : 'EN';

      const existingProducts = extractExistingProducts(routineCandidate);
      const issues = routineExpert && Array.isArray(routineExpert.key_issues) ? routineExpert.key_issues : [];
      const goals = profileSummary && Array.isArray(profileSummary.goals) ? profileSummary.goals : [];

      const recoInput = {
        existing_products: existingProducts,
        issues: issues.map((i) => ({ id: i.id, severity: i.severity, title: i.title })).slice(0, 5),
        goals,
        skin_type: profileSummary && profileSummary.skinType || null,
        sensitivity: profileSummary && profileSummary.sensitivity || null,
        barrier_status: profileSummary && profileSummary.barrierStatus || null,
        lifecycle_stage: lifecycleContext && lifecycleContext.stage || null,
        language: lang,
      };

      if (buildRecommendationsFn && typeof buildRecommendationsFn === 'function') {
        const result = await buildRecommendationsFn(recoInput);
        return {
          recommendations: result,
          based_on_existing: true,
          existing_product_count: existingProducts.length,
          issue_count: issues.length,
        };
      }

      return {
        recommendations: null,
        based_on_existing: true,
        existing_product_count: existingProducts.length,
        issue_count: issues.length,
        reco_input: recoInput,
      };
    },
  });
}

function extractExistingProducts(routineCandidate) {
  if (!routineCandidate || typeof routineCandidate !== 'object') return [];
  const products = [];

  for (const slot of ['am', 'pm']) {
    const steps = Array.isArray(routineCandidate[slot]) ? routineCandidate[slot] : [];
    for (const entry of steps) {
      if (!entry || typeof entry !== 'object') continue;
      const product = String(entry.product || '').trim();
      if (!product) continue;
      products.push({
        slot,
        step: String(entry.step || '').trim(),
        product,
        product_id: entry.product_id || null,
      });
    }
  }

  return products;
}

module.exports = {
  runRoutineRecommendationSkill,
  extractExistingProducts,
};
