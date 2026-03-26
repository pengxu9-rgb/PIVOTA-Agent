function createChatRecommendationFlowRuntime(options = {}) {
  const {
    looksLikeSuitabilityRequest = () => false,
    looksLikeCompatibilityOrConflictQuestion = () => false,
    looksLikeWeatherOrEnvironmentQuestion = () => false,
    looksLikeRecommendationRequest = () => false,
    chatRoutineGateRuntime = null,
    chatRecoEntryRuntime = null,
    chatRecommendationRuntime = null,
    chatProfileContinuationRuntime = null,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat recommendation flow runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function resolveRecommendationFlow(args = {}) {
    const {
      forceUpstreamAfterPendingAbandon = false,
      actionId = '',
      clarificationId = '',
      allowRecoCards = false,
      ctx = {},
      profile = null,
      appliedProfilePatch = null,
      message = '',
      normalizedActionPayload = null,
      ingredientScienceIntentEffective = false,
      recoInteractionAllowed = false,
      includeAlternatives = false,
      identity = {},
      recentLogs = [],
      debugUpstream = false,
      nextStateOverride = null,
      summarizeChatProfileForContext,
      pushGateDecision,
      enqueueGateAdvisory,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      textDerivedProfilePatch = null,
      textDerivedSkinLog = null,
      latestRecoContextFromSession = null,
      ingredientRecoOptInRequested = false,
      ingredientLookupRequested = false,
      ingredientByGoalRequested = false,
      ingredientRecoContext = null,
      ingredientActionData = null,
      safetyDecision = null,
      pendingSafetyAdvisory = null,
      pendingClarificationPatchOverride = undefined,
      buildDiagnosisChips,
      chatSafetyRuntime,
      chatDiagnosisGateRuntime,
      canonicalIntent = null,
      session = null,
      buildSafetyNoticeText,
      agentState = '',
      ingredientEntryRequested = false,
      ingredientTextTrigger = false,
      buildDiagnosisPrompt,
    } = args;

    const looksLikeSuitabilityRequestFn = requireFunction(
      'looksLikeSuitabilityRequest',
      looksLikeSuitabilityRequest,
    );
    const looksLikeCompatibilityOrConflictQuestionFn = requireFunction(
      'looksLikeCompatibilityOrConflictQuestion',
      looksLikeCompatibilityOrConflictQuestion,
    );
    const looksLikeWeatherOrEnvironmentQuestionFn = requireFunction(
      'looksLikeWeatherOrEnvironmentQuestion',
      looksLikeWeatherOrEnvironmentQuestion,
    );
    const looksLikeRecommendationRequestFn = requireFunction(
      'looksLikeRecommendationRequest',
      looksLikeRecommendationRequest,
    );
    const resolveRoutineGate = requireMethod(
      chatRoutineGateRuntime,
      'chatRoutineGateRuntime',
      'resolveRoutineGate',
    );
    const prepareRecoEntry = requireMethod(
      chatRecoEntryRuntime,
      'chatRecoEntryRuntime',
      'prepareRecoEntry',
    );
    const maybeBuildRecommendationEnvelope = requireMethod(
      chatRecommendationRuntime,
      'chatRecommendationRuntime',
      'maybeBuildRecommendationEnvelope',
    );
    const maybeBuildProfileContinuationEnvelope = requireMethod(
      chatProfileContinuationRuntime,
      'chatProfileContinuationRuntime',
      'maybeBuildProfileContinuationEnvelope',
    );

    let nextProfile = profile;
    let nextState = nextStateOverride;
    let nextCtxState = ctx && ctx.state;
    let nextPolicyMetaPatch = null;
    let nextIngredientRecoContext = ingredientRecoContext;
    let nextPendingSafetyAdvisory = pendingSafetyAdvisory;
    let nextPendingClarificationPatchOverride = pendingClarificationPatchOverride;

    const routineGateResult = await resolveRoutineGate({
      actionId,
      allowRecoCards,
      ctx,
      profile: nextProfile,
      appliedProfilePatch,
      message,
      normalizedActionPayload,
      ingredientScienceIntentEffective,
      recoInteractionAllowed,
      includeAlternatives,
      identity,
      recentLogs,
      debugUpstream,
      nextStateOverride: nextState,
      summarizeChatProfileForContext,
      pushGateDecision,
      enqueueGateAdvisory,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });
    nextProfile = routineGateResult.profile;
    nextState = routineGateResult.nextStateOverride;
    nextCtxState = routineGateResult.nextCtxState;
    nextPolicyMetaPatch = routineGateResult.policyMetaPatch;
    if (routineGateResult.handled) {
      return {
        handled: true,
        envelope: routineGateResult.envelope,
        profile: nextProfile,
        nextStateOverride: nextState,
        nextCtxState,
        policyMetaPatch: nextPolicyMetaPatch,
        ingredientRecoContext: nextIngredientRecoContext,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
      };
    }

    const recoEntry = prepareRecoEntry({
      forceUpstreamAfterPendingAbandon,
      actionId,
      clarificationId,
      appliedProfilePatch,
      textDerivedProfilePatch,
      textDerivedSkinLog,
      latestRecoContextFromSession,
      allowRecoCards,
      message,
      normalizedActionPayload,
      ingredientRecoOptInRequested,
      ingredientLookupRequested,
      ingredientByGoalRequested,
      ctx,
      profile: nextProfile,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      summarizeChatProfileForContext,
    });
    if (recoEntry.handled) {
      return {
        handled: true,
        envelope: recoEntry.envelope,
        profile: nextProfile,
        nextStateOverride: nextState,
        nextCtxState,
        policyMetaPatch: nextPolicyMetaPatch,
        ingredientRecoContext: nextIngredientRecoContext,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
      };
    }

    const {
      budgetChipCanContinueReco,
      profileClarificationAction,
      ingredientDrivenRecommendationRequested,
      shouldAutoRerunRecommendationsFromProfilePatch,
      recoEntrySourceDetail,
      recoRequestMessage,
    } = recoEntry;

    const recommendationResult = await maybeBuildRecommendationEnvelope({
      forceUpstreamAfterPendingAbandon,
      allowRecoCards,
      message,
      normalizedActionPayload,
      ingredientRecoOptInRequested,
      actionId,
      budgetChipCanContinueReco,
      profileClarificationAction,
      ingredientDrivenRecommendationRequested,
      shouldAutoRerunRecommendationsFromProfilePatch,
      recoInteractionAllowed,
      ingredientRecoContext: nextIngredientRecoContext,
      ingredientActionData,
      ctx,
      recoEntrySourceDetail,
      safetyDecision,
      profile: nextProfile,
      identity,
      pendingSafetyAdvisory: nextPendingSafetyAdvisory,
      pushGateDecision,
      enqueueGateAdvisory,
      pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
      buildDiagnosisChips,
      chatSafetyRuntime,
      chatDiagnosisGateRuntime,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      canonicalIntent,
      session,
      recentLogs,
      includeAlternatives,
      debugUpstream,
      recoRequestMessage,
      buildSafetyNoticeText,
    });
    nextIngredientRecoContext = recommendationResult.ingredientRecoContext;
    nextProfile = recommendationResult.profile;
    nextPendingSafetyAdvisory = recommendationResult.pendingSafetyAdvisory;
    nextPendingClarificationPatchOverride = recommendationResult.pendingClarificationPatchOverride;
    if (recommendationResult.handled) {
      return {
        handled: true,
        envelope: recommendationResult.envelope,
        profile: nextProfile,
        nextStateOverride: nextState,
        nextCtxState,
        policyMetaPatch: nextPolicyMetaPatch,
        ingredientRecoContext: nextIngredientRecoContext,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
      };
    }

    const hasExplicitUserIntentMessage =
      looksLikeSuitabilityRequestFn(message) ||
      looksLikeCompatibilityOrConflictQuestionFn(message) ||
      looksLikeWeatherOrEnvironmentQuestionFn(message) ||
      looksLikeRecommendationRequestFn(message);

    const profileContinuationEnvelope = maybeBuildProfileContinuationEnvelope({
      ctx,
      agentState,
      message,
      profileClarificationAction,
      hasExplicitUserIntentMessage,
      ingredientScienceIntentEffective,
      ingredientEntryRequested,
      ingredientLookupRequested,
      ingredientByGoalRequested,
      ingredientTextTrigger,
      profile: nextProfile,
      recentLogs,
      appliedProfilePatch,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      summarizeChatProfileForContext,
      buildDiagnosisPrompt,
      buildDiagnosisChips,
    });
    if (profileContinuationEnvelope) {
      return {
        handled: true,
        envelope: profileContinuationEnvelope,
        profile: nextProfile,
        nextStateOverride: nextState,
        nextCtxState,
        policyMetaPatch: nextPolicyMetaPatch,
        ingredientRecoContext: nextIngredientRecoContext,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
      };
    }

    return {
      handled: false,
      envelope: null,
      profile: nextProfile,
      nextStateOverride: nextState,
      nextCtxState,
      policyMetaPatch: nextPolicyMetaPatch,
      ingredientRecoContext: nextIngredientRecoContext,
      pendingSafetyAdvisory: nextPendingSafetyAdvisory,
      pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
    };
  }

  return {
    resolveRecommendationFlow,
  };
}

module.exports = {
  createChatRecommendationFlowRuntime,
};
