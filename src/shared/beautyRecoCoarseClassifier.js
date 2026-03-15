const {
  classifyBeautyBucketFromText,
  detectBeautyQueryBucket,
} = require('../findProductsMulti/beautyQueryProfile');
const {
  resolveRecoTargetStepIntent,
  normalizeRecoTargetStep,
  getRecoTargetFamilyRelation,
} = require('../auroraBff/recoTargetStep');

const BEAUTY_SEARCH_DECISION_CONTRACT_VERSION = 'beauty_search_decision_v3';
const TOOL_RE = /\b(brush|applicator|tool|accessory|sponge|puff|mirror|curler|sharpener)\b/i;
const BRUSH_RE = /\b(brush|applicator|sponge|puff)\b/i;
const ACCESSORY_RE = /\b(accessory|mirror|curler|sharpener)\b/i;
const BODY_RE = /\b(body|hand|foot|heel|bath|shower|deodorant|butt|booty|butta|trio|set)\b/i;
const FACE_RE = /\b(face|facial|barrier cream|gel cream)\b/i;
const MAKEUP_RE = /\b(lip|lipstick|mascara|eyeshadow|shadow|blush|concealer|foundation|liner|brow|powder|highlighter)\b/i;
const SERVICE_RE = /\b(cabine|fauteuil|minutes?|session|appointment|booking|spa)\b/i;
const SERVICE_FRENCH_RE = /\bsoin\b/i;

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

function classifyBeautyCoarseCandidate(product, { queryTargetStepFamily = null } = {}) {
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
  const coarseValidForTarget = Boolean(
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
    coarse_step_family: candidateStep || null,
    candidate_step: candidateStep || null,
    candidate_step_source: stepResolution.candidate_step_source || 'none',
    candidate_step_confidence: stepResolution.candidate_step_confidence || 'none',
    family_relation: familyRelation,
    coarse_valid_for_target: coarseValidForTarget,
  };
}

function scoreBeautyCandidateForTarget(product, { queryTargetStepFamily = null } = {}) {
  const coarse = classifyBeautyCoarseCandidate(product, { queryTargetStepFamily });
  let score = 0;
  if (coarse.domain_scope === 'skincare') score += 40;
  if (coarse.usage_scope === 'face') score += 20;
  if (coarse.object_type === 'product') score += 10;
  if (coarse.application_mode === 'leave_on') score += 10;
  if (coarse.family_relation === 'same_family') score += 80;
  if (queryTargetStepFamily && coarse.candidate_step === queryTargetStepFamily) score += 20;
  if (coarse.application_mode === 'rinse_off') score -= 15;
  if (coarse.domain_scope === 'bodycare') score -= 40;
  if (coarse.domain_scope === 'makeup') score -= 60;
  if (coarse.domain_scope === 'beauty_service' || coarse.object_type === 'service') score -= 120;
  if (coarse.domain_scope === 'beauty_tool' || coarse.object_type === 'brush' || coarse.object_type === 'tool') score -= 100;
  return { score, coarse };
}

function rerankBeautySkincareProductsByTargetFamily(products, { queryTargetStepFamily = null } = {}) {
  const rows = Array.isArray(products) ? products : [];
  return rows
    .map((product, index) => {
      const scored = scoreBeautyCandidateForTarget(product, { queryTargetStepFamily });
      return {
        product,
        index,
        score: scored.score,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    })
    .map((row) => row.product);
}

function buildBeautySkincareHitQualityDecision({ queryText, products, queryTargetStepFamily = null } = {}) {
  const queryBucket = detectBeautyQueryBucket(queryText);
  const rawProducts = Array.isArray(products) ? products : [];
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
      raw_result_count: rawProducts.length,
      products_returned_count: rawProducts.length,
      valid_products: rawProducts,
    };
  }
  const queryResolution = resolveRecoTargetStepIntent({ focus: queryText, text: queryText });
  const normalizedQueryTargetStepFamily = normalizeRecoTargetStep(
    queryTargetStepFamily || queryResolution?.resolved_target_step,
  );
  const rankedProducts = rerankBeautySkincareProductsByTargetFamily(rawProducts, {
    queryTargetStepFamily: normalizedQueryTargetStepFamily,
  });
  const topK = rankedProducts.slice(0, 8);
  const topkBucketMix = {};
  let toolsTopKCount = 0;
  let sameFamilyTopKCount = 0;
  let exactStepTopKCount = 0;
  let skincareTopKCount = 0;

  const classifyTopK = (product) => {
    const coarse = classifyBeautyCoarseCandidate(product, { queryTargetStepFamily: normalizedQueryTargetStepFamily });
    topkBucketMix[coarse.domain_scope] = Number(topkBucketMix[coarse.domain_scope] || 0) + 1;
    if (coarse.domain_scope === 'beauty_tool') toolsTopKCount += 1;
    if (coarse.domain_scope === 'skincare' && coarse.usage_scope === 'face' && coarse.object_type === 'product') skincareTopKCount += 1;
    if (coarse.coarse_valid_for_target) {
      sameFamilyTopKCount += 1;
      if (coarse.candidate_step && coarse.candidate_step === normalizedQueryTargetStepFamily) exactStepTopKCount += 1;
    }
    return coarse;
  };

  for (const product of topK) classifyTopK(product);

  const validProducts = rankedProducts.filter((product) => {
    const coarse = classifyBeautyCoarseCandidate(product, { queryTargetStepFamily: normalizedQueryTargetStepFamily });
    return coarse.coarse_valid_for_target;
  });

  let hitQuality = 'empty';
  let invalidHitReason = null;
  if (rawProducts.length > 0) {
    if (validProducts.length > 0 && (!normalizedQueryTargetStepFamily || sameFamilyTopKCount > 0)) {
      hitQuality = 'valid_hit';
    } else {
      hitQuality = 'invalid_hit';
      if (toolsTopKCount >= Math.max(1, Math.ceil(topK.length / 2))) invalidHitReason = 'invalid_hit_tools_dominant';
      else if (skincareTopKCount <= 0) invalidHitReason = 'invalid_hit_all_non_skincare';
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
    raw_result_count: rawProducts.length,
    products_returned_count: hitQuality === 'valid_hit' ? validProducts.length : 0,
    valid_products: hitQuality === 'valid_hit' ? validProducts : [],
  };
}

module.exports = {
  BEAUTY_SEARCH_DECISION_CONTRACT_VERSION,
  buildBeautyCandidateText,
  resolveBeautyCoarseStepFamily,
  classifyBeautyCoarseCandidate,
  scoreBeautyCandidateForTarget,
  rerankBeautySkincareProductsByTargetFamily,
  buildBeautySkincareHitQualityDecision,
};
