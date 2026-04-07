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

function createBeautyChatMainlineEntryRuntime(deps = {}) {
  const {
    RECO_CATALOG_GROUNDED_ENABLED = false,
    RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS = 0,
    BEAUTY_DISCOVERY_MAINLINE_OWNER = 'shopping_agent_beauty_mainline',
    resolveRecommendationTargetContext,
    summarizeProfileForContext,
    mergeIngredientRecoContextValue,
    appendLatestRecoContextToSessionPatch,
    extractRecoFinalSelectionContract,
    buildRouteAwareAssistantText,
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

    let hardPathHandoff = null;
    let hardPathHandoffErr = null;
    try {
      hardPathHandoff = await handoffRecoToBeautyMainlineSearch({
        ctx,
        logger,
        primaryQuery: pickFirstTrimmed(recoRequestMessage, message),
        fallbackMessage: message,
        targetContext: hardPathRecoTargetContext,
        fallbackFocus: hardPathRecoFocusForMainline,
        profileSummary: summarizeProfileForContext(profile),
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
        handoff: hardPathHandoff,
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
            recompute_from_profile_update:
              shouldAutoRerunRecommendationsFromProfilePatch === true,
            used_recent_logs: Array.isArray(recentLogs) && recentLogs.length > 0,
            used_safety_flags: false,
          },
        },
        selectionOwner: hardPathSelectionOwner,
        entryType: 'chat',
      });
      if (isPlainObject(hardPathPayloadBundle?.payload) && isPlainObject(hardPathPayloadBundle?.contract)) {
        const nextState =
          typeof stateChangeAllowed === 'function' && stateChangeAllowed(ctx?.trigger_source)
            ? 'S7_PRODUCT_RECO'
            : undefined;
        const sessionPatch = nextState ? { next_state: nextState } : {};
        appendLatestRecoContextToSessionPatch(
          sessionPatch,
          mergeIngredientRecoContextValue(hardPathRecoContext, {
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
        const assistantText =
          buildRouteAwareAssistantText({
            route: 'reco',
            payload: hardPathPayloadBundle.payload,
            language: ctx?.lang,
            profile,
          }) ||
          (ctx?.lang === 'CN'
            ? '我已经把这轮候选收成结构化推荐卡片。'
            : 'I summarized this pass into structured recommendation cards.');
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(assistantText),
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
