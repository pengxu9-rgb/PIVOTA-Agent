function createChatTurnPipelineRuntime(options = {}) {
  const {
    chatFollowupRuntime = null,
    chatPreludeCoordinatorRuntime = null,
    chatUpstreamTurnRuntime = null,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat turn pipeline runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function resolveChatTurnPipeline(args = {}) {
    const maybeBuildAnalysisFollowupEnvelope = requireMethod(
      chatFollowupRuntime,
      'chatFollowupRuntime',
      'maybeBuildAnalysisFollowupEnvelope',
    );
    const maybeBuildFollowupAlternativesEnvelope = requireMethod(
      chatFollowupRuntime,
      'chatFollowupRuntime',
      'maybeBuildFollowupAlternativesEnvelope',
    );
    const resolveChatPreludeFlow = requireMethod(
      chatPreludeCoordinatorRuntime,
      'chatPreludeCoordinatorRuntime',
      'resolveChatPreludeFlow',
    );
    const resolveUpstreamTurn = requireMethod(
      chatUpstreamTurnRuntime,
      'chatUpstreamTurnRuntime',
      'resolveUpstreamTurn',
    );

    const {
      ctx,
      parsedData,
      message = '',
      actionId = '',
      clarificationId = '',
      actionReplyText = '',
      normalizedActionPayload = null,
      profile = null,
      appliedProfilePatch = null,
      summarizeChatProfileForContext,
      pushGateDecision,
      policyMeta,
      logger,
      recordPendingClarificationAbandoned,
      recordSessionPatchProfileEmitted,
      buildChipsForQuestion,
      recordAuroraChatSkipped,
      recordPendingClarificationStep,
      recordPendingClarificationCompleted,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      getPendingClarification,
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED = false,
      canonicalIntent,
      INTENT_ENUM,
      requestMessage = '',
      ingredientReplayContext = null,
      skipRoutineRulesFallback = false,
      effectiveChatFlags,
      hasPlannerAnchor = false,
      debugUpstream = false,
      anchorProductId = '',
      anchorProductUrl = '',
      pendingSafetyAdvisory = null,
      enqueueGateAdvisory,
      identity,
      session,
      req,
      INGREDIENT_ROUTE_RULE_VERSION = '',
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED = false,
      recentLogs = [],
      chatContext = null,
      templateAcceptLanguage = '',
      buildDiagnosisPrompt,
      buildDiagnosisChips,
      profileCompleteness,
      stateChangeAllowed,
      normalizeIngredientActionId,
      recommendationFlowBaseArgs = {},
      includeAlternatives = false,
      latestRecoContextFromSession = null,
      textDerivedProfilePatch = null,
      textDerivedSkinLog = null,
      llmProvider = '',
      llmModel = '',
      upstreamMessages = null,
      AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED = false,
      profilePatchFromSession = null,
    } = args;

    const analysisFollowupEnvelope = maybeBuildAnalysisFollowupEnvelope({
      ctx,
      actionId,
      profile,
      actionReplyText,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });
    if (analysisFollowupEnvelope) {
      return { handled: true, envelope: analysisFollowupEnvelope };
    }

    const followupAlternativesEnvelope = await maybeBuildFollowupAlternativesEnvelope({
      ctx,
      actionId,
      normalizedActionPayload,
      message,
      anchorProductId,
      anchorProductUrl,
      debugUpstream,
      profile,
      summarizeChatProfileForContext,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });
    if (followupAlternativesEnvelope) {
      return { handled: true, envelope: followupAlternativesEnvelope };
    }

    const preludeResult = await resolveChatPreludeFlow({
      parsedData,
      ctx,
      message,
      actionId,
      clarificationId,
      actionReplyText,
      normalizedActionPayload,
      profile,
      appliedProfilePatch,
      summarizeChatProfileForContext,
      pushGateDecision,
      policyMeta,
      logger,
      recordPendingClarificationAbandoned,
      recordSessionPatchProfileEmitted,
      buildChipsForQuestion,
      recordAuroraChatSkipped,
      recordPendingClarificationStep,
      recordPendingClarificationCompleted,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      getPendingClarification,
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED,
      canonicalIntent,
      INTENT_ENUM,
      requestMessage,
      ingredientReplayContext,
      skipRoutineRulesFallback,
      effectiveChatFlags,
      hasPlannerAnchor,
      debugUpstream,
      anchorProductId,
      anchorProductUrl,
      pendingSafetyAdvisory,
      enqueueGateAdvisory,
      identity,
      session,
      req,
      INGREDIENT_ROUTE_RULE_VERSION,
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED,
      recentLogs,
      chatContext,
      templateAcceptLanguage,
      buildDiagnosisPrompt,
      buildDiagnosisChips,
      profileCompleteness,
      stateChangeAllowed,
      normalizeIngredientActionId,
      recommendationFlowBaseArgs: {
        ...recommendationFlowBaseArgs,
        actionId,
        clarificationId,
        appliedProfilePatch,
        includeAlternatives,
        identity,
        recentLogs,
        debugUpstream,
        summarizeChatProfileForContext,
        pushGateDecision,
        enqueueGateAdvisory,
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
        textDerivedProfilePatch,
        textDerivedSkinLog,
        latestRecoContextFromSession,
        buildDiagnosisChips,
        canonicalIntent,
        session,
        buildDiagnosisPrompt,
      },
    });

    const pipelineState = {
      clientStateForReplay: preludeResult.clientAgentState,
      agentStateForReplay: preludeResult.agentState,
      plannerSessionStatePatch: preludeResult.plannerSessionStatePatch,
      safetyDecision: preludeResult.safetyDecision,
      profile: preludeResult.profile,
      pendingSafetyAdvisory: preludeResult.pendingSafetyAdvisory,
      requestMessage: preludeResult.requestMessage,
      ingredientReplayContext: preludeResult.ingredientReplayContext,
      skipRoutineRulesFallback: preludeResult.skipRoutineRulesFallback,
      policyMetaPatch: preludeResult.policyMetaPatch || null,
    };

    if (preludeResult.handled) {
      return {
        handled: true,
        envelope: preludeResult.envelope,
        ...pipelineState,
      };
    }

    const upstreamTurnResult = await resolveUpstreamTurn({
      ctx,
      profile: preludeResult.profile,
      recentLogs,
      upstreamMessage: preludeResult.upstreamMessage,
      message,
      agentState: preludeResult.agentState,
      normalizedActionPayload,
      clarificationId,
      clarificationHistoryForUpstream: preludeResult.clarificationHistoryForUpstream,
      resumeContextForUpstream: preludeResult.resumeContextForUpstream,
      forceUpstreamAfterPendingAbandon: preludeResult.forceUpstreamAfterPendingAbandon,
      AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED,
      llmProvider,
      llmModel,
      anchorProductId,
      anchorProductUrl,
      upstreamMessages,
      debugUpstream,
      allowRecoCards: preludeResult.allowRecoCards,
      includeAlternatives,
      actionId,
      req,
      appliedProfilePatch,
      profilePatchFromSession,
      nextStateOverride: preludeResult.nextStateOverride,
      pendingClarificationPatchOverride: preludeResult.pendingClarificationPatchOverride,
      canonicalIntent,
      makeChatAssistantMessage,
      summarizeChatProfileForContext,
    });

    return {
      handled: true,
      envelope: upstreamTurnResult.envelope,
      llmRouteMetaForResponse: upstreamTurnResult.llmRouteMetaForResponse || null,
      ...pipelineState,
    };
  }

  return {
    resolveChatTurnPipeline,
  };
}

module.exports = {
  createChatTurnPipelineRuntime,
};
