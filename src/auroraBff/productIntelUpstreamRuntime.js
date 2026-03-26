function deepHasKey(obj, predicate, depth = 0) {
  if (depth > 6) return false;
  if (!obj) return false;
  if (Array.isArray(obj)) return obj.some((value) => deepHasKey(value, predicate, depth + 1));
  if (typeof obj !== 'object') return false;
  for (const [key, value] of Object.entries(obj)) {
    if (predicate(key)) return true;
    if (deepHasKey(value, predicate, depth + 1)) return true;
  }
  return false;
}

function createProductIntelUpstreamRuntime(options = {}) {
  const {
    extractJsonObject = () => null,
    extractJsonObjectByKeys = () => null,
    mapAuroraProductAnalysis = (value) => value,
    normalizeProductAnalysis = (value) => value,
  } = options;

  const PRODUCT_PARSE_ANSWER_JSON_KEYS = [
    'product',
    'parse',
    'anchor_product',
    'anchorProduct',
    'product_entity',
    'productEntity',
    'parsed_product',
    'parsedProduct',
  ];

  const PRODUCT_ANALYSIS_ANSWER_JSON_KEYS = [
    'assessment',
    'evidence',
    'confidence',
    'missing_info',
    'missingInfo',
    'analyze',
    'analysis',
    'product_analysis',
    'productAnalysis',
    'verdict',
    'reasons',
    'science_evidence',
    'scienceEvidence',
    'social_signals',
    'socialSignals',
    'expert_notes',
    'expertNotes',
  ];

  function structuredContainsCommerceLikeFields(structured) {
    const commerceKeys = new Set([
      'recommendations',
      'reco',
      'offers',
      'offer',
      'checkout',
      'purchase_route',
      'purchaseroute',
      'affiliate_url',
      'affiliateurl',
      'internal_checkout',
      'internalcheckout',
    ]);
    return deepHasKey(structured, (key) => commerceKeys.has(String(key || '').trim().toLowerCase()));
  }

  function getUpstreamStructuredOrJson(upstream, { answerRequiredKeys = null } = {}) {
    if (upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)) {
      return upstream.structured;
    }
    if (upstream && typeof upstream.answer === 'string') {
      const keyed = Array.isArray(answerRequiredKeys) && answerRequiredKeys.length
        ? extractJsonObjectByKeys(upstream.answer, answerRequiredKeys)
        : null;
      if (keyed && typeof keyed === 'object' && !Array.isArray(keyed)) return keyed;
      return extractJsonObject(upstream.answer);
    }
    return null;
  }

  function getProductAnalysisStructuredOrJson(upstream) {
    const upstreamStructured =
      upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)
        ? upstream.structured
        : null;
    const upstreamAnswerJson =
      upstream && typeof upstream.answer === 'string'
        ? extractJsonObjectByKeys(upstream.answer, PRODUCT_ANALYSIS_ANSWER_JSON_KEYS)
        : null;
    const upstreamAnswerObj =
      upstreamAnswerJson && typeof upstreamAnswerJson === 'object' && !Array.isArray(upstreamAnswerJson)
        ? upstreamAnswerJson
        : null;
    const answerLooksLikeProductAnalysis =
      upstreamAnswerObj &&
      (upstreamAnswerObj.assessment != null ||
        upstreamAnswerObj.evidence != null ||
        upstreamAnswerObj.analyze != null ||
        upstreamAnswerObj.analysis != null ||
        upstreamAnswerObj.product_analysis != null ||
        upstreamAnswerObj.productAnalysis != null ||
        upstreamAnswerObj.confidence != null ||
        upstreamAnswerObj.missing_info != null ||
        upstreamAnswerObj.missingInfo != null ||
        upstreamAnswerObj.verdict != null ||
        upstreamAnswerObj.reasons != null ||
        upstreamAnswerObj.science_evidence != null ||
        upstreamAnswerObj.scienceEvidence != null ||
        upstreamAnswerObj.social_signals != null ||
        upstreamAnswerObj.socialSignals != null ||
        upstreamAnswerObj.expert_notes != null ||
        upstreamAnswerObj.expertNotes != null);

    return upstreamStructured && upstreamStructured.analyze && typeof upstreamStructured.analyze === 'object'
      ? upstreamStructured
      : answerLooksLikeProductAnalysis
        ? upstreamAnswerObj
        : upstreamStructured || upstreamAnswerObj;
  }

  function normalizeProductAnalysisFromUpstream(upstream) {
    const structuredOrJson = getProductAnalysisStructuredOrJson(upstream);
    const direct =
      structuredOrJson && typeof structuredOrJson === 'object' && !Array.isArray(structuredOrJson)
        ? structuredOrJson
        : null;
    if (direct) {
      const directPayload =
        direct.product_analysis && typeof direct.product_analysis === 'object' && !Array.isArray(direct.product_analysis)
          ? direct.product_analysis
          : direct;
      const hasDirectShape =
        (directPayload.assessment && typeof directPayload.assessment === 'object' && !Array.isArray(directPayload.assessment)) ||
        (directPayload.evidence && typeof directPayload.evidence === 'object' && !Array.isArray(directPayload.evidence)) ||
        Array.isArray(directPayload.missing_info) ||
        Array.isArray(directPayload.missingInfo);
      if (hasDirectShape) return normalizeProductAnalysis(directPayload);
    }

    const mapped =
      structuredOrJson && typeof structuredOrJson === 'object' && !Array.isArray(structuredOrJson)
        ? mapAuroraProductAnalysis(structuredOrJson)
        : structuredOrJson;
    return normalizeProductAnalysis(mapped);
  }

  return {
    PRODUCT_ANALYSIS_ANSWER_JSON_KEYS,
    PRODUCT_PARSE_ANSWER_JSON_KEYS,
    getProductAnalysisStructuredOrJson,
    getUpstreamStructuredOrJson,
    normalizeProductAnalysisFromUpstream,
    structuredContainsCommerceLikeFields,
  };
}

module.exports = {
  createProductIntelUpstreamRuntime,
};
