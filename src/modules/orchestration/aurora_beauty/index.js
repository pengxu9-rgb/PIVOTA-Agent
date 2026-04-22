const {
  createAuroraOrchestrationInput,
  createAuroraOrchestrationOutput,
} = require('../../contracts/auroraContracts');
const { buildBeautyExpertV1Response } = require('./beautyExpertV1');

function createAuroraBeautyOrchestrationRuntime(deps = {}) {
  const normalizeSearchUiSurfaceImpl =
    typeof deps.normalizeSearchUiSurface === 'function'
      ? deps.normalizeSearchUiSurface
      : (value) => String(value || '').trim().toLowerCase();
  const normalizeAgentSourceImpl =
    typeof deps.normalizeAgentSource === 'function'
      ? deps.normalizeAgentSource
      : (value) => String(value || '').trim().toLowerCase();
  const normalizeRecoTargetStepImpl =
    typeof deps.normalizeRecoTargetStep === 'function'
      ? deps.normalizeRecoTargetStep
      : (value) => (value == null ? null : String(value || '').trim() || null);
  const firstQueryParamValueImpl =
    typeof deps.firstQueryParamValue === 'function'
      ? deps.firstQueryParamValue
      : (value) => {
          if (Array.isArray(value)) {
            return value.find((item) => item != null && String(item || '').trim()) ?? null;
          }
          return value;
        };
  const isAuroraSourceImpl =
    typeof deps.isAuroraSource === 'function' ? deps.isAuroraSource : () => false;
  const classifySharedBeautyCoarseCandidateImpl =
    typeof deps.classifySharedBeautyCoarseCandidate === 'function'
      ? deps.classifySharedBeautyCoarseCandidate
      : () => ({});
  const buildSearchDecisionProductKeyImpl =
    typeof deps.buildSearchDecisionProductKey === 'function'
      ? deps.buildSearchDecisionProductKey
      : () => null;
  const buildSearchProductKeyImpl =
    typeof deps.buildSearchProductKey === 'function'
      ? deps.buildSearchProductKey
      : () => null;
  const isExternalSeedProductImpl =
    typeof deps.isExternalSeedProduct === 'function'
      ? deps.isExternalSeedProduct
      : () => false;
  const isSupplementCandidateRelevantImpl =
    typeof deps.isSupplementCandidateRelevant === 'function'
      ? deps.isSupplementCandidateRelevant
      : () => false;
  const blendBeautyDiversitySupplementImpl =
    typeof deps.blendBeautyDiversitySupplement === 'function'
      ? deps.blendBeautyDiversitySupplement
      : (baselineProducts = [], supplementProducts = []) =>
          ([]).concat(baselineProducts || [], supplementProducts || []);
  const getAuroraFallbackOverridesImpl =
    typeof deps.getAuroraFallbackOverrides === 'function'
      ? deps.getAuroraFallbackOverrides
      : () => ({
          active: false,
          strategySource: 'default',
          disableSkipAfterResolverMiss: false,
          forceSecondaryFallback: false,
          forceInvokeFallback: false,
        });
  const getAuroraResolverTimeoutMs =
    typeof deps.auroraResolverTimeoutMs === 'function'
      ? deps.auroraResolverTimeoutMs
      : () => Number(deps.auroraResolverTimeoutMs || 0) || 0;
  const getDefaultResolverTimeoutMs =
    typeof deps.defaultResolverTimeoutMs === 'function'
      ? deps.defaultResolverTimeoutMs
      : () => Number(deps.defaultResolverTimeoutMs || 0) || 0;
  const getAuroraBypassCacheStrictEmptyEnabled =
    typeof deps.auroraBypassCacheStrictEmptyEnabled === 'function'
      ? deps.auroraBypassCacheStrictEmptyEnabled
      : () => deps.auroraBypassCacheStrictEmptyEnabled === true;
  const uniqueStringsImpl =
    typeof deps.uniqueStrings === 'function' ? deps.uniqueStrings : (values = []) => values;
  const normalizeExternalSeedStrategyImpl =
    typeof deps.normalizeExternalSeedStrategy === 'function'
      ? deps.normalizeExternalSeedStrategy
      : (value) => value;
  const isShoppingSourceImpl =
    typeof deps.isShoppingSource === 'function' ? deps.isShoppingSource : () => false;
  const isCatalogGuardSourceImpl =
    typeof deps.isCatalogGuardSource === 'function' ? deps.isCatalogGuardSource : () => false;
  const hasPetHarnessSearchSignalImpl =
    typeof deps.hasPetHarnessSearchSignal === 'function'
      ? deps.hasPetHarnessSearchSignal
      : () => false;
  const hasFragranceSearchSignalImpl =
    typeof deps.hasFragranceSearchSignal === 'function'
      ? deps.hasFragranceSearchSignal
      : () => false;
  const isBeautyGeneralDiversitySupplementCandidateImpl =
    typeof deps.isBeautyGeneralDiversitySupplementCandidate === 'function'
      ? deps.isBeautyGeneralDiversitySupplementCandidate
      : () => false;
  const getSearchExternalFillGated =
    typeof deps.searchExternalFillGated === 'function'
      ? deps.searchExternalFillGated
      : () => deps.searchExternalFillGated === true;
  const getSearchExternalHardRulePrune =
    typeof deps.searchExternalHardRulePrune === 'function'
      ? deps.searchExternalHardRulePrune
      : () => deps.searchExternalHardRulePrune === true;
  const countCandidateOriginBreakdownImpl =
    typeof deps.countCandidateOriginBreakdown === 'function'
      ? deps.countCandidateOriginBreakdown
      : () => ({});
  const mergeSearchCountMapsImpl =
    typeof deps.mergeSearchCountMaps === 'function' ? deps.mergeSearchCountMaps : (_, next) => next || {};
  const resolveGuidanceSearchSessionIdImpl =
    typeof deps.resolveGuidanceSearchSessionId === 'function'
      ? deps.resolveGuidanceSearchSessionId
      : () => null;
  const loadGuidanceSearchSessionSeenProductIdsImpl =
    typeof deps.loadGuidanceSearchSessionSeenProductIds === 'function'
      ? deps.loadGuidanceSearchSessionSeenProductIds
      : async () => [];
  const persistGuidanceSearchSeenProductsImpl =
    typeof deps.persistGuidanceSearchSeenProducts === 'function'
      ? deps.persistGuidanceSearchSeenProducts
      : async () => false;
  const normalizeGuidanceDiscoverySourcePolicyImpl =
    typeof deps.normalizeGuidanceDiscoverySourcePolicy === 'function'
      ? deps.normalizeGuidanceDiscoverySourcePolicy
      : (value) => (value == null ? null : String(value || '').trim() || null);
  const parseQueryBooleanImpl =
    typeof deps.parseQueryBoolean === 'function' ? deps.parseQueryBoolean : (value) => value;
  const parseQueryNumberImpl =
    typeof deps.parseQueryNumber === 'function' ? deps.parseQueryNumber : (value) => value;
  const inferGuidanceDiscoverySourceUsedImpl =
    typeof deps.inferGuidanceDiscoverySourceUsed === 'function'
      ? deps.inferGuidanceDiscoverySourceUsed
      : () => null;
  const resolveGuidanceSearchStepStrengthImpl =
    typeof deps.resolveGuidanceSearchStepStrength === 'function'
      ? deps.resolveGuidanceSearchStepStrength
      : (value) => value;
  const buildGuidanceSearchNormalizedIntentImpl =
    typeof deps.buildGuidanceSearchNormalizedIntent === 'function'
      ? deps.buildGuidanceSearchNormalizedIntent
      : () => null;
  const normalizeGuidanceDiscoveryProductPdpContractImpl =
    typeof deps.normalizeGuidanceDiscoveryProductPdpContract === 'function'
      ? deps.normalizeGuidanceDiscoveryProductPdpContract
      : (value) => value;
  const uiChatFindLatestScenarioSelectionImpl =
    typeof deps.uiChatFindLatestScenarioSelection === 'function'
      ? deps.uiChatFindLatestScenarioSelection
      : () => null;
  const uiChatFindLatestShoppingIntentImpl =
    typeof deps.uiChatFindLatestShoppingIntent === 'function'
      ? deps.uiChatFindLatestShoppingIntent
      : () => null;
  const buildGuidanceOnlyHitQualityDecisionImpl =
    typeof deps.buildGuidanceOnlyHitQualityDecision === 'function'
      ? deps.buildGuidanceOnlyHitQualityDecision
      : () => null;
  const normalizeAgentProductsListResponseImpl =
    typeof deps.normalizeAgentProductsListResponse === 'function'
      ? deps.normalizeAgentProductsListResponse
      : (value) => value;
  const applyFindProductsMultiPolicyIfNeededImpl =
    typeof deps.applyFindProductsMultiPolicyIfNeeded === 'function'
      ? deps.applyFindProductsMultiPolicyIfNeeded
      : ({ response }) => response;
  const applyDealsToResponseImpl =
    typeof deps.applyDealsToResponse === 'function'
      ? deps.applyDealsToResponse
      : (response) => response;
  const shouldAttemptCacheMissResolverFallbackImpl =
    typeof deps.shouldAttemptCacheMissResolverFallback === 'function'
      ? deps.shouldAttemptCacheMissResolverFallback
      : () => false;
  const buildCacheMissResolverFallbackRequestImpl =
    typeof deps.buildCacheMissResolverFallbackRequest === 'function'
      ? deps.buildCacheMissResolverFallbackRequest
      : () => null;
  const buildCacheMissResolverFallbackDiagnosedResponseImpl =
    typeof deps.buildCacheMissResolverFallbackDiagnosedResponse === 'function'
      ? deps.buildCacheMissResolverFallbackDiagnosedResponse
      : () => ({ response: null });
  const evaluateCacheQualityGateImpl =
    typeof deps.evaluateCacheQualityGate === 'function'
      ? deps.evaluateCacheQualityGate
      : () => ({
          enabled: false,
          accepted: true,
          reason: null,
        });
  const getSearchCacheMinAnchor =
    typeof deps.searchCacheMinAnchor === 'function'
      ? deps.searchCacheMinAnchor
      : () => Number(deps.searchCacheMinAnchor || 0) || 0;
  const withSearchDiagnosticsImpl =
    typeof deps.withSearchDiagnostics === 'function'
      ? deps.withSearchDiagnostics
      : (response) => response;
  const buildSearchRouteHealthImpl =
    typeof deps.buildSearchRouteHealth === 'function'
      ? deps.buildSearchRouteHealth
      : (value) => value;
  const buildSearchTraceImpl =
    typeof deps.buildSearchTrace === 'function' ? deps.buildSearchTrace : (value) => value;
  const buildCacheStageSnapshotImpl =
    typeof deps.buildCacheStageSnapshot === 'function'
      ? deps.buildCacheStageSnapshot
      : (value) => value;
  const guidanceDecisionContractVersion =
    String(deps.guidanceDecisionContractVersion || '').trim() || null;

  function normalizePromptText(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  function summarizeAuroraConversationState(messages = []) {
    const list = Array.isArray(messages) ? messages : [];
    const userMessages = list.filter(
      (item) => String(item?.role || '').trim().toLowerCase() === 'user' && String(item?.content || '').trim(),
    );
    const latestUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;
    const latestUserText = String(latestUserMessage?.content || '').trim();
    const latestScenarioSelection = uiChatFindLatestScenarioSelectionImpl(list);
    const latestShoppingIntent = uiChatFindLatestShoppingIntentImpl(list);
    const latestScenarioText = normalizePromptText(latestScenarioSelection?.text || '');
    const latestUserNormalized = normalizePromptText(latestUserText);
    const scenarioSelectionChosen =
      Boolean(latestScenarioSelection?.option?.key) &&
      Boolean(latestUserNormalized) &&
      latestUserNormalized === latestScenarioText;

    let promptIntent = null;
    let conversationProgress = null;
    let earlyDecision = 'stay_in_layer';

    if (scenarioSelectionChosen) {
      promptIntent = 'scenario_selection';
      conversationProgress = 'scenario_selected';
      earlyDecision = 'resume_prior_goal';
    } else if (userMessages.length > 1) {
      promptIntent = 'follow_up_refinement';
      conversationProgress = 'follow_up';
      earlyDecision = 'resume_prior_goal';
    } else if (userMessages.length === 1 || latestShoppingIntent?.text) {
      promptIntent = 'shopping_request';
      conversationProgress = 'new_request';
      earlyDecision = 'delegate_to_decisioning';
    }

    return {
      promptIntent,
      conversationProgress,
      earlyDecision,
      latestShoppingIntent: String(latestShoppingIntent?.text || '').trim() || null,
      latestScenario: String(latestScenarioSelection?.option?.key || '').trim() || null,
    };
  }

  function buildAuroraFindProductsMultiPlan({ source, operation = 'find_products_multi' } = {}) {
    const normalizedSource = normalizeAgentSourceImpl(source);
    const normalizedOperation = String(operation || '').trim();
    const auroraSource = isAuroraSourceImpl(source) || isAuroraSourceImpl(normalizedSource);
    const fallbackOverrides = getAuroraFallbackOverridesImpl(source, normalizedOperation);
    const active =
      Boolean(fallbackOverrides?.active) &&
      auroraSource &&
      normalizedOperation === 'find_products_multi';

    return {
      source: normalizedSource || null,
      auroraSource,
      operation: normalizedOperation || null,
      fallbackOverrides: {
        active,
        strategySource: String(fallbackOverrides?.strategySource || (active ? 'aurora_force_path' : 'default')),
        disableSkipAfterResolverMiss: Boolean(fallbackOverrides?.disableSkipAfterResolverMiss),
        forceSecondaryFallback: Boolean(fallbackOverrides?.forceSecondaryFallback),
        forceInvokeFallback: Boolean(fallbackOverrides?.forceInvokeFallback),
      },
      resolverTimeoutMs: active ? getAuroraResolverTimeoutMs() : getDefaultResolverTimeoutMs(),
      bypassCacheStrictEmpty:
        auroraSource &&
        normalizedOperation === 'find_products_multi' &&
        getAuroraBypassCacheStrictEmptyEnabled(),
    };
  }

  function buildGuidanceOnlyClarificationPlan({
    uiSurface,
    clarification,
    reasonCodes,
    querySource,
  } = {}) {
    const normalizedUiSurface = normalizeSearchUiSurfaceImpl(uiSurface);
    const normalizedReasonCodes = Array.isArray(reasonCodes)
      ? reasonCodes.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const legacyFallbackSource = new Set([
      'agent_products_error_fallback',
      'agent_products_recall_clarify',
      'agent_products_semantic_retry_exhausted',
    ]).has(String(querySource || '').trim());
    const suppressLegacyClarification =
      normalizedUiSurface === 'ingredient_plan_guidance_only' &&
      (Boolean(clarification?.question) ||
        normalizedReasonCodes.includes('AMBIGUITY_CLARIFY') ||
        legacyFallbackSource);

    return {
      uiSurface: normalizedUiSurface || null,
      guidanceOnlySurface: normalizedUiSurface === 'ingredient_plan_guidance_only',
      suppressLegacyClarification,
      filteredReasonCodes: suppressLegacyClarification
        ? normalizedReasonCodes.filter((code) => code !== 'AMBIGUITY_CLARIFY')
        : normalizedReasonCodes,
      legacyFallbackSuppressed: suppressLegacyClarification && legacyFallbackSource,
    };
  }

  function buildGuidanceOnlySearchStatePlan({
    uiSurface,
    requestedTargetStepFamily,
    clarification,
    reasonCodes,
    querySource,
  } = {}) {
    const clarificationPlan = buildGuidanceOnlyClarificationPlan({
      uiSurface,
      clarification,
      reasonCodes,
      querySource,
    });
    const shouldApplyGuidanceOnlyHitQuality =
      clarificationPlan.guidanceOnlySurface && Boolean(requestedTargetStepFamily);

    return {
      uiSurface: clarificationPlan.uiSurface,
      guidanceOnlySurface: clarificationPlan.guidanceOnlySurface,
      shouldApplyGuidanceOnlyHitQuality,
      shouldLoadSessionSeenProducts: shouldApplyGuidanceOnlyHitQuality,
      shouldPersistSeenProducts: clarificationPlan.guidanceOnlySurface,
      clarificationPlan,
    };
  }

  function applyGuidanceOnlyHitQualityOutcome({
    response,
    guidancePlan,
    guidanceDecision,
    sourcePolicy,
    productOnlyApplied = false,
    serviceRowsFilteredCount = 0,
    discoverySourceUsed = null,
    queryIndex = null,
    queryExhausted = false,
  } = {}) {
    if (!guidanceDecision?.applied || !response || typeof response !== 'object' || Array.isArray(response)) {
      return response;
    }

    const clarificationPlan = guidancePlan?.clarificationPlan || buildGuidanceOnlyClarificationPlan({});
    const existingMeta =
      response.metadata && typeof response.metadata === 'object' && !Array.isArray(response.metadata)
        ? response.metadata
        : {};
    const existingSearchDecision =
      existingMeta.search_decision &&
      typeof existingMeta.search_decision === 'object' &&
      !Array.isArray(existingMeta.search_decision)
        ? existingMeta.search_decision
        : {};
    const existingSourceBreakdown =
      existingMeta.source_breakdown &&
      typeof existingMeta.source_breakdown === 'object' &&
      !Array.isArray(existingMeta.source_breakdown)
        ? existingMeta.source_breakdown
        : {};
    const products = Array.isArray(response.products) ? response.products : [];
    const validProducts = Array.isArray(guidanceDecision.valid_products)
      ? guidanceDecision.valid_products
      : [];
    const shouldReplaceProducts =
      guidanceDecision.hit_quality === 'valid_hit' && validProducts.length > 0;
    const nextProducts = shouldReplaceProducts ? validProducts : products;
    const nextExternalSeedCount = nextProducts.filter((product) =>
      isExternalSeedProductImpl(product),
    ).length;
    const nextInternalCount = Math.max(0, nextProducts.length - nextExternalSeedCount);
    const reasonCodes = Array.isArray(response.reason_codes) ? response.reason_codes : [];
    const candidateOriginCounts =
      guidanceDecision.candidate_origin_counts || countCandidateOriginBreakdownImpl(nextProducts);

    return {
      ...response,
      ...(shouldReplaceProducts
        ? {
            products: nextProducts,
            total: nextProducts.length,
            page_size: nextProducts.length,
          }
        : {}),
      ...(clarificationPlan.suppressLegacyClarification
        ? {
            clarification: null,
            reply: '',
            reason_codes: clarificationPlan.filteredReasonCodes,
          }
        : {}),
      metadata: {
        ...existingMeta,
        normalized_intent: guidanceDecision.normalized_intent || null,
        quality_gate_result: guidanceDecision.quality_gate_result || null,
        candidate_origin_counts: candidateOriginCounts,
        source_breakdown: {
          ...existingSourceBreakdown,
          internal_count: nextInternalCount,
          external_seed_count: nextExternalSeedCount,
          stale_cache_used:
            existingSourceBreakdown.stale_cache_used === true,
        },
        external_seed_returned_count: nextExternalSeedCount,
        guidance_direct_external_seed_applied:
          shouldReplaceProducts && nextExternalSeedCount <= 0
            ? false
            : existingMeta.guidance_direct_external_seed_applied,
        guidance_direct_external_seed_valid_hit:
          shouldReplaceProducts && nextExternalSeedCount <= 0
            ? false
            : existingMeta.guidance_direct_external_seed_valid_hit,
        displayable_candidate_count: guidanceDecision.displayable_candidate_count,
        fill_target_count: guidanceDecision.fill_target_count,
        fill_completed_count: guidanceDecision.fill_completed_count,
        valid_scoping_dropped_count: guidanceDecision.valid_scoping_dropped_count,
        dedupe_dropped_count: guidanceDecision.dedupe_dropped_count,
        selection_diversity: guidanceDecision.selection_diversity || null,
        stable_prior_applied: guidanceDecision.stable_prior_applied === true,
        stable_prior_source: guidanceDecision.stable_prior_source || null,
        fallback_mode: guidanceDecision.fallback_mode || 'normal',
        diversity_exception_applied: guidanceDecision.diversity_exception_applied === true,
        coverage_limited_after_fill: guidanceDecision.coverage_limited_after_fill === true,
        surface_reason: guidanceDecision.surface_reason || null,
        ...(clarificationPlan.suppressLegacyClarification
          ? {
              clarification_suppressed: true,
              legacy_fallback_suppressed: clarificationPlan.legacyFallbackSuppressed,
            }
          : {}),
        search_decision: {
          ...existingSearchDecision,
          contract_version: guidanceDecision.contract_version || existingSearchDecision.contract_version || null,
          hit_quality: guidanceDecision.hit_quality,
          invalid_hit_reason: guidanceDecision.invalid_hit_reason,
          query_bucket: guidanceDecision.query_bucket,
          query_target_step_family: guidanceDecision.query_target_step_family,
          topk_bucket_mix: guidanceDecision.topk_bucket_mix,
          same_family_topk_count: guidanceDecision.same_family_topk_count,
          exact_step_topk_count: guidanceDecision.exact_step_topk_count,
          strong_goal_family_topk_count: guidanceDecision.strong_goal_family_topk_count,
          supportive_same_family_topk_count: guidanceDecision.supportive_same_family_topk_count,
          query_step_strength: guidanceDecision.query_step_strength,
          decision_mode: 'guidance_only',
          source_policy: sourcePolicy || null,
          normalized_intent: guidanceDecision.normalized_intent || null,
          step_success_class: guidanceDecision.step_success_class || null,
          success_contract_result: guidanceDecision.success_contract_result || null,
          quality_gate_result: guidanceDecision.quality_gate_result || null,
          candidate_origin_counts: candidateOriginCounts,
          candidate_class_counts: mergeSearchCountMapsImpl(
            existingSearchDecision.candidate_class_counts,
            guidanceDecision.candidate_class_counts,
          ),
          target_relevance_class_counts: mergeSearchCountMapsImpl(
            existingSearchDecision.target_relevance_class_counts,
            guidanceDecision.target_relevance_class_counts,
          ),
          noise_drop_counts: mergeSearchCountMapsImpl(
            existingSearchDecision.noise_drop_counts,
            guidanceDecision.noise_drop_counts,
          ),
          raw_result_count: guidanceDecision.raw_result_count,
          displayable_candidate_count: guidanceDecision.displayable_candidate_count,
          fill_target_count: guidanceDecision.fill_target_count,
          fill_completed_count: guidanceDecision.fill_completed_count,
          valid_scoping_dropped_count: guidanceDecision.valid_scoping_dropped_count,
          dedupe_dropped_count: guidanceDecision.dedupe_dropped_count,
          selection_diversity: guidanceDecision.selection_diversity || null,
          stable_prior_applied: guidanceDecision.stable_prior_applied === true,
          stable_prior_source: guidanceDecision.stable_prior_source || null,
          fallback_mode: guidanceDecision.fallback_mode || 'normal',
          diversity_exception_applied: guidanceDecision.diversity_exception_applied === true,
          coverage_limited_after_fill: guidanceDecision.coverage_limited_after_fill === true,
          surface_reason: guidanceDecision.surface_reason || null,
          products_returned_count: guidanceDecision.products_returned_count,
          product_only_applied: productOnlyApplied === true,
          service_rows_filtered_count: Math.max(0, Number(serviceRowsFilteredCount || 0) || 0),
          discovery_source_used: String(discoverySourceUsed || '').trim() || null,
          query_index: queryIndex,
          query_exhausted: queryExhausted === true,
          clarification_suppressed: clarificationPlan.suppressLegacyClarification,
          legacy_fallback_suppressed: clarificationPlan.legacyFallbackSuppressed,
        },
      },
      ...(clarificationPlan.suppressLegacyClarification
        ? {
            reason_codes: clarificationPlan.filteredReasonCodes,
          }
        : Array.isArray(reasonCodes)
          ? { reason_codes: reasonCodes }
          : {}),
    };
  }

  async function buildGuidanceOnlyCacheSearchPlan({
    uiSurface,
    requestedTargetStepFamily,
    requestedQueryStepStrength,
    queryText,
    req,
    query,
    metadata,
    products,
  } = {}) {
    const guidancePlan = buildGuidanceOnlySearchStatePlan({
      uiSurface,
      requestedTargetStepFamily,
      clarification: null,
      reasonCodes: [],
      querySource: metadata?.query_source,
    });
    const guidanceOnlyDiscovery = guidancePlan.guidanceOnlySurface;
    const guidanceTargetStepFamily = normalizeRecoTargetStepImpl(requestedTargetStepFamily);
    const guidanceQueryText = String(queryText || '').trim();
    const guidanceQueryStepStrength = guidanceOnlyDiscovery
      ? resolveGuidanceSearchStepStrengthImpl(
          requestedQueryStepStrength,
          guidanceQueryText,
          guidanceTargetStepFamily,
        )
      : null;
    const guidanceNormalizedIntent =
      guidanceOnlyDiscovery && guidanceQueryText
        ? buildGuidanceSearchNormalizedIntentImpl({
            queryText: guidanceQueryText,
            targetStepFamily: guidanceTargetStepFamily,
            uiSurface: guidancePlan.uiSurface,
            decisionMode: 'guidance_only',
            queryStepStrength: guidanceQueryStepStrength,
          })
        : null;
    const sessionState = await loadGuidanceOnlySessionState({
      guidancePlan,
      req,
      query,
      metadata,
    });

    const sourceProducts = Array.isArray(products) ? products : [];
    let internalGuidanceHitDecision = null;
    let guidanceNeedsPrimaryFillSupplement = false;
    let baselineProducts = sourceProducts;

    if (
      guidancePlan.shouldApplyGuidanceOnlyHitQuality &&
      guidanceTargetStepFamily &&
      sourceProducts.length > 0
    ) {
      internalGuidanceHitDecision = buildGuidanceOnlyHitQualityDecisionImpl({
        queryText: guidanceQueryText,
        products: sourceProducts,
        queryTargetStepFamily: guidanceTargetStepFamily,
        guidanceOnlyDiscovery: true,
        queryStepStrength: guidanceQueryStepStrength,
        mode: 'guidance_only',
        sessionSeenProductIds: sessionState.sessionSeenProductIds,
      });
      const guidanceValidKeys = new Set(
        (Array.isArray(internalGuidanceHitDecision?.valid_products)
          ? internalGuidanceHitDecision.valid_products
          : []
        )
          .map((product) => buildSearchDecisionProductKeyImpl(product))
          .filter(Boolean),
      );
      baselineProducts =
        internalGuidanceHitDecision?.applied &&
        internalGuidanceHitDecision?.hit_quality === 'valid_hit'
          ? sourceProducts.filter((product) =>
              guidanceValidKeys.has(buildSearchDecisionProductKeyImpl(product)),
            )
          : [];
      guidanceNeedsPrimaryFillSupplement =
        !internalGuidanceHitDecision?.applied ||
        internalGuidanceHitDecision?.hit_quality !== 'valid_hit' ||
        Number(internalGuidanceHitDecision?.same_family_topk_count || 0) <= 0 ||
        baselineProducts.length <= 0;
    }

    return {
      guidancePlan,
      guidanceOnlyDiscovery,
      guidanceTargetStepFamily,
      guidanceQueryStepStrength,
      guidanceNormalizedIntent,
      sessionState,
      internalGuidanceHitDecision,
      guidanceNeedsPrimaryFillSupplement,
      baselineProducts,
    };
  }

  function buildGuidanceOnlyDirectSupplementPlan({
    guidanceOnlyDiscovery = false,
    requestedAllowExternalSeed = false,
    requestedTargetStepFamily = null,
    queryText = '',
    upstreamData = null,
    requestedLimit = 20,
  } = {}) {
    const normalizedQuery = String(queryText || '').trim();
    const normalizedTargetStepFamily =
      requestedTargetStepFamily == null ? null : String(requestedTargetStepFamily || '').trim() || null;
    const existingMeta =
      upstreamData?.metadata &&
      typeof upstreamData.metadata === 'object' &&
      !Array.isArray(upstreamData.metadata)
        ? upstreamData.metadata
        : {};
    const existingSearchDecision =
      existingMeta.search_decision &&
      typeof existingMeta.search_decision === 'object' &&
      !Array.isArray(existingMeta.search_decision)
        ? existingMeta.search_decision
        : {};
    const existingRouteDebug =
      existingMeta.route_debug &&
      typeof existingMeta.route_debug === 'object' &&
      !Array.isArray(existingMeta.route_debug)
        ? existingMeta.route_debug
        : {};
    const existingCrossMerchantCache =
      existingRouteDebug.cross_merchant_cache &&
      typeof existingRouteDebug.cross_merchant_cache === 'object' &&
      !Array.isArray(existingRouteDebug.cross_merchant_cache)
        ? existingRouteDebug.cross_merchant_cache
        : {};
    const primaryProductsBeforeGuidance = Array.isArray(upstreamData?.products) ? upstreamData.products : [];
    const primaryHasExternalSeedBeforeGuidance = primaryProductsBeforeGuidance.some((product) =>
      isExternalSeedProductImpl(product),
    );
    const primaryHasValidGuidanceHit =
      existingSearchDecision.hit_quality === 'valid_hit' &&
      Number(existingSearchDecision.same_family_topk_count || 0) > 0 &&
      primaryProductsBeforeGuidance.length > 0;
    const primaryHasCacheReturnedGuidanceFastpath =
      String(existingMeta.query_source || '').trim() === 'agent_products_guidance_fastpath' &&
      String(existingMeta.final_decision || '').trim() === 'cache_returned' &&
      existingCrossMerchantCache.guidance_hit_quality === 'valid_hit' &&
      Number(existingCrossMerchantCache.internal_products_relevant_count || 0) > 0 &&
      Number(existingCrossMerchantCache.guidance_scoped_internal_products_count || 0) > 0;
    const primaryHasLockedGuidanceMainPath =
      existingCrossMerchantCache.main_path_contract_locked === true ||
      existingMeta.main_path_contract_locked === true;
    const shouldAttemptDirectSupplement =
      Boolean(guidanceOnlyDiscovery) &&
      requestedAllowExternalSeed === true &&
      Boolean(normalizedTargetStepFamily) &&
      normalizedQuery.length > 0 &&
      !primaryHasLockedGuidanceMainPath &&
      !primaryHasCacheReturnedGuidanceFastpath &&
      (!primaryHasValidGuidanceHit ||
        (!primaryHasExternalSeedBeforeGuidance &&
          primaryProductsBeforeGuidance.length < Math.max(1, Number(requestedLimit || 20) || 20)));

    return {
      shouldAttemptDirectSupplement,
      existingMeta,
      existingSearchDecision,
      primaryProductsBeforeGuidance,
      primaryHasExternalSeedBeforeGuidance,
      primaryHasValidGuidanceHit,
      primaryHasLockedGuidanceMainPath,
      primaryHasCacheReturnedGuidanceFastpath,
    };
  }

  function buildGuidanceOnlyDirectSupplementOutcome({
    upstreamData,
    directSupplement,
    existingMeta = {},
    primaryHasValidGuidanceHit = false,
    primaryProductsBeforeGuidance = [],
    requestedLimit = 20,
    queryLimit,
    queryOffset,
  } = {}) {
    const directProducts = Array.isArray(directSupplement?.products) ? directSupplement.products : [];
    const directSearchDecision =
      directSupplement?.metadata?.search_decision &&
      typeof directSupplement.metadata.search_decision === 'object' &&
      !Array.isArray(directSupplement.metadata.search_decision)
        ? directSupplement.metadata.search_decision
        : {};
    const directValidHit =
      directSearchDecision.hit_quality === 'valid_hit' && directProducts.length > 0;

    if (!directValidHit) {
      return {
        applied: false,
        directValidHit: false,
        response: upstreamData,
      };
    }

    const mergedProducts = [];
    const seen = new Set();
    const appendProducts = (products) => {
      for (const product of products) {
        const key = buildSearchProductKeyImpl(product);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        mergedProducts.push(product);
        if (mergedProducts.length >= Math.max(1, Number(requestedLimit || 20) || 20)) break;
      }
    };
    if (primaryHasValidGuidanceHit) {
      appendProducts(primaryProductsBeforeGuidance);
    }
    appendProducts(directProducts);
    const mergedExternalCount = mergedProducts.filter((product) => isExternalSeedProductImpl(product)).length;
    const mergedInternalCount = Math.max(0, mergedProducts.length - mergedExternalCount);

    return {
      applied: true,
      directValidHit: true,
      response: normalizeAgentProductsListResponseImpl(
        {
          ...(upstreamData && typeof upstreamData === 'object' && !Array.isArray(upstreamData)
            ? upstreamData
            : {}),
          products: mergedProducts,
          total: Math.max(
            mergedProducts.length,
            Number(upstreamData?.total || 0) || 0,
            Number(directSupplement?.total || 0) || 0,
          ),
          metadata: {
            ...existingMeta,
            query_source: primaryHasValidGuidanceHit
              ? 'agent_products_search_guidance_supplemented'
              : 'agent_products_guidance_external_seed_supplemented',
            guidance_direct_external_seed_applied: true,
            guidance_direct_external_seed_valid_hit: true,
            source_breakdown: {
              ...(existingMeta.source_breakdown && typeof existingMeta.source_breakdown === 'object'
                ? existingMeta.source_breakdown
                : {}),
              internal_count: mergedInternalCount,
              external_seed_count: mergedExternalCount,
              stale_cache_used: false,
              strategy_applied: 'guidance_direct_external_seed_supplement',
            },
            external_seed_executed: true,
            external_seed_rows_fetched: Number(
              directSupplement?.metadata?.external_seed_rows_fetched || directProducts.length,
            ) || 0,
            external_seed_rows_built: Number(
              directSupplement?.metadata?.external_seed_rows_built || directProducts.length,
            ) || 0,
            external_seed_returned_count: mergedExternalCount,
            search_stage_b: {
              attempted: true,
              applied: true,
              added_count: mergedExternalCount,
              reason: primaryHasValidGuidanceHit
                ? 'guidance_direct_external_seed_supplemented'
                : 'guidance_direct_external_seed_replaced',
            },
            supplement_attempted: true,
            supplement_skip_reason: null,
          },
        },
        {
          limit: queryLimit,
          offset: queryOffset,
        },
      ),
    };
  }

  function buildGuidanceOnlyCacheSupplementPlan({
    source,
    page,
    queryText,
    effectiveIntent,
    baselineProducts,
    internalGuidanceHitDecision,
    rawInternalProductsCount,
    safeResultLimit,
    guidanceTargetStepFamily,
    guidanceNormalizedIntent,
    guidanceNeedsPrimaryFillSupplement = false,
    cachePolicyQueryClass,
    ambiguityScorePre,
    isLookupQuery = false,
    preferInternalSpecificBeautyCache = false,
    cacheBeautyBucket = null,
  } = {}) {
    const normalizedBaselineProducts = Array.isArray(baselineProducts) ? baselineProducts : [];
    const normalizedInternalGuidanceHitDecision =
      internalGuidanceHitDecision &&
      typeof internalGuidanceHitDecision === 'object' &&
      !Array.isArray(internalGuidanceHitDecision)
        ? internalGuidanceHitDecision
        : {};
    const normalizedSafeResultLimit = Math.max(1, Number(safeResultLimit || 20) || 20);
    const normalizedPage = Number(page);
    const normalizedQueryText = String(queryText || '').trim();
    const guidanceSuccessContractSatisfied =
      normalizedInternalGuidanceHitDecision.applied === true &&
      normalizedInternalGuidanceHitDecision.hit_quality === 'valid_hit' &&
      normalizedInternalGuidanceHitDecision.success_contract_result &&
      typeof normalizedInternalGuidanceHitDecision.success_contract_result === 'object' &&
      !Array.isArray(normalizedInternalGuidanceHitDecision.success_contract_result) &&
      normalizedInternalGuidanceHitDecision.success_contract_result.satisfied === true &&
      normalizedBaselineProducts.length > 0;
    const guidanceFillTargetCount =
      guidanceNormalizedIntent?.backbone_id && guidanceTargetStepFamily === 'serum'
        ? Math.min(3, normalizedSafeResultLimit)
        : normalizedSafeResultLimit;
    const needsPrimaryFillSupplement =
      !guidanceSuccessContractSatisfied &&
      (guidanceNeedsPrimaryFillSupplement || normalizedBaselineProducts.length < guidanceFillTargetCount);
    const shouldSkipExternalSupplementForPetHarness =
      hasPetHarnessSearchSignalImpl(normalizedQueryText) && normalizedBaselineProducts.length >= 3;
    const needsBeautyDiversitySupplement =
      !(getSearchExternalHardRulePrune() && hasFragranceSearchSignalImpl(normalizedQueryText)) &&
      isCatalogGuardSourceImpl(source) &&
      normalizedPage === 1 &&
      isBeautyGeneralDiversitySupplementCandidateImpl(
        effectiveIntent,
        normalizedBaselineProducts,
        normalizedSafeResultLimit,
        {
          rawQuery: normalizedQueryText,
          queryClass: cachePolicyQueryClass,
        },
      );

    const basePlan = {
      guidanceFillTargetCount,
      needsPrimaryFillSupplement,
      needsBeautyDiversitySupplement,
      shouldAttemptSupplement: false,
      neededCount: 0,
      supplementMeta: {
        attempted: false,
        applied: false,
        added_count: 0,
        reason: 'not_needed',
      },
    };

    if (guidanceSuccessContractSatisfied) {
      return {
        ...basePlan,
        supplementMeta: {
          attempted: false,
          applied: false,
          added_count: 0,
          reason: 'guidance_contract_satisfied',
          gate: {
            internal_count: normalizedBaselineProducts.length,
            raw_internal_count: Math.max(
              0,
              Number(rawInternalProductsCount || normalizedBaselineProducts.length) || 0,
            ),
            step_success_class:
              String(normalizedInternalGuidanceHitDecision.step_success_class || '').trim() || null,
            success_contract_satisfied: true,
            beauty_diversity_targeted: needsBeautyDiversitySupplement,
          },
        },
      };
    }

    if (
      !isCatalogGuardSourceImpl(source) ||
      normalizedPage !== 1 ||
      (!needsPrimaryFillSupplement && !needsBeautyDiversitySupplement)
    ) {
      return basePlan;
    }

    const neededCount = needsPrimaryFillSupplement
      ? Math.max(0, guidanceFillTargetCount - normalizedBaselineProducts.length)
      : Math.max(1, Math.ceil(normalizedSafeResultLimit / 2));
    if (neededCount <= 0) {
      return {
        ...basePlan,
        neededCount,
      };
    }

    const confidenceOverall = Number(effectiveIntent?.confidence?.overall || 0) || 0;
    const normalizedAmbiguityScorePre = Number(ambiguityScorePre || 0) || 0;
    const externalFillMinInternal = Math.min(3, normalizedSafeResultLimit);
    const externalFillGateWouldBlock =
      getSearchExternalFillGated() &&
      !(
        normalizedBaselineProducts.length >= externalFillMinInternal &&
        (confidenceOverall >= 0.7 || isLookupQuery) &&
        normalizedAmbiguityScorePre <= 0.45
      );
    const canApplyExternalFillGate =
      guidanceNeedsPrimaryFillSupplement
        ? true
        : getSearchExternalHardRulePrune()
          ? true
          : !externalFillGateWouldBlock;

    if (shouldSkipExternalSupplementForPetHarness) {
      return {
        ...basePlan,
        neededCount,
        supplementMeta: {
          attempted: false,
          applied: false,
          added_count: 0,
          reason: 'pet_harness_internal_sufficient',
          gate: {
            internal_count: normalizedBaselineProducts.length,
            raw_internal_count: Math.max(
              0,
              Number(rawInternalProductsCount || normalizedBaselineProducts.length) || 0,
            ),
            min_internal_required: 3,
          },
        },
      };
    }

    if (preferInternalSpecificBeautyCache) {
      return {
        ...basePlan,
        neededCount,
        supplementMeta: {
          attempted: false,
          applied: false,
          added_count: 0,
          reason: 'specific_beauty_internal_preferred',
          gate: {
            beauty_bucket: String(cacheBeautyBucket || '').trim() || null,
            internal_count: Math.max(
              0,
              Number(rawInternalProductsCount || normalizedBaselineProducts.length) || 0,
            ),
          },
        },
      };
    }

    if (!canApplyExternalFillGate) {
      return {
        ...basePlan,
        neededCount,
        supplementMeta: {
          attempted: false,
          applied: false,
          added_count: 0,
          reason: 'external_fill_gate_blocked',
          gate: {
            enabled: getSearchExternalFillGated(),
            min_internal_required: externalFillMinInternal,
            internal_count: normalizedBaselineProducts.length,
            raw_internal_count: Math.max(
              0,
              Number(rawInternalProductsCount || normalizedBaselineProducts.length) || 0,
            ),
            overall_confidence: confidenceOverall,
            ambiguity_score_pre: normalizedAmbiguityScorePre,
            lookup_query_bypass: Boolean(isLookupQuery),
          },
        },
      };
    }

    return {
      guidanceFillTargetCount,
      needsPrimaryFillSupplement,
      needsBeautyDiversitySupplement,
      shouldAttemptSupplement: true,
      neededCount,
      supplementMeta: {
        attempted: true,
        applied: false,
        added_count: 0,
        reason:
          externalFillGateWouldBlock && getSearchExternalHardRulePrune()
            ? 'external_fill_gate_soft_bypassed'
            : 'supplement_pending',
        diversity_targeted: needsBeautyDiversitySupplement,
        gate: {
          enabled: getSearchExternalFillGated(),
          soft_bypassed: Boolean(
            externalFillGateWouldBlock && getSearchExternalHardRulePrune(),
          ),
          min_internal_required: externalFillMinInternal,
          internal_count: normalizedBaselineProducts.length,
          raw_internal_count: Math.max(
            0,
            Number(rawInternalProductsCount || normalizedBaselineProducts.length) || 0,
          ),
          overall_confidence: confidenceOverall,
          ambiguity_score_pre: normalizedAmbiguityScorePre,
          lookup_query_bypass: Boolean(isLookupQuery),
          guidance_fill_bypassed: guidanceNeedsPrimaryFillSupplement,
        },
      },
    };
  }

  function buildGuidanceOnlyCacheSupplementRequest({
    activeCacheSearchQueryText,
    search,
    metadata,
    guidanceSessionId,
    inStockOnly,
  } = {}) {
    const normalizedSearch =
      search && typeof search === 'object' && !Array.isArray(search) ? search : {};
    const normalizedMeta =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};

    return {
      query: String(activeCacheSearchQueryText || '').trim(),
      ...(normalizedSearch.catalog_surface
        ? { catalog_surface: normalizedSearch.catalog_surface }
        : {}),
      ...(normalizedMeta.ui_surface ? { ui_surface: normalizedMeta.ui_surface } : {}),
      ...(normalizedMeta.product_only_requested !== undefined
        ? { product_only: normalizedMeta.product_only_requested }
        : {}),
      ...(normalizedMeta.query_index !== undefined
        ? { query_index: normalizedMeta.query_index }
        : {}),
      ...(normalizedMeta.query_total !== undefined
        ? { query_total: normalizedMeta.query_total }
        : {}),
      ...(normalizedMeta.query_target_step_family
        ? { target_step_family: normalizedMeta.query_target_step_family }
        : {}),
      ...(normalizedMeta.query_step_strength
        ? { query_step_strength: normalizedMeta.query_step_strength }
        : {}),
      ...(normalizedMeta.decision_mode
        ? { decision_mode: normalizedMeta.decision_mode }
        : {}),
      ...(normalizedMeta.source_policy
        ? { source_policy: normalizedMeta.source_policy }
        : {}),
      ...(guidanceSessionId ? { session_id: guidanceSessionId } : {}),
      ...(normalizedSearch.category ? { category: normalizedSearch.category } : {}),
      ...(normalizedSearch.price_min != null || normalizedSearch.min_price != null
        ? { min_price: normalizedSearch.price_min ?? normalizedSearch.min_price }
        : {}),
      ...(normalizedSearch.price_max != null || normalizedSearch.max_price != null
        ? { max_price: normalizedSearch.price_max ?? normalizedSearch.max_price }
        : {}),
      in_stock_only: inStockOnly,
    };
  }

  function buildGuidanceOnlyCacheSupplementOutcome({
    supplement,
    toAppend,
    needsBeautyDiversitySupplement = false,
  } = {}) {
    const normalizedAppend = Array.isArray(toAppend) ? toAppend : [];
    const existingMeta =
      supplement?.metadata &&
      typeof supplement.metadata === 'object' &&
      !Array.isArray(supplement.metadata)
        ? supplement.metadata
        : {};

    return {
      ...existingMeta,
      attempted: true,
      applied: normalizedAppend.length > 0,
      added_count: normalizedAppend.length,
      reason:
        normalizedAppend.length > 0
          ? needsBeautyDiversitySupplement
            ? 'supplemented_external_seed_diversity'
            : 'supplemented_external_seed'
          : needsBeautyDiversitySupplement && !getSearchExternalHardRulePrune()
            ? 'no_external_candidates_for_diversity'
            : 'no_external_candidates',
      diversity_targeted: needsBeautyDiversitySupplement,
    };
  }

  function buildGuidanceOnlyCacheSupplementErrorOutcome({
    error,
    needsBeautyDiversitySupplement = false,
  } = {}) {
    return {
      attempted: true,
      applied: false,
      added_count: 0,
      reason: 'supplement_error',
      error: String(error && error.message ? error.message : error),
      diversity_targeted: needsBeautyDiversitySupplement,
    };
  }

  function buildGuidanceOnlyCacheSupplementSelection({
    baselineProducts,
    supplementProducts,
    neededCount,
    needsBeautyDiversitySupplement = false,
    safeResultLimit,
    queryText,
    normalizedLookupQuery,
    lookupAnchorTokens,
    lookupQueryTokens,
    guidanceTargetStepFamily,
    uiSurface,
    guidanceQueryStepStrength,
  } = {}) {
    const normalizedBaselineProducts = Array.isArray(baselineProducts) ? baselineProducts : [];
    const normalizedSupplementProducts = Array.isArray(supplementProducts) ? supplementProducts : [];
    const normalizedNeededCount = Math.max(0, Number(neededCount || 0) || 0);
    const normalizedSafeResultLimit = Math.max(1, Number(safeResultLimit || 20) || 20);
    const seen = new Set(
      normalizedBaselineProducts
        .map((product) => buildSearchProductKeyImpl(product))
        .filter(Boolean),
    );
    const toAppend = [];

    for (const product of normalizedSupplementProducts) {
      if (!isExternalSeedProductImpl(product)) continue;
      if (
        !isSupplementCandidateRelevantImpl(product, queryText, {
          normalizedQuery: normalizedLookupQuery,
          anchorTokens: lookupAnchorTokens,
          queryTokens: lookupQueryTokens,
          targetStepFamily: guidanceTargetStepFamily,
          uiSurface,
          queryStepStrength: guidanceQueryStepStrength,
        })
      ) {
        continue;
      }
      const key = buildSearchProductKeyImpl(product);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      toAppend.push(product);
      if (toAppend.length >= normalizedNeededCount) break;
    }

    const supplementedProducts =
      needsBeautyDiversitySupplement && normalizedBaselineProducts.length >= normalizedSafeResultLimit
        ? blendBeautyDiversitySupplementImpl(
            normalizedBaselineProducts,
            toAppend,
            normalizedSafeResultLimit,
          )
        : normalizedBaselineProducts.concat(toAppend);

    return {
      supplementedProducts,
      toAppend,
      addedCount: toAppend.length,
      applied: toAppend.length > 0,
    };
  }

  function buildGuidanceOnlyCacheResponseArtifacts({
    source,
    search,
    payload,
    metadata,
    cacheQueryText,
    activeCacheSearchQueryText,
    cacheQueryMode,
    queryText,
    cacheStageStartedAt,
    cacheStageBudgetMs,
    page,
    limit,
    inStockOnly,
    effectiveProducts,
    internalProducts,
    internalProductsAfterAnchor,
    baselineInternalProducts,
    internalGuidanceHitDecision,
    guidanceTargetStepFamily,
    leashAnchoredQuery = false,
    cacheRelevant = true,
    relaxCacheRelevanceGate = false,
    fromCache,
    cacheBeautyQueryProfile,
    supplementMeta,
    routeDebugEnabled = false,
  } = {}) {
    const normalizedEffectiveProducts = Array.isArray(effectiveProducts) ? effectiveProducts : [];
    const normalizedInternalProducts = Array.isArray(internalProducts) ? internalProducts : [];
    const normalizedRelevantInternalProducts = Array.isArray(internalProductsAfterAnchor)
      ? internalProductsAfterAnchor
      : [];
    const normalizedBaselineInternalProducts = Array.isArray(baselineInternalProducts)
      ? baselineInternalProducts
      : [];
    const normalizedMeta =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const normalizedSearch =
      search && typeof search === 'object' && !Array.isArray(search) ? search : {};
    const normalizedPayload =
      payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const normalizedFromCache =
      fromCache && typeof fromCache === 'object' && !Array.isArray(fromCache) ? fromCache : {};
    const normalizedSeedStrategyForCache = normalizeExternalSeedStrategyImpl(
      firstQueryParamValueImpl(
        normalizedSearch.external_seed_strategy ||
          normalizedSearch.externalSeedStrategy ||
          normalizedPayload?.search?.external_seed_strategy ||
          normalizedPayload?.search?.externalSeedStrategy,
      ) || (isCatalogGuardSourceImpl(source) ? 'unified_relevance' : 'legacy'),
      isCatalogGuardSourceImpl(source) ? 'unified_relevance' : 'legacy',
    );
    const unifiedRelevanceRequested = normalizedSeedStrategyForCache === 'unified_relevance';
    const externalCount = normalizedEffectiveProducts.filter((product) =>
      isExternalSeedProductImpl(product),
    ).length;
    const cacheRouteDebug = {
      attempted: true,
      mode: 'search',
      query: String(cacheQueryText || '').trim(),
      cache_query: String(activeCacheSearchQueryText || '').trim(),
      cache_query_mode: cacheQueryMode || null,
      cache_query_terms: Array.isArray(normalizedFromCache.query_terms)
        ? normalizedFromCache.query_terms
        : [],
      upstream_query: String(queryText || '').trim(),
      latency_ms: Math.max(0, Date.now() - Number(cacheStageStartedAt || Date.now())),
      timeout_budget_ms: cacheStageBudgetMs,
      page,
      limit,
      in_stock_only: inStockOnly,
      cache_hit:
        normalizedEffectiveProducts.length > 0 &&
        (!isShoppingSourceImpl(source) || cacheRelevant || relaxCacheRelevanceGate),
      cache_hit_base:
        normalizedEffectiveProducts.length > 0 &&
        (!isShoppingSourceImpl(source) || cacheRelevant || relaxCacheRelevanceGate),
      products_count: normalizedEffectiveProducts.length,
      internal_products_count: normalizedInternalProducts.length,
      internal_products_relevant_count: normalizedRelevantInternalProducts.length,
      guidance_scoped_internal_products_count: normalizedBaselineInternalProducts.length,
      guidance_hit_quality: internalGuidanceHitDecision?.hit_quality || null,
      guidance_same_family_topk_count: Number(
        internalGuidanceHitDecision?.same_family_topk_count || 0,
      ),
      guidance_query_target_step_family: guidanceTargetStepFamily || null,
      leash_anchor_applied: leashAnchoredQuery,
      external_products_count: externalCount,
      cache_relevant: cacheRelevant,
      cache_relevance_gate_relaxed: relaxCacheRelevanceGate,
      total: Number(normalizedFromCache.total || 0),
      retrieval_sources: normalizedFromCache.retrieval_sources || null,
      beauty_query_bucket:
        normalizedFromCache?.beauty_query_bucket || cacheBeautyQueryProfile?.bucket || null,
      internal_filtered_irrelevant_count: Number(
        normalizedFromCache?.internal_filter_debug?.filtered_irrelevant_count || 0,
      ),
      internal_bucket_mix_before: normalizedFromCache?.internal_filter_debug?.bucket_mix_before || null,
      internal_bucket_mix_after: normalizedFromCache?.internal_filter_debug?.bucket_mix_after || null,
      supplement: supplementMeta,
    };
    const merchantsReturned = uniqueStringsImpl(
      normalizedEffectiveProducts.map((product) => product?.merchant_id || product?.merchantId),
    );
    const upstreamData = {
      products: normalizedEffectiveProducts,
      total: Math.max(Number(normalizedFromCache.total || 0), normalizedEffectiveProducts.length),
      page: normalizedFromCache.page,
      page_size: normalizedEffectiveProducts.length,
      reply: null,
      metadata: {
        query_source: supplementMeta?.applied
          ? 'cache_cross_merchant_search_supplemented'
          : 'cache_cross_merchant_search',
        fetched_at: new Date().toISOString(),
        merchants_searched: merchantsReturned.length,
        source_breakdown: {
          internal_count: normalizedEffectiveProducts.length - externalCount,
          external_seed_count: externalCount,
          stale_cache_used: false,
          strategy_applied: isCatalogGuardSourceImpl(source)
            ? normalizedSeedStrategyForCache || 'legacy'
            : 'cache_only',
        },
        ...(normalizedFromCache.retrieval_sources
          ? { retrieval_sources: normalizedFromCache.retrieval_sources }
          : {}),
        ...(routeDebugEnabled
          ? {
              route_debug: {
                cross_merchant_cache: cacheRouteDebug,
              },
            }
          : {}),
      },
    };

    return {
      normalizedSeedStrategyForCache,
      unifiedRelevanceRequested,
      externalCount,
      merchantsReturned,
      cacheRouteDebug,
      upstreamData,
    };
  }

  function buildGuidanceOnlyCacheTransitionPlan({
    effectiveCacheHit,
    response,
    effectiveProducts,
    cacheQueryText,
    queryText,
    intent,
    traceQueryClass,
    cachePolicyQueryClass,
    cacheBrandLikeQuery = false,
    isLookupQuery = false,
    cacheRelevant = true,
    relaxCacheRelevanceGate = false,
    unifiedRelevanceRequested = false,
    externalCount = 0,
    source,
    hasMerchantScope = false,
    preferInternalSpecificBeautyCache = false,
    cacheBeautyQueryProfile,
    internalGuidanceHitDecision = null,
  } = {}) {
    const normalizedCacheQueryText = String(cacheQueryText || '').trim();
    const normalizedResponse =
      response && typeof response === 'object' && !Array.isArray(response) ? response : {};
    const withPolicyProducts = Array.isArray(normalizedResponse.products)
      ? normalizedResponse.products
      : [];
    const normalizedEffectiveProducts = Array.isArray(effectiveProducts) ? effectiveProducts : [];
    const cacheClarifyOnly =
      Boolean(normalizedResponse?.clarification?.question) && withPolicyProducts.length === 0;
    const cacheClarifyOnlyShouldUseEarlyDecision =
      cacheClarifyOnly &&
      ['mission', 'scenario', 'gift'].includes(cachePolicyQueryClass) &&
      !cacheBrandLikeQuery &&
      !isLookupQuery;
    const cacheIrrelevantShouldUseEarlyDecision =
      !cacheRelevant &&
      (withPolicyProducts.length > 0 || normalizedEffectiveProducts.length > 0) &&
      ['mission', 'scenario', 'gift'].includes(cachePolicyQueryClass);
    const cacheValidationQueryClass =
      traceQueryClass || intent?.query_class || (isLookupQuery && !cacheBrandLikeQuery ? 'lookup' : null);
    const cacheValidation = evaluateCacheQualityGateImpl({
      products: withPolicyProducts.length > 0 ? withPolicyProducts : normalizedEffectiveProducts,
      queryText: cacheQueryText,
      intent,
      queryClass: cacheValidationQueryClass,
    });
    const normalizedCacheValidation =
      cacheValidation && typeof cacheValidation === 'object' && !Array.isArray(cacheValidation)
        ? { ...cacheValidation }
        : {
            enabled: false,
            accepted: true,
            reason: null,
          };
    const lookupRelevantCacheMiss =
      normalizedCacheValidation.enabled &&
      isLookupQuery &&
      normalizedEffectiveProducts.length > 0 &&
      !cacheRelevant;
    if (lookupRelevantCacheMiss) {
      normalizedCacheValidation.accepted = false;
      normalizedCacheValidation.reason = 'anchor_below_threshold';
      normalizedCacheValidation.anchor_ratio = Math.min(
        Number(normalizedCacheValidation.anchor_ratio || 0) || 0,
        Math.max(0, getSearchCacheMinAnchor() - 0.01),
      );
    }
    const cacheRejectedLowQuality = Boolean(
      normalizedCacheValidation.enabled &&
        (!normalizedCacheValidation.accepted || lookupRelevantCacheMiss),
    );
    const guidanceSuccessContractSatisfied =
      internalGuidanceHitDecision?.applied === true &&
      internalGuidanceHitDecision?.hit_quality === 'valid_hit' &&
      Number(internalGuidanceHitDecision?.same_family_topk_count || 0) > 0 &&
      internalGuidanceHitDecision?.success_contract_result &&
      typeof internalGuidanceHitDecision.success_contract_result === 'object' &&
      !Array.isArray(internalGuidanceHitDecision.success_contract_result) &&
      internalGuidanceHitDecision.success_contract_result.satisfied === true &&
      normalizedEffectiveProducts.length > 0;
    const relaxedGuidanceSerumCacheHit =
      !isLookupQuery &&
      !cacheBrandLikeQuery &&
      String(cacheBeautyQueryProfile?.bucket || '').trim().toLowerCase() === 'skincare' &&
      /\bserum\b/i.test(normalizedCacheQueryText) &&
      normalizedEffectiveProducts.length > 0 &&
      !cacheRelevant &&
      Boolean(relaxCacheRelevanceGate) &&
      guidanceSuccessContractSatisfied &&
      !cacheRejectedLowQuality;
    const genericSkincareSerumCacheHit =
      !isLookupQuery &&
      !cacheBrandLikeQuery &&
      ['category', 'exploratory', ''].includes(String(cachePolicyQueryClass || '').trim()) &&
      String(cacheBeautyQueryProfile?.bucket || '').trim().toLowerCase() === 'skincare' &&
      /\bserum\b/i.test(normalizedCacheQueryText) &&
      normalizedEffectiveProducts.length > 0 &&
      (cacheRelevant || guidanceSuccessContractSatisfied) &&
      !cacheRejectedLowQuality;
    const protectedSkincareSerumCacheHit =
      genericSkincareSerumCacheHit || relaxedGuidanceSerumCacheHit;
    const mainPathContractLocked = protectedSkincareSerumCacheHit;
    const cacheMissingExternalForUnified =
      unifiedRelevanceRequested &&
      !isShoppingSourceImpl(source) &&
      !hasMerchantScope &&
      Boolean(cacheQueryText) &&
      Math.max(0, Number(externalCount || 0) || 0) <= 0 &&
      !isLookupQuery &&
      !preferInternalSpecificBeautyCache &&
      !mainPathContractLocked;
    const forceSearchFirstForExpandedQuery =
      Boolean(cacheQueryText) &&
      Boolean(queryText) &&
      String(cacheQueryText || '').trim() !== String(queryText || '').trim() &&
      !isLookupQuery &&
      !cacheBrandLikeQuery &&
      ['category', 'exploratory'].includes(cachePolicyQueryClass) &&
      !cacheBeautyQueryProfile?.isSpecificBeautyQuery &&
      !mainPathContractLocked;

    let nextEffectiveCacheHit = Boolean(effectiveCacheHit);
    if (!nextEffectiveCacheHit && protectedSkincareSerumCacheHit) {
      nextEffectiveCacheHit = true;
    }
    if (
      cacheRejectedLowQuality ||
      cacheClarifyOnlyShouldUseEarlyDecision ||
      cacheIrrelevantShouldUseEarlyDecision ||
      cacheMissingExternalForUnified ||
      forceSearchFirstForExpandedQuery
    ) {
      nextEffectiveCacheHit = false;
    }

    const cacheStrictEmptyBypassReason =
      cacheMissingExternalForUnified
        ? 'missing_external_for_unified'
        : cacheRejectedLowQuality
          ? 'cache_rejected_low_quality'
          : cacheBrandLikeQuery
            ? 'brand_query_search_first'
            : null;
    const bypassCacheStrictEmptyForUnified =
      Boolean(cacheStrictEmptyBypassReason) &&
      (unifiedRelevanceRequested || cacheBrandLikeQuery);

    return {
      effectiveCacheHit: nextEffectiveCacheHit,
      withPolicyProducts,
      cacheClarifyOnly,
      cacheClarifyOnlyShouldUseEarlyDecision,
      cacheIrrelevantShouldUseEarlyDecision,
      cacheValidation: normalizedCacheValidation,
      cacheRejectedLowQuality,
      mainPathContractLocked,
      cacheMissingExternalForUnified,
      cacheStrictEmptyBypassReason,
      forceSearchFirstForExpandedQuery,
      bypassCacheStrictEmptyForUnified,
    };
  }

  function applyGuidanceOnlyCacheRouteDebugOutcome(params = {}) {
    const {
      cacheRouteDebug,
      effectiveCacheHit,
      cacheValidation,
      cacheRejectedLowQuality,
      mainPathContractLocked,
      cacheMissingExternalForUnified,
      bypassCacheStrictEmptyForUnified,
      cacheStrictEmptyBypassReason,
      forceSearchFirstForExpandedQuery,
      cacheClarifyOnlyShouldUseEarlyDecision,
      cacheIrrelevantShouldUseEarlyDecision,
      earlyDecisionRouteDebugUpdate,
    } = params;
    if (!cacheRouteDebug || typeof cacheRouteDebug !== 'object' || Array.isArray(cacheRouteDebug)) {
      return cacheRouteDebug || null;
    }
    const next = cacheRouteDebug;
    const has = (key) => Object.prototype.hasOwnProperty.call(params, key);

    if (has('effectiveCacheHit')) next.cache_hit = Boolean(effectiveCacheHit);
    if (has('cacheValidation')) next.cache_validation = cacheValidation || null;
    if (has('cacheRejectedLowQuality')) {
      next.cache_rejected_low_quality = Boolean(cacheRejectedLowQuality);
    }
    if (has('mainPathContractLocked')) {
      next.main_path_contract_locked = Boolean(mainPathContractLocked);
    }
    if (has('cacheMissingExternalForUnified')) {
      next.cache_missing_external_for_unified = Boolean(cacheMissingExternalForUnified);
    }
    if (has('bypassCacheStrictEmptyForUnified')) {
      next.cache_strict_empty_bypassed = Boolean(bypassCacheStrictEmptyForUnified);
    }
    if (has('cacheStrictEmptyBypassReason')) {
      next.cache_strict_empty_bypass_reason = cacheStrictEmptyBypassReason || null;
    }
    if (has('forceSearchFirstForExpandedQuery')) {
      next.force_search_first_for_expanded_query = Boolean(forceSearchFirstForExpandedQuery);
    }
    if (has('cacheClarifyOnlyShouldUseEarlyDecision')) {
      next.cache_clarify_only_recast_as_early_decision = Boolean(
        cacheClarifyOnlyShouldUseEarlyDecision,
      );
    }
    if (has('cacheIrrelevantShouldUseEarlyDecision')) {
      next.cache_irrelevant_recast_as_early_decision = Boolean(
        cacheIrrelevantShouldUseEarlyDecision,
      );
    }
    if (has('earlyDecisionRouteDebugUpdate') && earlyDecisionRouteDebugUpdate) {
      next.early_decision = earlyDecisionRouteDebugUpdate;
    }

    return next;
  }

  function buildGuidanceOnlyCacheEarlyDecisionResponse({
    page,
    merchantsReturned,
    cacheRouteDebug,
    routeDebugEnabled = false,
    earlyDecisionCause = null,
    queryClassForEarlyDecision = null,
  } = {}) {
    const normalizedMerchantsReturned = Array.isArray(merchantsReturned)
      ? merchantsReturned.filter(Boolean)
      : [];
    const normalizedCacheRouteDebug =
      cacheRouteDebug && typeof cacheRouteDebug === 'object' && !Array.isArray(cacheRouteDebug)
        ? cacheRouteDebug
        : null;

    return {
      products: [],
      total: 0,
      page,
      page_size: 0,
      reply: null,
      metadata: {
        query_source: 'cache_cross_merchant_search_early_decision',
        fetched_at: new Date().toISOString(),
        merchants_searched: normalizedMerchantsReturned.length,
        source_breakdown: {
          internal_count: 0,
          external_seed_count: 0,
          stale_cache_used: false,
          strategy_applied: 'ambiguity_gate_before_upstream',
        },
        ...(routeDebugEnabled
          ? {
              route_debug: {
                cross_merchant_cache: {
                  ...(normalizedCacheRouteDebug || {}),
                  early_decision: {
                    applied: true,
                    reason: earlyDecisionCause || null,
                    query_class: queryClassForEarlyDecision || null,
                  },
                },
              },
            }
          : {}),
      },
    };
  }

  function buildGuidanceOnlyCacheEarlyDecisionOutcome({
    page,
    merchantsReturned,
    cacheRouteDebug,
    routeDebugEnabled = false,
    earlyDecisionCause = null,
    queryClassForEarlyDecision = null,
    intent = null,
    requestPayload = null,
    policyMetadata = null,
    rawUserQuery = '',
    primaryLatencyMs = 0,
    ambiguityScorePre = null,
    traceId = null,
    expandedQuery = '',
    expansionMode = '',
    queryClass = null,
    rewriteGate = null,
    associationPlan = null,
    flagsSnapshot = null,
    retrievalSources = [],
  } = {}) {
    const earlyDecisionResponse = buildGuidanceOnlyCacheEarlyDecisionResponse({
      page,
      merchantsReturned,
      cacheRouteDebug,
      routeDebugEnabled,
      earlyDecisionCause,
      queryClassForEarlyDecision,
    });
    const earlyWithPolicyRaw = applyFindProductsMultiPolicyIfNeededImpl({
      response: earlyDecisionResponse,
      intent,
      requestPayload,
      metadata: policyMetadata,
      rawUserQuery,
    });
    const earlyWithPolicy =
      earlyWithPolicyRaw && typeof earlyWithPolicyRaw === 'object' && !Array.isArray(earlyWithPolicyRaw)
        ? earlyWithPolicyRaw
        : earlyDecisionResponse;
    const earlyDecisionProducts = Array.isArray(earlyWithPolicy?.products)
      ? earlyWithPolicy.products
      : [];
    const earlyDecisionClarification =
      earlyWithPolicy &&
      typeof earlyWithPolicy === 'object' &&
      !Array.isArray(earlyWithPolicy) &&
      earlyWithPolicy.clarification &&
      typeof earlyWithPolicy.clarification === 'object' &&
      earlyWithPolicy.clarification.question
        ? earlyWithPolicy.clarification
        : null;
    const earlyDecisionStrictEmpty =
      Boolean(earlyWithPolicy?.metadata?.strict_empty) ||
      (earlyDecisionProducts.length === 0 && !earlyDecisionClarification);
    const earlyDecisionResponsePayload =
      earlyDecisionStrictEmpty && !earlyWithPolicy?.metadata?.strict_empty
        ? {
            ...earlyWithPolicy,
            metadata: {
              ...(earlyWithPolicy.metadata && typeof earlyWithPolicy.metadata === 'object'
                ? earlyWithPolicy.metadata
                : {}),
              strict_empty: true,
              strict_empty_reason:
                String(
                  (earlyWithPolicy.metadata &&
                  typeof earlyWithPolicy.metadata === 'object' &&
                  earlyWithPolicy.metadata.strict_empty_reason) ||
                    earlyDecisionCause ||
                    'strict_empty',
                ).trim() || 'strict_empty',
            },
          }
        : earlyWithPolicy;

    const shouldReturn = Boolean(earlyDecisionClarification || earlyDecisionStrictEmpty);

    return {
      shouldReturn,
      clarification: earlyDecisionClarification,
      strictEmpty: Boolean(earlyDecisionStrictEmpty && !earlyDecisionClarification),
      response: shouldReturn
        ? buildGuidanceOnlyCacheDiagnosedResponse({
            response: earlyDecisionResponsePayload,
            primaryLatencyMs,
            ambiguityScorePre,
            traceId,
            rawQuery: rawUserQuery,
            expandedQuery: expandedQuery || rawUserQuery,
            expansionMode,
            queryClass,
            rewriteGate,
            associationPlan,
            flagsSnapshot,
            intent,
            candidateCount: 0,
            relevantCount: 0,
            retrievalSources,
            cacheRouteDebug,
            selectedSource: 'cache_empty',
            clarifyTriggered: Boolean(earlyDecisionClarification),
            finalDecision: earlyDecisionClarification ? 'clarify' : 'strict_empty',
            strictEmpty: Boolean(earlyDecisionStrictEmpty && !earlyDecisionClarification),
          })
        : earlyDecisionResponsePayload,
    };
  }

  function buildGuidanceOnlyCacheStrictEmptyResponse({
    source,
    page,
    retrievalSources,
    merchantsReturned,
    cacheRouteDebug,
    routeDebugEnabled = false,
    cacheStrictReason = null,
    normalizedSeedStrategyForCache = null,
  } = {}) {
    const normalizedMerchantsReturned = Array.isArray(merchantsReturned)
      ? merchantsReturned.filter(Boolean)
      : [];
    const normalizedCacheRouteDebug =
      cacheRouteDebug && typeof cacheRouteDebug === 'object' && !Array.isArray(cacheRouteDebug)
        ? cacheRouteDebug
        : null;
    const normalizedRetrievalSources = Array.isArray(retrievalSources)
      ? retrievalSources
      : null;

    return {
      status: 'success',
      success: true,
      products: [],
      total: 0,
      page,
      page_size: 0,
      reply: null,
      metadata: {
        query_source: 'cache_cross_merchant_search',
        fetched_at: new Date().toISOString(),
        merchants_searched: normalizedMerchantsReturned.length,
        source_breakdown: {
          internal_count: 0,
          external_seed_count: 0,
          stale_cache_used: false,
          strategy_applied: isCatalogGuardSourceImpl(source)
            ? normalizedSeedStrategyForCache || 'unified_relevance'
            : 'cache_only',
        },
        proxy_search_fallback: {
          applied: false,
          reason: cacheStrictReason || null,
        },
        ...(normalizedRetrievalSources ? { retrieval_sources: normalizedRetrievalSources } : {}),
        ...(routeDebugEnabled
          ? {
              route_debug: {
                cross_merchant_cache: normalizedCacheRouteDebug,
              },
            }
          : {}),
      },
    };
  }

  function buildGuidanceOnlyCacheStrictEmptyOutcome({
    source,
    page,
    retrievalSources,
    merchantsReturned,
    cacheRouteDebug,
    routeDebugEnabled = false,
    cacheStrictReason = null,
    normalizedSeedStrategyForCache = null,
    intent = null,
    requestPayload = null,
    policyMetadata = null,
    rawUserQuery = '',
    promotions = [],
    now = new Date(),
    creatorId = null,
    primaryLatencyMs = 0,
    ambiguityScorePre = null,
    traceId = null,
    expandedQuery = '',
    expansionMode = '',
    queryClass = null,
    rewriteGate = null,
    associationPlan = null,
    flagsSnapshot = null,
    candidateCount = 0,
    relevantCount = 0,
  } = {}) {
    const strictEmptyBase = buildGuidanceOnlyCacheStrictEmptyResponse({
      source,
      page,
      retrievalSources,
      merchantsReturned,
      cacheRouteDebug,
      routeDebugEnabled,
      cacheStrictReason,
      normalizedSeedStrategyForCache,
    });
    const strictEmptyWithPolicy = applyFindProductsMultiPolicyIfNeededImpl({
      response: strictEmptyBase,
      intent,
      requestPayload,
      metadata: policyMetadata,
      rawUserQuery,
      responseMetadata: strictEmptyBase?.metadata,
    });
    const strictEmptyEnriched = applyDealsToResponseImpl(
      strictEmptyWithPolicy,
      promotions,
      now,
      creatorId,
    );
    const strictEmptyClarification =
      strictEmptyEnriched &&
      typeof strictEmptyEnriched === 'object' &&
      !Array.isArray(strictEmptyEnriched) &&
      strictEmptyEnriched.clarification &&
      typeof strictEmptyEnriched.clarification === 'object' &&
      strictEmptyEnriched.clarification.question
        ? strictEmptyEnriched.clarification
        : null;

    return {
      response: buildGuidanceOnlyCacheDiagnosedResponse({
        response: strictEmptyEnriched,
        primaryLatencyMs,
        ambiguityScorePre,
        traceId,
        rawQuery: rawUserQuery,
        expandedQuery: expandedQuery || rawUserQuery,
        expansionMode,
        queryClass,
        rewriteGate,
        associationPlan,
        flagsSnapshot,
        intent,
        candidateCount,
        relevantCount,
        retrievalSources,
        cacheRouteDebug,
        selectedSource: 'cache_strict_empty',
        clarifyTriggered: Boolean(strictEmptyClarification),
        finalDecision: strictEmptyClarification ? 'clarify' : 'strict_empty',
        fallbackReason: cacheStrictReason,
        strictEmpty: !strictEmptyClarification,
        strictEmptyReason: cacheStrictReason,
      }),
      clarification: strictEmptyClarification,
    };
  }

  function buildGuidanceOnlyCacheHitOutcome({
    response,
    primaryLatencyMs = 0,
    ambiguityScorePre = null,
    traceId = null,
    rawQuery = '',
    expandedQuery = '',
    expansionMode = '',
    queryClass = null,
    rewriteGate = null,
    associationPlan = null,
    flagsSnapshot = null,
    intent = null,
    candidateCount = 0,
    relevantCount = 0,
    retrievalSources = [],
    cacheRouteDebug = null,
  } = {}) {
    const cacheClarification =
      response &&
      typeof response === 'object' &&
      !Array.isArray(response) &&
      response.clarification &&
      typeof response.clarification === 'object' &&
      response.clarification.question
        ? response.clarification
        : null;

    return {
      clarification: cacheClarification,
      response: buildGuidanceOnlyCacheDiagnosedResponse({
        response,
        primaryLatencyMs,
        ambiguityScorePre,
        traceId,
        rawQuery,
        expandedQuery,
        expansionMode,
        queryClass,
        rewriteGate,
        associationPlan,
        flagsSnapshot,
        intent,
        candidateCount,
        relevantCount,
        retrievalSources,
        cacheRouteDebug,
        selectedSource: 'internal_cache',
        clarifyTriggered: Boolean(cacheClarification),
        finalDecision: cacheClarification ? 'clarify' : 'cache_returned',
      }),
    };
  }

  function buildGuidanceOnlyCacheDiagnosedResponse({
    response,
    primaryLatencyMs,
    ambiguityScorePre,
    traceId,
    rawQuery,
    expandedQuery,
    expansionMode,
    queryClass,
    rewriteGate,
    associationPlan,
    flagsSnapshot,
    intent,
    candidateCount,
    relevantCount,
    retrievalSources,
    cacheRouteDebug,
    selectedSource,
    clarifyTriggered = false,
    finalDecision = null,
    fallbackTriggered = false,
    fallbackReason = null,
    strictEmpty = false,
    strictEmptyReason = null,
  } = {}) {
    const normalizedCandidateCount = Math.max(0, Number(candidateCount || 0) || 0);
    const normalizedRelevantCount = Math.max(0, Number(relevantCount || 0) || 0);
    const normalizedRetrievalSources = Array.isArray(retrievalSources) ? retrievalSources : [];
    const normalizedCacheRouteDebug =
      cacheRouteDebug && typeof cacheRouteDebug === 'object' && !Array.isArray(cacheRouteDebug)
        ? cacheRouteDebug
        : null;
    const normalizedFinalDecision =
      String(finalDecision || '').trim() ||
      (strictEmpty ? 'strict_empty' : clarifyTriggered ? 'clarify' : 'cache_returned');
    const normalizedFallbackReason = String(fallbackReason || '').trim() || null;
    const normalizedStrictEmptyReason =
      String(strictEmptyReason || '').trim() || normalizedFallbackReason || 'no_candidates';
    const cacheQuerySource =
      response?.metadata && typeof response.metadata === 'object' && !Array.isArray(response.metadata)
        ? String(response.metadata.query_source || '').trim() || null
        : null;
    const cacheDecisionLockReason =
      normalizedCacheRouteDebug?.main_path_contract_locked === true
        ? 'guidance_cache_success_contract'
        : normalizedFinalDecision === 'cache_returned'
        ? 'cache_main_path'
        : normalizedFinalDecision === 'clarify'
        ? 'clarify_contract'
        : 'strict_empty_contract';

    return withSearchDiagnosticsImpl(response, {
      route_health: buildSearchRouteHealthImpl({
        primaryPathUsed: 'cache_stage',
        primaryLatencyMs: Math.max(0, Number(primaryLatencyMs || 0) || 0),
        fallbackTriggered: Boolean(fallbackTriggered),
        fallbackReason: normalizedFallbackReason,
        ambiguityScorePre,
        ambiguityScorePost: strictEmpty ? 1 : undefined,
        clarifyTriggered: Boolean(clarifyTriggered),
      }),
      search_trace: buildSearchTraceImpl({
        traceId,
        rawQuery: String(rawQuery || '').trim(),
        expandedQuery: String(expandedQuery || rawQuery || '').trim(),
        expansionMode: expansionMode || null,
        queryClass: queryClass || null,
        rewriteGate: rewriteGate || null,
        associationPlan: associationPlan || null,
        flagsSnapshot: flagsSnapshot || null,
        intent: intent || null,
        cacheStage: buildCacheStageSnapshotImpl({
          hit: normalizedFinalDecision === 'cache_returned',
          candidateCount: normalizedCandidateCount,
          relevantCount: normalizedRelevantCount,
          retrievalSources: normalizedRetrievalSources,
          cacheRouteDebug: normalizedCacheRouteDebug,
          selectedSource: selectedSource || null,
        }),
        upstreamStage: {
          called: false,
          timeout: false,
          status: null,
          latency_ms: 0,
        },
        resolverStage: {
          called: false,
          hit: false,
          miss: false,
          latency_ms: null,
        },
        finalDecision: normalizedFinalDecision,
      }),
      search_decision: {
        final_decision: normalizedFinalDecision,
        primary_path_used: 'cache_stage',
        decision_authority: cacheQuerySource,
        decision_locked: true,
        decision_lock_reason: cacheDecisionLockReason,
      },
      ...(strictEmpty
        ? {
            strict_empty: true,
            strict_empty_reason: normalizedStrictEmptyReason,
          }
        : {}),
    });
  }

  function buildGuidanceOnlyCacheMissPlan({
    source,
    cacheQueryText,
    page,
    limit,
    inStockOnly,
    effectiveCacheHit,
    isLookupQuery = false,
    effectiveProducts,
    bypassCacheStrictEmpty = false,
    bypassCacheStrictEmptyForUnified = false,
    cacheStrictEmptyBypassReason = null,
    forceControlledRecallForScenario = false,
    cacheStrictEmptyEarlyReturnEnabled = false,
  } = {}) {
    const normalizedQuery = String(cacheQueryText || '').trim();
    const normalizedSource = String(source || '').trim() || null;
    const normalizedEffectiveProducts = Array.isArray(effectiveProducts) ? effectiveProducts : [];
    const shouldEvaluateMissPlan =
      isCatalogGuardSourceImpl(source) &&
      normalizedQuery.length > 0 &&
      !effectiveCacheHit &&
      !isLookupQuery;
    const shouldReturnStrictEmpty =
      cacheStrictEmptyEarlyReturnEnabled &&
      shouldEvaluateMissPlan &&
      !bypassCacheStrictEmpty &&
      !bypassCacheStrictEmptyForUnified &&
      !forceControlledRecallForScenario;
    const cacheStrictReason = shouldEvaluateMissPlan
      ? normalizedEffectiveProducts.length > 0
        ? 'cache_irrelevant_strict_empty'
        : 'cache_miss_strict_empty'
      : null;
    const shouldLogStrictEmptyBypass =
      shouldEvaluateMissPlan && (bypassCacheStrictEmpty || bypassCacheStrictEmptyForUnified);
    const strictEmptyBypassLogReason = shouldLogStrictEmptyBypass
      ? bypassCacheStrictEmptyForUnified
        ? String(cacheStrictEmptyBypassReason || '').trim() || 'unified_relevance'
        : 'aurora_override'
      : null;

    return {
      shouldEvaluateMissPlan,
      shouldReturnStrictEmpty,
      cacheStrictReason,
      shouldLogStrictEmptyBypass,
      strictEmptyBypassLogReason,
      upstreamFallbackLogPayload: {
        source: normalizedSource,
        page,
        limit,
        inStockOnly,
        query: normalizedQuery,
      },
    };
  }

  function buildGuidanceOnlyCacheMissLoggingArtifacts({
    source,
    cacheQueryText,
    cacheMissPlan,
  } = {}) {
    const normalizedSource = String(source || '').trim() || null;
    const normalizedQuery = String(cacheQueryText || '').trim();
    const normalizedPlan =
      cacheMissPlan && typeof cacheMissPlan === 'object' && !Array.isArray(cacheMissPlan)
        ? cacheMissPlan
        : {};

    return {
      bypassLog: normalizedPlan.shouldLogStrictEmptyBypass
        ? {
            payload: {
              source: normalizedSource,
              query: normalizedQuery,
              reason: normalizedPlan.strictEmptyBypassLogReason || null,
            },
            message: 'Catalog cache miss strict-empty bypassed; continuing to upstream search',
          }
        : null,
      upstreamFallbackLog: {
        payload:
          normalizedPlan.upstreamFallbackLogPayload &&
          typeof normalizedPlan.upstreamFallbackLogPayload === 'object' &&
          !Array.isArray(normalizedPlan.upstreamFallbackLogPayload)
            ? normalizedPlan.upstreamFallbackLogPayload
            : {
                source: normalizedSource,
                query: normalizedQuery,
              },
        message: 'Cross-merchant cache search returned empty; falling back to upstream',
      },
    };
  }

  function buildGuidanceOnlyCacheResolverFallbackPlan({
    resolverFallbackEnabled = false,
    isLookupQuery = false,
    search,
    cacheQueryText,
    inStockOnly,
    limit,
    normalizedSeedStrategyForCache,
    checkoutToken,
    source,
  } = {}) {
    const shouldAttemptResolverFallback = shouldAttemptCacheMissResolverFallbackImpl({
      resolverFallbackEnabled,
      isLookupQuery,
      cacheQueryText,
    });

    return {
      shouldAttemptResolverFallback,
      request: shouldAttemptResolverFallback
        ? buildCacheMissResolverFallbackRequestImpl({
            search,
            cacheQueryText,
            inStockOnly,
            limit,
            normalizedSeedStrategyForCache,
            checkoutToken,
            source,
            auroraResolverTimeoutMs: getAuroraResolverTimeoutMs(),
            resolverTimeoutMs: getDefaultResolverTimeoutMs(),
          })
        : null,
    };
  }

  function buildGuidanceOnlyCacheResolverFallbackOutcome({
    result,
    promotions,
    now,
    creatorId,
    primaryLatencyMs = 0,
    ambiguityScorePre = null,
    effectiveProducts = [],
    internalProductsAfterAnchor = [],
    retrievalSources = [],
    cacheRouteDebug = null,
    traceId = null,
    rawQuery = '',
    expandedQuery = '',
    expansionMode = '',
    queryClass = null,
    rewriteGate = null,
    associationPlan = null,
    flagsSnapshot = null,
    intent = null,
  } = {}) {
    const shouldReturnResolverFallback =
      Boolean(result) &&
      Number(result?.status || 0) >= 200 &&
      Number(result?.status || 0) < 300 &&
      Number(result?.usableCount || 0) > 0;

    return {
      shouldReturnResolverFallback,
      response: shouldReturnResolverFallback
        ? buildCacheMissResolverFallbackDiagnosedResponseImpl({
            result,
            promotions,
            now,
            creatorId,
            primaryLatencyMs,
            ambiguityScorePre,
            effectiveProducts,
            internalProductsAfterAnchor,
            retrievalSources,
            cacheRouteDebug,
            traceId,
            rawQuery,
            expandedQuery,
            expansionMode,
            queryClass,
            rewriteGate,
            associationPlan,
            flagsSnapshot,
            intent,
          }).response
        : null,
    };
  }

  function buildGuidanceOnlyCacheResolverFallbackFailureArtifacts({
    error,
    cacheQueryText,
  } = {}) {
    const errorMessage = String(error && error.message ? error.message : error || '').trim();
    return {
      warnLogPayload: {
        err: errorMessage,
        query: String(cacheQueryText || '').trim(),
      },
    };
  }

  function buildGuidanceOnlyCacheFailureArtifacts({
    error,
    cacheQueryText,
    expandedCacheSearchQueryText,
    preferRawBeautyCacheQuery = false,
    queryText,
    page,
    limit,
    inStockOnly,
    cacheStageBudgetMs,
    cacheBeautyBucket = null,
    source,
  } = {}) {
    const normalizedQuery = String(cacheQueryText || '').trim();
    const normalizedExpandedQuery = String(expandedCacheSearchQueryText || '').trim();
    const cacheQuery =
      (preferRawBeautyCacheQuery ? normalizedQuery : normalizedExpandedQuery) || normalizedQuery;
    const errorMessage = String(error && error.message ? error.message : error || '').trim();

    return {
      cacheRouteDebug: {
        attempted: true,
        mode: 'search',
        query: normalizedQuery,
        cache_query: cacheQuery,
        cache_query_mode: preferRawBeautyCacheQuery ? 'raw_first' : null,
        cache_query_terms: [],
        upstream_query: String(queryText || '').trim(),
        page,
        limit,
        in_stock_only: inStockOnly,
        cache_hit: false,
        timeout_budget_ms: cacheStageBudgetMs,
        stage_timeout: String(error?.code || '').toUpperCase() === 'STAGE_TIMEOUT',
        beauty_query_bucket: cacheBeautyBucket || null,
        error: errorMessage,
      },
      warnLogPayload: {
        err: errorMessage,
        source,
        query: normalizedQuery,
      },
    };
  }

  async function loadGuidanceOnlySessionState({
    guidancePlan,
    req,
    query,
    metadata,
  } = {}) {
    if (!guidancePlan?.shouldLoadSessionSeenProducts) {
      return {
        sessionId: null,
        sessionSeenProductIds: [],
      };
    }

    const sessionId = resolveGuidanceSearchSessionIdImpl({ req, query, metadata });
    const sessionSeenProductIds = sessionId
      ? await loadGuidanceSearchSessionSeenProductIdsImpl(sessionId)
      : [];

    return {
      sessionId: sessionId || null,
      sessionSeenProductIds: Array.isArray(sessionSeenProductIds) ? sessionSeenProductIds : [],
    };
  }

  async function persistGuidanceOnlySessionState({
    guidancePlan,
    req,
    query,
    metadata,
    response,
  } = {}) {
    if (!guidancePlan?.shouldPersistSeenProducts) {
      return {
        persisted: false,
        sessionId: null,
        productCount: Array.isArray(response?.products) ? response.products.length : 0,
      };
    }

    const sessionId = resolveGuidanceSearchSessionIdImpl({ req, query, metadata });
    const products = Array.isArray(response?.products) ? response.products : [];
    if (!sessionId) {
      return {
        persisted: false,
        sessionId: null,
        productCount: products.length,
      };
    }

    await persistGuidanceSearchSeenProductsImpl(sessionId, products);
    return {
      persisted: true,
      sessionId,
      productCount: products.length,
    };
  }

  function buildGuidanceOnlyHitQualityInputs({
    guidancePlan,
    metadata,
    reqQuery,
    query,
    queryText,
    requestedTargetStepFamily,
    products,
    sessionState,
  } = {}) {
    const normalizedMeta =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const normalizedReqQuery =
      reqQuery && typeof reqQuery === 'object' && !Array.isArray(reqQuery) ? reqQuery : {};
    const normalizedQuery =
      query && typeof query === 'object' && !Array.isArray(query) ? query : {};
    const normalizedProducts = Array.isArray(products) ? products : [];
    const sessionSeenProductIds = Array.isArray(sessionState?.sessionSeenProductIds)
      ? sessionState.sessionSeenProductIds
      : [];
    const allowExternalSeed =
      parseQueryBooleanImpl(
        normalizedReqQuery.allow_external_seed ??
          normalizedReqQuery.allowExternalSeed ??
          normalizedQuery.allow_external_seed ??
          normalizedQuery.allowExternalSeed,
      ) === true;

    return {
      shouldApplyGuidanceOnlyHitQuality: guidancePlan?.shouldApplyGuidanceOnlyHitQuality === true,
      sessionSeenProductIds,
      queryStepStrength: resolveGuidanceSearchStepStrengthImpl(
        normalizedMeta.query_step_strength ??
          normalizedReqQuery.query_step_strength ??
          normalizedReqQuery.queryStepStrength,
        queryText,
        requestedTargetStepFamily,
      ),
      sourcePolicy:
        normalizeGuidanceDiscoverySourcePolicyImpl(
          normalizedMeta.source_policy ??
            normalizedReqQuery.source_policy ??
            normalizedReqQuery.sourcePolicy ??
            normalizedQuery.source_policy ??
            normalizedQuery.sourcePolicy,
        ) || null,
      productOnlyApplied:
        normalizedMeta.product_only_applied === true ||
        parseQueryBooleanImpl(
          normalizedReqQuery.product_only ??
            normalizedReqQuery.productOnly ??
            normalizedQuery.product_only ??
            normalizedQuery.productOnly,
        ) === true,
      serviceRowsFilteredCount: Math.max(
        0,
        Number(normalizedMeta.service_rows_filtered_count || 0) || 0,
      ),
      discoverySourceUsed:
        String(normalizedMeta.discovery_source_used || '').trim() ||
        inferGuidanceDiscoverySourceUsedImpl(normalizedProducts, allowExternalSeed) ||
        null,
      queryIndex:
        parseQueryNumberImpl(
          normalizedMeta.query_index ??
            normalizedReqQuery.query_index ??
            normalizedReqQuery.queryIndex ??
            normalizedQuery.query_index ??
            normalizedQuery.queryIndex,
        ) ?? null,
      queryExhausted:
        normalizedMeta.query_exhausted === true || normalizedProducts.length === 0,
    };
  }

  function buildGuidanceOnlySearchDecisionPatches({
    guidanceOnlyDiscovery = false,
    requestedProductOnly,
    requestedAllowExternalSeed,
    requestedExternalSeedStrategy,
    requestedQueryIndex,
    requestedQueryTotal,
    requestedDecisionMode,
    requestedTargetStepFamily,
    requestedQueryStepStrength,
    existingMeta,
    rawProductsForQualityGate,
    nextProducts,
    hitDecision,
  } = {}) {
    if (!guidanceOnlyDiscovery) {
      return {
        searchDecisionPatch: {},
        metadataPatch: {},
      };
    }

    const normalizedMeta =
      existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
        ? existingMeta
        : {};
    const normalizedRawProducts = Array.isArray(rawProductsForQualityGate) ? rawProductsForQualityGate : [];
    const normalizedNextProducts = Array.isArray(nextProducts) ? nextProducts : [];
    const nextProductKeys = new Set(
      normalizedNextProducts.map((product) => buildSearchDecisionProductKeyImpl(product)).filter(Boolean),
    );
    const guidanceOnlyProductOnlyApplied =
      requestedProductOnly !== undefined
        ? requestedProductOnly
        : normalizedMeta.product_only_requested !== false;
    const serviceRowsFilteredCount = normalizedRawProducts.reduce((count, product) => {
      const productKey = buildSearchDecisionProductKeyImpl(product);
      if (productKey && nextProductKeys.has(productKey)) return count;
      const coarse = classifySharedBeautyCoarseCandidateImpl(product, {
        queryTargetStepFamily: requestedTargetStepFamily,
      });
      return coarse.object_type === 'service' || coarse.domain_scope === 'beauty_service'
        ? count + 1
        : count;
    }, 0);
    const normalizedQueryIndex = requestedQueryIndex !== undefined
      ? Math.max(0, Math.floor(requestedQueryIndex))
      : Number.isFinite(Number(normalizedMeta.query_index))
      ? Math.max(0, Math.floor(Number(normalizedMeta.query_index)))
      : null;
    const normalizedQueryTotal = requestedQueryTotal !== undefined
      ? Math.max(0, Math.floor(requestedQueryTotal))
      : Number.isFinite(Number(normalizedMeta.query_total))
      ? Math.max(0, Math.floor(Number(normalizedMeta.query_total)))
      : null;
    const discoveryAllowExternalSeed = requestedAllowExternalSeed !== undefined
      ? requestedAllowExternalSeed === true
      : normalizedMeta.allow_external_seed === true ||
        normalizedMeta.search_allow_external_seed === true ||
        normalizedMeta.external_seed_strategy === 'supplement_internal_first' ||
        requestedExternalSeedStrategy === 'supplement_internal_first';
    const queryStepStrength =
      hitDecision?.query_step_strength || requestedQueryStepStrength || null;
    const queryExhausted =
      normalizedQueryIndex != null && normalizedQueryTotal != null
        ? normalizedQueryTotal > 0 && normalizedQueryIndex >= normalizedQueryTotal - 1
        : normalizedNextProducts.length === 0;
    const discoverySourceUsed = inferGuidanceDiscoverySourceUsedImpl(
      normalizedNextProducts,
      discoveryAllowExternalSeed,
    );

    return {
      searchDecisionPatch: {
        product_only_applied: guidanceOnlyProductOnlyApplied,
        service_rows_filtered_count: serviceRowsFilteredCount,
        discovery_source_used: discoverySourceUsed,
        query_step_strength: queryStepStrength,
        decision_mode: requestedDecisionMode || null,
        query_index: normalizedQueryIndex,
        query_exhausted: queryExhausted,
      },
      metadataPatch: {
        product_only_applied: guidanceOnlyProductOnlyApplied,
        service_rows_filtered_count: serviceRowsFilteredCount,
        discovery_source_used: discoverySourceUsed,
        query_step_strength: queryStepStrength,
        decision_mode: requestedDecisionMode || null,
        query_index: normalizedQueryIndex,
        query_exhausted: queryExhausted,
      },
    };
  }

  function normalizeGuidanceOnlyInvokeSearchResponse({
    response,
    reqQuery,
  } = {}) {
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return {
        response,
        searchDecision: null,
      };
    }

    const normalizedReqQuery =
      reqQuery && typeof reqQuery === 'object' && !Array.isArray(reqQuery) ? reqQuery : {};
    const existingMeta =
      response.metadata && typeof response.metadata === 'object' && !Array.isArray(response.metadata)
        ? response.metadata
        : {};
    const existingSearchDecision =
      existingMeta.search_decision &&
      typeof existingMeta.search_decision === 'object' &&
      !Array.isArray(existingMeta.search_decision)
        ? existingMeta.search_decision
        : {};
    const guidanceUiSurface = normalizeSearchUiSurfaceImpl(
      existingMeta.ui_surface ||
        normalizedReqQuery.ui_surface ||
        normalizedReqQuery.uiSurface,
    );
    const guidanceTargetStepFamily = normalizeRecoTargetStepImpl(
      existingMeta.query_target_step_family ||
        firstQueryParamValueImpl(
          normalizedReqQuery.target_step_family || normalizedReqQuery.targetStepFamily,
        ),
    );
    const guidanceQueryText = String(
      normalizedReqQuery.query ||
        existingMeta.search_trace?.raw_query ||
        '',
    ).trim();
    const guidancePlan = buildGuidanceOnlySearchStatePlan({
      uiSurface: guidanceUiSurface,
      requestedTargetStepFamily: guidanceTargetStepFamily,
      clarification: response.clarification,
      reasonCodes: Array.isArray(response.reason_codes) ? response.reason_codes : [],
      querySource: existingMeta.query_source,
    });
    let nextResponse = response;
    let normalizedProducts = Array.isArray(response.products) ? response.products : [];
    let normalizedSearchDecision = existingSearchDecision;

    if (guidancePlan.shouldApplyGuidanceOnlyHitQuality && guidanceQueryText) {
      normalizedProducts = normalizedProducts.map((product) =>
        normalizeGuidanceDiscoveryProductPdpContractImpl(product),
      );
      nextResponse = {
        ...response,
        products: normalizedProducts,
      };
      const guidanceInputs = buildGuidanceOnlyHitQualityInputs({
        guidancePlan,
        metadata: existingMeta,
        reqQuery: normalizedReqQuery,
        query: normalizedReqQuery,
        queryText: guidanceQueryText,
        requestedTargetStepFamily: guidanceTargetStepFamily,
        products: normalizedProducts,
        sessionState: {
          sessionSeenProductIds: [],
        },
      });
      const guidanceDecision = buildGuidanceOnlyHitQualityDecisionImpl({
        queryText: guidanceQueryText,
        products: normalizedProducts,
        queryTargetStepFamily: guidanceTargetStepFamily,
        guidanceOnlyDiscovery: true,
        queryStepStrength: guidanceInputs.queryStepStrength,
        mode: 'guidance_only',
        sessionSeenProductIds: guidanceInputs.sessionSeenProductIds,
      });

      if (guidanceDecision?.applied) {
        normalizedSearchDecision = {
          ...existingSearchDecision,
          contract_version:
            guidanceDecision.contract_version || guidanceDecisionContractVersion || null,
          hit_quality: guidanceDecision.hit_quality,
          invalid_hit_reason: guidanceDecision.invalid_hit_reason,
          query_bucket: guidanceDecision.query_bucket,
          query_target_step_family: guidanceDecision.query_target_step_family,
          topk_bucket_mix: guidanceDecision.topk_bucket_mix,
          same_family_topk_count: guidanceDecision.same_family_topk_count,
          exact_step_topk_count: guidanceDecision.exact_step_topk_count,
          strong_goal_family_topk_count: guidanceDecision.strong_goal_family_topk_count,
          supportive_same_family_topk_count: guidanceDecision.supportive_same_family_topk_count,
          query_step_strength: guidanceDecision.query_step_strength,
          decision_mode: 'guidance_only',
          normalized_intent: guidanceDecision.normalized_intent || null,
          step_success_class: guidanceDecision.step_success_class || null,
          success_contract_result: guidanceDecision.success_contract_result || null,
          quality_gate_result: guidanceDecision.quality_gate_result || null,
          candidate_origin_counts:
            guidanceDecision.candidate_origin_counts ||
            countCandidateOriginBreakdownImpl(normalizedProducts),
          candidate_class_counts: mergeSearchCountMapsImpl(
            existingSearchDecision.candidate_class_counts,
            guidanceDecision.candidate_class_counts,
          ),
          target_relevance_class_counts: mergeSearchCountMapsImpl(
            existingSearchDecision.target_relevance_class_counts,
            guidanceDecision.target_relevance_class_counts,
          ),
          noise_drop_counts: mergeSearchCountMapsImpl(
            existingSearchDecision.noise_drop_counts,
            guidanceDecision.noise_drop_counts,
          ),
          raw_result_count: guidanceDecision.raw_result_count,
          displayable_candidate_count: guidanceDecision.displayable_candidate_count,
          fill_target_count: guidanceDecision.fill_target_count,
          fill_completed_count: guidanceDecision.fill_completed_count,
          valid_scoping_dropped_count: guidanceDecision.valid_scoping_dropped_count,
          dedupe_dropped_count: guidanceDecision.dedupe_dropped_count,
          selection_diversity: guidanceDecision.selection_diversity || null,
          stable_prior_applied: guidanceDecision.stable_prior_applied === true,
          stable_prior_source: guidanceDecision.stable_prior_source || null,
          fallback_mode: guidanceDecision.fallback_mode || 'normal',
          diversity_exception_applied: guidanceDecision.diversity_exception_applied === true,
          coverage_limited_after_fill: guidanceDecision.coverage_limited_after_fill === true,
          surface_reason: guidanceDecision.surface_reason || null,
          products_returned_count: guidanceDecision.products_returned_count,
          product_only_applied: guidanceInputs.productOnlyApplied,
          service_rows_filtered_count: guidanceInputs.serviceRowsFilteredCount,
          discovery_source_used: guidanceInputs.discoverySourceUsed,
          query_index: guidanceInputs.queryIndex,
          query_exhausted: guidanceInputs.queryExhausted,
        };
      }
    }

    return {
      response: nextResponse,
      searchDecision: normalizedSearchDecision,
    };
  }

  function finalizeInvokeFindProductsMultiResponse({
    response,
    reqQuery,
    routeContext,
    orchestratorVersion,
  } = {}) {
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return response;
    }

    const existingMeta =
      response.metadata && typeof response.metadata === 'object' && !Array.isArray(response.metadata)
        ? response.metadata
        : {};
    const existingSearchDecision =
      existingMeta.search_decision &&
      typeof existingMeta.search_decision === 'object' &&
      !Array.isArray(existingMeta.search_decision)
        ? existingMeta.search_decision
        : {};
    const existingRouteDebugPolicy =
      existingMeta.route_debug &&
      typeof existingMeta.route_debug === 'object' &&
      !Array.isArray(existingMeta.route_debug) &&
      existingMeta.route_debug.policy &&
      typeof existingMeta.route_debug.policy === 'object' &&
      !Array.isArray(existingMeta.route_debug.policy)
        ? existingMeta.route_debug.policy
        : {};
    const guidanceNormalization = normalizeGuidanceOnlyInvokeSearchResponse({
      response,
      reqQuery,
    });
    const nextResponse = guidanceNormalization.response;
    const normalizedMeta =
      nextResponse?.metadata &&
      typeof nextResponse.metadata === 'object' &&
      !Array.isArray(nextResponse.metadata)
        ? nextResponse.metadata
        : existingMeta;
    const normalizedSearchDecision =
      guidanceNormalization.searchDecision &&
      typeof guidanceNormalization.searchDecision === 'object' &&
      !Array.isArray(guidanceNormalization.searchDecision)
        ? guidanceNormalization.searchDecision
        : existingSearchDecision;
    const defaultExternalFillGateReason =
      String(normalizedMeta.external_fill_gate_reason || '').trim() ||
      String(normalizedMeta.external_seed_skip_reason || '').trim() ||
      String(normalizedMeta.route_health?.external_seed_skip_reason || '').trim() ||
      null;
    const domainFilterDroppedExternal =
      Number(
        normalizedMeta.domain_filter_dropped_external ??
          normalizedSearchDecision.domain_filter_dropped_external ??
          existingRouteDebugPolicy?.ambiguity?.domain_filter_dropped_external ??
          0,
      ) || 0;

    return {
      ...nextResponse,
      metadata: {
        ...normalizedMeta,
        orchestrator_version:
          String(orchestratorVersion || '').trim() || 'search_orchestrator_unified_v1',
        orchestrator_path:
          String(routeContext?.orchestrator_path || normalizedMeta.orchestrator_path || '').trim() ||
          'external_invoke_route',
        semantic_retry_applied: Boolean(normalizedMeta.semantic_retry_applied),
        semantic_retry_query: normalizedMeta.semantic_retry_query || null,
        semantic_retry_hits: Math.max(0, Number(normalizedMeta.semantic_retry_hits || 0) || 0),
        domain_filter_dropped_external: Math.max(0, domainFilterDroppedExternal),
        external_fill_gate_reason: defaultExternalFillGateReason,
        ...(normalizedSearchDecision && Object.keys(normalizedSearchDecision).length > 0
          ? {
              normalized_intent: normalizedSearchDecision.normalized_intent || null,
              quality_gate_result: normalizedSearchDecision.quality_gate_result || null,
              candidate_origin_counts: normalizedSearchDecision.candidate_origin_counts || null,
              displayable_candidate_count: normalizedSearchDecision.displayable_candidate_count ?? null,
              fill_target_count: normalizedSearchDecision.fill_target_count ?? null,
              fill_completed_count: normalizedSearchDecision.fill_completed_count ?? null,
              valid_scoping_dropped_count: normalizedSearchDecision.valid_scoping_dropped_count ?? 0,
              dedupe_dropped_count: normalizedSearchDecision.dedupe_dropped_count ?? 0,
              selection_diversity: normalizedSearchDecision.selection_diversity || null,
              stable_prior_applied: normalizedSearchDecision.stable_prior_applied === true,
              stable_prior_source: normalizedSearchDecision.stable_prior_source || null,
              fallback_mode: normalizedSearchDecision.fallback_mode || 'normal',
              diversity_exception_applied: normalizedSearchDecision.diversity_exception_applied === true,
              coverage_limited_after_fill: normalizedSearchDecision.coverage_limited_after_fill === true,
              surface_reason: normalizedSearchDecision.surface_reason || null,
            }
          : {}),
        ...(normalizedSearchDecision && Object.keys(normalizedSearchDecision).length > 0
          ? { search_decision: normalizedSearchDecision }
          : {}),
      },
    };
  }

  async function finalizeGuidanceOnlySearchResponse({
    response,
    uiSurface,
    requestedTargetStepFamily,
    queryText,
    req,
    query,
  } = {}) {
    const guidancePlan = buildGuidanceOnlySearchStatePlan({
      uiSurface,
      requestedTargetStepFamily,
      clarification: response?.clarification,
      reasonCodes: Array.isArray(response?.reason_codes) ? response.reason_codes : [],
      querySource: response?.metadata?.query_source,
    });
    let nextResponse = response;

    if (guidancePlan.shouldApplyGuidanceOnlyHitQuality) {
      const responseMeta =
        nextResponse?.metadata &&
        typeof nextResponse.metadata === 'object' &&
        !Array.isArray(nextResponse.metadata)
          ? nextResponse.metadata
          : {};
      const sessionState = await loadGuidanceOnlySessionState({
        guidancePlan,
        req,
        query,
        metadata: responseMeta,
      });
      const products = Array.isArray(nextResponse?.products) ? nextResponse.products : [];
      const guidanceInputs = buildGuidanceOnlyHitQualityInputs({
        guidancePlan,
        metadata: responseMeta,
        reqQuery: req?.query,
        query,
        queryText,
        requestedTargetStepFamily,
        products,
        sessionState,
      });
      const guidanceDecision = buildGuidanceOnlyHitQualityDecisionImpl({
        queryText,
        products,
        queryTargetStepFamily: requestedTargetStepFamily,
        guidanceOnlyDiscovery: true,
        queryStepStrength: guidanceInputs.queryStepStrength,
        mode: 'guidance_only',
        sessionSeenProductIds: guidanceInputs.sessionSeenProductIds,
      });

      if (guidanceDecision?.applied) {
        nextResponse = applyGuidanceOnlyHitQualityOutcome({
          response: nextResponse,
          guidancePlan,
          guidanceDecision: {
            ...guidanceDecision,
            contract_version:
              guidanceDecision.contract_version || guidanceDecisionContractVersion || null,
          },
          sourcePolicy: guidanceInputs.sourcePolicy,
          productOnlyApplied: guidanceInputs.productOnlyApplied,
          serviceRowsFilteredCount: guidanceInputs.serviceRowsFilteredCount,
          discoverySourceUsed: guidanceInputs.discoverySourceUsed,
          queryIndex: guidanceInputs.queryIndex,
          queryExhausted: guidanceInputs.queryExhausted,
        });
      }
    }

    const persistence = await persistGuidanceOnlySessionState({
      guidancePlan,
      req,
      query,
      metadata: nextResponse?.metadata,
      response: nextResponse,
    });

    return {
      response: nextResponse,
      guidancePlan,
      persistence,
    };
  }

  async function handleAuroraBeautyOrchestration(input = {}) {
    const normalized = createAuroraOrchestrationInput(input);
    const conversationState = summarizeAuroraConversationState(normalized.messages);
    const hasMessages = normalized.messages.length > 0;
    const sourceProfile = normalized.context?.source_profile || input.source_profile || null;
    const beautyExpertV1 = buildBeautyExpertV1Response({
      source: sourceProfile?.source || null,
      entryLayer: 'orchestration',
      taskType: normalized.context?.task_type || input.task_type || null,
      context: normalized.context,
      metadata: input.metadata,
      payload: input.payload,
      messages: normalized.messages,
      response: {
        metadata: {
          mainline_status: hasMessages ? 'delegated' : 'analysis_only',
          decision_owner: 'aurora_orchestration',
          semantic_owner: 'aurora_orchestration',
        },
      },
    });
    const delegatedLayer =
      beautyExpertV1?.mode === 'exact_product_assist'
        ? 'execution_facing'
        : hasMessages
          ? 'decisioning'
          : null;
    const delegationPlan =
      delegatedLayer === 'execution_facing'
        ? 'call_execution'
        : hasMessages
          ? 'call_decisioning'
          : 'stay_in_layer';
    const updatedContext = {
      ...normalized.context,
      normalized_need: {
        ...(normalized.context?.normalized_need || {}),
        ...(beautyExpertV1?.beauty_intent ? { beauty_request: beautyExpertV1.beauty_intent } : {}),
      },
    };
    return createAuroraOrchestrationOutput({
      context: normalized.context,
      updated_context: updatedContext,
      status: hasMessages ? 'delegated' : 'completed',
      prompt_intent: conversationState.promptIntent,
      conversation_progress: conversationState.conversationProgress,
      early_decision: conversationState.earlyDecision,
      decision_owner: 'aurora_orchestration',
      delegation_plan: delegationPlan,
      next_layer: delegatedLayer,
      beauty_expert_v1: beautyExpertV1,
      next_actions: beautyExpertV1?.next_actions || [],
      orchestration_notes: [
        'milestone0_orchestration_facade',
        ...(beautyExpertV1 ? ['beauty_expert_v1'] : []),
        ...(beautyExpertV1?.mode ? [`beauty_mode:${beautyExpertV1.mode}`] : []),
        ...(conversationState.latestShoppingIntent
          ? [`latest_shopping_intent:${conversationState.latestShoppingIntent}`]
          : []),
        ...(conversationState.latestScenario
          ? [`latest_scenario:${conversationState.latestScenario}`]
          : []),
      ],
    });
  }

  return {
    handleAuroraBeautyOrchestration,
    buildAuroraFindProductsMultiPlan,
    buildGuidanceOnlyClarificationPlan,
    buildGuidanceOnlySearchStatePlan,
    buildGuidanceOnlyCacheSearchPlan,
    buildGuidanceOnlyDirectSupplementPlan,
    buildGuidanceOnlyDirectSupplementOutcome,
    buildGuidanceOnlyCacheSupplementPlan,
    buildGuidanceOnlyCacheSupplementRequest,
    buildGuidanceOnlyCacheSupplementOutcome,
    buildGuidanceOnlyCacheSupplementErrorOutcome,
    buildGuidanceOnlyCacheSupplementSelection,
    buildGuidanceOnlyCacheResponseArtifacts,
    buildGuidanceOnlyCacheTransitionPlan,
    applyGuidanceOnlyCacheRouteDebugOutcome,
    buildGuidanceOnlyCacheEarlyDecisionResponse,
    buildGuidanceOnlyCacheEarlyDecisionOutcome,
    buildGuidanceOnlyCacheStrictEmptyResponse,
    buildGuidanceOnlyCacheStrictEmptyOutcome,
    buildGuidanceOnlyCacheHitOutcome,
    buildGuidanceOnlyCacheDiagnosedResponse,
    buildGuidanceOnlyCacheMissPlan,
    buildGuidanceOnlyCacheMissLoggingArtifacts,
    buildGuidanceOnlyCacheResolverFallbackPlan,
    buildGuidanceOnlyCacheResolverFallbackOutcome,
    buildGuidanceOnlyCacheResolverFallbackFailureArtifacts,
    buildGuidanceOnlyCacheFailureArtifacts,
    applyGuidanceOnlyHitQualityOutcome,
    loadGuidanceOnlySessionState,
    persistGuidanceOnlySessionState,
    buildGuidanceOnlyHitQualityInputs,
    buildGuidanceOnlySearchDecisionPatches,
    normalizeGuidanceOnlyInvokeSearchResponse,
    finalizeInvokeFindProductsMultiResponse,
    finalizeGuidanceOnlySearchResponse,
  };
}

const defaultAuroraBeautyOrchestrationRuntime = createAuroraBeautyOrchestrationRuntime();

module.exports = {
  createAuroraBeautyOrchestrationRuntime,
  handleAuroraBeautyOrchestration:
    defaultAuroraBeautyOrchestrationRuntime.handleAuroraBeautyOrchestration,
};
