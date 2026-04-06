const {
  createShoppingAgentDecisioningInput,
  createShoppingAgentDecisioningOutput,
} = require('../../contracts/shoppingAgentContracts');
const { buildBeautyQueryProfile } = require('../../../findProductsMulti/beautyQueryProfile');
const {
  buildFindProductsMultiContext,
  applyFindProductsMultiPolicy,
  hasFashionConstraintQuerySignal,
} = require('../../../findProductsMulti/policy');
const { createStrictFindProductsMultiRuntime } = require('./strictFindProductsMulti');

function createShoppingAgentDecisioningRuntime(deps = {}) {
  const strictRuntime = createStrictFindProductsMultiRuntime({
    buildBeautyQueryProfile,
    ...deps,
  });
  const buildFindProductsMultiContextImpl =
    typeof deps.buildFindProductsMultiContext === 'function'
      ? deps.buildFindProductsMultiContext
      : buildFindProductsMultiContext;
  const applyFindProductsMultiPolicyImpl =
    typeof deps.applyFindProductsMultiPolicy === 'function'
      ? deps.applyFindProductsMultiPolicy
      : applyFindProductsMultiPolicy;
  const hasFashionConstraintQuerySignalImpl =
    typeof deps.hasFashionConstraintQuerySignal === 'function'
      ? deps.hasFashionConstraintQuerySignal
      : hasFashionConstraintQuerySignal;
  const extractSearchAnchorTokensImpl =
    typeof deps.extractSearchAnchorTokens === 'function'
      ? deps.extractSearchAnchorTokens
      : (queryText) =>
          String(queryText || '')
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 12);
  const detectBrandEntitiesImpl =
    typeof deps.detectBrandEntities === 'function'
      ? deps.detectBrandEntities
      : () => ({ brand_like: false, brands: [] });
  const hasPetLeashSearchSignalImpl =
    typeof deps.hasPetLeashSearchSignal === 'function' ? deps.hasPetLeashSearchSignal : () => false;
  const isKnownLookupAliasQueryImpl =
    typeof deps.isKnownLookupAliasQuery === 'function' ? deps.isKnownLookupAliasQuery : () => false;
  const searchForceControlledRecallForScenario =
    typeof deps.searchForceControlledRecallForScenario === 'boolean'
      ? deps.searchForceControlledRecallForScenario
      : true;

  function shouldApplyFindProductsMultiPolicyForQuery({ intent, rawQuery, responseMetadata }) {
    const metadata =
      responseMetadata && typeof responseMetadata === 'object' && !Array.isArray(responseMetadata)
        ? responseMetadata
        : {};
    const querySource = String(metadata.query_source || '').trim().toLowerCase();
    const sourceStrategy = String(metadata?.source_breakdown?.strategy_applied || '').trim().toLowerCase();
    if (
      metadata.brand_query_mainline_applied === true ||
      querySource.includes('brand_search_mainline') ||
      sourceStrategy === 'brand_search_multi_source'
    ) {
      return false;
    }
    if (intent) return true;
    if (metadata.strict_constraint_query === true) return true;
    if (
      metadata.budget_fx_applied != null ||
      metadata.budget_fx_rate != null ||
      metadata.budget_fx_candidate_currency != null
    ) {
      return true;
    }
    return hasFashionConstraintQuerySignalImpl(rawQuery, responseMetadata);
  }

  function applyFindProductsMultiPolicyIfNeeded({
    response,
    intent,
    requestPayload,
    metadata,
    rawUserQuery,
    responseMetadata,
  } = {}) {
    if (
      !shouldApplyFindProductsMultiPolicyForQuery({
        intent,
        rawQuery: rawUserQuery,
        responseMetadata:
          responseMetadata ||
          (response && typeof response === 'object' && !Array.isArray(response) ? response.metadata : null),
      })
    ) {
      return response;
    }
    return applyFindProductsMultiPolicyImpl({
      response,
      intent,
      requestPayload,
      metadata,
      rawUserQuery,
    });
  }

  function evaluateCacheStageAmbiguityDecision({
    effectiveIntent = null,
    cacheQueryText = '',
    effectiveProducts = [],
    internalProductsAfterAnchor = [],
    traceQueryClass = null,
    genericRecommendQuery = false,
  } = {}) {
    const queryClassForEarlyDecision = String(traceQueryClass || effectiveIntent?.query_class || '').toLowerCase();
    const earlyDecisionBrandDetection = detectBrandEntitiesImpl(cacheQueryText, {
      candidateProducts: effectiveProducts,
    });
    const isBrandLikeForEarlyDecision = Boolean(earlyDecisionBrandDetection?.brand_like);
    const queryClassMissing = queryClassForEarlyDecision.length === 0;
    const hasAmbiguitySignal = Boolean(effectiveIntent?.ambiguity?.needs_clarification);
    const forceControlledRecallForScenario =
      searchForceControlledRecallForScenario &&
      (
        ['scenario', 'mission'].includes(queryClassForEarlyDecision) ||
        (queryClassMissing && hasAmbiguitySignal)
      );
    const isStrongLookupForEarlyDecision =
      queryClassForEarlyDecision === 'lookup' || isKnownLookupAliasQueryImpl(cacheQueryText);
    const hasEarlyDecisionClass = [
      'mission',
      'scenario',
      'gift',
      'exploratory',
      'non_shopping',
    ].includes(queryClassForEarlyDecision);
    const petLeashPriceMinRaw = effectiveIntent?.hard_constraints?.price?.min;
    const petLeashPriceMaxRaw = effectiveIntent?.hard_constraints?.price?.max;
    const petLeashHasPriceMin =
      petLeashPriceMinRaw != null && Number.isFinite(Number(petLeashPriceMinRaw));
    const petLeashHasPriceMax =
      petLeashPriceMaxRaw != null && Number.isFinite(Number(petLeashPriceMaxRaw));
    const petLeashGenericCategoryCacheMiss =
      effectiveProducts.length === 0 &&
      hasPetLeashSearchSignalImpl(cacheQueryText) &&
      queryClassForEarlyDecision === 'category' &&
      genericRecommendQuery &&
      !petLeashHasPriceMin &&
      !petLeashHasPriceMax;
    const forceSearchFirstForClass = ['category', 'exploratory'].includes(queryClassForEarlyDecision);
    const earlyDecisionCause =
      internalProductsAfterAnchor.length === 0
        ? 'cache_miss_ambiguity_sensitive'
        : 'cache_irrelevant_ambiguity_sensitive';
    const canUseEarlyAmbiguityDecision =
      Boolean(effectiveIntent) &&
      !isBrandLikeForEarlyDecision &&
      !isStrongLookupForEarlyDecision &&
      (!forceSearchFirstForClass || petLeashGenericCategoryCacheMiss) &&
      (
        hasEarlyDecisionClass ||
        (queryClassMissing && hasAmbiguitySignal) ||
        petLeashGenericCategoryCacheMiss
      ) &&
      !forceControlledRecallForScenario;

    let routeDebugUpdate = null;
    if (forceSearchFirstForClass) {
      routeDebugUpdate = {
        applied: false,
        reason: 'search_first_query_class',
        query_class: queryClassForEarlyDecision,
      };
    }
    if (forceControlledRecallForScenario) {
      routeDebugUpdate = {
        applied: false,
        reason: 'force_controlled_recall_for_scenario',
        query_class: queryClassForEarlyDecision,
      };
    }
    if (isBrandLikeForEarlyDecision) {
      routeDebugUpdate = {
        applied: false,
        reason: 'brand_like_search_first',
        query_class: queryClassForEarlyDecision,
        brand_entities: Array.isArray(earlyDecisionBrandDetection?.brands)
          ? earlyDecisionBrandDetection.brands
          : [],
      };
    }
    if (canUseEarlyAmbiguityDecision) {
      routeDebugUpdate = {
        applied: true,
        reason: earlyDecisionCause,
        query_class: queryClassForEarlyDecision,
      };
    }

    return {
      queryClassForEarlyDecision,
      isBrandLikeForEarlyDecision,
      forceControlledRecallForScenario,
      isStrongLookupForEarlyDecision,
      hasEarlyDecisionClass,
      petLeashGenericCategoryCacheMiss,
      forceSearchFirstForClass,
      earlyDecisionCause,
      canUseEarlyAmbiguityDecision,
      routeDebugUpdate,
      gateTraceReason: canUseEarlyAmbiguityDecision
        ? earlyDecisionCause
        : isBrandLikeForEarlyDecision
          ? 'brand_like_search_first'
          : forceSearchFirstForClass
            ? 'search_first_query_class'
            : null,
    };
  }

  function getFindProductsMultiSecondStageSupplementDecision({
    queryText = '',
    expandedQuery = '',
    traceQueryClass = null,
    effectiveIntent = null,
    expansionMeta = null,
  } = {}) {
    const normalizedQueryText = String(queryText || '').trim();
    const normalizedExpandedQuery = String(expandedQuery || '').trim();
    const queryClass = String(
      traceQueryClass || effectiveIntent?.query_class || expansionMeta?.query_class || '',
    )
      .trim()
      .toLowerCase();
    const brandDetection =
      expansionMeta?.brand_query_detected === true
        ? { brand_like: true, brands: expansionMeta?.brand_entities || [] }
        : detectBrandEntitiesImpl(normalizedQueryText);
    const brandLike = Boolean(brandDetection?.brand_like);
    const resolutionLike =
      queryClass === 'lookup' ||
      queryClass === 'attribute' ||
      isKnownLookupAliasQueryImpl(normalizedQueryText);
    const ambiguitySensitive = ['scenario', 'mission', 'gift'].includes(queryClass);
    const browseLike = ['category', 'exploratory'].includes(queryClass);
    const originalAnchors = extractSearchAnchorTokensImpl(normalizedQueryText)
      .map((token) => String(token || '').trim().toLowerCase())
      .filter(Boolean);
    const expandedAnchors = extractSearchAnchorTokensImpl(normalizedExpandedQuery)
      .map((token) => String(token || '').trim().toLowerCase())
      .filter(Boolean);
    const originalSet = new Set(originalAnchors);
    const addedTokens = expandedAnchors.filter((token) => !originalSet.has(token));
    const riskyBroadeningTokens = [...addedTokens];
    const humanApparelOutfitBroadening =
      browseLike &&
      String(effectiveIntent?.primary_domain || '').trim().toLowerCase() === 'human_apparel' &&
      String(effectiveIntent?.target_object?.type || '').trim().toLowerCase() === 'human' &&
      addedTokens.includes('outfit');
    if (humanApparelOutfitBroadening) {
      for (const token of ['dress', 'skirt']) {
        if (!riskyBroadeningTokens.includes(token)) riskyBroadeningTokens.push(token);
      }
    }
    const riskyBroadening = riskyBroadeningTokens.length >= 3;

    if (!normalizedExpandedQuery || normalizedExpandedQuery === normalizedQueryText) {
      return {
        allowSupplement: false,
        reason: 'second_stage_not_expanded',
        queryClass,
        addedTokens: riskyBroadeningTokens,
        riskyBroadening,
      };
    }
    if (brandLike) {
      return {
        allowSupplement: false,
        reason: 'disabled_for_brand_like_query',
        queryClass,
        addedTokens: riskyBroadeningTokens,
        riskyBroadening,
      };
    }
    if (resolutionLike) {
      return {
        allowSupplement: false,
        reason: 'disabled_for_resolution_like_query',
        queryClass,
        addedTokens: riskyBroadeningTokens,
        riskyBroadening,
      };
    }
    if (ambiguitySensitive) {
      return {
        allowSupplement: false,
        reason: 'disabled_for_ambiguity_sensitive_query',
        queryClass,
        addedTokens: riskyBroadeningTokens,
        riskyBroadening,
      };
    }
    if (!browseLike) {
      return {
        allowSupplement: false,
        reason: queryClass ? 'disabled_for_query_class' : 'disabled_for_unknown_query_class',
        queryClass,
        addedTokens: riskyBroadeningTokens,
        riskyBroadening,
      };
    }
    if (riskyBroadening) {
      return {
        allowSupplement: false,
        reason: 'disabled_for_risky_broadening',
        queryClass,
        addedTokens: riskyBroadeningTokens,
        riskyBroadening,
      };
    }
    return {
      allowSupplement: true,
      reason: 'second_stage_allowed',
      queryClass,
      addedTokens: riskyBroadeningTokens,
      riskyBroadening,
    };
  }

  async function handleShoppingAgentDecisioning(input = {}) {
    const normalized = createShoppingAgentDecisioningInput(input);
    const queryText = String(
      normalized.context?.normalized_need?.query ||
        normalized.context?.raw_user_goal ||
        '',
    ).trim();
    const strictDecision = strictRuntime.getStrictFindProductsMultiConstraintDecision({
      search: queryText ? { query: queryText } : {},
      metadata: {},
    });
    const currentRationale = Array.isArray(normalized.context?.decision_state?.rationale)
      ? normalized.context.decision_state.rationale.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const strictRationale =
      strictDecision.strictConstraintQuery && strictDecision.strictConstraintReason
        ? [`strict_constraint:${strictDecision.strictConstraintReason}`]
        : [];
    const taskType = String(input.task_type || '').trim().toLowerCase();

    return createShoppingAgentDecisioningOutput({
      context: normalized.context,
      updated_context: {
        ...normalized.context,
        normalized_need: {
          ...(normalized.context?.normalized_need || {}),
          ...(queryText ? { query: queryText } : {}),
        },
        decision_state: {
          ...(normalized.context?.decision_state || {}),
          rationale: Array.from(new Set([...currentRationale, ...strictRationale])),
          confidence: strictDecision.strictConstraintQuery
            ? Math.max(Number(normalized.context?.decision_state?.confidence || 0) || 0, 0.35)
            : Number(normalized.context?.decision_state?.confidence || 0) || 0,
        },
      },
      status: taskType === 'exact_product' ? 'needs_execution' : 'no_match',
      ranked_candidates: [],
      compare_matrix: [],
      delegation_plan: taskType === 'exact_product' ? 'call_execution' : 'stay_in_layer',
    });
  }

  return {
    handleShoppingAgentDecisioning,
    buildFindProductsMultiContext: buildFindProductsMultiContextImpl,
    shouldApplyFindProductsMultiPolicyForQuery,
    applyFindProductsMultiPolicyIfNeeded,
    evaluateCacheStageAmbiguityDecision,
    getFindProductsMultiSecondStageSupplementDecision,
    getStrictFindProductsMultiConstraintDecision: strictRuntime.getStrictFindProductsMultiConstraintDecision,
    buildFindProductsMultiInvokeBody: strictRuntime.buildFindProductsMultiInvokeBody,
  };
}

const defaultDecisioningRuntime = createShoppingAgentDecisioningRuntime();

module.exports = {
  createShoppingAgentDecisioningRuntime,
  handleShoppingAgentDecisioning: defaultDecisioningRuntime.handleShoppingAgentDecisioning,
};
