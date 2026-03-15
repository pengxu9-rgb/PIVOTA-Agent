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
  normalizeRecommendationDecisionMode,
  getTargetRelevanceClassRank,
  buildSuccessContractResult,
  buildRecommendationDecisionCapabilityOutput,
  countTargetRelevanceClasses,
  shouldUseSharedTargetRelevancePipeline,
} = require('./recommendationDecisionCapability');

const BEAUTY_SEARCH_DECISION_CONTRACT_VERSION = 'beauty_search_decision_v4';
const TOOL_RE = /\b(brush|applicator|tool|accessory|sponge|puff|mirror|curler|sharpener)\b/i;
const BRUSH_RE = /\b(brush|applicator|sponge|puff)\b/i;
const ACCESSORY_RE = /\b(accessory|mirror|curler|sharpener)\b/i;
const BODY_RE = /\b(body|hand|foot|heel|bath|shower|deodorant|butt|booty|butta|trio|set)\b/i;
const FACE_RE = /\b(face|facial|barrier cream|gel cream)\b/i;
const MAKEUP_RE = /\b(lip|lipstick|mascara|eyeshadow|shadow|blush|concealer|foundation|liner|brow|powder|highlighter)\b/i;
const SERVICE_RE = /\b(cabine|fauteuil|minutes?|session|appointment|booking|spa)\b/i;
const SERVICE_FRENCH_RE = /\bsoin\b/i;
const BUNDLE_RE = /\b(bundle)\b/i;
const DUO_RE = /\b(duo)\b/i;
const SET_RE = /\b(set)\b/i;
const KIT_RE = /\b(kit)\b/i;
const SAMPLE_RE = /\b(sample|mini|travel size|trial size)\b/i;
const TINT_RE = /\b(skin tint|tinted|tint(ed)? moisturizer|bb cream|cc cream|foundation|concealer)\b/i;
const PEEL_RE = /\b(peel|exfoliant|exfoliating|resurfacing)\b/i;
const SPF_RE = /\b(spf\s*\d+|spf|sunscreen|sun screen|uv filters?)\b/i;
const BRIGHTENING_RE = /\b(brightening|vitamin c|glow|radiance)\b/i;
const MOISTURIZER_GUIDANCE_FAMILY_RE = /\b(moisturizer|moisturiser|cream|lotion|gel cream|balm)\b/i;
const GUIDANCE_BARRIER_RE = /\b(barrier|repair)\b/i;
const GUIDANCE_INGREDIENT_RE = /\b(ceramides?|panthenol|niacinamide|hyalur|hyaluronic|centella|cica|allantoin|phyto.?ceramides?)\b/i;
const GUIDANCE_SENSITIVITY_RE = /\b(sensitive|fragrance[- ]free|gentle|soothing|calming)\b/i;
const GUIDANCE_HYDRATION_RE = /\b(hydrat|gel cream)\b/i;

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
  const anchorMatches = countGuidanceAnchorMatches(candidateFlags, queryFlags);
  const looksLikeMoisturizerFamily =
    coarse.candidate_step === 'moisturizer' || MOISTURIZER_GUIDANCE_FAMILY_RE.test(lower);
  const effectiveStrength =
    normalizeGuidanceIntentStrength(queryStepStrength) ||
    classifyBeautyGuidanceQueryStrength(queryText, { queryTargetStepFamily: 'moisturizer' });

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
  if (coarse.application_mode === 'rinse_off' || coarse.family_relation === 'adjacent_family') {
    return { offer_type: offerType, target_relevance_class: 'hard_invalid', noise_reason: 'peel' };
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
    candidateFlags.ingredient &&
    (candidateFlags.barrier || candidateFlags.sensitivity || candidateFlags.hydration) &&
    (queryFlags.ingredient || queryFlags.barrier || queryFlags.sensitivity || queryFlags.hydration)
  ) {
    return { offer_type: offerType, target_relevance_class: 'strong_goal_family', noise_reason: null };
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
    return { offer_type: offerType, target_relevance_class: 'supportive_family', noise_reason: null };
  }
  if (anchorMatches >= 2 && effectiveStrength !== 'generic_family') {
    return { offer_type: offerType, target_relevance_class: 'strong_goal_family', noise_reason: null };
  }
  if (anchorMatches >= 1) {
    return { offer_type: offerType, target_relevance_class: 'supportive_family', noise_reason: null };
  }
  if (
    candidateFlags.ingredient &&
    (queryFlags.barrier || queryFlags.sensitivity || queryFlags.hydration || queryFlags.ingredient)
  ) {
    return { offer_type: offerType, target_relevance_class: 'supportive_family', noise_reason: null };
  }
  return { offer_type: offerType, target_relevance_class: 'generic_family', noise_reason: null };
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
    ...(Array.isArray(product.tags) ? product.tags : []),
    ...(Array.isArray(product.tag_tokens) ? product.tag_tokens : []),
    ...(Array.isArray(product.ingredient_tokens) ? product.ingredient_tokens : []),
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
  const hasServiceCue = SERVICE_RE.test(lower) || (SERVICE_FRENCH_RE.test(lower) && SERVICE_RE.test(lower));

  let domainScope = 'unknown';
  if (hasServiceCue) {
    domainScope = 'beauty_service';
  } else if (TOOL_RE.test(lower)) {
    domainScope = 'beauty_tool';
  } else if (hasBodyCue && !hasFaceCue) {
    domainScope = 'bodycare';
  } else if (MAKEUP_RE.test(lower) || rawBucket === 'makeup') {
    domainScope = 'makeup';
  } else if (rawBucket === 'skincare' || candidateStep) {
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
  const guidanceOnlyMoisturizer =
    shouldUseSharedTargetRelevancePipeline({
      mode: decisionMode,
      targetStepFamily: normalizeRecoTargetStep(queryTargetStepFamily),
      queryStepStrength,
    });
  let offerType = detectBeautyOfferType(lower);
  let targetRelevanceClass = 'supportive_family';
  let noiseReason = null;
  if (guidanceOnlyMoisturizer) {
    const guidanceRelevance = classifyGuidanceOnlyMoisturizerTargetRelevance({
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
    });
    offerType = guidanceRelevance.offer_type;
    targetRelevanceClass = guidanceRelevance.target_relevance_class;
    noiseReason = guidanceRelevance.noise_reason;
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
  const coarseValidForTarget = guidanceOnlyMoisturizer
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
  let score = 0;
  if (coarse.domain_scope === 'skincare') score += 40;
  if (coarse.usage_scope === 'face') score += 20;
  if (coarse.object_type === 'product') score += 10;
  if (coarse.application_mode === 'leave_on') score += 10;
  if (coarse.family_relation === 'same_family') score += 80;
  if (queryTargetStepFamily && coarse.candidate_step === queryTargetStepFamily) score += 20;
  if (guidanceOnlyDiscovery === true && normalizeRecoTargetStep(queryTargetStepFamily) === 'moisturizer') {
    if (coarse.target_relevance_class === 'strong_goal_family') score += 120;
    else if (coarse.target_relevance_class === 'supportive_family') score += 80;
    else if (coarse.target_relevance_class === 'generic_family') score += 10;
    else if (coarse.target_relevance_class === 'adjacent_noise') score -= 90;
    else score -= 160;
    if (coarse.offer_type === 'sample') score -= 4;
  }
  if (coarse.application_mode === 'rinse_off') score -= 15;
  if (coarse.domain_scope === 'bodycare') score -= 40;
  if (coarse.domain_scope === 'makeup') score -= 60;
  if (coarse.domain_scope === 'beauty_service' || coarse.object_type === 'service') score -= 120;
  if (coarse.domain_scope === 'beauty_tool' || coarse.object_type === 'brush' || coarse.object_type === 'tool') score -= 100;
  return { score, coarse };
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

function buildBeautySkincareHitQualityDecision({
  queryText,
  products,
  queryTargetStepFamily = null,
  guidanceOnlyDiscovery = false,
  queryStepStrength = null,
  mode = null,
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
    rankedProducts.map((product) => {
      const coarse = classifyBeautyCoarseCandidate(product, {
        queryTargetStepFamily: normalizedQueryTargetStepFamily,
        queryText,
        guidanceOnlyDiscovery,
        queryStepStrength: normalizedQueryStepStrength,
        mode: decisionMode,
      });
      return coarse.target_relevance_class;
    }),
  );

  const contractStrongOrSupportive = [];
  const contractGenericFallback = [];
  const validProducts = rankedProducts.filter((product) => {
    const coarse = classifyBeautyCoarseCandidate(product, {
      queryTargetStepFamily: normalizedQueryTargetStepFamily,
      queryText,
      guidanceOnlyDiscovery,
      queryStepStrength: normalizedQueryStepStrength,
      mode: decisionMode,
    });
    candidateClassCounts[coarse.target_relevance_class] = Number(candidateClassCounts[coarse.target_relevance_class] || 0) + 1;
    if (coarse.noise_reason) {
      noiseDropCounts[coarse.noise_reason] = Number(noiseDropCounts[coarse.noise_reason] || 0) + 1;
    }
    const sharedPipelineApplied = shouldUseSharedTargetRelevancePipeline({
      mode: decisionMode,
      targetStepFamily: normalizedQueryTargetStepFamily,
      queryStepStrength: normalizedQueryStepStrength,
    });
    if (sharedPipelineApplied) {
      if (coarse.target_relevance_class === 'strong_goal_family' || coarse.target_relevance_class === 'supportive_family') {
        contractStrongOrSupportive.push(product);
        return true;
      }
      if (coarse.target_relevance_class === 'generic_family' && contractStrongOrSupportive.length > 0 && contractGenericFallback.length < 1) {
        contractGenericFallback.push(product);
      }
      return false;
    }
    return coarse.coarse_valid_for_target;
  });

  const normalizedValidProducts =
    shouldUseSharedTargetRelevancePipeline({
      mode: decisionMode,
      targetStepFamily: normalizedQueryTargetStepFamily,
      queryStepStrength: normalizedQueryStepStrength,
    })
      ? contractStrongOrSupportive.concat(contractGenericFallback)
      : validProducts;
  const candidateClassesTop3 = normalizedValidProducts.slice(0, 3).map((product) => {
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
    candidateClassCounts: contractCandidateClassCounts,
    topCandidateClasses: candidateClassesTop3,
  });

  let hitQuality = 'empty';
  let invalidHitReason = null;
  let stepSuccessClass = null;
  if (rawProducts.length > 0) {
    stepSuccessClass = successContractResult.step_success_class || null;
    const guidanceSuccess =
      !shouldUseSharedTargetRelevancePipeline({
        mode: decisionMode,
        targetStepFamily: normalizedQueryTargetStepFamily,
        queryStepStrength: normalizedQueryStepStrength,
      }) ||
      successContractResult.satisfied === true;
    if (
      normalizedValidProducts.length > 0 &&
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
    candidate_class_counts: candidateClassCounts,
    target_relevance_class_counts: candidateClassCounts,
    noise_drop_counts: noiseDropCounts,
    raw_result_count: rawProducts.length,
    products_returned_count: hitQuality === 'valid_hit' ? normalizedValidProducts.length : 0,
    valid_products: hitQuality === 'valid_hit' ? normalizedValidProducts : [],
    decision_capability: buildRecommendationDecisionCapabilityOutput({
      normalized_intent: {
        target_step_family: normalizedQueryTargetStepFamily || null,
        query_step_strength: normalizedQueryStepStrength,
        mode: decisionMode,
      },
      query_plan: {
        query_text: queryText || null,
      },
      candidate_class_counts: candidateClassCounts,
      step_success_class: stepSuccessClass,
      success_contract_result: successContractResult,
      output_policy_payload: {
        hit_quality: hitQuality,
      },
    }),
  };
}

module.exports = {
  BEAUTY_SEARCH_DECISION_CONTRACT_VERSION,
  buildBeautyCandidateText,
  resolveBeautyCoarseStepFamily,
  normalizeGuidanceIntentStrength,
  classifyBeautyGuidanceQueryStrength,
  classifyBeautyCoarseCandidate,
  scoreBeautyCandidateForTarget,
  rerankBeautySkincareProductsByTargetFamily,
  buildBeautySkincareHitQualityDecision,
};
