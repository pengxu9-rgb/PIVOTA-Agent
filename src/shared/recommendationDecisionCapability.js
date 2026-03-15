const RECOMMENDATION_DECISION_CAPABILITY_VERSION = 'recommendation_decision_capability_v1';
const TARGET_RELEVANCE_CLASS_OWNER = 'shared_relevance_classifier';
const SHARED_TARGET_RELEVANCE_POLICY_VERSION = 'shared_target_relevance_policy_v2';
const TOP3_TARGET_RELEVANCE_CONTRACT_VERSION = 'top3_target_relevance_contract_v1';

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
  if (normalizedStep !== 'moisturizer') return false;
  if (normalizedMode === RECOMMENDATION_DECISION_MODES.guidance_only) return true;
  if (normalizedMode === RECOMMENDATION_DECISION_MODES.step_aware_reco) {
    return true;
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

function buildSuccessContractResult({
  mode = null,
  targetStepFamily = '',
  queryStepStrength = '',
  candidateClassCounts = {},
  topCandidateClasses = [],
} = {}) {
  const applied = shouldUseSharedTargetRelevancePipeline({ mode, targetStepFamily, queryStepStrength });
  const normalizedCounts = countTargetRelevanceClasses(
    Object.entries(candidateClassCounts || {}).flatMap(([token, count]) => Array(Math.max(0, Number(count) || 0)).fill(token)),
  );
  const top3Contract = buildTop3Contract({ topCandidateClasses });
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
    };
  }

  let stepSuccessClass = null;
  let failureClass = null;
  if (normalizedCounts.strong_goal_family >= 1) {
    stepSuccessClass = 'strong_goal_family';
  } else if (normalizedCounts.supportive_family >= 2) {
    stepSuccessClass = 'supportive_family';
  } else if (
    top3Contract.satisfied
    && normalizedCounts.supportive_family >= 1
    && Number(top3Contract.visible_count || 0) > 0
    && Number(top3Contract.visible_count || 0) < 3
  ) {
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
    satisfied: Boolean(stepSuccessClass),
    step_success_class: stepSuccessClass,
    failure_class: stepSuccessClass ? null : failureClass,
    stop_on_success: Boolean(stepSuccessClass),
    top3_contract: top3Contract,
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
  TARGET_RELEVANCE_CLASS_ORDER,
  BARRIER_MOISTURIZER_TARGET_POLICY_V2,
  normalizeRecommendationDecisionMode,
  normalizeTargetRelevanceClass,
  getTargetRelevanceClassRank,
  shouldUseSharedTargetRelevancePipeline,
  countTargetRelevanceClasses,
  buildTop3Contract,
  buildSuccessContractResult,
  buildRecommendationDecisionCapabilityOutput,
};
