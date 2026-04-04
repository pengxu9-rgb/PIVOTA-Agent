const RECOMMENDATION_DECISION_CAPABILITY_VERSION = 'recommendation_decision_capability_v1';
const TARGET_RELEVANCE_CLASS_OWNER = 'shared_relevance_classifier';
const SHARED_TARGET_RELEVANCE_POLICY_VERSION = 'shared_target_relevance_policy_v2';
const TOP3_TARGET_RELEVANCE_CONTRACT_VERSION = 'top3_target_relevance_contract_v1';
const SERUM_PANTHENOL_CANARY_BACKBONE_ID = 'serum_panthenol_canary_backbone_v1';

const TARGET_RELEVANCE_CLASSES = Object.freeze([
  'strong_goal_family',
  'supportive_family',
  'generic_family',
  'adjacent_noise',
  'hard_invalid',
]);

const TARGET_RELEVANCE_CLASS_ORDER = Object.freeze({
  strong_goal_family: 0,
  supportive_family: 1,
  generic_family: 2,
  adjacent_noise: 3,
  hard_invalid: 4,
});

const RECOMMENDATION_DECISION_MODES = Object.freeze({
  guidance_only: 'guidance_only',
  step_aware_reco: 'step_aware_reco',
});

const BARRIER_MOISTURIZER_TARGET_POLICY_V2 = Object.freeze({
  policy_version: SHARED_TARGET_RELEVANCE_POLICY_VERSION,
  core_anchor_set: Object.freeze(['barrier', 'repair', 'ceramide']),
  supportive_anchor_set: Object.freeze(['sensitive', 'fragrance-free', 'soothing']),
  noise_anchor_set: Object.freeze(['tinted', 'peel', 'brightening', 'spf']),
  family_only_match_rule: 'same_family_without_anchor',
  offer_type_penalty_rule: 'bundle_duo_set_kit_demote_sample_penalize',
});

const BARRIER_SERUM_TARGET_POLICY_V1 = Object.freeze({
  policy_version: SHARED_TARGET_RELEVANCE_POLICY_VERSION,
  core_anchor_set: Object.freeze(['panthenol', 'b5', 'barrier', 'repair']),
  supportive_anchor_set: Object.freeze(['soothing', 'sensitive', 'centella', 'cica', 'hydrating']),
  noise_anchor_set: Object.freeze(['tinted', 'peel', 'brightening', 'spf', 'hair']),
  family_only_match_rule: 'same_family_without_anchor',
  offer_type_penalty_rule: 'bundle_duo_set_kit_demote_sample_penalize',
});

function asString(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeRecommendationDecisionMode(value, { guidanceOnlyDiscovery = false } = {}) {
  if (guidanceOnlyDiscovery === true) return RECOMMENDATION_DECISION_MODES.guidance_only;
  const token = asString(value).toLowerCase();
  if (token === 'guidance_only' || token === 'guidance-only') {
    return RECOMMENDATION_DECISION_MODES.guidance_only;
  }
  if (token === 'step_aware_reco' || token === 'step-aware-reco' || token === 'step_aware') {
    return RECOMMENDATION_DECISION_MODES.step_aware_reco;
  }
  return null;
}

function normalizeTargetRelevanceClass(value) {
  const token = asString(value).toLowerCase();
  if (TARGET_RELEVANCE_CLASSES.includes(token)) return token;
  return 'generic_family';
}

function normalizeQueryStepStrength(value) {
  const token = asString(value).toLowerCase();
  if (token === 'strong_goal_family' || token === 'supportive_family' || token === 'generic_family') {
    return token;
  }
  return null;
}

function detectSerumCanaryVariantOverlay(queryText) {
  const text = asString(queryText).toLowerCase();
  if (!text) return null;
  if (/\b(barrier|repair)\b/.test(text)) return 'barrier_repair_focus';
  if (/\b(soothing|sensitive|cica|centella|calming)\b/.test(text)) return 'soothing_focus';
  return 'ingredient_fidelity';
}

function normalizeSharedTargetIntent({
  queryText = '',
  targetStepFamily = '',
  mode = null,
  queryStepStrength = '',
} = {}) {
  const normalizedMode = normalizeRecommendationDecisionMode(mode);
  const normalizedTargetStepFamily = asString(targetStepFamily).toLowerCase() || null;
  const normalizedStrength = normalizeQueryStepStrength(queryStepStrength);
  const normalizedQuery = asString(queryText).toLowerCase();
  const out = {
    target_step_family: normalizedTargetStepFamily,
    query_step_strength: normalizedStrength,
    mode: normalizedMode,
    backbone_id: null,
    variant_overlay: null,
  };
  if (
    normalizedMode === RECOMMENDATION_DECISION_MODES.guidance_only &&
    normalizedTargetStepFamily === 'serum' &&
    /\b(panthenol|vitamin[- ]?b5|\bb5\b)\b/.test(normalizedQuery)
  ) {
    out.backbone_id = SERUM_PANTHENOL_CANARY_BACKBONE_ID;
    out.variant_overlay = detectSerumCanaryVariantOverlay(normalizedQuery);
  }
  return out;
}

function getTargetRelevanceClassRank(value) {
  const normalized = normalizeTargetRelevanceClass(value);
  return Number.isFinite(Number(TARGET_RELEVANCE_CLASS_ORDER[normalized]))
    ? TARGET_RELEVANCE_CLASS_ORDER[normalized]
    : TARGET_RELEVANCE_CLASS_ORDER.generic_family;
}

function shouldUseSharedTargetRelevancePipeline({
  mode = null,
  targetStepFamily = '',
  queryStepStrength = '',
} = {}) {
  const normalizedMode = normalizeRecommendationDecisionMode(mode);
  const normalizedStep = asString(targetStepFamily).toLowerCase();
  if (normalizedStep === 'treatment' || normalizedStep === 'sunscreen') {
    return true;
  }
  if (normalizedMode === RECOMMENDATION_DECISION_MODES.guidance_only) {
    return normalizedStep === 'moisturizer' || normalizedStep === 'serum';
  }
  if (normalizedMode === RECOMMENDATION_DECISION_MODES.step_aware_reco) {
    return normalizedStep === 'moisturizer';
  }
  return false;
}

function countTargetRelevanceClasses(items) {
  const counts = {
    strong_goal_family: 0,
    supportive_family: 0,
    generic_family: 0,
    adjacent_noise: 0,
    hard_invalid: 0,
  };
  for (const item of Array.isArray(items) ? items : []) {
    const token = normalizeTargetRelevanceClass(item);
    counts[token] = Number(counts[token] || 0) + 1;
  }
  return counts;
}

function buildTop3Contract({
  topCandidateClasses = [],
} = {}) {
  const visibleTop3 = (Array.isArray(topCandidateClasses) ? topCandidateClasses : []).slice(0, 3);
  const visibleCount = visibleTop3.length;
  const top3Counts = countTargetRelevanceClasses(visibleTop3);
  const enoughHighQualityVisible =
    top3Counts.strong_goal_family >= 1
    || top3Counts.supportive_family >= 2
    || (
      visibleCount > 0
      && visibleCount < 3
      && top3Counts.supportive_family >= 1
      && top3Counts.adjacent_noise === 0
      && top3Counts.hard_invalid === 0
    );
  const satisfied = visibleCount > 0
    && top3Counts.hard_invalid === 0
    && top3Counts.adjacent_noise === 0
    && enoughHighQualityVisible
    && top3Counts.generic_family <= 1;
  return {
    contract_version: TOP3_TARGET_RELEVANCE_CONTRACT_VERSION,
    satisfied,
    visible_count: visibleCount,
    counts: top3Counts,
  };
}

function buildQualityGateResult({
  applied = false,
  strongCount = 0,
  supportiveCount = 0,
  supportiveDistinctCount = supportiveCount,
} = {}) {
  const normalizedStrongCount = Math.max(0, Number(strongCount || 0) || 0);
  const normalizedSupportiveCount = Math.max(0, Number(supportiveCount || 0) || 0);
  const normalizedSupportiveDistinctCount = Math.max(
    0,
    Number(supportiveDistinctCount == null ? normalizedSupportiveCount : supportiveDistinctCount) || 0,
  );
  const satisfied =
    normalizedStrongCount >= 1 ||
    normalizedSupportiveDistinctCount >= 2;
  return {
    applied: applied === true,
    satisfied,
    rule: 'at_least_one_strong_or_two_distinct_supportive',
    strong_count: normalizedStrongCount,
    supportive_count: normalizedSupportiveCount,
    supportive_distinct_count: normalizedSupportiveDistinctCount,
  };
}

function buildSuccessContractResult({
  mode = null,
  targetStepFamily = '',
  queryStepStrength = '',
  queryText = '',
  candidateClassCounts = {},
  topCandidateClasses = [],
  qualityGateResult = null,
} = {}) {
  const normalizedMode = normalizeRecommendationDecisionMode(mode);
  const normalizedTargetStepFamily = asString(targetStepFamily).toLowerCase();
  const normalizedIntent = normalizeSharedTargetIntent({
    queryText,
    targetStepFamily: normalizedTargetStepFamily,
    mode: normalizedMode,
    queryStepStrength,
  });
  const applied = shouldUseSharedTargetRelevancePipeline({
    mode: normalizedMode,
    targetStepFamily: normalizedTargetStepFamily,
    queryStepStrength,
  });
  const normalizedCounts = countTargetRelevanceClasses(
    Object.entries(candidateClassCounts || {}).flatMap(([token, count]) => Array(Math.max(0, Number(count) || 0)).fill(token)),
  );
  const top3Contract = buildTop3Contract({ topCandidateClasses });
  const resolvedQualityGateResult =
    qualityGateResult && typeof qualityGateResult === 'object'
      ? {
          ...qualityGateResult,
          applied: applied === true,
        }
      : buildQualityGateResult({
          applied,
          strongCount: normalizedCounts.strong_goal_family,
          supportiveCount: normalizedCounts.supportive_family,
        });
  if (!applied) {
    return {
      owner: TARGET_RELEVANCE_CLASS_OWNER,
      policy_version: SHARED_TARGET_RELEVANCE_POLICY_VERSION,
      capability_version: RECOMMENDATION_DECISION_CAPABILITY_VERSION,
      applied: false,
      satisfied: false,
      step_success_class: null,
      failure_class: null,
      stop_on_success: false,
      top3_contract: top3Contract,
      quality_gate_result: resolvedQualityGateResult,
    };
  }

  let stepSuccessClass = null;
  let failureClass = null;
  const explicitQualityGateSatisfied = resolvedQualityGateResult.satisfied === true;
  const serumCanaryGuidance =
    normalizedMode === RECOMMENDATION_DECISION_MODES.guidance_only &&
    normalizedTargetStepFamily === 'serum' &&
    Boolean(normalizedIntent?.backbone_id);
  const supportiveTop3ShortListSatisfied =
    !serumCanaryGuidance &&
    top3Contract.satisfied &&
    normalizedCounts.supportive_family >= 1 &&
    Number(top3Contract.visible_count || 0) > 0 &&
    Number(top3Contract.visible_count || 0) < 3;
  if (resolvedQualityGateResult.strong_count >= 1) {
    stepSuccessClass = 'strong_goal_family';
  } else if (resolvedQualityGateResult.supportive_distinct_count >= 2) {
    stepSuccessClass = 'supportive_family';
  } else if (supportiveTop3ShortListSatisfied) {
    stepSuccessClass = 'supportive_family';
  } else if (normalizedCounts.adjacent_noise >= Math.max(1, normalizedCounts.generic_family + normalizedCounts.supportive_family + normalizedCounts.strong_goal_family)) {
    failureClass = 'retrieval_direction_weak';
  } else if (normalizedCounts.generic_family > 0) {
    failureClass = 'generic_family_only';
  } else if (normalizedCounts.hard_invalid > 0 && normalizedCounts.strong_goal_family === 0 && normalizedCounts.supportive_family === 0) {
    failureClass = 'hard_invalid_only';
  } else {
    failureClass = 'no_target_relevant_candidates';
  }

  return {
    owner: TARGET_RELEVANCE_CLASS_OWNER,
    policy_version: SHARED_TARGET_RELEVANCE_POLICY_VERSION,
    capability_version: RECOMMENDATION_DECISION_CAPABILITY_VERSION,
    applied: true,
    satisfied: Boolean(stepSuccessClass) && (explicitQualityGateSatisfied || supportiveTop3ShortListSatisfied),
    step_success_class: stepSuccessClass,
    failure_class: stepSuccessClass ? null : failureClass,
    stop_on_success: Boolean(stepSuccessClass) && (explicitQualityGateSatisfied || supportiveTop3ShortListSatisfied),
    top3_contract: top3Contract,
    quality_gate_result: resolvedQualityGateResult,
  };
}

function buildRecommendationDecisionCapabilityOutput({
  normalized_intent = null,
  query_plan = null,
  candidate_class_counts = {},
  step_success_class = null,
  success_contract_result = null,
  surface_reason = null,
  output_policy_payload = null,
} = {}) {
  return {
    capability_version: RECOMMENDATION_DECISION_CAPABILITY_VERSION,
    normalized_intent: normalized_intent || null,
    query_plan: query_plan || null,
    candidate_class_counts: countTargetRelevanceClasses(
      Object.entries(candidate_class_counts || {}).flatMap(([token, count]) => Array(Math.max(0, Number(count) || 0)).fill(token)),
    ),
    step_success_class: step_success_class || null,
    success_contract_result: success_contract_result || null,
    surface_reason: surface_reason || null,
    output_policy_payload: output_policy_payload || null,
  };
}

module.exports = {
  RECOMMENDATION_DECISION_CAPABILITY_VERSION,
  TARGET_RELEVANCE_CLASS_OWNER,
  SHARED_TARGET_RELEVANCE_POLICY_VERSION,
  TOP3_TARGET_RELEVANCE_CONTRACT_VERSION,
  RECOMMENDATION_DECISION_MODES,
  SERUM_PANTHENOL_CANARY_BACKBONE_ID,
  TARGET_RELEVANCE_CLASS_ORDER,
  BARRIER_MOISTURIZER_TARGET_POLICY_V2,
  BARRIER_SERUM_TARGET_POLICY_V1,
  normalizeRecommendationDecisionMode,
  normalizeQueryStepStrength,
  normalizeTargetRelevanceClass,
  normalizeSharedTargetIntent,
  getTargetRelevanceClassRank,
  shouldUseSharedTargetRelevancePipeline,
  countTargetRelevanceClasses,
  buildTop3Contract,
  buildQualityGateResult,
  buildSuccessContractResult,
  buildRecommendationDecisionCapabilityOutput,
};
