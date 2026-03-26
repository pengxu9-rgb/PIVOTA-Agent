function createChatPreludeCoordinatorRuntime(options = {}) {
  const {
    chatTurnStateRuntime = null,
    chatIngredientPreludeRuntime = null,
    chatIngredientLookupRuntime = null,
    chatPreUpstreamRuntime = null,
    chatSafetyRuntime = null,
    looksLikeIngredientScienceIntent = () => false,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat prelude coordinator runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function resolveChatPreludeFlow(args = {}) {
    const prepareChatTurnPrelude = requireMethod(
      chatTurnStateRuntime,
      'chatTurnStateRuntime',
      'prepareChatTurnPrelude',
    );
    const prepareIngredientPrelude = requireMethod(
      chatIngredientPreludeRuntime,
      'chatIngredientPreludeRuntime',
      'prepareIngredientPrelude',
    );
    const attachIngredientRouteMetaToSessionPatch = requireMethod(
      chatIngredientLookupRuntime,
      'chatIngredientLookupRuntime',
      'attachIngredientRouteMetaToSessionPatch',
    );
    const resolvePreUpstreamFlow = requireMethod(
      chatPreUpstreamRuntime,
      'chatPreUpstreamRuntime',
      'resolvePreUpstreamFlow',
    );
    const buildSafetyNoticeTextBase = requireMethod(
      chatSafetyRuntime,
      'chatSafetyRuntime',
      'buildSafetyNoticeText',
    );
    const looksLikeIngredientScienceIntentFn = requireFunction(
      'looksLikeIngredientScienceIntent',
      looksLikeIngredientScienceIntent,
    );

    const {
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
    } = args;

    const chatTurnPrelude = prepareChatTurnPrelude({
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
    });
    const clientAgentState = chatTurnPrelude.clientAgentState;
    const requestedTransition = chatTurnPrelude.requestedTransition;
    const agentState = chatTurnPrelude.agentState;
    const recoInteractionAllowed = chatTurnPrelude.recoInteractionAllowed;
    const allowRecoCards = chatTurnPrelude.allowRecoCards;
    let upstreamMessage = chatTurnPrelude.upstreamMessage;
    const clarificationHistoryForUpstream = chatTurnPrelude.clarificationHistoryForUpstream;
    const resumeContextForUpstream = chatTurnPrelude.resumeContextForUpstream;
    let pendingClarificationPatchOverride = chatTurnPrelude.pendingClarificationPatchOverride;
    const forceUpstreamAfterPendingAbandon = chatTurnPrelude.forceUpstreamAfterPendingAbandon;
    if (chatTurnPrelude.earlyEnvelope) {
      return {
        handled: true,
        envelope: chatTurnPrelude.earlyEnvelope,
        clientAgentState,
        agentState,
      };
    }

    const ingredientScienceIntent = looksLikeIngredientScienceIntentFn(message, normalizedActionPayload);
    const ingredientPrelude = await prepareIngredientPrelude({
      actionId,
      normalizedActionPayload,
      parsedData,
      message,
      ctx,
      canonicalIntent,
      INTENT_ENUM,
      requestedTransition,
      ingredientScienceIntent,
      upstreamMessage,
    });

    let nextIngredientReplayContext = ingredientPrelude.ingredientReplayContext;
    let nextSkipRoutineRulesFallback = ingredientPrelude.skipRoutineRulesFallback;
    let ingredientRecoContext = ingredientPrelude.ingredientRecoContext;
    upstreamMessage = ingredientPrelude.upstreamMessage;

    const buildSafetyNoticeText = (safety) =>
      buildSafetyNoticeTextBase({
        safety,
        language: ctx && ctx.lang,
      });

    let nextStateOverride = null;
    const preUpstreamResult = await resolvePreUpstreamFlow({
      effectiveChatFlags,
      message,
      actionId,
      ctx,
      canonicalIntent,
      profile,
      hasPlannerAnchor,
      debugUpstream,
      appliedProfilePatch,
      anchorProductId,
      anchorProductUrl,
      allowRecoCards,
      evaluateIntent: ingredientPrelude.evaluateIntent,
      ingredientScienceIntentEffective: ingredientPrelude.ingredientScienceIntentEffective,
      conflictIntentRequested: ingredientPrelude.conflictIntentRequested,
      recommendationEntryRequested: ingredientPrelude.recommendationEntryRequested,
      diagnosisEntryRequested: ingredientPrelude.diagnosisEntryRequested,
      normalizedActionPayload,
      pendingSafetyAdvisory,
      pushGateDecision,
      enqueueGateAdvisory,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      identity,
      session,
      req,
      ingredientRecoContext,
      ingredientGoalRequest: ingredientPrelude.ingredientGoalRequest,
      nextStateOverride,
      ingredientEntryRequested: ingredientPrelude.ingredientEntryRequested,
      ingredientByGoalRequested: ingredientPrelude.ingredientByGoalRequested,
      ingredientLookupRequested: ingredientPrelude.ingredientLookupRequested,
      ingredientResearchPollRequested: ingredientPrelude.ingredientResearchPollRequested,
      ingredientRouteDecisionReasons: ingredientPrelude.ingredientRouteDecisionReasons,
      ingredientLookupQuery: ingredientPrelude.ingredientLookupQuery,
      ingredientActionData: ingredientPrelude.ingredientActionData,
      INGREDIENT_ROUTE_RULE_VERSION,
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED,
      summarizeChatProfileForContext,
      recentLogs,
      chatContext,
      templateAcceptLanguage,
      agentState,
      ingredientDiagnosisOptInRequested: ingredientPrelude.ingredientDiagnosisOptInRequested,
      ingredientTextTrigger: ingredientPrelude.ingredientTextTrigger,
      buildDiagnosisPrompt,
      buildDiagnosisChips,
      profileCompleteness,
      stateChangeAllowed,
      normalizeIngredientActionId,
      attachIngredientRouteMetaToSessionPatch,
      ingredientLookupTargetFromText: ingredientPrelude.ingredientLookupTargetFromText,
      ingredientEntityMatch: ingredientPrelude.ingredientEntityMatch,
      buildSafetyNoticeText,
      requestMessage,
      recommendationFlowArgs: {
        ...recommendationFlowBaseArgs,
        forceUpstreamAfterPendingAbandon,
        allowRecoCards,
        ctx,
        message,
        normalizedActionPayload,
        recoInteractionAllowed,
        ingredientRecoOptInRequested: ingredientPrelude.ingredientRecoOptInRequested,
        ingredientLookupRequested: ingredientPrelude.ingredientLookupRequested,
        ingredientByGoalRequested: ingredientPrelude.ingredientByGoalRequested,
        ingredientActionData: ingredientPrelude.ingredientActionData,
        pendingClarificationPatchOverride,
        buildSafetyNoticeText,
        agentState,
      },
    });

    ingredientRecoContext = preUpstreamResult.ingredientRecoContext;
    pendingClarificationPatchOverride = preUpstreamResult.pendingClarificationPatchOverride;
    nextStateOverride = preUpstreamResult.nextStateOverride;

    return {
      handled: preUpstreamResult.handled,
      envelope: preUpstreamResult.envelope || null,
      clientAgentState,
      agentState,
      allowRecoCards,
      upstreamMessage,
      clarificationHistoryForUpstream,
      resumeContextForUpstream,
      forceUpstreamAfterPendingAbandon,
      nextStateOverride,
      pendingClarificationPatchOverride,
      plannerSessionStatePatch: preUpstreamResult.plannerSessionStatePatch,
      safetyDecision: preUpstreamResult.safetyDecision,
      profile: preUpstreamResult.profile,
      pendingSafetyAdvisory: preUpstreamResult.pendingSafetyAdvisory,
      requestMessage: preUpstreamResult.requestMessage,
      policyMetaPatch: preUpstreamResult.policyMetaPatch || null,
      ingredientRecoContext,
      ingredientReplayContext: nextIngredientReplayContext,
      skipRoutineRulesFallback: nextSkipRoutineRulesFallback,
      nextCtxState: preUpstreamResult.nextCtxState,
    };
  }

  return {
    resolveChatPreludeFlow,
  };
}

module.exports = {
  createChatPreludeCoordinatorRuntime,
};
