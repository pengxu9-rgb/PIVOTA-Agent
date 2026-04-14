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

function shouldUseBeautyChatMainlinePlanner(targetContext = null) {
  const entryType = String(targetContext?.entry_type || 'chat').trim().toLowerCase();
  if (entryType && entryType !== 'chat') return false;
  const intentMode = String(targetContext?.intent_mode || '').trim().toLowerCase();
  if (new Set(['exact_product', 'specific_product', 'pdp_open']).has(intentMode)) return false;
  if (intentMode === 'generic_concern') return true;
  if (intentMode === 'explicit_role' || intentMode === 'generic') return true;
  if (targetContext?.step_aware_intent && targetContext?.resolved_target_step) return true;
  return Array.isArray(targetContext?.framework_roles) && targetContext.framework_roles.length > 0;
}

function canUseDeterministicBeautyChatPlannerFallback(targetContext = null) {
  return false;
}

function normalizeBeautyChatPlannerTargetContext(baseTargetContext = null, plannerTargetContext = null) {
  if (
    plannerTargetContext &&
    typeof plannerTargetContext === 'object' &&
    !Array.isArray(plannerTargetContext) &&
    Array.isArray(plannerTargetContext.framework_roles) &&
    plannerTargetContext.framework_roles.length > 0
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

function createBeautyChatMainlineBudget({ budgetMs = 0 } = {}) {
  const normalizedBudgetMs =
    Number.isFinite(Number(budgetMs)) && Number(budgetMs) > 0
      ? Math.trunc(Number(budgetMs))
      : 13000;
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
    AURORA_BFF_CHAT_RECO_BUDGET_MS = 13000,
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
    recentLogs = [],
    includeAlternatives = false,
    actionId = '',
    shouldAutoRerunRecommendationsFromProfilePatch = false,
    debugUpstream = false,
  } = {}) {
    const recoRequestMessage = String(message || '').trim();
    const profileSummary = summarizeProfileForContext(profile);
    const hardPathRecoFocusForMainline = pickFirstTrimmed(
      latestRecoContextFromSession?.resolved_target_step,
      latestRecoContextFromSession?.ingredient_query,
      latestRecoContextFromSession?.goal,
    );
    const hardPathRecoTargetContext = resolveRecommendationTargetContext({
      explicitStep: pickFirstTrimmed(
        latestRecoContextFromSession?.target_step,
        latestRecoContextFromSession?.step,
        latestRecoContextFromSession?.resolved_target_step,
      ),
      focus: hardPathRecoFocusForMainline,
      text: recoRequestMessage || message,
      entryType: 'chat',
      profileSummary,
    });
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
    const handoffDeadlineAtMs = hardPathBudget.deadlineAtMs - rewriteReserveMs;
    const plannerReserveMs = Math.max(
      3000,
      rewriteReserveMs,
      Number.isFinite(Number(RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS))
        ? Math.trunc(Number(RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS))
        : 0,
    );
    let hardPathPlannerTrace = null;
    let hardPathPlannerSemanticPlan = null;
    let effectivePlannerTargetContext = hardPathRecoTargetContext;
    if (
      shouldUseBeautyChatMainlinePlanner(hardPathRecoTargetContext) &&
      typeof runConcernSemanticPlanner === 'function' &&
      typeof buildConcernTargetContextFromSemanticPlan === 'function'
    ) {
      const plannerDeadlineAtMs = hardPathBudget.deadlineAtMs - plannerReserveMs;
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
          const concernPlanOut = await runConcernSemanticPlanner({
            ctx,
            logger,
            requestText: pickFirstTrimmed(recoRequestMessage, message),
            focus: hardPathRecoFocusForMainline,
            profileSummary,
            recommendationTaskContext: latestRecoContextFromSession,
            deadlineAtMs: plannerDeadlineAtMs,
          });
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
            const plannerTargetContext = buildConcernTargetContextFromSemanticPlan(plannerSemanticPlan, {
              text: pickFirstTrimmed(recoRequestMessage, message),
              focus: hardPathRecoFocusForMainline,
              entryType: 'chat',
            });
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
      hardPathHandoff = await handoffRecoToBeautyMainlineSearch({
        ctx,
        logger,
        primaryQuery: pickFirstTrimmed(recoRequestMessage, message),
        fallbackMessage: message,
        targetContext: effectivePlannerTargetContext,
        fallbackFocus: hardPathRecoFocusForMainline,
        profileSummary,
        deadlineAtMs: handoffDeadlineAtMs,
        debug: debugUpstream,
        timeoutMs: RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS,
        minTimeoutMs: RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS,
      });
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
      const hardPathSelectorSemanticPlan =
        effectiveHandoffTargetContext?.semantic_plan &&
        typeof effectiveHandoffTargetContext.semantic_plan === 'object' &&
        !Array.isArray(effectiveHandoffTargetContext.semantic_plan)
          ? effectiveHandoffTargetContext.semantic_plan
          : hardPathPlannerSemanticPlan;
      if (
        shouldUseBeautyChatMainlinePlanner(effectiveHandoffTargetContext) &&
        typeof runConcernSelectorRace === 'function' &&
        typeof applyConcernSelectorRaceOrdering === 'function' &&
        hardPathSelectorSemanticPlan &&
        typeof hardPathSelectorSemanticPlan === 'object' &&
        !Array.isArray(hardPathSelectorSemanticPlan) &&
        hardPathRecommendations.length > 1 &&
        hardPathBudget.getRemainingMs(rewriteReserveMs + 1200) > 350
      ) {
        const selectorStartedAtMs = Date.now();
        const selectorOut = await runConcernSelectorRace({
          ctx,
          logger,
          requestText: pickFirstTrimmed(recoRequestMessage, message),
          semanticPlan: hardPathSelectorSemanticPlan,
          recommendations: hardPathRecommendations,
          deadlineAtMs: handoffDeadlineAtMs - 1200,
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
        profile,
        targetContext: effectiveHandoffTargetContext,
        recoContext: hardPathRecoContext,
        taskMode: 'goal_based_products',
        triggerSource: recoEntrySourceDetail,
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
          profileSummary && typeof profileSummary === 'object' && !Array.isArray(profileSummary)
            ? profileSummary
            : profile;
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
            source_detail: recoEntrySourceDetail,
            trigger_source: ctx?.trigger_source,
            action_id: actionId || '',
            message: recoRequestMessage || message,
            include_alternatives: includeAlternatives === true,
            context_origin: 'beauty_mainline_handoff',
            updated_at_ms: Date.now(),
          }),
        );
        const rewriteDeadlineAtMs = Date.now() + rewriteReserveMs;
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
                    ? normalizeRecoSourceDetail(recoEntrySourceDetail)
                    : recoEntrySourceDetail,
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
};
