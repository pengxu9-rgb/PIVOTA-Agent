const {
  LOCAL_INGREDIENT_RECALL_REGISTRY: INGREDIENT_RECALL_PROFILES,
  resolveIngredientRecallProfileId,
  resolveIngredientRecallProfile,
  resolveIngredientRecallProfileKnowledge,
  hasIngredientRegistryIntentSignal,
  getIngredientRecallRegistryHealth,
} = require('./ingredientRecallRegistry');
const {
  EVIDENCE_MODE,
  recallIngredientProductsFromProfile,
  stabilizeIngredientRecallProducts,
} = require('./ingredientSkuEvidence');

async function recallIngredientProducts({
  target = null,
  query = '',
  ingredientId = '',
  recallKnowledge = null,
  ...rest
} = {}) {
  const knowledge =
    recallKnowledge && typeof recallKnowledge === 'object'
      ? recallKnowledge
      : await resolveIngredientRecallProfileKnowledge({ target, query, ingredientId });
  return recallIngredientProductsFromProfile({
    profile: knowledge?.profile || null,
    registryDiagnostics:
      knowledge?.diagnostics && typeof knowledge.diagnostics === 'object'
        ? knowledge.diagnostics
        : {},
    query,
    ...rest,
  });
}

module.exports = {
  EVIDENCE_MODE,
  INGREDIENT_RECALL_PROFILES,
  resolveIngredientRecallProfileId,
  resolveIngredientRecallProfile,
  resolveIngredientRecallProfileKnowledge,
  hasIngredientRegistryIntentSignal,
  getIngredientRecallRegistryHealth,
  recallIngredientProducts,
  stabilizeIngredientRecallProducts,
};
