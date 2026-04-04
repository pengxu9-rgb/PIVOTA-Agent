const {
  classifyBeautyBucketFromText,
  detectBeautyQueryBucket,
} = require('../findProductsMulti/beautyQueryProfile');
const {
  resolveRecoTargetStepIntent,
  normalizeRecoTargetStep,
  getRecoTargetFamilyRelation,
} = require('../auroraBff/recoTargetStep');
const {
  TARGET_RELEVANCE_CLASS_OWNER,
  SHARED_TARGET_RELEVANCE_POLICY_VERSION,
  BARRIER_MOISTURIZER_TARGET_POLICY_V2,
  BARRIER_SERUM_TARGET_POLICY_V1,
  normalizeRecommendationDecisionMode,
  normalizeSharedTargetIntent,
  getTargetRelevanceClassRank,
  buildQualityGateResult,
  buildSuccessContractResult,
  buildRecommendationDecisionCapabilityOutput,
  countTargetRelevanceClasses,
  shouldUseSharedTargetRelevancePipeline,
} = require('./recommendationDecisionCapability');

const BEAUTY_SEARCH_DECISION_CONTRACT_VERSION = 'beauty_search_decision_v4';
const TOOL_RE = /\b(brush|applicator|tool|accessory|sponge|puff|mirror|curler|sharpener)\b/i;
const BRUSH_RE = /\b(brush|applicator|sponge|puff)\b/i;
const ACCESSORY_RE = /\b(accessory|mirror|curler|sharpener)\b/i;
const BODY_RE = /\b(body|hand|hands|nail|nails|cuticle|foot|heel|bath|shower|deodorant|butt|booty|butta|trio|set)\b/i;
const FACE_RE = /\b(face|facial|barrier cream|gel cream)\b/i;
const MAKEUP_RE = /\b(lip|lipstick|mascara|eyeshadow|shadow|blush|concealer|foundation|liner|brow|powder|highlighter)\b/i;
const SERVICE_RE = /\b(cabine|fauteuil|session|appointment|booking|spa)\b/i;
const SERVICE_FRENCH_RE = /\bsoin\b/i;
const SERVICE_DURATION_RE = /\b\d+\s*minutes?\b/i;
const SERVICE_CONTEXT_RE = /\b(session|appointment|booking|spa|facial|massage|service|cabine|fauteuil)\b/i;
const BUNDLE_RE = /\b(bundle)\b/i;
const DUO_RE = /\b(duo)\b/i;
const SET_RE = /\b(set)\b/i;
const KIT_RE = /\b(kit)\b/i;
const ROUTINE_BUNDLE_RE = /\b(routine|regimen|ritual|system)\b/i;
const SAMPLE_RE = /\b(sample|mini|travel size|trial size)\b/i;
const TINT_RE = /\b(skin tint|tinted|tint(ed)? moisturizer|bb cream|cc cream|foundation|concealer)\b/i;
const PEEL_RE = /\b(peel|exfoliant|exfoliating|resurfacing)\b/i;
const SPF_RE = /\b(spf\s*\d+|spf|sunscreen|sun screen|uv filters?)\b/i;
const CLEANSER_RE = /\b(cleanser|cleanse|cleansing|face wash|facial wash|wash[- ]off|wash off|foaming wash|cream cleanser)\b/i;
const HAIR_RE = /\b(hair|scalp|frizz|heat protectant|styling|conditioner|shampoo|leave[- ]?in|blowout|curl cream)\b/i;
const PET_RE = /\b(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets|harness|leash|collar)\b/i;
const BRIGHTENING_RE = /\b(brightening|vitamin c|glow|radiance)\b/i;
const MOISTURIZER_GUIDANCE_FAMILY_RE = /\b(moisturizer|moisturiser|cream|lotion|gel cream|balm)\b/i;
const SERUM_GUIDANCE_FAMILY_RE = /\b(serum|ampoule|essence)\b/i;
const TREATMENT_GUIDANCE_FAMILY_RE = /\b(treatment|spot treatment|serum|ampoule|concentrate|booster|solution|suspension|gel)\b/i;
const TREATMENT_GOAL_RE = /\b(oil control|shine control|acne|blemish|congestion|clarifying|salicylic|niacinamide|retinol|retinoid|azelaic|pore)\b/i;
const SUNSCREEN_GUIDANCE_FAMILY_RE = /\b(sunscreen|sun screen|sunblock|sun fluid|sun lotion|spf\s*\d+|broad spectrum|uv filters?)\b/i;
const SUNSCREEN_SUPPORTIVE_RE = /\b(face|facial|daily|lightweight|oil[- ]?control|oily|matte|non[- ]greasy|mineral|invisible)\b/i;
const GUIDANCE_BARRIER_RE = /\b(barrier|repair)\b/i;
const GUIDANCE_INGREDIENT_RE = /\b(ceramides?|panthenol|vitamin[- ]?b5|b5|niacinamide|hyalur|hyaluronic|centella|cica|allantoin|phyto.?ceramides?)\b/i;
const GUIDANCE_SENSITIVITY_RE = /\b(sensitive|fragrance[- ]free|gentle|soothing|calming)\b/i;
const GUIDANCE_HYDRATION_RE = /\b(hydrat\w*|dehydrat\w*|hyalur\w*|sodium hyaluronate|gel cream)\b/i;
const SERUM_TREATMENT_CUE_RE = /\b(serum|concentrate|booster|treatment)\b/i;
const SERUM_ADJACENT_LIQUID_RE = /\b(toner|mist|treatment lotion|hydrating liquid|essence lotion)\b/i;
const CACHE_OWNER_RE = /\b(?:cache(?:[_-][a-z0-9]+)+|[a-z0-9]+_cache(?:[_-][a-z0-9]+)*)\b/i;
const GUIDANCE_INGREDIENT_TOKEN_SPECS = Object.freeze([
  { key: 'ceramide', re: /\b(ceramides?|phyto.?ceramides?)\b/i },
  { key: 'panthenol', re: /\b(panthenol|vitamin[- ]?b5|b5)\b/i },
  { key: 'niacinamide', re: /\bniacinamide\b/i },
  { key: 'centella', re: /\b(centella|cica)\b/i },
  { key: 'allantoin', re: /\ballantoin\b/i },
  { key: 'hyaluronic', re: /\b(hyalur|hyaluronic)\b/i },
]);
const SOURCE_TIER_SCORE_ADJUSTMENTS = Object.freeze({
  fresh_internal: 28,
  fresh_external: 6,
  cache_fresh: -30,
  cache_stale: -44,
  fallback: -56,
});
const SOURCE_QUALITY_SCORE_ADJUSTMENTS = Object.freeze({
  trusted: 12,
  mixed: 0,
  degraded: -16,
});

function normalizeGuidanceIntentStrength(value) {
  const normalized = asString(value).toLowerCase();
  if (normalized === 'strong_goal_family') return 'strong_goal_family';
  if (normalized === 'supportive_family') return 'supportive_family';
  if (normalized === 'generic_family') return 'generic_family';
  return null;
}

function buildGuidanceAnchorFlags(text) {
  const lower = asString(text).toLowerCase();
  return {
    barrier: GUIDANCE_BARRIER_RE.test(lower),
    ingredient: GUIDANCE_INGREDIENT_RE.test(lower),
    sensitivity: GUIDANCE_SENSITIVITY_RE.test(lower),
    hydration: GUIDANCE_HYDRATION_RE.test(lower),
  };
}

function countGuidanceAnchorMatches(candidateFlags, queryFlags) {
  const flags = queryFlags && Object.values(queryFlags).some(Boolean) ? queryFlags : candidateFlags;
  let count = 0;
  if (flags.barrier && candidateFlags.barrier) count += 1;
  if (flags.ingredient && candidateFlags.ingredient) count += 1;
  if (flags.sensitivity && candidateFlags.sensitivity) count += 1;
  if (flags.hydration && candidateFlags.hydration) count += 1;
  return count;
}

function extractGuidanceIngredientTokens(text) {
  const lower = asString(text).toLowerCase();
  if (!lower) return new Set();
  const tokens = new Set();
  for (const spec of GUIDANCE_INGREDIENT_TOKEN_SPECS) {
    if (spec.re.test(lower)) tokens.add(spec.key);
  }
  return tokens;
}

function buildMoisturizerGuidanceSignalProfile(text) {
  const flags = buildGuidanceAnchorFlags(text);
  const ingredientTokens = extractGuidanceIngredientTokens(text);
  return {
    barrier: flags.barrier,
    ceramide: ingredientTokens.has('ceramide'),
    sensitivity: flags.sensitivity,
    hydration: flags.hydration,
    supportive_ingredient: Array.from(ingredientTokens).some((token) => token !== 'ceramide'),
  };
}

function buildMoisturizerGuidanceOverlayScore(candidateProfile, queryProfile) {
  let overlayScore = 0;
  let relevanceChannel = null;

  if (candidateProfile.barrier) {
    overlayScore += 2;
    relevanceChannel = relevanceChannel || 'goal-strong';
  }
  if (candidateProfile.ceramide) {
    overlayScore += 3;
    relevanceChannel = 'ingredient-strong';
  }
  if (candidateProfile.supportive_ingredient) overlayScore += 1;
  if (candidateProfile.hydration) overlayScore += 1;
  if (candidateProfile.sensitivity) overlayScore += 1;
  if (queryProfile.sensitivity && candidateProfile.sensitivity) overlayScore += 1;
  if ((queryProfile.barrier || queryProfile.ceramide) && candidateProfile.ceramide) overlayScore += 1;

  return {
    overlay_score: overlayScore,
    relevance_channel: relevanceChannel,
  };
}

function classifyBeautyGuidanceQueryStrength(queryText, { queryTargetStepFamily = null } = {}) {
  const targetStep = normalizeRecoTargetStep(queryTargetStepFamily);
  const text = asString(queryText).toLowerCase();
  if (!text) return 'generic_family';
  const flags = buildGuidanceAnchorFlags(text);
  if (targetStep === 'moisturizer' || MOISTURIZER_GUIDANCE_FAMILY_RE.test(text)) {
    if (flags.ingredient && (flags.barrier || flags.sensitivity || flags.hydration)) {
      return 'strong_goal_family';
    }
    if (flags.barrier || flags.ingredient || flags.sensitivity || flags.hydration) {
      return 'supportive_family';
    }
    return 'generic_family';
  }
  if (flags.ingredient && (flags.barrier || flags.sensitivity || flags.hydration)) {
    return 'strong_goal_family';
  }
  if (flags.barrier || flags.ingredient || flags.sensitivity || flags.hydration) {
    return 'supportive_family';
  }
  return 'generic_family';
}

function detectBeautyOfferType(text) {
  const lower = asString(text).toLowerCase();
  if (!lower) return 'unknown';
  if (BUNDLE_RE.test(lower)) return 'bundle';
  if (ROUTINE_BUNDLE_RE.test(lower)) return 'bundle';
  if (DUO_RE.test(lower)) return 'duo';
  if (SET_RE.test(lower)) return 'set';
  if (KIT_RE.test(lower)) return 'kit';
  if (SAMPLE_RE.test(lower)) return 'sample';
  return 'single';
}

function classifyGuidanceOnlyMoisturizerTargetRelevance({
  text,
  coarse,
  queryText,
  queryStepStrength,
}) {
  const lower = asString(text).toLowerCase();
  const offerType = detectBeautyOfferType(lower);
  const policy = BARRIER_MOISTURIZER_TARGET_POLICY_V2;
  const queryFlags = buildGuidanceAnchorFlags(queryText);
  const candidateFlags = buildGuidanceAnchorFlags(lower);
  const querySignalProfile = buildMoisturizerGuidanceSignalProfile(queryText);
  const candidateSignalProfile = buildMoisturizerGuidanceSignalProfile(lower);
  const guidanceOverlay = buildMoisturizerGuidanceOverlayScore(candidateSignalProfile, querySignalProfile);
  const anchorMatches = countGuidanceAnchorMatches(candidateFlags, queryFlags);
  const looksLikeMoisturizerFamily =
    coarse.candidate_step === 'moisturizer' || MOISTURIZER_GUIDANCE_FAMILY_RE.test(lower);
  const effectiveStrength =
    normalizeGuidanceIntentStrength(queryStepStrength) ||
    classifyBeautyGuidanceQueryStrength(queryText, { queryTargetStepFamily: 'moisturizer' });
  const queryHasCoreDemand =
    querySignalProfile.barrier ||
    querySignalProfile.ceramide;
  const candidateHasCoreSignal =
    candidateSignalProfile.barrier ||
    candidateSignalProfile.ceramide;
  const candidateHasSupportiveSignal =
    candidateSignalProfile.sensitivity ||
    candidateSignalProfile.hydration ||
    candidateSignalProfile.supportive_ingredient;

  if (coarse.object_type === 'service' || coarse.domain_scope === 'beauty_service') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'service' };
  }
  if (
    coarse.object_type === 'brush' ||
    coarse.object_type === 'tool' ||
    coarse.object_type === 'accessory' ||
    coarse.domain_scope === 'beauty_tool'
  ) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'tool' };
  }
  if (TINT_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'tint' };
  }
  if (HAIR_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'hair' };
  }
  if (coarse.candidate_step === 'cleanser' || CLEANSER_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'cleanser' };
  }
  if (SPF_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'spf' };
  }
  if (PEEL_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'peel' };
  }
  if (coarse.domain_scope === 'bodycare' || coarse.usage_scope === 'body') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'body' };
  }
  if (coarse.domain_scope === 'makeup') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'tool' };
  }
  if (coarse.application_mode === 'rinse_off') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'cleanser' };
  }
  if (coarse.family_relation === 'adjacent_family') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'adjacent_family' };
  }
  if (
    coarse.domain_scope !== 'skincare' ||
    coarse.object_type !== 'product' ||
    coarse.usage_scope !== 'face' ||
    (!looksLikeMoisturizerFamily && coarse.family_relation !== 'same_family')
  ) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'body' };
  }
  if (offerType === 'bundle' || offerType === 'duo' || offerType === 'set' || offerType === 'kit') {
    return { offer_type: offerType, target_relevance_class: 'adjacent_noise', noise_reason: 'bundle' };
  }
  if (BRIGHTENING_RE.test(lower) && (queryFlags.barrier || queryFlags.ingredient || queryFlags.sensitivity)) {
    return { offer_type: offerType, target_relevance_class: 'adjacent_noise', noise_reason: 'brightening' };
  }
  if (
    effectiveStrength !== 'generic_family' &&
    candidateHasCoreSignal &&
    (queryHasCoreDemand || queryFlags.sensitivity || queryFlags.hydration || queryFlags.ingredient)
  ) {
    return {
      offer_type: offerType,
      target_relevance_class: 'strong_goal_family',
      noise_reason: null,
      relevance_channel: guidanceOverlay.relevance_channel,
      overlay_score: guidanceOverlay.overlay_score,
      ingredient_overlap: candidateSignalProfile.ceramide || candidateSignalProfile.supportive_ingredient,
    };
  }
  if (
    coarse.family_relation === 'same_family' &&
    coarse.candidate_step_source === 'retrieval_step' &&
    coarse.candidate_step === 'moisturizer' &&
    offerType !== 'bundle' &&
    offerType !== 'duo' &&
    offerType !== 'set' &&
    offerType !== 'kit'
  ) {
    return {
      offer_type: offerType,
      target_relevance_class: 'supportive_family',
      noise_reason: null,
      relevance_channel: null,
      overlay_score: guidanceOverlay.overlay_score,
      ingredient_overlap: candidateSignalProfile.ceramide || candidateSignalProfile.supportive_ingredient,
    };
  }
  if (anchorMatches >= 2 && effectiveStrength !== 'generic_family' && candidateHasCoreSignal) {
    return {
      offer_type: offerType,
      target_relevance_class: 'strong_goal_family',
      noise_reason: null,
      relevance_channel: guidanceOverlay.relevance_channel,
      overlay_score: guidanceOverlay.overlay_score,
      ingredient_overlap: candidateSignalProfile.ceramide || candidateSignalProfile.supportive_ingredient,
    };
  }
  if (anchorMatches >= 1 || candidateHasSupportiveSignal) {
    return {
      offer_type: offerType,
      target_relevance_class: 'supportive_family',
      noise_reason: null,
      relevance_channel: null,
      overlay_score: guidanceOverlay.overlay_score,
      ingredient_overlap: candidateSignalProfile.ceramide || candidateSignalProfile.supportive_ingredient,
    };
  }
  if (
    candidateFlags.ingredient &&
    (queryFlags.barrier || queryFlags.sensitivity || queryFlags.hydration || queryFlags.ingredient)
  ) {
    return {
      offer_type: offerType,
      target_relevance_class: 'supportive_family',
      noise_reason: null,
      relevance_channel: null,
      overlay_score: guidanceOverlay.overlay_score,
      ingredient_overlap: candidateSignalProfile.ceramide || candidateSignalProfile.supportive_ingredient,
    };
  }
  return {
    offer_type: offerType,
    target_relevance_class: 'generic_family',
    noise_reason: null,
    relevance_channel: null,
    overlay_score: guidanceOverlay.overlay_score,
    ingredient_overlap: candidateSignalProfile.ceramide || candidateSignalProfile.supportive_ingredient,
  };
}

function classifyGuidanceOnlySerumTargetRelevance({
  text,
  coarse,
  queryText,
  queryStepStrength,
}) {
  const lower = asString(text).toLowerCase();
  const offerType = detectBeautyOfferType(lower);
  const queryFlags = buildGuidanceAnchorFlags(queryText);
  const candidateFlags = buildGuidanceAnchorFlags(lower);
  const queryIngredientTokens = extractGuidanceIngredientTokens(queryText);
  const candidateIngredientTokens = extractGuidanceIngredientTokens(lower);
  const ingredientOverlap = Array.from(candidateIngredientTokens).some((token) => queryIngredientTokens.has(token));
  const looksLikeSerumFamily =
    coarse.candidate_step === 'serum' || SERUM_GUIDANCE_FAMILY_RE.test(lower);
  const looksLikeAdjacentLiquid =
    SERUM_ADJACENT_LIQUID_RE.test(lower) ||
    (/\bessence\b/.test(lower) && !/\bserum\b/.test(lower)) ||
    (/\bampoule\b/.test(lower) && !/\bserum\b/.test(lower));
  const normalizedIntent = normalizeSharedTargetIntent({
    queryText,
    targetStepFamily: 'serum',
    mode: 'guidance_only',
    queryStepStrength,
  });
  const overlay = normalizedIntent?.variant_overlay || null;
  let overlayScore = 0;
  if (overlay === 'ingredient_fidelity') {
    if (ingredientOverlap) overlayScore += 2;
    if (candidateFlags.barrier || candidateFlags.sensitivity) overlayScore += 1;
  } else if (overlay === 'soothing_focus') {
    if (candidateFlags.sensitivity) overlayScore += 2;
    if (/\b(cica|centella|madecassoside|calming|redness)\b/.test(lower)) overlayScore += 1;
    if (ingredientOverlap) overlayScore += 1;
  } else if (overlay === 'barrier_repair_focus') {
    if (candidateFlags.barrier) overlayScore += 2;
    if (/\brepair\b/.test(lower)) overlayScore += 1;
    if (ingredientOverlap) overlayScore += 1;
  } else if (ingredientOverlap) {
    overlayScore += 1;
  }
  const queryConsistentAnchorFidelity =
    /\b(sensitive|cica|centella|madecassoside|panthenol|vitamin[- ]?b5|b5|allantoin|soothing|calming|repair|barrier)\b/.test(lower) ||
    SERUM_TREATMENT_CUE_RE.test(lower) ||
    overlayScore >= 2;
  const explicitSerumGoalCue =
    /\b(barrier|repair|soothing|calming|sensitive|cica|centella|madecassoside)\b/.test(lower) ||
    SERUM_TREATMENT_CUE_RE.test(lower);
  const effectiveStrength =
    normalizeGuidanceIntentStrength(queryStepStrength) ||
    classifyBeautyGuidanceQueryStrength(queryText, { queryTargetStepFamily: 'serum' });

  if (coarse.object_type === 'service' || coarse.domain_scope === 'beauty_service') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'service' };
  }
  if (
    coarse.object_type === 'brush' ||
    coarse.object_type === 'tool' ||
    coarse.object_type === 'accessory' ||
    coarse.domain_scope === 'beauty_tool'
  ) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'tool' };
  }
  if (TINT_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'tint' };
  }
  if (HAIR_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'hair' };
  }
  if (coarse.candidate_step === 'cleanser' || CLEANSER_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'cleanser' };
  }
  if (SPF_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'spf' };
  }
  if (PEEL_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'peel' };
  }
  if (coarse.domain_scope === 'bodycare' || coarse.usage_scope === 'body') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'body' };
  }
  if (coarse.domain_scope === 'makeup') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'tool' };
  }
  if (coarse.application_mode === 'rinse_off') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'cleanser' };
  }
  if (looksLikeAdjacentLiquid) {
    return {
      offer_type: offerType,
      target_relevance_class: 'adjacent_noise',
      noise_reason: 'adjacent_liquid',
      overlay_score: overlayScore,
      relevance_channel: null,
      ingredient_overlap: ingredientOverlap,
    };
  }
  if (coarse.family_relation === 'adjacent_family') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'adjacent_family' };
  }
  if (
    coarse.domain_scope !== 'skincare' ||
    coarse.object_type !== 'product' ||
    coarse.usage_scope !== 'face' ||
    (!looksLikeSerumFamily && coarse.family_relation !== 'same_family')
  ) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'body' };
  }
  if (offerType === 'bundle' || offerType === 'duo' || offerType === 'set' || offerType === 'kit') {
    return { offer_type: offerType, target_relevance_class: 'adjacent_noise', noise_reason: 'bundle' };
  }
  if (BRIGHTENING_RE.test(lower) && (queryFlags.barrier || queryFlags.ingredient || queryFlags.sensitivity)) {
    return {
      offer_type: offerType,
      target_relevance_class: 'adjacent_noise',
      noise_reason: 'brightening',
      overlay_score: overlayScore,
      relevance_channel: null,
      ingredient_overlap: ingredientOverlap,
    };
  }
  if (
    effectiveStrength !== 'generic_family' &&
    ingredientOverlap &&
    looksLikeSerumFamily &&
    !looksLikeAdjacentLiquid &&
    (
      candidateFlags.barrier ||
      candidateFlags.sensitivity ||
      candidateFlags.hydration ||
      overlayScore >= 1
    )
  ) {
    return {
      offer_type: offerType,
      target_relevance_class: 'strong_goal_family',
      noise_reason: null,
      relevance_channel: 'ingredient-strong',
      overlay_score: overlayScore,
      ingredient_overlap: ingredientOverlap,
    };
  }
  if (
    effectiveStrength !== 'generic_family' &&
    looksLikeSerumFamily &&
    !looksLikeAdjacentLiquid &&
    (candidateFlags.barrier || candidateFlags.sensitivity) &&
    queryConsistentAnchorFidelity &&
    (
      overlayScore >= 2 ||
      (
        !normalizedIntent?.backbone_id &&
        effectiveStrength !== 'generic_family' &&
        explicitSerumGoalCue
      )
    )
  ) {
    return {
      offer_type: offerType,
      target_relevance_class: 'strong_goal_family',
      noise_reason: null,
      relevance_channel: 'goal-strong',
      overlay_score: overlayScore,
      ingredient_overlap: ingredientOverlap,
    };
  }
  if (
    looksLikeSerumFamily &&
    !looksLikeAdjacentLiquid &&
    (
      ingredientOverlap ||
      ((candidateFlags.barrier || candidateFlags.sensitivity || candidateFlags.hydration) && queryConsistentAnchorFidelity)
    )
  ) {
    return {
      offer_type: offerType,
      target_relevance_class: 'supportive_family',
      noise_reason: null,
      relevance_channel: null,
      overlay_score: overlayScore,
      ingredient_overlap: ingredientOverlap,
    };
  }
  return {
    offer_type: offerType,
    target_relevance_class: 'generic_family',
    noise_reason: null,
    relevance_channel: null,
    overlay_score: overlayScore,
    ingredient_overlap: ingredientOverlap,
  };
}

function classifySharedTreatmentTargetRelevance({
  text,
  coarse,
  queryText,
}) {
  const lower = asString(text).toLowerCase();
  const normalizedQuery = asString(queryText).toLowerCase();
  const offerType = detectBeautyOfferType(lower);
  const candidateHasTreatmentCue = TREATMENT_GOAL_RE.test(lower);
  const queryHasTreatmentCue = TREATMENT_GOAL_RE.test(normalizedQuery) || /\btreatment\b/.test(normalizedQuery);
  const looksLikeTreatmentFamily =
    coarse.candidate_step === 'treatment' ||
    coarse.candidate_step === 'serum' ||
    TREATMENT_GUIDANCE_FAMILY_RE.test(lower);
  const looksLikeAdjacentLiquid =
    SERUM_ADJACENT_LIQUID_RE.test(lower) &&
    coarse.candidate_step !== 'treatment' &&
    !candidateHasTreatmentCue;

  if (coarse.object_type === 'service' || coarse.domain_scope === 'beauty_service') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'service' };
  }
  if (
    coarse.object_type === 'brush' ||
    coarse.object_type === 'tool' ||
    coarse.object_type === 'accessory' ||
    coarse.domain_scope === 'beauty_tool'
  ) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'tool' };
  }
  if (HAIR_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'hair' };
  }
  if (coarse.candidate_step === 'cleanser' || CLEANSER_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'cleanser' };
  }
  if (SPF_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'spf' };
  }
  if (PEEL_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'peel' };
  }
  if (coarse.domain_scope === 'bodycare' || coarse.usage_scope === 'body') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'body' };
  }
  if (coarse.domain_scope === 'makeup') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'makeup' };
  }
  if (coarse.application_mode === 'rinse_off') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'cleanser' };
  }
  if (
    coarse.domain_scope !== 'skincare' ||
    coarse.object_type !== 'product' ||
    coarse.usage_scope !== 'face' ||
    !looksLikeTreatmentFamily
  ) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'wrong_scope' };
  }
  if (offerType === 'bundle' || offerType === 'duo' || offerType === 'set' || offerType === 'kit') {
    return { offer_type: offerType, target_relevance_class: 'adjacent_noise', noise_reason: 'bundle' };
  }
  if (looksLikeAdjacentLiquid) {
    return { offer_type: offerType, target_relevance_class: 'adjacent_noise', noise_reason: 'adjacent_liquid' };
  }
  if (
    candidateHasTreatmentCue &&
    (queryHasTreatmentCue || coarse.candidate_step === 'treatment' || coarse.candidate_step === 'serum')
  ) {
    return { offer_type: offerType, target_relevance_class: 'strong_goal_family', noise_reason: null };
  }
  if (coarse.candidate_step === 'treatment') {
    return { offer_type: offerType, target_relevance_class: 'strong_goal_family', noise_reason: null };
  }
  if (coarse.candidate_step === 'serum' || looksLikeTreatmentFamily) {
    return { offer_type: offerType, target_relevance_class: 'supportive_family', noise_reason: null };
  }
  return { offer_type: offerType, target_relevance_class: 'generic_family', noise_reason: null };
}

function classifySharedSunscreenTargetRelevance({
  text,
  coarse,
}) {
  const lower = asString(text).toLowerCase();
  const offerType = detectBeautyOfferType(lower);
  const candidateHasSunscreenCue =
    coarse.candidate_step === 'sunscreen' ||
    SUNSCREEN_GUIDANCE_FAMILY_RE.test(lower);
  const candidateHasSupportiveCue = SUNSCREEN_SUPPORTIVE_RE.test(lower);
  const tintedMakeupLike = TINT_RE.test(lower);

  if (coarse.object_type === 'service' || coarse.domain_scope === 'beauty_service') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'service' };
  }
  if (
    coarse.object_type === 'brush' ||
    coarse.object_type === 'tool' ||
    coarse.object_type === 'accessory' ||
    coarse.domain_scope === 'beauty_tool'
  ) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'tool' };
  }
  if (HAIR_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'hair' };
  }
  if (coarse.candidate_step === 'cleanser' || CLEANSER_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'cleanser' };
  }
  if (PEEL_RE.test(lower)) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'peel' };
  }
  if (coarse.domain_scope === 'bodycare' || coarse.usage_scope === 'body') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'body' };
  }
  if (
    coarse.domain_scope !== 'skincare' ||
    coarse.object_type !== 'product' ||
    coarse.usage_scope !== 'face'
  ) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'wrong_scope' };
  }
  if (offerType === 'bundle' || offerType === 'duo' || offerType === 'set' || offerType === 'kit') {
    return { offer_type: offerType, target_relevance_class: 'adjacent_noise', noise_reason: 'bundle' };
  }
  if (!candidateHasSunscreenCue) {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'spf_missing' };
  }
  if (tintedMakeupLike) {
    return { offer_type: offerType, target_relevance_class: 'adjacent_noise', noise_reason: 'tint' };
  }
  if (coarse.candidate_step === 'sunscreen' || candidateHasSupportiveCue) {
    return { offer_type: offerType, target_relevance_class: 'strong_goal_family', noise_reason: null };
  }
  return { offer_type: offerType, target_relevance_class: 'supportive_family', noise_reason: null };
}

function asString(value) {
  return value == null ? '' : String(value).trim();
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return '';
}

function normalizeReasonCodes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asString(item).toUpperCase())
    .filter(Boolean);
}

function looksLikeCacheSourceSignal(value) {
  const normalized = asString(value).toLowerCase();
  if (!normalized) return false;
  if (normalized === 'fresh_cache' || normalized === 'stale_cache') return true;
  if (normalized.startsWith('cache_')) return true;
  if (normalized.includes('products_cache')) return true;
  if (normalized.includes('catalog_cache')) return true;
  if (normalized.includes('internal_cache')) return true;
  if (normalized.includes('cache_multi_intent')) return true;
  if (normalized.includes('cache_stage')) return true;
  return CACHE_OWNER_RE.test(normalized);
}

function buildCandidateProvenance(product) {
  const explicitOrigin = asString(product?.candidate_origin).toLowerCase();
  const retrievalReason = asString(product?.retrieval_reason).toLowerCase();
  const merchantId = asString(product?.merchant_id || product?.merchantId).toLowerCase();
  const rawSource = asString(product?.source).toLowerCase();
  const querySource = asString(product?.query_source || product?.metadata?.query_source).toLowerCase();
  const detailSource = asString(product?.__detail_source).toLowerCase();
  const combinedSourceSignals = [
    explicitOrigin,
    retrievalReason,
    rawSource,
    querySource,
    detailSource,
  ]
    .filter(Boolean)
    .join(' ');
  const sourceOwner =
    pickFirstTrimmed(
      explicitOrigin === 'stable_prior' ? 'stable_prior' : '',
      /\bexact_title\b/.test(combinedSourceSignals) ? 'exact_title_rescue' : '',
      rawSource,
      querySource,
      detailSource,
      explicitOrigin,
      retrievalReason,
      merchantId === 'external_seed' ? 'external_seed' : '',
      'internal_search',
    ).toLowerCase() || 'internal_search';

  if (explicitOrigin === 'stable_prior' || retrievalReason.includes('catalog_transient_fallback')) {
    return {
      legacy_origin: 'stable_prior',
      source_channel: 'transient_fallback',
      source_tier: 'fallback',
      source_quality_class: 'degraded',
      source_owner: sourceOwner,
    };
  }

  const exactTitleRescue =
    explicitOrigin === 'exact_title_rescue' ||
    /\bexact_title\b/.test(combinedSourceSignals);
  const cacheStale =
    rawSource === 'products_cache_stale' ||
    querySource === 'products_cache_stale' ||
    detailSource === 'stale_cache' ||
    /\bstale[_-]?cache\b/.test(combinedSourceSignals);
  const cacheFresh =
    !cacheStale &&
    (
      rawSource === 'products_cache' ||
      rawSource === 'products_cache_relaxed' ||
      rawSource === 'catalog_cache' ||
      rawSource === 'internal_cache' ||
      querySource === 'products_cache' ||
      querySource === 'cache_multi_intent' ||
      looksLikeCacheSourceSignal(querySource) ||
      looksLikeCacheSourceSignal(sourceOwner) ||
      detailSource === 'fresh_cache' ||
      /\b(products_cache|catalog_cache|internal_cache|cache_multi_intent|cache_stage)\b/.test(
        combinedSourceSignals,
      ) ||
      looksLikeCacheSourceSignal(combinedSourceSignals)
    );
  const externalSeed =
    merchantId === 'external_seed' ||
    rawSource === 'external_seed' ||
    querySource.includes('external_seed');

  if (exactTitleRescue) {
    return {
      legacy_origin: externalSeed ? 'external_supplement' : 'internal_live',
      source_channel: 'exact_title_rescue',
      source_tier: cacheFresh ? 'cache_fresh' : externalSeed ? 'fresh_external' : 'fresh_internal',
      source_quality_class: cacheFresh ? 'mixed' : externalSeed ? 'mixed' : 'trusted',
      source_owner: sourceOwner,
    };
  }

  if (cacheStale) {
    return {
      legacy_origin: externalSeed ? 'external_supplement' : 'internal_live',
      source_channel: 'products_cache_stale',
      source_tier: 'cache_stale',
      source_quality_class: 'degraded',
      source_owner: sourceOwner,
    };
  }

  if (cacheFresh) {
    return {
      legacy_origin: externalSeed ? 'external_supplement' : 'internal_live',
      source_channel: 'products_cache',
      source_tier: 'cache_fresh',
      source_quality_class: externalSeed ? 'mixed' : 'mixed',
      source_owner: sourceOwner,
    };
  }

  if (externalSeed) {
    return {
      legacy_origin: 'external_supplement',
      source_channel: 'external_seed',
      source_tier: 'fresh_external',
      source_quality_class: 'mixed',
      source_owner: sourceOwner,
    };
  }

  return {
    legacy_origin: 'internal_live',
    source_channel: 'internal_search',
    source_tier: 'fresh_internal',
    source_quality_class: 'trusted',
    source_owner: sourceOwner,
  };
}

function summarizeCandidateSources(products) {
  const summary = {
    internal_live: 0,
    external_supplement: 0,
    stable_prior: 0,
    source_channel_counts: {
      internal_search: 0,
      external_seed: 0,
      products_cache: 0,
      products_cache_stale: 0,
      exact_title_rescue: 0,
      transient_fallback: 0,
    },
    source_tier_counts: {
      fresh_internal: 0,
      fresh_external: 0,
      cache_fresh: 0,
      cache_stale: 0,
      fallback: 0,
    },
    source_quality_counts: {
      trusted: 0,
      mixed: 0,
      degraded: 0,
    },
    cache_owner_paths: [],
    top_candidate_provenance: null,
  };
  const cacheOwnerPaths = new Set();
  const rows = Array.isArray(products) ? products : [];
  for (const product of rows) {
    const provenance = buildCandidateProvenance(product);
    summary[provenance.legacy_origin] =
      Number(summary[provenance.legacy_origin] || 0) + 1;
    summary.source_channel_counts[provenance.source_channel] =
      Number(summary.source_channel_counts[provenance.source_channel] || 0) + 1;
    summary.source_tier_counts[provenance.source_tier] =
      Number(summary.source_tier_counts[provenance.source_tier] || 0) + 1;
    summary.source_quality_counts[provenance.source_quality_class] =
      Number(summary.source_quality_counts[provenance.source_quality_class] || 0) + 1;
    if (
      (provenance.source_channel === 'products_cache' ||
        provenance.source_channel === 'products_cache_stale') &&
      provenance.source_owner
    ) {
      cacheOwnerPaths.add(provenance.source_owner);
    }
  }
  summary.cache_owner_paths = Array.from(cacheOwnerPaths);
  if (rows.length > 0) {
    summary.top_candidate_provenance = buildCandidateProvenance(rows[0]);
  }
  return summary;
}

function buildBeautyCandidateText(product, { includeRetrieval = true } = {}) {
  if (!product || typeof product !== 'object') return '';
  const parts = [
    product.title,
    product.name,
    product.display_name,
    product.displayName,
    product.brand,
    product.product_type,
    product.productType,
    product.category,
    product.category_name,
    product.categoryName,
    product.type,
    product.description,
    product.subtitle,
    product.how_to_use,
    product.howToUse,
    product.usage,
    product.usage_instructions,
    product.instructions,
    product.benefits,
    product.claims,
    product.key_ingredients,
    product.active_ingredients,
    product.activeIngredients,
    product.skin_concerns,
    product.why_we_love_it,
    ...(Array.isArray(product.tags) ? product.tags : []),
    ...(Array.isArray(product.tag_tokens) ? product.tag_tokens : []),
    ...(Array.isArray(product.ingredient_tokens) ? product.ingredient_tokens : []),
    ...(Array.isArray(product.how_to_use_steps) ? product.how_to_use_steps : []),
    ...(Array.isArray(product.benefit_bullets) ? product.benefit_bullets : []),
    ...(Array.isArray(product.highlights) ? product.highlights : []),
    ...(includeRetrieval ? [product.retrieval_query, product.query] : []),
  ]
    .map((item) => asString(item))
    .filter(Boolean);
  return parts.join(' ');
}

function resolveBeautyCoarseStepFamily(product) {
  const structuredStep = normalizeRecoTargetStep(
    [
      product?.product_type,
      product?.productType,
      product?.category,
      product?.category_name,
      product?.categoryName,
      product?.type,
    ]
      .map((item) => asString(item))
      .find(Boolean) || '',
  );
  if (structuredStep) {
    return {
      candidate_step: structuredStep,
      candidate_step_source: 'structured_category',
      candidate_step_confidence: 'high',
    };
  }
  const retrievalStep = normalizeRecoTargetStep(
    pickFirstTrimmed(product?.retrieval_step, product?.retrievalStep),
  );
  if (retrievalStep) {
    return {
      candidate_step: retrievalStep,
      candidate_step_source: 'retrieval_step',
      candidate_step_confidence: 'medium',
    };
  }
  const text = buildBeautyCandidateText(product);
  const resolved = resolveRecoTargetStepIntent({ text, focus: text });
  const candidateStep = normalizeRecoTargetStep(resolved?.resolved_target_step);
  if (!candidateStep) {
    return {
      candidate_step: null,
      candidate_step_source: 'none',
      candidate_step_confidence: 'none',
    };
  }
  return {
    candidate_step: candidateStep,
    candidate_step_source: 'text_salvage',
    candidate_step_confidence: asString(resolved?.resolved_target_step_confidence).toLowerCase() || 'medium',
  };
}

function classifyBeautyCoarseCandidate(product, {
  queryTargetStepFamily = null,
  queryText = '',
  guidanceOnlyDiscovery = false,
  queryStepStrength = null,
  mode = null,
} = {}) {
  const text = buildBeautyCandidateText(product, { includeRetrieval: false });
  const lower = text.toLowerCase();
  const rawBucket = classifyBeautyBucketFromText(text);
  const stepResolution = resolveBeautyCoarseStepFamily(product);
  const candidateStep = normalizeRecoTargetStep(stepResolution.candidate_step);
  const hasBodyCue = BODY_RE.test(lower);
  const hasFaceCue = FACE_RE.test(lower);
  const hasServiceCue =
    SERVICE_RE.test(lower) ||
    (SERVICE_FRENCH_RE.test(lower) && SERVICE_RE.test(lower)) ||
    (SERVICE_DURATION_RE.test(lower) && SERVICE_CONTEXT_RE.test(lower));
  const hasSkincareCue =
    rawBucket === 'skincare' ||
    Boolean(candidateStep) ||
    SPF_RE.test(lower) ||
    CLEANSER_RE.test(lower) ||
    SERUM_GUIDANCE_FAMILY_RE.test(lower) ||
    TREATMENT_GUIDANCE_FAMILY_RE.test(lower) ||
    MOISTURIZER_GUIDANCE_FAMILY_RE.test(lower) ||
    BRIGHTENING_RE.test(lower);

  let domainScope = 'unknown';
  if (hasServiceCue) {
    domainScope = 'beauty_service';
  } else if (TOOL_RE.test(lower)) {
    domainScope = 'beauty_tool';
  } else if (hasBodyCue && !hasFaceCue) {
    domainScope = 'bodycare';
  } else if (MAKEUP_RE.test(lower) || rawBucket === 'makeup') {
    domainScope = 'makeup';
  } else if (hasSkincareCue) {
    domainScope = 'skincare';
  }

  let objectType = 'unknown';
  if (domainScope === 'beauty_service') objectType = 'service';
  else if (BRUSH_RE.test(lower)) objectType = 'brush';
  else if (TOOL_RE.test(lower)) objectType = 'tool';
  else if (ACCESSORY_RE.test(lower)) objectType = 'accessory';
  else if (domainScope === 'skincare' || domainScope === 'bodycare' || domainScope === 'makeup') objectType = 'product';

  let usageScope = 'unknown';
  if (objectType === 'brush' || objectType === 'tool' || objectType === 'accessory') usageScope = 'tool';
  else if (domainScope === 'bodycare' || (hasBodyCue && !hasFaceCue)) usageScope = 'body';
  else if (domainScope === 'skincare' || hasFaceCue || candidateStep) usageScope = 'face';

  let applicationMode = 'unknown';
  if (usageScope === 'tool') applicationMode = 'tool';
  else if (candidateStep === 'cleanser') applicationMode = 'rinse_off';
  else if (domainScope === 'skincare' || candidateStep) applicationMode = 'leave_on';

  const familyRelation = queryTargetStepFamily && candidateStep
    ? getRecoTargetFamilyRelation(queryTargetStepFamily, candidateStep)
    : candidateStep
      ? 'same_family'
      : 'unknown';
  const decisionMode = normalizeRecommendationDecisionMode(mode, { guidanceOnlyDiscovery });
  const sharedGuidancePipeline =
    shouldUseSharedTargetRelevancePipeline({
      mode: decisionMode,
      targetStepFamily: normalizeRecoTargetStep(queryTargetStepFamily),
      queryStepStrength,
    });
  let offerType = detectBeautyOfferType(lower);
  let targetRelevanceClass = 'supportive_family';
  let noiseReason = null;
  let relevanceChannel = null;
  let overlayScore = 0;
  let ingredientOverlap = false;
  if (sharedGuidancePipeline) {
    const normalizedTargetStepFamily = normalizeRecoTargetStep(queryTargetStepFamily);
    const guidanceInput = {
      text,
      coarse: {
        domain_scope: domainScope,
        application_mode: applicationMode,
        usage_scope: usageScope,
        object_type: objectType,
        family_relation: familyRelation,
        candidate_step: candidateStep,
        candidate_step_source: stepResolution.candidate_step_source || 'none',
      },
      queryText,
      queryStepStrength,
    };
    const guidanceRelevance =
      normalizedTargetStepFamily === 'serum'
        ? classifyGuidanceOnlySerumTargetRelevance(guidanceInput)
        : normalizedTargetStepFamily === 'treatment'
          ? classifySharedTreatmentTargetRelevance(guidanceInput)
          : normalizedTargetStepFamily === 'sunscreen'
            ? classifySharedSunscreenTargetRelevance(guidanceInput)
        : classifyGuidanceOnlyMoisturizerTargetRelevance(guidanceInput);
    offerType = guidanceRelevance.offer_type;
    targetRelevanceClass = guidanceRelevance.target_relevance_class;
    noiseReason = guidanceRelevance.noise_reason;
    relevanceChannel = guidanceRelevance.relevance_channel || null;
    overlayScore = Number(guidanceRelevance.overlay_score || 0) || 0;
    ingredientOverlap = guidanceRelevance.ingredient_overlap === true;
  } else if (
    domainScope === 'skincare' &&
    objectType === 'product' &&
    usageScope === 'face' &&
    (!queryTargetStepFamily || familyRelation === 'same_family')
  ) {
    targetRelevanceClass = 'supportive_family';
  } else if (
    domainScope === 'bodycare' ||
    domainScope === 'makeup' ||
    domainScope === 'beauty_tool' ||
    objectType === 'service'
  ) {
    targetRelevanceClass = 'hard_invalid';
  } else {
    targetRelevanceClass = 'adjacent_noise';
  }
  const coarseValidForTarget = sharedGuidancePipeline
    ? targetRelevanceClass === 'strong_goal_family' || targetRelevanceClass === 'supportive_family'
    : Boolean(
        domainScope === 'skincare'
          && objectType === 'product'
          && usageScope === 'face'
          && (!queryTargetStepFamily || familyRelation === 'same_family')
      );

  return {
    domain_scope: domainScope,
    application_mode: applicationMode,
    usage_scope: usageScope,
    object_type: objectType,
    offer_type: offerType,
    coarse_step_family: candidateStep || null,
    candidate_step: candidateStep || null,
    candidate_step_source: stepResolution.candidate_step_source || 'none',
    candidate_step_confidence: stepResolution.candidate_step_confidence || 'none',
    family_relation: familyRelation,
    target_relevance_class: targetRelevanceClass,
    target_relevance_owner: TARGET_RELEVANCE_CLASS_OWNER,
    target_relevance_policy_version: SHARED_TARGET_RELEVANCE_POLICY_VERSION,
    noise_reason: noiseReason,
    relevance_channel: relevanceChannel,
    overlay_score: overlayScore,
    ingredient_overlap: ingredientOverlap,
    coarse_valid_for_target: coarseValidForTarget,
  };
}

function scoreBeautyCandidateForTarget(product, {
  queryTargetStepFamily = null,
  queryText = '',
  guidanceOnlyDiscovery = false,
  queryStepStrength = null,
  mode = null,
} = {}) {
  const coarse = classifyBeautyCoarseCandidate(product, {
    queryTargetStepFamily,
    queryText,
    guidanceOnlyDiscovery,
    queryStepStrength,
    mode,
  });
  const provenance = buildCandidateProvenance(product);
  const reasonCodes = new Set(
    normalizeReasonCodes(product?.reason_codes).concat(
      normalizeReasonCodes(product?.pivota?.reason_codes),
    ),
  );
  const pivotaDomain = asString(
    product?.pivota?.domain || product?.pivota_domain || product?.pivotaDomain,
  ).toLowerCase();
  const targetObject = asString(
    product?.target_object?.type ||
      product?.target_object ||
      product?.targetObject?.type ||
      product?.targetObject,
  ).toLowerCase();
  const candidateText = buildBeautyCandidateText(product, { includeRetrieval: true });
  let score = 0;
  if (coarse.domain_scope === 'skincare') score += 40;
  if (coarse.usage_scope === 'face') score += 20;
  if (coarse.object_type === 'product') score += 10;
  if (coarse.application_mode === 'leave_on') score += 10;
  if (coarse.family_relation === 'same_family') score += 80;
  if (queryTargetStepFamily && coarse.candidate_step === queryTargetStepFamily) score += 20;
  if (
    shouldUseSharedTargetRelevancePipeline({
      mode,
      targetStepFamily: normalizeRecoTargetStep(queryTargetStepFamily),
      queryStepStrength,
    })
  ) {
    if (coarse.target_relevance_class === 'strong_goal_family') score += 120;
    else if (coarse.target_relevance_class === 'supportive_family') score += 80;
    else if (coarse.target_relevance_class === 'generic_family') score += 10;
    else if (coarse.target_relevance_class === 'adjacent_noise') score -= 90;
    else score -= 160;
    if (coarse.offer_type === 'sample') score -= 32;
    if (coarse.relevance_channel === 'ingredient-strong') score += 36;
    else if (coarse.relevance_channel === 'goal-strong') score += 8;
    score += Math.max(0, Number(coarse.overlay_score || 0) || 0) * 6;
  }
  if (coarse.application_mode === 'rinse_off') score -= 15;
  if (coarse.domain_scope === 'bodycare') score -= 40;
  if (coarse.domain_scope === 'makeup') score -= 60;
  if (coarse.domain_scope === 'beauty_service' || coarse.object_type === 'service') score -= 120;
  if (coarse.domain_scope === 'beauty_tool' || coarse.object_type === 'brush' || coarse.object_type === 'tool') score -= 100;
  score += Number(SOURCE_TIER_SCORE_ADJUSTMENTS[provenance.source_tier] || 0);
  score += Number(SOURCE_QUALITY_SCORE_ADJUSTMENTS[provenance.source_quality_class] || 0);
  if (/^cache_/.test(provenance.source_owner || '')) score -= 18;
  if (pivotaDomain === 'other') score -= 70;
  if (targetObject === 'unknown') score -= 22;
  if (reasonCodes.has('OBJ_UNCERTAIN')) score -= 24;
  if (reasonCodes.has('CAT_PARENT')) score -= 12;
  if (PET_RE.test(candidateText)) score -= 240;
  return { score, coarse, provenance };
}

function rerankBeautySkincareProductsByTargetFamily(products, {
  queryTargetStepFamily = null,
  queryText = '',
  guidanceOnlyDiscovery = false,
  queryStepStrength = null,
  mode = null,
} = {}) {
  const rows = Array.isArray(products) ? products : [];
  return rows
    .map((product, index) => {
      const scored = scoreBeautyCandidateForTarget(product, {
        queryTargetStepFamily,
        queryText,
        guidanceOnlyDiscovery,
        queryStepStrength,
        mode,
      });
      return {
        product,
        index,
        score: scored.score,
        relevance_rank: getTargetRelevanceClassRank(scored.coarse?.target_relevance_class),
      };
    })
    .sort((left, right) => {
      if (left.relevance_rank !== right.relevance_rank) return left.relevance_rank - right.relevance_rank;
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    })
    .map((row) => row.product);
}

function buildCandidateBrandKey(product) {
  return asString(product?.brand || product?.merchant_name || product?.vendor || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCandidateTitleForDedupe(product) {
  return asString(product?.title || product?.display_name || product?.displayName || product?.name || '')
    .toLowerCase()
    .replace(/\b(\d+(?:\.\d+)?\s?(?:ml|oz|fl oz|g|count|ct)|mini|sample|travel(?:\s+size)?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCandidateExactSkuKey(product) {
  const merchantId = asString(product?.merchant_id || product?.merchantId).toLowerCase();
  const productId = asString(product?.product_id || product?.productId || product?.id).toLowerCase();
  const skuId = asString(product?.sku_id || product?.skuId).toLowerCase();
  if (merchantId && productId) return `${merchantId}::${productId}`;
  if (merchantId && skuId) return `${merchantId}::sku::${skuId}`;
  const canonicalUrl = asString(product?.canonical_url || product?.canonicalUrl || product?.destination_url || product?.destinationUrl || product?.url).toLowerCase();
  if (canonicalUrl) return canonicalUrl;
  const brandKey = buildCandidateBrandKey(product);
  const titleKey = normalizeCandidateTitleForDedupe(product);
  return `${brandKey}::${titleKey}`;
}

function buildCandidateCrossOriginKey(product) {
  const brandKey = buildCandidateBrandKey(product);
  const titleKey = normalizeCandidateTitleForDedupe(product);
  return brandKey && titleKey ? `${brandKey}::${titleKey}` : buildCandidateExactSkuKey(product);
}

function buildCandidateFamilyVariantKey(product) {
  return buildCandidateCrossOriginKey(product);
}

function buildCandidateOrigin(product) {
  return buildCandidateProvenance(product).legacy_origin;
}

function countCandidateOrigins(products) {
  return summarizeCandidateSources(products);
}

function countDistinctSupportiveCandidates(rows) {
  const seen = new Set();
  let count = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const coarse = row?.coarse;
    if (coarse?.target_relevance_class !== 'supportive_family') continue;
    const key = buildCandidateFamilyVariantKey(row.product);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    count += 1;
  }
  return count;
}

function buildStablePriorSource(product) {
  const explicitOrigin = asString(product?.candidate_origin).toLowerCase();
  if (explicitOrigin === 'stable_prior') return explicitOrigin;
  const retrievalReason = asString(product?.retrieval_reason).toLowerCase();
  if (retrievalReason.includes('catalog_transient_fallback')) return 'catalog_transient_fallback';
  return null;
}

function selectStablePriorFallbackRows(rows, {
  existingRows = [],
  minimumDisplayCount = 2,
  sessionSeenProductIds = [],
} = {}) {
  const selectedRows = Array.isArray(existingRows) ? existingRows.slice() : [];
  const candidates = Array.isArray(rows) ? rows.slice() : [];
  const sessionSeen = new Set(
    (Array.isArray(sessionSeenProductIds) ? sessionSeenProductIds : [])
      .map((value) => asString(value).toLowerCase())
      .filter(Boolean),
  );
  const exactSeen = new Set();
  const familySeen = new Set();
  const crossOriginSeen = new Set();
  const brandCounts = new Map();

  for (const row of selectedRows) {
    const exactKey = buildCandidateExactSkuKey(row.product);
    const familyVariantKey = buildCandidateFamilyVariantKey(row.product);
    const crossOriginKey = buildCandidateCrossOriginKey(row.product);
    const brandKey = buildCandidateBrandKey(row.product);
    if (exactKey) exactSeen.add(exactKey);
    if (familyVariantKey) familySeen.add(familyVariantKey);
    if (crossOriginKey) crossOriginSeen.add(crossOriginKey);
    if (brandKey) brandCounts.set(brandKey, Number(brandCounts.get(brandKey) || 0) + 1);
  }

  const decorated = candidates.map((row, index) => {
    const exactKey = buildCandidateExactSkuKey(row.product);
    const seenInSession =
      exactKey
        ? sessionSeen.has(exactKey) || sessionSeen.has(asString(row.product?.product_id).toLowerCase())
        : false;
    return {
      ...row,
      index,
      exact_key: exactKey,
      family_variant_key: buildCandidateFamilyVariantKey(row.product),
      cross_origin_key: buildCandidateCrossOriginKey(row.product),
      brand_key: buildCandidateBrandKey(row.product),
      adjusted_score: row.score - (seenInSession ? 80 : 0),
      seen_in_session: seenInSession,
    };
  });

  decorated.sort((left, right) => {
    const leftRank = getTargetRelevanceClassRank(left.coarse?.target_relevance_class);
    const rightRank = getTargetRelevanceClassRank(right.coarse?.target_relevance_class);
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (right.adjusted_score !== left.adjusted_score) return right.adjusted_score - left.adjusted_score;
    return left.index - right.index;
  });

  const fallbackRows = [];
  let diversityExceptionApplied = false;
  let stablePriorSource = null;
  let sessionExposurePenaltyApplied = false;
  for (const row of decorated) {
    if (selectedRows.length + fallbackRows.length >= minimumDisplayCount) break;
    if (row.exact_key && exactSeen.has(row.exact_key)) continue;
    if (row.family_variant_key && familySeen.has(row.family_variant_key)) continue;
    if (row.cross_origin_key && crossOriginSeen.has(row.cross_origin_key)) continue;
    const brandCount = row.brand_key ? Number(brandCounts.get(row.brand_key) || 0) : 0;
    if (brandCount >= 1) {
      const crossBrandAlternative = decorated.find((candidate) =>
        candidate !== row &&
        candidate.brand_key !== row.brand_key &&
        (!candidate.exact_key || !exactSeen.has(candidate.exact_key)) &&
        (!candidate.family_variant_key || !familySeen.has(candidate.family_variant_key)) &&
        (!candidate.cross_origin_key || !crossOriginSeen.has(candidate.cross_origin_key)),
      );
      const allowException =
        !crossBrandAlternative ||
        getTargetRelevanceClassRank(row.coarse?.target_relevance_class) <
          getTargetRelevanceClassRank(crossBrandAlternative.coarse?.target_relevance_class) ||
        (
          getTargetRelevanceClassRank(row.coarse?.target_relevance_class) ===
            getTargetRelevanceClassRank(crossBrandAlternative.coarse?.target_relevance_class) &&
          row.adjusted_score - crossBrandAlternative.adjusted_score >= 25
        );
      if (!allowException) continue;
      diversityExceptionApplied = true;
    }
    if (row.seen_in_session) sessionExposurePenaltyApplied = true;
    if (row.exact_key) exactSeen.add(row.exact_key);
    if (row.family_variant_key) familySeen.add(row.family_variant_key);
    if (row.cross_origin_key) crossOriginSeen.add(row.cross_origin_key);
    if (row.brand_key) brandCounts.set(row.brand_key, brandCount + 1);
    if (!stablePriorSource) stablePriorSource = buildStablePriorSource(row.product);
    fallbackRows.push(row);
  }

  return {
    rows: fallbackRows,
    diversity_exception_applied: diversityExceptionApplied,
    stable_prior_source: stablePriorSource,
    session_exposure_penalty_applied: sessionExposurePenaltyApplied,
  };
}

function applySerumCanarySelectionPolicy(rows, {
  fillTargetCount = 3,
  sessionSeenProductIds = [],
} = {}) {
  const sourceRows = Array.isArray(rows) ? rows.slice() : [];
  const sessionSeen = new Set(
    (Array.isArray(sessionSeenProductIds) ? sessionSeenProductIds : [])
      .map((value) => asString(value).toLowerCase())
      .filter(Boolean),
  );
  const selectionDiversity = {
    exact_sku_dropped_count: 0,
    cross_origin_dropped_count: 0,
    family_variant_dropped_count: 0,
    brand_near_duplicate_dropped_count: 0,
    session_exposure_penalty_applied: false,
    session_repeat_exact_sku_rate: 0,
    same_canonical_intent_top1_repeat_rate: 0,
  };
  const exactSeen = new Set();
  const familySeen = new Set();
  const crossOriginSeen = new Set();
  const deduped = [];

  for (const row of sourceRows) {
    const exactKey = buildCandidateExactSkuKey(row.product);
    const crossOriginKey = buildCandidateCrossOriginKey(row.product);
    const familyVariantKey = buildCandidateFamilyVariantKey(row.product);
    if (exactKey && exactSeen.has(exactKey)) {
      selectionDiversity.exact_sku_dropped_count += 1;
      continue;
    }
    if (familyVariantKey && familySeen.has(familyVariantKey)) {
      selectionDiversity.family_variant_dropped_count += 1;
      continue;
    }
    if (crossOriginKey && crossOriginSeen.has(crossOriginKey)) {
      selectionDiversity.cross_origin_dropped_count += 1;
      continue;
    }
    if (exactKey) exactSeen.add(exactKey);
    if (familyVariantKey) familySeen.add(familyVariantKey);
    if (crossOriginKey) crossOriginSeen.add(crossOriginKey);
    const seenInSession = exactKey ? sessionSeen.has(exactKey) || sessionSeen.has(asString(row.product?.product_id).toLowerCase()) : false;
    if (seenInSession) selectionDiversity.session_exposure_penalty_applied = true;
    deduped.push({
      ...row,
      exact_key: exactKey,
      family_variant_key: familyVariantKey,
      cross_origin_key: crossOriginKey,
      brand_key: buildCandidateBrandKey(row.product),
      seen_in_session: seenInSession,
      adjusted_score: row.score - (seenInSession ? 80 : 0),
    });
  }

  deduped.sort((left, right) => {
    const leftRank = getTargetRelevanceClassRank(left.coarse?.target_relevance_class);
    const rightRank = getTargetRelevanceClassRank(right.coarse?.target_relevance_class);
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (right.adjusted_score !== left.adjusted_score) return right.adjusted_score - left.adjusted_score;
    return left.index - right.index;
  });

  const topRows = [];
  const deferred = [];
  const brandCounts = new Map();
  for (const row of deduped) {
    if (topRows.length >= fillTargetCount) {
      deferred.push(row);
      continue;
    }
    const brandKey = row.brand_key;
    if (brandKey && Number(brandCounts.get(brandKey) || 0) >= 1) {
      selectionDiversity.brand_near_duplicate_dropped_count += 1;
      deferred.push(row);
      continue;
    }
    topRows.push(row);
    if (brandKey) brandCounts.set(brandKey, Number(brandCounts.get(brandKey) || 0) + 1);
  }

  let diversityExceptionApplied = false;
  if (topRows.length < fillTargetCount && deferred.length > 0) {
    const remaining = [];
    for (const row of deferred) {
      if (topRows.length < fillTargetCount) {
        const bestCrossBrandAlternative =
          deferred.find((candidate) => candidate !== row && candidate.brand_key !== row.brand_key) || null;
        const shouldAllowException =
          !bestCrossBrandAlternative ||
          getTargetRelevanceClassRank(row.coarse?.target_relevance_class) < getTargetRelevanceClassRank(bestCrossBrandAlternative.coarse?.target_relevance_class) ||
          (
            getTargetRelevanceClassRank(row.coarse?.target_relevance_class) === getTargetRelevanceClassRank(bestCrossBrandAlternative.coarse?.target_relevance_class) &&
            row.adjusted_score - bestCrossBrandAlternative.adjusted_score >= 25
          );
        if (shouldAllowException) {
          diversityExceptionApplied = true;
          selectionDiversity.brand_near_duplicate_dropped_count = Math.max(
            0,
            selectionDiversity.brand_near_duplicate_dropped_count - 1,
          );
          topRows.push(row);
          continue;
        }
      }
      remaining.push(row);
    }
    deferred.length = 0;
    deferred.push(...remaining);
  }

  const finalRows = topRows.concat(deferred);
  const finalProducts = finalRows.map((row) => row.product);
  const repeatedExactSkuCount = finalRows.filter((row) => row.seen_in_session).length;
  const top1Seen = topRows[0]?.seen_in_session === true;
  selectionDiversity.session_repeat_exact_sku_rate =
    finalRows.length > 0 ? repeatedExactSkuCount / finalRows.length : 0;
  selectionDiversity.same_canonical_intent_top1_repeat_rate = top1Seen ? 1 : 0;

  return {
    products: finalProducts,
    candidate_origin_counts: countCandidateOrigins(finalProducts),
    selection_diversity: selectionDiversity,
    dedupe_dropped_count:
      selectionDiversity.exact_sku_dropped_count +
      selectionDiversity.cross_origin_dropped_count +
      selectionDiversity.family_variant_dropped_count,
    diversity_exception_applied: diversityExceptionApplied,
  };
}

function applyGuidanceMoisturizerDisplayPolicy(rows, {
  decisionMode = null,
  queryTargetStepFamily = null,
} = {}) {
  const normalizedTargetStepFamily = normalizeRecoTargetStep(queryTargetStepFamily);
  if (decisionMode !== 'guidance_only' || normalizedTargetStepFamily !== 'moisturizer') {
    return rows;
  }
  const list = Array.isArray(rows) ? rows : [];
  const strongRows = list.filter((row) => row?.coarse?.target_relevance_class === 'strong_goal_family');
  if (strongRows.length >= 3) return strongRows;
  return list;
}

function buildBeautySkincareHitQualityDecision({
  queryText,
  products,
  queryTargetStepFamily = null,
  guidanceOnlyDiscovery = false,
  queryStepStrength = null,
  mode = null,
  sessionSeenProductIds = [],
} = {}) {
  const queryBucket = detectBeautyQueryBucket(queryText);
  const rawProducts = Array.isArray(products) ? products : [];
  const normalizedQueryStepStrength =
    normalizeGuidanceIntentStrength(queryStepStrength) ||
    classifyBeautyGuidanceQueryStrength(queryText, { queryTargetStepFamily });
  if (queryBucket !== 'skincare') {
    return {
      applied: false,
      contract_version: BEAUTY_SEARCH_DECISION_CONTRACT_VERSION,
      hit_quality: '',
      invalid_hit_reason: null,
      query_bucket: queryBucket || null,
      query_target_step_family: null,
      topk_bucket_mix: {},
      same_family_topk_count: 0,
      exact_step_topk_count: 0,
      strong_goal_family_topk_count: 0,
      supportive_same_family_topk_count: 0,
      query_step_strength: normalizedQueryStepStrength,
      step_success_class: null,
      candidate_class_counts: {},
      noise_drop_counts: {},
      raw_result_count: rawProducts.length,
      products_returned_count: rawProducts.length,
      valid_products: rawProducts,
    };
  }
  const queryResolution = resolveRecoTargetStepIntent({ focus: queryText, text: queryText });
  const normalizedQueryTargetStepFamily = normalizeRecoTargetStep(
    queryTargetStepFamily || queryResolution?.resolved_target_step,
  );
  const decisionMode = normalizeRecommendationDecisionMode(mode, { guidanceOnlyDiscovery });
  const sharedPipelineApplied = shouldUseSharedTargetRelevancePipeline({
    mode: decisionMode,
    targetStepFamily: normalizedQueryTargetStepFamily,
    queryStepStrength: normalizedQueryStepStrength,
  });
  const normalizedIntent = normalizeSharedTargetIntent({
    queryText,
    targetStepFamily: normalizedQueryTargetStepFamily,
    mode: decisionMode,
    queryStepStrength: normalizedQueryStepStrength,
  });
  const serumCanaryGuidance =
    decisionMode === 'guidance_only' &&
    normalizedQueryTargetStepFamily === 'serum' &&
    Boolean(normalizedIntent?.backbone_id);
  const rankedProducts = rerankBeautySkincareProductsByTargetFamily(rawProducts, {
    queryTargetStepFamily: normalizedQueryTargetStepFamily,
    queryText,
    guidanceOnlyDiscovery,
    queryStepStrength: normalizedQueryStepStrength,
    mode: decisionMode,
  });
  const topK = rankedProducts.slice(0, 8);
  const topkBucketMix = {};
  let toolsTopKCount = 0;
  let sameFamilyTopKCount = 0;
  let exactStepTopKCount = 0;
  let skincareTopKCount = 0;
  let strongGoalFamilyTopKCount = 0;
  let supportiveSameFamilyTopKCount = 0;
  let genericFamilyTopKCount = 0;
  const candidateClassCounts = {};
  const noiseDropCounts = {};

  const classifyTopK = (product) => {
    const coarse = classifyBeautyCoarseCandidate(product, {
      queryTargetStepFamily: normalizedQueryTargetStepFamily,
      queryText,
      guidanceOnlyDiscovery,
      queryStepStrength: normalizedQueryStepStrength,
      mode: decisionMode,
    });
    topkBucketMix[coarse.domain_scope] = Number(topkBucketMix[coarse.domain_scope] || 0) + 1;
    if (coarse.domain_scope === 'beauty_tool') toolsTopKCount += 1;
    if (coarse.domain_scope === 'skincare' && coarse.usage_scope === 'face' && coarse.object_type === 'product') skincareTopKCount += 1;
    if (coarse.coarse_valid_for_target) {
      sameFamilyTopKCount += 1;
      if (coarse.candidate_step && coarse.candidate_step === normalizedQueryTargetStepFamily) exactStepTopKCount += 1;
    }
    if (coarse.target_relevance_class === 'strong_goal_family') strongGoalFamilyTopKCount += 1;
    else if (coarse.target_relevance_class === 'supportive_family') supportiveSameFamilyTopKCount += 1;
    else if (coarse.target_relevance_class === 'generic_family') genericFamilyTopKCount += 1;
    return coarse;
  };

  for (const product of topK) classifyTopK(product);

  const contractCandidateClassCounts = countTargetRelevanceClasses(
    rankedProducts.flatMap((product) => {
      if (serumCanaryGuidance && buildCandidateOrigin(product) === 'stable_prior') return [];
      const coarse = classifyBeautyCoarseCandidate(product, {
        queryTargetStepFamily: normalizedQueryTargetStepFamily,
        queryText,
        guidanceOnlyDiscovery,
        queryStepStrength: normalizedQueryStepStrength,
        mode: decisionMode,
      });
      return [coarse.target_relevance_class];
    }),
  );

  const contractStrongOrSupportive = [];
  const contractStablePriorRows = [];
  const validProducts = rankedProducts.filter((product) => {
    const candidateOrigin = buildCandidateOrigin(product);
    const stablePriorProduct = serumCanaryGuidance && candidateOrigin === 'stable_prior';
    const coarse = classifyBeautyCoarseCandidate(product, {
      queryTargetStepFamily: normalizedQueryTargetStepFamily,
      queryText,
      guidanceOnlyDiscovery,
      queryStepStrength: normalizedQueryStepStrength,
      mode: decisionMode,
    });
    if (!stablePriorProduct) {
      candidateClassCounts[coarse.target_relevance_class] = Number(candidateClassCounts[coarse.target_relevance_class] || 0) + 1;
    }
    if (coarse.noise_reason) {
      noiseDropCounts[coarse.noise_reason] = Number(noiseDropCounts[coarse.noise_reason] || 0) + 1;
    }
    if (sharedPipelineApplied) {
      if (coarse.target_relevance_class === 'strong_goal_family' || coarse.target_relevance_class === 'supportive_family') {
        if (stablePriorProduct) {
          contractStablePriorRows.push(product);
          return false;
        }
        contractStrongOrSupportive.push(product);
        return true;
      }
      return false;
    }
    return coarse.coarse_valid_for_target;
  });

  const normalizedValidProducts =
    sharedPipelineApplied
      ? contractStrongOrSupportive
      : validProducts;
  const normalizedValidRows = normalizedValidProducts.map((product, index) => {
    const scored = scoreBeautyCandidateForTarget(product, {
      queryTargetStepFamily: normalizedQueryTargetStepFamily,
      queryText,
      guidanceOnlyDiscovery,
      queryStepStrength: normalizedQueryStepStrength,
      mode: decisionMode,
    });
    return {
      product,
      index,
      score: scored.score,
      coarse: scored.coarse,
    };
  });
  const displayPolicyRows = applyGuidanceMoisturizerDisplayPolicy(normalizedValidRows, {
    decisionMode,
    queryTargetStepFamily: normalizedQueryTargetStepFamily,
  });
  const supportiveDistinctCount = countDistinctSupportiveCandidates(normalizedValidRows);
  const qualityGateResult = buildQualityGateResult({
    applied: sharedPipelineApplied,
    strongCount: contractCandidateClassCounts.strong_goal_family,
    supportiveCount: contractCandidateClassCounts.supportive_family,
    supportiveDistinctCount,
  });
  let displayableProducts = displayPolicyRows.map((row) => row.product);
  let selectionDiversity = {
    exact_sku_dropped_count: 0,
    cross_origin_dropped_count: 0,
    family_variant_dropped_count: 0,
    brand_near_duplicate_dropped_count: 0,
    session_exposure_penalty_applied: false,
    session_repeat_exact_sku_rate: 0,
    same_canonical_intent_top1_repeat_rate: 0,
  };
  let dedupeDroppedCount = 0;
  let diversityExceptionApplied = false;
  let candidateOriginCounts = countCandidateOrigins(displayableProducts);
  let stablePriorApplied = false;
  let stablePriorSource = null;
  let fallbackMode = 'normal';
  let validScopingDroppedCount = serumCanaryGuidance ? contractStablePriorRows.length : 0;
  const fillTargetCount = serumCanaryGuidance ? 3 : Math.min(3, Math.max(0, normalizedValidProducts.length));
  if (serumCanaryGuidance && normalizedValidRows.length > 0) {
    const selection = applySerumCanarySelectionPolicy(normalizedValidRows, {
      fillTargetCount: Math.max(1, fillTargetCount),
      sessionSeenProductIds,
    });
    displayableProducts = selection.products;
    selectionDiversity = selection.selection_diversity;
    dedupeDroppedCount = selection.dedupe_dropped_count;
    diversityExceptionApplied = selection.diversity_exception_applied === true;
    candidateOriginCounts = selection.candidate_origin_counts;
  }
  const contractDisplayableProducts = displayableProducts.slice();
  if (
    serumCanaryGuidance &&
    qualityGateResult.satisfied === true &&
    displayableProducts.length < 2 &&
    contractStablePriorRows.length > 0
  ) {
    const stablePriorRows = contractStablePriorRows.map((product, index) => {
      const scored = scoreBeautyCandidateForTarget(product, {
        queryTargetStepFamily: normalizedQueryTargetStepFamily,
        queryText,
        guidanceOnlyDiscovery,
        queryStepStrength: normalizedQueryStepStrength,
        mode: decisionMode,
      });
      return {
        product,
        index,
        score: scored.score,
        coarse: scored.coarse,
      };
    });
    const selectedRows = contractDisplayableProducts.map((product, index) => {
      const scored = scoreBeautyCandidateForTarget(product, {
        queryTargetStepFamily: normalizedQueryTargetStepFamily,
        queryText,
        guidanceOnlyDiscovery,
        queryStepStrength: normalizedQueryStepStrength,
        mode: decisionMode,
      });
      return {
        product,
        index,
        score: scored.score,
        coarse: scored.coarse,
      };
    });
    const fallbackSelection = selectStablePriorFallbackRows(stablePriorRows, {
      existingRows: selectedRows,
      minimumDisplayCount: 2,
      sessionSeenProductIds,
    });
    if (fallbackSelection.rows.length > 0) {
      displayableProducts = displayableProducts.concat(fallbackSelection.rows.map((row) => row.product));
      stablePriorApplied = true;
      stablePriorSource = fallbackSelection.stable_prior_source || null;
      fallbackMode = 'stable_prior_fill';
      if (fallbackSelection.session_exposure_penalty_applied) {
        selectionDiversity.session_exposure_penalty_applied = true;
      }
      if (fallbackSelection.diversity_exception_applied) {
        diversityExceptionApplied = true;
      }
      candidateOriginCounts = countCandidateOrigins(displayableProducts);
    }
  }
  const candidateClassesTop3 = contractDisplayableProducts.slice(0, 3).map((product) => {
    const coarse = classifyBeautyCoarseCandidate(product, {
      queryTargetStepFamily: normalizedQueryTargetStepFamily,
      queryText,
      guidanceOnlyDiscovery,
      queryStepStrength: normalizedQueryStepStrength,
      mode: decisionMode,
    });
    return coarse.target_relevance_class;
  });
  const successContractResult = buildSuccessContractResult({
    mode: decisionMode,
    targetStepFamily: normalizedQueryTargetStepFamily,
    queryStepStrength: normalizedQueryStepStrength,
    queryText,
    candidateClassCounts: contractCandidateClassCounts,
    topCandidateClasses: candidateClassesTop3,
    qualityGateResult,
  });
  const fillCompletedCount = serumCanaryGuidance
    ? Math.min(fillTargetCount, contractDisplayableProducts.length)
    : Math.min(3, displayableProducts.length);
  const coverageLimitedAfterFill =
    serumCanaryGuidance && fillTargetCount > 0
      ? contractDisplayableProducts.length < fillTargetCount
      : false;
  const surfaceReason =
    successContractResult.satisfied !== true
      ? successContractResult.failure_class || 'no_target_relevant_candidates'
      : coverageLimitedAfterFill
        ? 'coverage_limited_after_fill'
        : 'filled_success';

  let hitQuality = 'empty';
  let invalidHitReason = null;
  let stepSuccessClass = null;
  if (rawProducts.length > 0) {
    stepSuccessClass = successContractResult.step_success_class || null;
    const guidanceSuccess =
      !sharedPipelineApplied ||
      successContractResult.satisfied === true;
    if (
      displayableProducts.length > 0 &&
      (!normalizedQueryTargetStepFamily || sameFamilyTopKCount > 0) &&
      guidanceSuccess
    ) {
      hitQuality = 'valid_hit';
    } else {
      hitQuality = 'invalid_hit';
      if (toolsTopKCount >= Math.max(1, Math.ceil(topK.length / 2))) invalidHitReason = 'invalid_hit_tools_dominant';
      else if (skincareTopKCount <= 0) invalidHitReason = 'invalid_hit_all_non_skincare';
      else if (successContractResult.failure_class === 'retrieval_direction_weak') {
        invalidHitReason = 'invalid_hit_adjacent_noise_dominant';
      } else if (guidanceOnlyDiscovery && normalizedQueryTargetStepFamily === 'moisturizer' && genericFamilyTopKCount > 0) {
        invalidHitReason = 'invalid_hit_only_generic_family_candidates';
      }
      else if (normalizedQueryTargetStepFamily && sameFamilyTopKCount <= 0) invalidHitReason = 'invalid_hit_no_same_family_candidates';
      else invalidHitReason = 'invalid_hit_wrong_beauty_bucket';
    }
  }

  return {
    applied: true,
    contract_version: BEAUTY_SEARCH_DECISION_CONTRACT_VERSION,
    hit_quality: hitQuality,
    invalid_hit_reason: invalidHitReason,
    query_bucket: 'skincare',
    query_target_step_family: normalizedQueryTargetStepFamily || null,
    topk_bucket_mix: topkBucketMix,
    same_family_topk_count: sameFamilyTopKCount,
    exact_step_topk_count: exactStepTopKCount,
    strong_goal_family_topk_count: strongGoalFamilyTopKCount,
    supportive_same_family_topk_count: supportiveSameFamilyTopKCount,
    query_step_strength: normalizedQueryStepStrength,
    step_success_class: stepSuccessClass,
    success_contract_result: successContractResult,
    quality_gate_result: qualityGateResult,
    candidate_class_counts: candidateClassCounts,
    target_relevance_class_counts: candidateClassCounts,
    normalized_intent: normalizedIntent,
    candidate_origin_counts: candidateOriginCounts,
    noise_drop_counts: noiseDropCounts,
    classified_candidate_count: normalizedValidProducts.length,
    displayable_candidate_count: displayableProducts.length,
    returned_candidate_count: hitQuality === 'valid_hit' ? displayableProducts.length : 0,
    fill_target_count: serumCanaryGuidance ? fillTargetCount : null,
    fill_completed_count: serumCanaryGuidance ? fillCompletedCount : null,
    coverage_limited_after_fill: coverageLimitedAfterFill,
    post_fill_unmet_count:
      serumCanaryGuidance && fillTargetCount > 0
        ? Math.max(0, fillTargetCount - fillCompletedCount)
        : 0,
    valid_scoping_dropped_count: validScopingDroppedCount,
    dedupe_dropped_count: dedupeDroppedCount,
    selection_diversity: selectionDiversity,
    diversity_exception_applied: diversityExceptionApplied,
    stable_prior_applied: stablePriorApplied,
    stable_prior_source: stablePriorSource,
    fallback_mode: fallbackMode,
    surface_reason: surfaceReason,
    raw_result_count: rawProducts.length,
    products_returned_count: hitQuality === 'valid_hit' ? displayableProducts.length : 0,
    ranked_products: rankedProducts,
    valid_products: hitQuality === 'valid_hit' ? displayableProducts : [],
    decision_capability: buildRecommendationDecisionCapabilityOutput({
      normalized_intent: normalizedIntent,
      query_plan: {
        query_text: queryText || null,
      },
      candidate_class_counts: candidateClassCounts,
      step_success_class: stepSuccessClass,
      success_contract_result: successContractResult,
      surface_reason: surfaceReason,
      output_policy_payload: {
        hit_quality: hitQuality,
        quality_gate_result: qualityGateResult,
        coverage_limited_after_fill: coverageLimitedAfterFill,
        fallback_mode: fallbackMode,
      },
    }),
  };
}

module.exports = {
  BEAUTY_SEARCH_DECISION_CONTRACT_VERSION,
  buildBeautyCandidateText,
  buildCandidateProvenance,
  summarizeCandidateSources,
  resolveBeautyCoarseStepFamily,
  normalizeGuidanceIntentStrength,
  classifyBeautyGuidanceQueryStrength,
  classifyBeautyCoarseCandidate,
  scoreBeautyCandidateForTarget,
  rerankBeautySkincareProductsByTargetFamily,
  buildBeautySkincareHitQualityDecision,
};
