function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getRecommendations(payload) {
  return Array.isArray(payload && payload.recommendations) ? payload.recommendations : [];
}

function hasNonEmptyRecommendationsPayload(payload) {
  const recommendations = getRecommendations(payload);
  if (recommendations.length > 0) return true;

  const count = Number(
    isPlainObject(payload)
      ? payload.recommendations_count ?? payload.recommendation_count ?? payload.recommendationsCount
      : 0,
  );
  return Number.isFinite(count) && count > 0;
}

function getRecommendationTaskMode(payload) {
  const base = isPlainObject(payload) ? payload : {};
  const recommendationMeta = isPlainObject(base.recommendation_meta) ? base.recommendation_meta : {};
  return (
    asString(base.task_mode) ||
    asString(base.taskMode) ||
    asString(recommendationMeta.task_mode) ||
    asString(recommendationMeta.taskMode)
  ).toLowerCase();
}

function isExplicitIngredientRecoEmptyMode(payload) {
  const base = isPlainObject(payload) ? payload : {};
  const recommendations = getRecommendations(base);
  if (recommendations.length > 0) return false;

  const taskMode = getRecommendationTaskMode(base);
  if (!taskMode.startsWith('ingredient_')) return false;

  const emptyReason = asString(base.products_empty_reason).toLowerCase();
  const constraintMatchSummary = isPlainObject(base.constraint_match_summary) ? base.constraint_match_summary : {};
  const matched = Number(constraintMatchSummary.matched);
  const emptyActions = asArray(base.empty_match_actions);
  const missingInfo = asArray(base.missing_info).map((value) => asString(value).toLowerCase()).filter(Boolean);

  return (
    emptyReason === 'ingredient_constraint_no_match' ||
    emptyReason === 'ingredient_no_verified_candidates' ||
    emptyActions.length > 0 ||
    (Number.isFinite(matched) && matched === 0) ||
    missingInfo.includes('ingredient_constraint_no_match') ||
    missingInfo.includes('ingredient_no_verified_candidates')
  );
}

function cardHasNonEmptyRecommendations(card) {
  if (!isPlainObject(card)) return false;
  if (asString(card.type).toLowerCase() !== 'recommendations') return false;
  return hasNonEmptyRecommendationsPayload(isPlainObject(card.payload) ? card.payload : {});
}

function hasNonEmptyRecommendationsCard(cards) {
  return (Array.isArray(cards) ? cards : []).some((card) => cardHasNonEmptyRecommendations(card));
}

module.exports = {
  isPlainObject,
  getRecommendations,
  hasNonEmptyRecommendationsPayload,
  getRecommendationTaskMode,
  isExplicitIngredientRecoEmptyMode,
  cardHasNonEmptyRecommendations,
  hasNonEmptyRecommendationsCard,
};
