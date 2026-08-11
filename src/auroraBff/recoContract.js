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

function pickFirstString(...values) {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) return normalized;
  }
  return '';
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

function applyVerifiedCandidateRestoreToRecoPayload(payload, restoredRecommendations) {
  if (!isPlainObject(payload)) {
    return { payload, applied: false, count: 0 };
  }
  const restored = asArray(restoredRecommendations).filter((row) => isPlainObject(row));
  if (!restored.length) {
    return { payload, applied: false, count: 0 };
  }

  const nextPayload = { ...payload };
  const restoredRecommendationMeta = isPlainObject(nextPayload.recommendation_meta)
    ? { ...nextPayload.recommendation_meta }
    : {};

  // Fabrication-belt F4 (2026-08-11): the restore path used to DELETE the
  // original failure telemetry outright — dashboards aggregating these fields
  // were fed a scrubbed history. The restore still supersedes the failure (the
  // buyer gets grounded recommendations), but the original context now travels
  // under `restored_from_failure_context` instead of vanishing.
  const RESTORE_SUPERSEDED_FIELDS = [
    'primary_failure_reason',
    'telemetry_failure_reason',
    'failure_class',
    'effective_failure_class',
    'failure_origin',
    'surface_reason',
    'products_empty_reason',
    'catalog_skip_reason',
    'upstream_status',
    'weak_viable_pool',
    'same_family_success_threshold_met',
    'overall_target_fidelity_satisfied',
    'selected_candidate_count',
    'candidate_pool_signature',
  ];
  const supersededContext = {};
  for (const field of RESTORE_SUPERSEDED_FIELDS) {
    if (field in restoredRecommendationMeta) {
      supersededContext[field] = restoredRecommendationMeta[field];
      delete restoredRecommendationMeta[field];
    }
  }
  if (Object.keys(supersededContext).length > 0) {
    restoredRecommendationMeta.restored_from_failure_context = supersededContext;
  }

  nextPayload.source = 'catalog_grounded_v1';
  nextPayload.recommendations = restored;
  nextPayload.grounding_status = 'grounded';
  nextPayload.grounded_count = restored.length;
  nextPayload.ungrounded_count = 0;
  nextPayload.recommendation_confidence_level =
    pickFirstString(nextPayload.recommendation_confidence_level, 'medium') || 'medium';
  // F4: never invent a precise-looking score. If nothing computed one, say so
  // with null (legacyChatRecoFinalize already defaults its view to null).
  nextPayload.recommendation_confidence_score =
    Number.isFinite(Number(nextPayload.recommendation_confidence_score))
      ? Number(nextPayload.recommendation_confidence_score)
      : null;
  nextPayload.recommendation_meta = {
    ...restoredRecommendationMeta,
    source_mode: 'catalog_grounded',
    contract_status: 'recommendations_ready',
    mainline_status: 'grounded_success',
    grounding_status: 'grounded',
    grounded_count: restored.length,
    ungrounded_count: 0,
    upstream_status: 'ok',
    effective_failure_class: 'none',
    failure_origin: 'none',
    terminal_success: true,
    viable_pool_strength: 'strong',
    target_fidelity_level: 'satisfied',
    presentation_mode: 'deterministic_degraded',
    success_mode: 'degraded_success',
    same_family_success_threshold_met: true,
    overall_target_fidelity_satisfied: true,
    pre_llm_selected_candidate_count: restored.length,
    final_selected_candidate_count: restored.length,
    post_guardrail_count: restored.length,
    selected_candidate_count: restored.length,
    verified_candidate_restore_applied: true,
    verified_candidate_restore_count: restored.length,
  };
  nextPayload.metadata = {
    ...(isPlainObject(nextPayload.metadata) ? nextPayload.metadata : {}),
    mainline_status: 'grounded_success',
    contract_status: 'recommendations_ready',
    verified_candidate_restore_applied: true,
    verified_candidate_restore_count: restored.length,
  };

  delete nextPayload.products_empty_reason;
  delete nextPayload.failure_reason;
  delete nextPayload.telemetry_reason;
  delete nextPayload.mainline_status;

  return { payload: nextPayload, applied: true, count: restored.length };
}

module.exports = {
  isPlainObject,
  getRecommendations,
  hasNonEmptyRecommendationsPayload,
  getRecommendationTaskMode,
  isExplicitIngredientRecoEmptyMode,
  cardHasNonEmptyRecommendations,
  hasNonEmptyRecommendationsCard,
  applyVerifiedCandidateRestoreToRecoPayload,
};
