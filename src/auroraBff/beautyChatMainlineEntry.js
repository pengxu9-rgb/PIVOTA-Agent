function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function uniqueBeautyMainlineStrings(values = [], max = 8) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const token = String(value || '').replace(/\s+/g, ' ').trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

function collectBeautyExactProductQueryTerms(beautyRequestContext = null) {
  const request =
    beautyRequestContext && typeof beautyRequestContext === 'object' && !Array.isArray(beautyRequestContext)
      ? beautyRequestContext
      : null;
  const productContext =
    request?.product_context && typeof request.product_context === 'object' && !Array.isArray(request.product_context)
      ? request.product_context
      : null;
  if (!productContext) return [];
  const brand = pickFirstTrimmed(productContext.brand, productContext.brand_name);
  const title = pickFirstTrimmed(
    productContext.product_name,
    productContext.name,
    productContext.title,
    productContext.display_name,
    productContext.canonical_product_ref,
    productContext.product_ref,
  );
  return uniqueBeautyMainlineStrings([
    brand && title ? `${brand} ${title}` : '',
    title,
    pickFirstTrimmed(productContext.canonical_product_ref),
    pickFirstTrimmed(productContext.product_ref),
    pickFirstTrimmed(productContext.product_id),
    pickFirstTrimmed(productContext.product_group_id),
  ]);
}

function augmentBeautyExactProductTargetContext(targetContext = null, beautyRequestContext = null) {
  const terms = collectBeautyExactProductQueryTerms(beautyRequestContext);
  if (!terms.length || !isPlainObject(targetContext)) return targetContext;
  const prependTerms = (values = []) => uniqueBeautyMainlineStrings([
    ...terms,
    ...(Array.isArray(values) ? values : []),
  ], 12);
  const augmentRole = (role) => {
    if (!isPlainObject(role)) return role;
    return {
      ...role,
      query_terms: prependTerms(role.query_terms),
      exact_product_anchor_query_terms: terms.slice(0, 6),
    };
  };
  const semanticPlan = isPlainObject(targetContext.semantic_plan)
    ? {
        ...targetContext.semantic_plan,
      }
    : null;
  if (semanticPlan && Array.isArray(semanticPlan.core_roles)) {
    semanticPlan.core_roles = semanticPlan.core_roles.map(augmentRole);
  }
  return {
    ...targetContext,
    exact_product_anchor_query_terms: terms.slice(0, 6),
    framework_roles: Array.isArray(targetContext.framework_roles)
      ? targetContext.framework_roles.map(augmentRole)
      : targetContext.framework_roles,
    support_roles: Array.isArray(targetContext.support_roles)
      ? targetContext.support_roles.map(augmentRole)
      : targetContext.support_roles,
    ...(semanticPlan ? { semantic_plan: semanticPlan } : {}),
  };
}

function shouldUseBeautyChatMainlinePlanner(targetContext = null) {
  const entryType = String(targetContext?.entry_type || 'chat').trim().toLowerCase();
  if (entryType && entryType !== 'chat') return false;
  const intentMode = String(
    pickFirstTrimmed(
      targetContext?.intent_mode,
      targetContext?.semantic_plan?.intent_mode,
    ) || '',
  ).trim().toLowerCase();
  if (new Set(['exact_product', 'specific_product', 'pdp_open']).has(intentMode)) return false;
  if (intentMode === 'generic_concern') return true;
  if (intentMode === 'explicit_role' || intentMode === 'generic') return true;
  if (targetContext?.step_aware_intent && targetContext?.resolved_target_step) return true;
  if (Array.isArray(targetContext?.framework_roles) && targetContext.framework_roles.length > 0) return true;
  return hasBeautyChatMainlineSemanticPlannerContract(targetContext);
}

function resolveBeautyChatSelectorComparisonMode(targetContext = null) {
  const semanticPlan =
    targetContext?.semantic_plan && typeof targetContext.semantic_plan === 'object' && !Array.isArray(targetContext.semantic_plan)
      ? targetContext.semantic_plan
      : null;
  return String(
    pickFirstTrimmed(
      targetContext?.comparison_mode,
      semanticPlan?.comparison_mode,
      semanticPlan?.selection_constraints?.comparison_mode,
      targetContext?.routine_mode,
      semanticPlan?.routine_mode,
    ) || '',
  ).trim().toLowerCase();
}

function hasBeautyChatMainlineSemanticPlannerContract(targetContext = null) {
  const semanticPlan =
    targetContext?.semantic_plan && typeof targetContext.semantic_plan === 'object' && !Array.isArray(targetContext.semantic_plan)
      ? targetContext.semantic_plan
      : null;
  if (!semanticPlan) return false;
  if (Array.isArray(semanticPlan.core_roles) && semanticPlan.core_roles.length > 0) return true;
  if (pickFirstTrimmed(targetContext?.primary_role_id, semanticPlan?.primary_role_id)) return true;
  if (pickFirstTrimmed(targetContext?.resolved_target_step)) return true;
  return Boolean(resolveBeautyChatSelectorComparisonMode(targetContext));
}

function resolveBeautyChatSelectorReserveMs({
  targetContext = null,
  handoffRewriteReserveMs = 0,
} = {}) {
  const comparisonMode = resolveBeautyChatSelectorComparisonMode(targetContext);
  if (comparisonMode === 'same_role_comparison' || comparisonMode === 'same_role') {
    return clampBeautyMainlineStageBudgetMs(Math.min(handoffRewriteReserveMs, 1600), {
      minMs: 1200,
      maxMs: 1600,
      fallbackMs: 1500,
    });
  }
  return handoffRewriteReserveMs;
}

function canUseDeterministicBeautyChatPlannerFallback(targetContext = null) {
  return false;
}

function looksLikeBeautyChatContextualRecoContinuationMessage(message = '', latestRecoContextFromSession = null) {
  const context = isPlainObject(latestRecoContextFromSession) ? latestRecoContextFromSession : null;
  if (!context) return false;
  if (String(context.intent || '').trim().toLowerCase() !== 'reco_products') return false;
  const text = String(message || '').trim();
  if (!text) return false;
  return /\b(given that|based on that|with that|for that|which (?:card|one|option)|these (?:cards|options)|compare (?:the )?(?:cards|options)|prioriti[sz]e|why over the others?|over the others?|first buy change|should the first buy change|tell me which one|what should i do next|if there are not enough|not enough strong options|under \$?\d+|\$\d+|budget|affordable|fragrance|white cast|foundation|makeup|shiny|greasy|retinoid|barrier|dry heat|high[-\s]?uv|commute)\b/i.test(text)
    || /(基于这些|既然这样|这样的话|哪张卡|哪个更优先|优先哪个|对比一下|和其他相比|下一步怎么做|预算|香精|粉底|底妆|泛白|油光|屏障|刺激|高紫外线|通勤)/i.test(text);
}

function buildBeautyChatContextualRecoContinuationText({
  message = '',
  latestRecoContextFromSession = null,
} = {}) {
  const current = String(message || '').replace(/\s+/g, ' ').trim();
  const context = isPlainObject(latestRecoContextFromSession) ? latestRecoContextFromSession : null;
  if (!current || !context) return current;
  if (!looksLikeBeautyChatContextualRecoContinuationMessage(current, context)) return current;
  const rankedTargets = Array.isArray(context.ranked_targets)
    ? context.ranked_targets.filter(isPlainObject).slice(0, 4)
    : [];
  const targetSummary = uniqueBeautyMainlineStrings([
    pickFirstTrimmed(context.primary_target_id),
    pickFirstTrimmed(context.ingredient_query, context.query, context.goal),
    ...rankedTargets.map((target) => pickFirstTrimmed(
      target.target_id,
      target.ingredient_query,
      target.resolved_target_step,
    )),
  ], 8).join(', ');
  const priorMessage = pickFirstTrimmed(
    context.message,
    context.request_text,
    context.user_request,
  );
  return [
    priorMessage ? `Previous recommendation request: ${priorMessage}` : '',
    targetSummary ? `Previous recommendation targets: ${targetSummary}` : '',
    `Current follow-up constraints/question: ${current}`,
  ].filter(Boolean).join('\n');
}

function normalizeBeautyChatPlannerTargetContext(baseTargetContext = null, plannerTargetContext = null) {
  if (
    plannerTargetContext &&
    typeof plannerTargetContext === 'object' &&
    !Array.isArray(plannerTargetContext) && (
      (Array.isArray(plannerTargetContext.framework_roles) && plannerTargetContext.framework_roles.length > 0)
      || hasBeautyChatMainlineSemanticPlannerContract(plannerTargetContext)
    )
  ) {
    return plannerTargetContext;
  }
  return baseTargetContext;
}

function buildBeautyChatPlannerMeta(trace = null) {
  const plannerTrace =
    trace && typeof trace === 'object' && !Array.isArray(trace)
      ? trace
      : null;
  if (!plannerTrace) return {};
  return {
    chat_planner_used: plannerTrace.planner_used === true,
    chat_planner_fallback_used: plannerTrace.planner_fallback_used === true,
    ...(pickFirstTrimmed(plannerTrace.planner_source) ? { chat_planner_source: pickFirstTrimmed(plannerTrace.planner_source) } : {}),
    ...(pickFirstTrimmed(plannerTrace.planner_failure_class) ? { chat_planner_failure_class: pickFirstTrimmed(plannerTrace.planner_failure_class) } : {}),
    ...(pickFirstTrimmed(plannerTrace.planner_route) ? { chat_planner_route: pickFirstTrimmed(plannerTrace.planner_route) } : {}),
    ...(pickFirstTrimmed(plannerTrace.planner_selection_source) ? { chat_planner_selection_source: pickFirstTrimmed(plannerTrace.planner_selection_source) } : {}),
  };
}

function buildBeautyChatAnalysisContextUsageMeta(latestRecoContextFromSession = null) {
  const context =
    latestRecoContextFromSession &&
    typeof latestRecoContextFromSession === 'object' &&
    !Array.isArray(latestRecoContextFromSession)
      ? latestRecoContextFromSession
      : null;
  if (!context) return null;
  const sourceDetail = pickFirstTrimmed(
    context.source_detail,
    context.trigger_source,
    context.context_origin,
  );
  const contextOrigin = pickFirstTrimmed(context.context_origin);
  const artifactId = pickFirstTrimmed(context.artifact_id, context.artifactId);
  const isAnalysisContext = Boolean(
    sourceDetail === 'analysis_handoff' ||
      contextOrigin === 'routine_audit_v1' ||
      artifactId,
  );
  if (!isAnalysisContext) return null;
  const rankedTargets = Array.isArray(context.ranked_targets)
    ? context.ranked_targets.filter((target) => target && typeof target === 'object' && !Array.isArray(target))
    : [];
  const hardContextFieldsUsed = [];
  if (artifactId) hardContextFieldsUsed.push('latest_artifact_id');
  if (pickFirstTrimmed(context.goal)) hardContextFieldsUsed.push('active_goals');
  if (pickFirstTrimmed(context.resolved_target_step, context.target_step, context.step)) {
    hardContextFieldsUsed.push('target_step');
  }
  if (pickFirstTrimmed(context.ingredient_query, context.query)) hardContextFieldsUsed.push('ingredient_query');
  if (rankedTargets.length > 0) hardContextFieldsUsed.push('ranked_targets');
  return {
    snapshot_present: Boolean(artifactId),
    context_source_mode: sourceDetail || 'analysis_handoff',
    analysis_context_available: true,
    snapshot_fields_used: [],
    hard_context_fields_used: hardContextFieldsUsed,
    soft_context_fields_used: [],
    explicit_override_applied: false,
    context_mode: 'latest_reco_context',
    adapter_version: 'beauty_chat_mainline_analysis_context_v1',
    request_context_signature_version: 'request_context_signature_v1',
    candidate_pool_signature_version: 'candidate_pool_signature_v1',
    strictness_source: 'beauty_chat_mainline',
    minimum_recommendation_context_satisfied: Boolean(
      rankedTargets.length > 0 ||
        pickFirstTrimmed(context.resolved_target_step, context.ingredient_query, context.query),
    ),
    context_origin: contextOrigin || null,
    artifact_id_present: Boolean(artifactId),
    ranked_target_count: rankedTargets.length,
    primary_target_id: pickFirstTrimmed(context.primary_target_id) || null,
  };
}

function createBeautyChatMainlineBudget({ budgetMs = 0 } = {}) {
  const requestedBudgetMs =
    Number.isFinite(Number(budgetMs)) && Number(budgetMs) > 0
      ? Math.trunc(Number(budgetMs))
      : 13000;
  const normalizedBudgetMs = Math.max(9000, Math.min(22000, requestedBudgetMs));
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + normalizedBudgetMs;
  return {
    startedAtMs,
    deadlineAtMs,
    budgetMs: normalizedBudgetMs,
    getRemainingMs(reserveMs = 0) {
      const reserve =
        Number.isFinite(Number(reserveMs)) && Number(reserveMs) > 0
          ? Math.trunc(Number(reserveMs))
          : 0;
      return Math.max(0, deadlineAtMs - Date.now() - reserve);
    },
  };
}

function clampBeautyMainlineStageBudgetMs(value, { minMs = 0, maxMs = 0, fallbackMs = 0 } = {}) {
  const normalized = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : Math.trunc(Number(fallbackMs) || 0);
  const min = Math.max(0, Math.trunc(Number(minMs) || 0));
  const max = Math.max(min, Math.trunc(Number(maxMs) || min));
  return Math.max(min, Math.min(max, normalized));
}

function withBeautyMainlineTimeout(promise, timeoutMs, code = 'BEAUTY_MAINLINE_TIMEOUT') {
  const hardTimeoutMs =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.max(1, Math.trunc(Number(timeoutMs)))
      : 1;
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${code} after ${hardTimeoutMs}ms`);
        err.code = code;
        reject(err);
      }, hardTimeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function resolveBeautyChatPlannerDeadlineAtMs({
  nowMs = Date.now(),
  handoffDeadlineAtMs = 0,
  retrievalReserveMs = 0,
  budgetMs = 0,
} = {}) {
  const normalizedNowMs = Number.isFinite(Number(nowMs)) ? Math.trunc(Number(nowMs)) : Date.now();
  const normalizedHandoffDeadlineAtMs = Number.isFinite(Number(handoffDeadlineAtMs))
    ? Math.trunc(Number(handoffDeadlineAtMs))
    : normalizedNowMs;
  const normalizedRetrievalReserveMs = clampBeautyMainlineStageBudgetMs(retrievalReserveMs, {
    minMs: 2500,
    maxMs: 3500,
    fallbackMs: 3000,
  });
  const budgetCapMs = clampBeautyMainlineStageBudgetMs(Math.trunc(Number(budgetMs || 0) * 0.55), {
    minMs: 3500,
    maxMs: 9500,
    fallbackMs: 6500,
  });
  const latestDeadlineBeforeRetrieval = normalizedHandoffDeadlineAtMs - normalizedRetrievalReserveMs;
  return Math.min(
    normalizedNowMs + budgetCapMs,
    latestDeadlineBeforeRetrieval,
  );
}

function pickBeautyRecoProductId(row) {
  return pickFirstTrimmed(row?.product_id, row?.productId, row?.sku?.product_id, row?.sku?.productId);
}

function pickBeautyRecoProductTitle(row) {
  return pickFirstTrimmed(
    row?.display_name,
    row?.displayName,
    row?.name,
    row?.title,
    row?.sku?.display_name,
    row?.sku?.displayName,
    row?.sku?.name,
    row?.sku?.title,
  );
}

function buildBeautyChatSelectorSelectionContract({
  existingSelection = null,
  orderedRecommendations = [],
  selectionOwner = '',
} = {}) {
  const selectedProductIds = [];
  const selectedTitles = [];
  const seenIds = new Set();
  for (const row of Array.isArray(orderedRecommendations) ? orderedRecommendations : []) {
    const productId = pickBeautyRecoProductId(row);
    if (!productId || seenIds.has(productId)) continue;
    seenIds.add(productId);
    selectedProductIds.push(productId);
    const title = pickBeautyRecoProductTitle(row);
    if (title) selectedTitles.push(title);
  }
  if (!selectedProductIds.length) return null;
  const existing =
    existingSelection && typeof existingSelection === 'object' && !Array.isArray(existingSelection)
      ? existingSelection
      : {};
  return {
    ...existing,
    selection_owner: pickFirstTrimmed(selectionOwner, existing.selection_owner) || null,
    selected_product_ids: selectedProductIds,
    selected_titles: selectedTitles,
    selection_signature: null,
    mainline_status: pickFirstTrimmed(existing.mainline_status, 'grounded_success') || 'grounded_success',
  };
}

function patchBeautyChatHandoffSelection({
  handoff = null,
  orderedRecommendations = [],
  selectionContract = null,
  selectionOwner = '',
} = {}) {
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) return handoff;
  const nextSelection = buildBeautyChatSelectorSelectionContract({
    existingSelection: selectionContract,
    orderedRecommendations,
    selectionOwner,
  });
  if (!nextSelection) return handoff;
  const searchResult =
    handoff.searchResult && typeof handoff.searchResult === 'object' && !Array.isArray(handoff.searchResult)
      ? handoff.searchResult
      : {};
  const metadata =
    searchResult.metadata && typeof searchResult.metadata === 'object' && !Array.isArray(searchResult.metadata)
      ? searchResult.metadata
      : {};
  const searchStageLedger =
    metadata.search_stage_ledger &&
    typeof metadata.search_stage_ledger === 'object' &&
    !Array.isArray(metadata.search_stage_ledger)
      ? metadata.search_stage_ledger
      : {};
  return {
    ...handoff,
    recommendations: orderedRecommendations,
    searchResult: {
      ...searchResult,
      final_selection: nextSelection,
      metadata: {
        ...metadata,
        final_selection: nextSelection,
        search_stage_ledger: {
          ...searchStageLedger,
          final_selection: nextSelection,
        },
      },
    },
  };
}

function classifyBeautyChatPlannerBlock(trace = null, semanticPlan = null) {
  const plannerTrace =
    trace && typeof trace === 'object' && !Array.isArray(trace)
      ? trace
      : null;
  const plannerFailureClass = pickFirstTrimmed(plannerTrace?.planner_failure_class).toLowerCase();
  const selectionOwnerState = pickFirstTrimmed(semanticPlan?.selection_owner_state).toLowerCase();
  if (!plannerFailureClass && selectionOwnerState !== 'fallback') return null;
  return {
    fallback_reason: 'beauty_mainline_planner_blocked',
    notice_reason: 'planner_untrusted',
    mainline_status: 'needs_more_context',
    source_mode: 'framework_mainline',
    products_empty_reason: 'planner_untrusted',
    telemetry_failure_reason: plannerFailureClass === 'timeout' ? 'planner_timeout' : 'planner_untrusted',
  };
}

function shouldClarifyBeautyChatBeforeHandoff({
  message = '',
  profileSummary = null,
  latestRecoContextFromSession = null,
  analysisContextUsageMeta = null,
} = {}) {
  const normalizedMessage = String(message || '').trim().toLowerCase();
  if (!normalizedMessage) return false;
  const explicitCategoryPattern =
    /\b(sunscreen|spf|moisturizer|moisturiser|cleanser|serum|toner|essence|retinol|retinoid|mask|balm|oil|cream|lotion)\b/;
  const genericGuidancePattern =
    /\bwhat should i (use|buy)\b(?:[^.]{0,24}\bfor my skin\b)?|\bhelp my skin\b|\bfor my skin\b/;
  const explicitSkinSignalPattern =
    /\b(oily|dry|sensitive|combination|combo|acne-prone|acne prone|dehydrated|barrier|rosacea|eczema)\b/;
  if (!genericGuidancePattern.test(normalizedMessage)) return false;
  if (explicitCategoryPattern.test(normalizedMessage)) return false;
  if (explicitSkinSignalPattern.test(normalizedMessage)) return false;
  const profileSkinType = pickFirstTrimmed(
    profileSummary?.skinType,
    profileSummary?.skin_type,
    profileSummary?.skin_type_tendency,
  );
  if (profileSkinType) return false;
  if (analysisContextUsageMeta?.analysis_context_available === true) return false;
  if (
    latestRecoContextFromSession &&
    typeof latestRecoContextFromSession === 'object' &&
    !Array.isArray(latestRecoContextFromSession)
  ) {
    return false;
  }
  return true;
}

function elapsedBeautyChatStageMs(startedAtMs = 0) {
  const started = Number(startedAtMs);
  if (!Number.isFinite(started) || started <= 0) return 0;
  return Math.max(0, Date.now() - started);
}

function buildBeautyChatMainlineTimingLedger({
  budgetMs = 0,
  plannerMs = 0,
  handoffMs = 0,
  selectorMs = 0,
  rewriteMs = 0,
  totalElapsedMs = 0,
  plannerTrace = null,
  selectorTrace = null,
  selectorApplied = null,
  selectorSkipReason = '',
  rewrite = null,
} = {}) {
  return {
    owner: 'beauty_chat_mainline_entry',
    budget_ms: Number.isFinite(Number(budgetMs)) ? Math.max(0, Math.trunc(Number(budgetMs))) : 0,
    planner_ms: Number.isFinite(Number(plannerMs)) ? Math.max(0, Math.trunc(Number(plannerMs))) : 0,
    handoff_ms: Number.isFinite(Number(handoffMs)) ? Math.max(0, Math.trunc(Number(handoffMs))) : 0,
    selector_ms: Number.isFinite(Number(selectorMs)) ? Math.max(0, Math.trunc(Number(selectorMs))) : 0,
    rewrite_ms: Number.isFinite(Number(rewriteMs)) ? Math.max(0, Math.trunc(Number(rewriteMs))) : 0,
    total_elapsed_ms: Number.isFinite(Number(totalElapsedMs))
      ? Math.max(0, Math.trunc(Number(totalElapsedMs)))
      : 0,
    planner_used: plannerTrace?.planner_used === true,
    planner_fallback_used: plannerTrace?.planner_fallback_used === true,
    selector_attempted: Boolean(selectorTrace),
    selector_applied: pickFirstTrimmed(selectorApplied?.winner_source).toLowerCase() === 'llm_selector',
    ...(pickFirstTrimmed(selectorSkipReason) ? { selector_skip_reason: pickFirstTrimmed(selectorSkipReason) } : {}),
    rewrite_attempted: rewrite?.attempted === true,
    rewrite_llm_used: rewrite?.llm_used === true,
    rewrite_attempt_count: Number.isFinite(Number(rewrite?.attempt_count))
      ? Math.max(0, Math.trunc(Number(rewrite.attempt_count)))
      : 0,
  };
}

function attachBeautyChatMainlineTimingLedger(payload = null, timingLedger = null) {
  if (!isPlainObject(payload) || !isPlainObject(timingLedger)) return;
  const metadata = isPlainObject(payload.metadata) ? payload.metadata : {};
  const searchStageLedger =
    isPlainObject(metadata.search_stage_ledger) ? metadata.search_stage_ledger : {};
  payload.metadata = {
    ...metadata,
    search_stage_ledger: {
      ...searchStageLedger,
      chat_mainline_timing: timingLedger,
    },
  };
}

function createBeautyChatMainlineEntryRuntime(deps = {}) {
  const {
    RECO_CATALOG_GROUNDED_ENABLED = false,
    RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS = 0,
    AURORA_BFF_CHAT_RECO_BUDGET_MS = 18000,
    AURORA_RECO_ASSISTANT_REWRITE_TIMEOUT_MS = 4500,
    BEAUTY_DISCOVERY_MAINLINE_OWNER = 'shopping_agent_beauty_mainline',
    resolveRecommendationTargetContext,
    summarizeProfileForContext,
    mergeIngredientRecoContextValue,
    appendLatestRecoContextToSessionPatch,
    extractRecoFinalSelectionContract,
    maybeRewriteRecoAssistantTextWithLlm,
    makeAssistantMessage,
    buildEnvelope,
    makeEvent,
    applyRecoContractToRecoRequestedEvents,
    buildRecoRequestedEventData,
    normalizeRecoSourceDetail,
    stateChangeAllowed,
    handoffRecoToBeautyMainlineSearch,
    buildRecoPayloadFromBeautyMainlineHandoff,
    classifyBeautyMainlineHandoffFallback,
    buildBeautyMainlineHandoffFallbackEnvelope,
    looksLikeRecommendationRequest,
    runConcernSemanticPlanner,
    buildConcernTargetContextFromSemanticPlan,
    runConcernSelectorRace,
    applyConcernSelectorRaceOrdering,
    sendChatEnvelope,
  } = deps;

  function isBeautyOwnedChatRecoRequest({
    typedRecoOwnershipKeepsV1Mainline = false,
    forceUpstreamAfterPendingAbandon = false,
    ingredientDrivenRecommendationRequested = false,
    recoEntrySourceDetail = '',
    targetContext = null,
    message = '',
  } = {}) {
    if (!RECO_CATALOG_GROUNDED_ENABLED) return false;
    if (forceUpstreamAfterPendingAbandon) return false;
    if (ingredientDrivenRecommendationRequested) return false;
    if (recoEntrySourceDetail === 'travel_handoff') return false;
    if (typedRecoOwnershipKeepsV1Mainline) return true;
    if (targetContext?.step_aware_intent && targetContext?.resolved_target_step) return true;
    if (Array.isArray(targetContext?.framework_roles) && targetContext.framework_roles.length > 0) return true;
    return typeof looksLikeRecommendationRequest === 'function'
      ? looksLikeRecommendationRequest(message)
      : false;
  }

  async function maybeHandleBeautyOwnedChatReco({
    ctx,
    logger,
    message = '',
    typedRecoOwnershipKeepsV1Mainline = false,
    forceUpstreamAfterPendingAbandon = false,
    ingredientDrivenRecommendationRequested = false,
    recoEntrySourceDetail = '',
    latestRecoContextFromSession = null,
    profile = null,
    requestContextProfilePatch = null,
    recentLogs = [],
    includeAlternatives = false,
    actionId = '',
    beautyRequestContext = null,
    shouldAutoRerunRecommendationsFromProfilePatch = false,
    debugUpstream = false,
  } = {}) {
    const recoRequestMessage = String(message || '').trim();
    const contextualRecoContinuation = looksLikeBeautyChatContextualRecoContinuationMessage(
      recoRequestMessage || message,
      latestRecoContextFromSession,
    );
    const contextualPlannerRequestText = buildBeautyChatContextualRecoContinuationText({
      message: recoRequestMessage || message,
      latestRecoContextFromSession,
    });
    const plannerAndRetrievalRequestText = contextualRecoContinuation
      ? contextualPlannerRequestText
      : pickFirstTrimmed(recoRequestMessage, message);
    const priorRecoRequestText = contextualRecoContinuation
      ? pickFirstTrimmed(
        latestRecoContextFromSession?.message,
        latestRecoContextFromSession?.request_text,
        latestRecoContextFromSession?.user_request,
      )
      : '';
    const effectiveProfile =
      (requestContextProfilePatch && typeof requestContextProfilePatch === 'object' && !Array.isArray(requestContextProfilePatch))
        || (profile && typeof profile === 'object' && !Array.isArray(profile))
        ? {
          ...(profile && typeof profile === 'object' && !Array.isArray(profile)
            ? profile
            : {}),
          ...(requestContextProfilePatch && typeof requestContextProfilePatch === 'object' && !Array.isArray(requestContextProfilePatch)
            ? requestContextProfilePatch
            : {}),
        }
        : profile;
    const profileSummary = summarizeProfileForContext(effectiveProfile);
    const hardPathRecoFocusForMainline = pickFirstTrimmed(
      latestRecoContextFromSession?.resolved_target_step,
      latestRecoContextFromSession?.ingredient_query,
      latestRecoContextFromSession?.goal,
    );
    const hardPathRecoTargetContext = augmentBeautyExactProductTargetContext(
      resolveRecommendationTargetContext({
        explicitStep: pickFirstTrimmed(
          latestRecoContextFromSession?.target_step,
          latestRecoContextFromSession?.step,
          latestRecoContextFromSession?.resolved_target_step,
        ),
        focus: hardPathRecoFocusForMainline,
        text: plannerAndRetrievalRequestText || recoRequestMessage || message,
        entryType: 'chat',
        profileSummary,
      }),
      beautyRequestContext,
    );
    const hardPathBeautyRecoOwnership = isBeautyOwnedChatRecoRequest({
      typedRecoOwnershipKeepsV1Mainline,
      forceUpstreamAfterPendingAbandon,
      ingredientDrivenRecommendationRequested,
      recoEntrySourceDetail,
        targetContext: hardPathRecoTargetContext,
        message,
    });
    if (!hardPathBeautyRecoOwnership) {
      return { handled: false, targetContext: hardPathRecoTargetContext };
    }

    const hardPathBudget = createBeautyChatMainlineBudget({
      budgetMs: AURORA_BFF_CHAT_RECO_BUDGET_MS,
    });
    const hardPathTiming = {
      plannerMs: 0,
      handoffMs: 0,
      selectorMs: 0,
      rewriteMs: 0,
    };
    const rewriteReserveMs = Math.max(
      3500,
      Math.min(
        5500,
        Math.max(
          Math.trunc(hardPathBudget.budgetMs * 0.3),
          Number.isFinite(Number(AURORA_RECO_ASSISTANT_REWRITE_TIMEOUT_MS))
            ? Math.trunc(Number(AURORA_RECO_ASSISTANT_REWRITE_TIMEOUT_MS)) + 500
            : 0,
        ),
      ),
    );
    const handoffRewriteReserveMs = clampBeautyMainlineStageBudgetMs(rewriteReserveMs, {
      minMs: 1200,
      maxMs: 2500,
      fallbackMs: 2000,
    });
    const handoffDeadlineAtMs = hardPathBudget.deadlineAtMs - handoffRewriteReserveMs;
    const retrievalReserveMs = clampBeautyMainlineStageBudgetMs(RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS, {
      minMs: 2500,
      maxMs: 8000,
      fallbackMs: 5000,
    });
    let hardPathPlannerTrace = null;
    let hardPathPlannerSemanticPlan = null;
    let effectivePlannerTargetContext = hardPathRecoTargetContext;
    const analysisContextUsageMeta = buildBeautyChatAnalysisContextUsageMeta(latestRecoContextFromSession);
    const effectiveRecoEntrySourceDetail =
      analysisContextUsageMeta?.context_source_mode === 'analysis_handoff'
        ? 'analysis_handoff'
        : recoEntrySourceDetail;
    if (
      shouldClarifyBeautyChatBeforeHandoff({
        message: pickFirstTrimmed(recoRequestMessage, message),
        profileSummary,
        latestRecoContextFromSession,
        analysisContextUsageMeta,
      })
    ) {
      return {
        handled: true,
        targetContext: hardPathRecoTargetContext,
        envelope: buildBeautyMainlineHandoffFallbackEnvelope({
          ctx,
          fallback: {
            fallback_reason: 'beauty_mainline_missing_context',
            notice_reason: 'needs_more_context',
            mainline_status: 'needs_more_context',
            products_empty_reason: 'minimum_recommendation_context_unsatisfied',
            telemetry_failure_reason: 'minimum_recommendation_context_unsatisfied',
            source_mode: 'framework_mainline',
          },
          suggestedChips: [],
        }),
      };
    }
    if (
      shouldUseBeautyChatMainlinePlanner(hardPathRecoTargetContext) &&
      typeof runConcernSemanticPlanner === 'function' &&
      typeof buildConcernTargetContextFromSemanticPlan === 'function'
    ) {
      const plannerDeadlineAtMs = resolveBeautyChatPlannerDeadlineAtMs({
        nowMs: Date.now(),
        handoffDeadlineAtMs,
        retrievalReserveMs,
        budgetMs: hardPathBudget.budgetMs,
      });
      if (plannerDeadlineAtMs <= Date.now() + 250) {
        hardPathPlannerTrace = {
          planner_used: false,
          planner_failure_class: 'timeout',
          planner_source: 'budget_guard',
        };
        hardPathPlannerSemanticPlan = {
          selection_owner_state: 'fallback',
        };
      } else {
        const plannerStartedAtMs = Date.now();
        try {
          const plannerTimeoutMs = Math.max(1, plannerDeadlineAtMs - Date.now());
          const concernPlanOut = await withBeautyMainlineTimeout(
            Promise.resolve().then(() => runConcernSemanticPlanner({
              ctx,
              logger,
              requestText: plannerAndRetrievalRequestText,
              focus: hardPathRecoFocusForMainline,
              profileSummary,
              recommendationTaskContext: latestRecoContextFromSession,
              deadlineAtMs: plannerDeadlineAtMs,
            })),
            plannerTimeoutMs,
            'BEAUTY_CHAT_PLANNER_TIMEOUT',
          );
          hardPathPlannerTrace =
            concernPlanOut?.trace && typeof concernPlanOut.trace === 'object' && !Array.isArray(concernPlanOut.trace)
              ? concernPlanOut.trace
              : null;
          const plannerSemanticPlan =
            concernPlanOut?.semanticPlan && typeof concernPlanOut.semanticPlan === 'object' && !Array.isArray(concernPlanOut.semanticPlan)
              ? concernPlanOut.semanticPlan
              : null;
          hardPathPlannerSemanticPlan = plannerSemanticPlan;
          if (plannerSemanticPlan) {
            const plannerTargetContext = augmentBeautyExactProductTargetContext(
              buildConcernTargetContextFromSemanticPlan(plannerSemanticPlan, {
                text: plannerAndRetrievalRequestText,
                focus: hardPathRecoFocusForMainline,
                entryType: 'chat',
              }),
              beautyRequestContext,
            );
            effectivePlannerTargetContext = normalizeBeautyChatPlannerTargetContext(
              hardPathRecoTargetContext,
              isPlainObject(plannerTargetContext)
                ? {
                    ...plannerTargetContext,
                    mainline_fallback_policy: 'strict_no_runtime_fallback',
                    semantic_planner_required: true,
                  }
                : plannerTargetContext,
            );
          }
        } catch (err) {
          const errMessage = String(err?.message || err || '').trim();
          const failureClass =
            /timeout/i.test(errMessage) || String(err?.code || '').trim().toUpperCase() === 'ECONNABORTED'
              ? 'timeout'
              : 'planner_untrusted';
          hardPathPlannerTrace = {
            ...(hardPathPlannerTrace && typeof hardPathPlannerTrace === 'object' ? hardPathPlannerTrace : {}),
            planner_used: hardPathPlannerTrace?.planner_used === true,
            planner_failure_class: failureClass,
          };
          hardPathPlannerSemanticPlan = {
            selection_owner_state: 'fallback',
          };
          logger?.warn(
            {
              request_id: ctx?.request_id,
              trace_id: ctx?.trace_id,
              err: err?.message || String(err),
            },
            'aurora bff: beauty chat mainline planner failed; fail-closed before deterministic target fallback',
          );
        } finally {
          hardPathTiming.plannerMs = elapsedBeautyChatStageMs(plannerStartedAtMs);
        }
      }
    }

    if (shouldUseBeautyChatMainlinePlanner(hardPathRecoTargetContext)) {
      const plannerBlock = classifyBeautyChatPlannerBlock(
        hardPathPlannerTrace,
        hardPathPlannerSemanticPlan,
      );
      if (plannerBlock) {
        if (!canUseDeterministicBeautyChatPlannerFallback(hardPathRecoTargetContext)) {
          return {
            handled: true,
            targetContext: hardPathRecoTargetContext,
            envelope: buildBeautyMainlineHandoffFallbackEnvelope({
              ctx,
              fallback: {
                ...plannerBlock,
                fallback_or_gate_blocked: true,
                planner_failure_class: pickFirstTrimmed(hardPathPlannerTrace?.planner_failure_class) || 'planner_untrusted',
              },
              suggestedChips: [],
            }),
          };
        }
        hardPathPlannerTrace = {
          ...(hardPathPlannerTrace && typeof hardPathPlannerTrace === 'object' ? hardPathPlannerTrace : {}),
          planner_fallback_used: true,
          planner_source:
            pickFirstTrimmed(
              hardPathPlannerTrace?.planner_source,
              'deterministic_target_context_fallback',
            ) || 'deterministic_target_context_fallback',
          planner_selection_source:
            pickFirstTrimmed(
              hardPathPlannerTrace?.planner_selection_source,
              'deterministic_target_context_fallback',
            ) || 'deterministic_target_context_fallback',
        };
        hardPathPlannerSemanticPlan =
          hardPathRecoTargetContext?.semantic_plan &&
          typeof hardPathRecoTargetContext.semantic_plan === 'object' &&
          !Array.isArray(hardPathRecoTargetContext.semantic_plan)
            ? hardPathRecoTargetContext.semantic_plan
            : hardPathPlannerSemanticPlan;
        effectivePlannerTargetContext = hardPathRecoTargetContext;
      }
    }

    let hardPathHandoff = null;
    let hardPathHandoffErr = null;
    const handoffStartedAtMs = Date.now();
    try {
      const handoffStageTimeoutMs = Math.max(0, handoffDeadlineAtMs - Date.now());
      if (handoffStageTimeoutMs <= 150) {
        const err = new Error(`BEAUTY_MAINLINE_HANDOFF_TIMEOUT after ${handoffStageTimeoutMs}ms`);
        err.code = 'BEAUTY_MAINLINE_HANDOFF_TIMEOUT';
        throw err;
      }
      hardPathHandoff = await withBeautyMainlineTimeout(
        handoffRecoToBeautyMainlineSearch({
          ctx,
          logger,
          primaryQuery: plannerAndRetrievalRequestText,
          fallbackMessage: message,
          targetContext: effectivePlannerTargetContext,
          fallbackFocus: hardPathRecoFocusForMainline,
          profileSummary,
          deadlineAtMs: handoffDeadlineAtMs,
          debug: debugUpstream,
          timeoutMs: RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS,
          minTimeoutMs: RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS,
        }),
        handoffStageTimeoutMs,
        'BEAUTY_MAINLINE_HANDOFF_TIMEOUT',
      );
    } catch (err) {
      hardPathHandoffErr = err;
      logger?.warn(
        {
          request_id: ctx?.request_id,
          trace_id: ctx?.trace_id,
          err: err?.message || String(err),
        },
        'aurora bff: beauty mainline hard branch failed',
      );
    } finally {
      hardPathTiming.handoffMs = elapsedBeautyChatStageMs(handoffStartedAtMs);
    }

    const hardPathRecommendations = Array.isArray(hardPathHandoff?.recommendations)
      ? hardPathHandoff.recommendations
      : [];
    if (hardPathRecommendations.length > 0) {
      const effectiveHandoffTargetContext =
        hardPathHandoff?.targetContext &&
        typeof hardPathHandoff.targetContext === 'object' &&
        !Array.isArray(hardPathHandoff.targetContext)
          ? hardPathHandoff.targetContext
          : hardPathRecoTargetContext;
      const hardPathSelectionContract = extractRecoFinalSelectionContract(
        hardPathHandoff.searchResult,
      );
      const hardPathSelectionOwner =
        pickFirstTrimmed(
          hardPathHandoff?.searchResult?.decision_owner,
          hardPathSelectionContract?.selection_owner,
          BEAUTY_DISCOVERY_MAINLINE_OWNER,
        ) || BEAUTY_DISCOVERY_MAINLINE_OWNER;
      let effectiveHardPathHandoff = hardPathHandoff;
      let hardPathSelectorTrace = null;
      let hardPathSelectorApplied = null;
      let hardPathSelectorSkipReason = '';
      const hardPathSelectorSemanticPlan =
        effectiveHandoffTargetContext?.semantic_plan &&
        typeof effectiveHandoffTargetContext.semantic_plan === 'object' &&
        !Array.isArray(effectiveHandoffTargetContext.semantic_plan)
          ? effectiveHandoffTargetContext.semantic_plan
          : hardPathPlannerSemanticPlan;
      const selectorRewriteReserveMs = resolveBeautyChatSelectorReserveMs({
        targetContext: effectiveHandoffTargetContext,
        handoffRewriteReserveMs,
      });
      const selectorLeadTimeMs =
        selectorRewriteReserveMs <= 1600
          ? 700
          : 1200;
      const selectorDeadlineAtMs = Math.max(
        Date.now() + 250,
        hardPathBudget.deadlineAtMs - selectorRewriteReserveMs,
      );
      const selectorPlannerEligible = shouldUseBeautyChatMainlinePlanner(effectiveHandoffTargetContext);
      const selectorDepsReady =
        typeof runConcernSelectorRace === 'function' &&
        typeof applyConcernSelectorRaceOrdering === 'function';
      const selectorSemanticPlanReady =
        hardPathSelectorSemanticPlan &&
        typeof hardPathSelectorSemanticPlan === 'object' &&
        !Array.isArray(hardPathSelectorSemanticPlan);
      const selectorRecommendationCountReady = hardPathRecommendations.length > 1;
      const selectorBudgetReady =
        hardPathBudget.getRemainingMs(selectorRewriteReserveMs + selectorLeadTimeMs) > 150;
      if (
        selectorPlannerEligible &&
        selectorDepsReady &&
        selectorSemanticPlanReady &&
        selectorRecommendationCountReady &&
        selectorBudgetReady
      ) {
        const selectorStartedAtMs = Date.now();
        const selectorOut = await runConcernSelectorRace({
          ctx,
          logger,
          requestText: plannerAndRetrievalRequestText,
          semanticPlan: hardPathSelectorSemanticPlan,
          recommendations: hardPathRecommendations,
          deadlineAtMs: selectorDeadlineAtMs,
        });
        hardPathSelectorTrace = {
          ...(selectorOut?.trace && typeof selectorOut.trace === 'object' ? selectorOut.trace : {}),
          result: selectorOut?.result || null,
        };
        hardPathSelectorApplied = applyConcernSelectorRaceOrdering(
          hardPathRecommendations,
          selectorOut?.result,
        );
        if (
          hardPathSelectorApplied?.winner_source === 'llm_selector' &&
          Array.isArray(hardPathSelectorApplied.recommendations) &&
          hardPathSelectorApplied.recommendations.length > 0
        ) {
          effectiveHardPathHandoff = patchBeautyChatHandoffSelection({
            handoff: hardPathHandoff,
            orderedRecommendations: hardPathSelectorApplied.recommendations,
            selectionContract: hardPathSelectionContract,
            selectionOwner: hardPathSelectionOwner,
          });
        }
        hardPathTiming.selectorMs = elapsedBeautyChatStageMs(selectorStartedAtMs);
      } else if (!selectorPlannerEligible) {
        hardPathSelectorSkipReason = 'planner_contract_missing';
      } else if (!selectorDepsReady) {
        hardPathSelectorSkipReason = 'selector_dependency_missing';
      } else if (!selectorSemanticPlanReady) {
        hardPathSelectorSkipReason = 'selector_semantic_plan_missing';
      } else if (!selectorRecommendationCountReady) {
        hardPathSelectorSkipReason = 'insufficient_recommendations';
      } else if (!selectorBudgetReady) {
        hardPathSelectorSkipReason = 'selector_budget_exhausted';
      }
      const hardPathRecoContext = mergeIngredientRecoContextValue(
        latestRecoContextFromSession,
        {
          target_step: pickFirstTrimmed(effectiveHandoffTargetContext?.resolved_target_step),
          step: pickFirstTrimmed(effectiveHandoffTargetContext?.resolved_target_step),
          resolved_target_step: pickFirstTrimmed(
            effectiveHandoffTargetContext?.resolved_target_step,
          ),
          resolved_target_step_confidence: pickFirstTrimmed(
            effectiveHandoffTargetContext?.resolved_target_step_confidence,
          ),
          resolved_target_step_source: pickFirstTrimmed(
            effectiveHandoffTargetContext?.resolved_target_step_source,
          ),
          query: pickFirstTrimmed(
            latestRecoContextFromSession?.ingredient_query,
            latestRecoContextFromSession?.query,
          ),
          goal: pickFirstTrimmed(latestRecoContextFromSession?.goal),
          updated_at_ms: Date.now(),
        },
      );
      const hardPathPayloadBundle = buildRecoPayloadFromBeautyMainlineHandoff({
        handoff: effectiveHardPathHandoff,
        profile: effectiveProfile,
        targetContext: effectiveHandoffTargetContext,
        recoContext: hardPathRecoContext,
        taskMode: 'goal_based_products',
        triggerSource: effectiveRecoEntrySourceDetail,
        sourceMode:
          String(effectiveHandoffTargetContext?.intent_mode || '').trim().toLowerCase() ===
          'generic_concern'
            ? 'framework_mainline'
            : 'step_aware_mainline',
        basePayload: {
          recommendation_confidence_score: 0.61,
          recommendation_confidence_level: 'medium',
          recommendation_meta: {
            ...buildBeautyChatPlannerMeta(hardPathPlannerTrace),
            ...(analysisContextUsageMeta ? { analysis_context_usage: analysisContextUsageMeta } : {}),
            request_text: recoRequestMessage || message || '',
            ...(contextualRecoContinuation
              ? {
                  contextual_reco_continuation: true,
                  current_request_text: recoRequestMessage || message || '',
                  prior_request_text: priorRecoRequestText || null,
                  combined_request_text: plannerAndRetrievalRequestText,
                }
              : {}),
            recompute_from_profile_update:
              shouldAutoRerunRecommendationsFromProfilePatch === true,
            used_recent_logs: Array.isArray(recentLogs) && recentLogs.length > 0,
            used_safety_flags: false,
          },
        },
        selectionOwner: hardPathSelectionOwner,
        entryType: 'chat',
        language: ctx?.lang || 'EN',
      });
      if (isPlainObject(hardPathPayloadBundle?.payload) && isPlainObject(hardPathPayloadBundle?.contract)) {
        const effectiveHardPathRecoContext =
          hardPathPayloadBundle?.recoContext &&
          typeof hardPathPayloadBundle.recoContext === 'object' &&
          !Array.isArray(hardPathPayloadBundle.recoContext)
            ? hardPathPayloadBundle.recoContext
            : hardPathRecoContext;
        const assistantProfile =
          (effectiveProfile && typeof effectiveProfile === 'object' && !Array.isArray(effectiveProfile))
            || (profileSummary && typeof profileSummary === 'object' && !Array.isArray(profileSummary))
            ? {
              ...(profileSummary && typeof profileSummary === 'object' && !Array.isArray(profileSummary)
                ? profileSummary
                : {}),
              ...(effectiveProfile && typeof effectiveProfile === 'object' && !Array.isArray(effectiveProfile)
                ? effectiveProfile
                : {}),
            }
            : effectiveProfile;
        if (isPlainObject(hardPathPayloadBundle.payload?.recommendation_meta)) {
          hardPathPayloadBundle.payload.recommendation_meta.selector_race_applied =
            Boolean(hardPathSelectorTrace);
          hardPathPayloadBundle.payload.recommendation_meta.selector_race_trace =
            hardPathSelectorTrace;
          hardPathPayloadBundle.payload.recommendation_meta.llm_selector_used =
            hardPathSelectorTrace?.llm_selector_used === true;
          hardPathPayloadBundle.payload.recommendation_meta.selector_winner_source =
            pickFirstTrimmed(
              hardPathSelectorApplied?.winner_source,
              hardPathSelectorTrace?.winner_source,
              'deterministic',
            ) || 'deterministic';
          if (Array.isArray(hardPathSelectorApplied?.support_roles_surfaced)) {
            hardPathPayloadBundle.payload.recommendation_meta.selector_support_roles_surfaced =
              hardPathSelectorApplied.support_roles_surfaced;
          }
          if (analysisContextUsageMeta) {
            hardPathPayloadBundle.payload.recommendation_meta.analysis_context_usage =
              analysisContextUsageMeta;
          }
          if (isPlainObject(hardPathPayloadBundle.payload?.metadata)) {
            hardPathPayloadBundle.payload.metadata.selector_race_trace = hardPathSelectorTrace;
          }
        }
        const nextState =
          typeof stateChangeAllowed === 'function' && stateChangeAllowed(ctx?.trigger_source)
            ? 'S7_PRODUCT_RECO'
            : undefined;
        const sessionPatch = nextState ? { next_state: nextState } : {};
        appendLatestRecoContextToSessionPatch(
          sessionPatch,
          mergeIngredientRecoContextValue(effectiveHardPathRecoContext, {
            intent: 'reco_products',
            source_detail: effectiveRecoEntrySourceDetail,
            trigger_source: ctx?.trigger_source,
            action_id: actionId || '',
            message: recoRequestMessage || message,
            include_alternatives: includeAlternatives === true,
            context_origin: 'beauty_mainline_handoff',
            updated_at_ms: Date.now(),
          }),
        );
        const rewriteDeadlineAtMs = Math.max(Date.now() + rewriteReserveMs, handoffDeadlineAtMs + 1);
        const assistantRewrite =
          typeof maybeRewriteRecoAssistantTextWithLlm === 'function'
            ? await (async () => {
              const rewriteStartedAtMs = Date.now();
              try {
                return await maybeRewriteRecoAssistantTextWithLlm({
                  payload: hardPathPayloadBundle.payload,
                  language: ctx?.lang,
                  profile: assistantProfile,
                  userRequestText: pickFirstTrimmed(recoRequestMessage, message),
                  allowLockedSelectionRewrite: true,
                  deadlineAtMs: rewriteDeadlineAtMs,
                });
              } finally {
                hardPathTiming.rewriteMs = elapsedBeautyChatStageMs(rewriteStartedAtMs);
              }
            })()
            : { text: '', llm_used: false, reason: 'rewrite_unavailable' };
        const assistantText =
          assistantRewrite?.llm_used === true
            ? pickFirstTrimmed(assistantRewrite?.text)
            : '';
        if (isPlainObject(hardPathPayloadBundle.payload?.recommendation_meta)) {
          hardPathPayloadBundle.payload.recommendation_meta.assistant_rewrite_llm_used =
            assistantRewrite?.llm_used === true;
          hardPathPayloadBundle.payload.recommendation_meta.assistant_rewrite_reason =
            pickFirstTrimmed(assistantRewrite?.reason) || null;
          if (assistantRewrite?.refinement_question && typeof assistantRewrite.refinement_question === 'object') {
            hardPathPayloadBundle.payload.recommendation_meta.assistant_refinement_question =
              assistantRewrite.refinement_question;
          }
          if (Array.isArray(assistantRewrite?.attempts) && assistantRewrite.attempts.length > 0) {
            hardPathPayloadBundle.payload.recommendation_meta.assistant_rewrite_attempts =
              assistantRewrite.attempts.slice(0, 3);
          }
          if (assistantRewrite?.llm_used === true) {
            hardPathPayloadBundle.payload.recommendation_meta.assistant_rewrite_provider =
              pickFirstTrimmed(assistantRewrite?.provider) || null;
            hardPathPayloadBundle.payload.recommendation_meta.assistant_rewrite_model =
              pickFirstTrimmed(assistantRewrite?.model) || null;
          }
        }
        attachBeautyChatMainlineTimingLedger(
          hardPathPayloadBundle.payload,
          buildBeautyChatMainlineTimingLedger({
            budgetMs: hardPathBudget.budgetMs,
            plannerMs: hardPathTiming.plannerMs,
            handoffMs: hardPathTiming.handoffMs,
            selectorMs: hardPathTiming.selectorMs,
            rewriteMs: hardPathTiming.rewriteMs,
            totalElapsedMs: elapsedBeautyChatStageMs(hardPathBudget.startedAtMs),
            plannerTrace: hardPathPlannerTrace,
            selectorTrace: hardPathSelectorTrace,
            selectorApplied: hardPathSelectorApplied,
            selectorSkipReason: hardPathSelectorSkipReason,
            rewrite: {
              attempted: typeof maybeRewriteRecoAssistantTextWithLlm === 'function',
              llm_used: assistantRewrite?.llm_used === true,
              attempt_count: assistantRewrite?.attempt_count,
            },
          }),
        );
        const envelope = buildEnvelope(ctx, {
          assistant_message: assistantText ? makeAssistantMessage(assistantText) : null,
          suggested_chips: [],
          cards: [
            {
              card_id: `reco_${ctx?.request_id}`,
              type: 'recommendations',
              payload: hardPathPayloadBundle.payload,
            },
          ],
          session_patch: sessionPatch,
          events: applyRecoContractToRecoRequestedEvents(
            [makeEvent(ctx, 'value_moment', { kind: 'product_reco' })],
            hardPathPayloadBundle.contract,
            {
              ctx,
              emitIfMissing: true,
              eventData: buildRecoRequestedEventData({
                explicit: true,
                payload: hardPathPayloadBundle.payload,
                source: String(
                  hardPathPayloadBundle.payload?.source ||
                    hardPathPayloadBundle.payload?.recommendation_meta?.source_mode ||
                    'catalog_grounded_v1',
                ),
                sourceDetail:
                  typeof normalizeRecoSourceDetail === 'function'
                    ? normalizeRecoSourceDetail(effectiveRecoEntrySourceDetail)
                    : effectiveRecoEntrySourceDetail,
                recomputeFromProfileUpdate:
                  shouldAutoRerunRecommendationsFromProfilePatch === true,
                lowConfidence: false,
                confidenceLevel: 'medium',
              }),
            },
          ).events,
        });
        return {
          handled: true,
          targetContext: effectiveHandoffTargetContext,
          envelope,
        };
      }
    }

    const fallbackEnvelope = buildBeautyMainlineHandoffFallbackEnvelope({
      ctx,
      fallback: classifyBeautyMainlineHandoffFallback({
        handoff: hardPathHandoff,
        err: hardPathHandoffErr,
      }),
      suggestedChips: [],
    });
    return {
      handled: true,
      targetContext: hardPathRecoTargetContext,
      envelope: fallbackEnvelope,
    };
  }

  return {
    isBeautyOwnedChatRecoRequest,
    maybeHandleBeautyOwnedChatReco,
  };
}

module.exports = {
  createBeautyChatMainlineEntryRuntime,
  __internal: {
    collectBeautyExactProductQueryTerms,
    augmentBeautyExactProductTargetContext,
    looksLikeBeautyChatContextualRecoContinuationMessage,
    buildBeautyChatContextualRecoContinuationText,
  },
};
