function createChatIngredientRouteRuntime(options = {}) {
  const {
    looksLikeRoutineRequest = () => false,
    looksLikeSuitabilityRequest = () => false,
    looksLikeCompatibilityOrConflictQuestion = () => false,
    looksLikeWeatherOrEnvironmentQuestion = () => false,
    messageContainsSpecificIngredientScienceTarget = () => false,
    chatSafetyRuntime = null,
    chatIngredientEntryRuntime = null,
    chatRecommendationFlowRuntime = null,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat ingredient route runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function resolveIngredientRouteFlow(args = {}) {
    const looksLikeRoutineRequestFn = requireFunction('looksLikeRoutineRequest', looksLikeRoutineRequest);
    const looksLikeSuitabilityRequestFn = requireFunction('looksLikeSuitabilityRequest', looksLikeSuitabilityRequest);
    const looksLikeCompatibilityOrConflictQuestionFn = requireFunction(
      'looksLikeCompatibilityOrConflictQuestion',
      looksLikeCompatibilityOrConflictQuestion,
    );
    const looksLikeWeatherOrEnvironmentQuestionFn = requireFunction(
      'looksLikeWeatherOrEnvironmentQuestion',
      looksLikeWeatherOrEnvironmentQuestion,
    );
    const messageContainsSpecificIngredientScienceTargetFn = requireFunction(
      'messageContainsSpecificIngredientScienceTarget',
      messageContainsSpecificIngredientScienceTarget,
    );
    const resolveSafetyGate = requireMethod(chatSafetyRuntime, 'chatSafetyRuntime', 'resolveSafetyGate');
    const resolveIngredientEntryEnvelope = requireMethod(
      chatIngredientEntryRuntime,
      'chatIngredientEntryRuntime',
      'resolveIngredientEntryEnvelope',
    );
    const resolveRecommendationFlow = requireMethod(
      chatRecommendationFlowRuntime,
      'chatRecommendationFlowRuntime',
      'resolveRecommendationFlow',
    );

    const {
      ingredientScienceIntentEffective = false,
      safetyDecision = null,
      profile = null,
      identity = {},
      pendingSafetyAdvisory = null,
      pushGateDecision,
      ctx = {},
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      attachIngredientRouteMetaToSessionPatch,
      ingredientRouteDecisionReasons = [],
      INGREDIENT_ROUTE_RULE_VERSION = '',
      req,
      ingredientRecoContext = null,
      ingredientGoalRequest = { goal: '', sensitivity: 'unknown' },
      nextStateOverride = null,
      message = '',
      ingredientTextTrigger = false,
      ingredientEntryRequested = false,
      ingredientByGoalRequested = false,
      ingredientLookupRequested = false,
      ingredientResearchPollRequested = false,
      ingredientDiagnosisOptInRequested = false,
      ingredientLookupQuery = '',
      ingredientLookupTargetFromText = '',
      ingredientEntityMatch = { entity_match_type: 'none' },
      buildSafetyNoticeText,
      normalizedActionPayload = null,
      recommendationFlowArgs = null,
    } = args;

    let nextProfile = profile;
    let nextIngredientRecoContext = ingredientRecoContext;
    let nextPendingSafetyAdvisory = pendingSafetyAdvisory;
    let nextState = nextStateOverride;
    let nextCtxState = ctx && ctx.state;
    let nextPendingClarificationPatchOverride =
      recommendationFlowArgs && 'pendingClarificationPatchOverride' in recommendationFlowArgs
        ? recommendationFlowArgs.pendingClarificationPatchOverride
        : undefined;
    let nextPolicyMetaPatch = null;
    let nextRequestMessage = null;

    if (ingredientScienceIntentEffective && safetyDecision) {
      const ingredientSafetyGate = await resolveSafetyGate({
        safety: safetyDecision,
        profile: nextProfile,
        identity,
        conflictIntent: false,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        pushGateDecision,
        language: ctx.lang,
        variant: 'ingredient',
        ctx,
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
        attachIngredientRouteMetaToSessionPatch,
        ingredientRouteMeta: {
          routeSource: ingredientTextTrigger ? 'text' : 'chip',
          routeDecisionReasons: ['safety_block', ...ingredientRouteDecisionReasons],
          routeRuleVersion: INGREDIENT_ROUTE_RULE_VERSION,
        },
      });
      nextProfile = ingredientSafetyGate.profile;
      nextPendingSafetyAdvisory = ingredientSafetyGate.pendingSafetyAdvisory;
      if (ingredientSafetyGate.blockedEnvelope) {
        return {
          handled: true,
          envelope: ingredientSafetyGate.blockedEnvelope,
          profile: nextProfile,
          ingredientRecoContext: nextIngredientRecoContext,
          pendingSafetyAdvisory: nextPendingSafetyAdvisory,
          nextStateOverride: nextState,
          nextCtxState,
          pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
          policyMetaPatch: nextPolicyMetaPatch,
          requestMessage: nextRequestMessage,
        };
      }
    }

    const ingredientTextQueryFirstEligible =
      ingredientScienceIntentEffective &&
      ingredientTextTrigger &&
      !ingredientEntryRequested &&
      !ingredientByGoalRequested &&
      !ingredientLookupRequested &&
      !ingredientResearchPollRequested &&
      !ingredientDiagnosisOptInRequested &&
      !looksLikeRoutineRequestFn(message, normalizedActionPayload) &&
      !looksLikeSuitabilityRequestFn(message) &&
      !looksLikeCompatibilityOrConflictQuestionFn(message) &&
      !looksLikeWeatherOrEnvironmentQuestionFn(message);

    if (ingredientTextQueryFirstEligible) {
      const ingredientTextResult = await resolveIngredientEntryEnvelope({
        ctx,
        req,
        identity,
        profile: nextProfile,
        ingredientRecoContext: nextIngredientRecoContext,
        ingredientGoalRequest,
        nextStateOverride: nextState,
        message,
        ingredientTextQueryFirstEligible,
        ingredientRouteDecisionReasons,
        ingredientLookupTargetFromText,
        ingredientEntityMatch,
        ingredientTextTrigger,
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
        INGREDIENT_ROUTE_RULE_VERSION,
      });
      nextIngredientRecoContext = ingredientTextResult.ingredientRecoContext;
      if (ingredientTextResult.requestMessage) {
        nextRequestMessage = ingredientTextResult.requestMessage;
      }
      if (ingredientTextResult.handled) {
        return {
          handled: true,
          envelope: ingredientTextResult.envelope,
          profile: nextProfile,
          ingredientRecoContext: nextIngredientRecoContext,
          pendingSafetyAdvisory: nextPendingSafetyAdvisory,
          nextStateOverride: nextState,
          nextCtxState,
          pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
          policyMetaPatch: nextPolicyMetaPatch,
          requestMessage: nextRequestMessage,
        };
      }
    }

    const ingredientLookupTargetProvided =
      Boolean(ingredientLookupQuery) ||
      Boolean(ingredientLookupTargetFromText) ||
      messageContainsSpecificIngredientScienceTargetFn(message);
    const shouldKickoffIngredientScience =
      ingredientScienceIntentEffective &&
      !ingredientEntryRequested &&
      !ingredientByGoalRequested &&
      !ingredientLookupRequested &&
      !ingredientResearchPollRequested &&
      !ingredientDiagnosisOptInRequested &&
      !looksLikeRoutineRequestFn(message, normalizedActionPayload) &&
      !looksLikeSuitabilityRequestFn(message) &&
      !looksLikeCompatibilityOrConflictQuestionFn(message) &&
      !looksLikeWeatherOrEnvironmentQuestionFn(message) &&
      !ingredientLookupTargetProvided;

    if (shouldKickoffIngredientScience) {
      const ingredientScienceResult = await resolveIngredientEntryEnvelope({
        ctx,
        req,
        identity,
        profile: nextProfile,
        ingredientRecoContext: nextIngredientRecoContext,
        ingredientGoalRequest,
        nextStateOverride: nextState,
        shouldKickoffIngredientScience,
        ingredientScienceIntentEffective,
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
        buildSafetyNoticeText,
        safetyDecision,
      });
      nextIngredientRecoContext = ingredientScienceResult.ingredientRecoContext;
      if (ingredientScienceResult.requestMessage) {
        nextRequestMessage = ingredientScienceResult.requestMessage;
      }
      if (ingredientScienceResult.handled) {
        return {
          handled: true,
          envelope: ingredientScienceResult.envelope,
          profile: nextProfile,
          ingredientRecoContext: nextIngredientRecoContext,
          pendingSafetyAdvisory: nextPendingSafetyAdvisory,
          nextStateOverride: nextState,
          nextCtxState,
          pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
          policyMetaPatch: nextPolicyMetaPatch,
          requestMessage: nextRequestMessage,
        };
      }
    }

    const recommendationFlowResult = await resolveRecommendationFlow({
      ...(recommendationFlowArgs || {}),
      profile: nextProfile,
      ingredientRecoContext: nextIngredientRecoContext,
      safetyDecision,
      pendingSafetyAdvisory: nextPendingSafetyAdvisory,
      nextStateOverride: nextState,
      ingredientScienceIntentEffective,
      ingredientEntryRequested,
      ingredientTextTrigger,
    });
    nextIngredientRecoContext = recommendationFlowResult.ingredientRecoContext;
    nextProfile = recommendationFlowResult.profile;
    nextState = recommendationFlowResult.nextStateOverride;
    nextCtxState = recommendationFlowResult.nextCtxState;
    nextPendingSafetyAdvisory = recommendationFlowResult.pendingSafetyAdvisory;
    nextPendingClarificationPatchOverride = recommendationFlowResult.pendingClarificationPatchOverride;
    nextPolicyMetaPatch = recommendationFlowResult.policyMetaPatch;
    if (recommendationFlowResult.handled) {
      return {
        handled: true,
        envelope: recommendationFlowResult.envelope,
        profile: nextProfile,
        ingredientRecoContext: nextIngredientRecoContext,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        nextStateOverride: nextState,
        nextCtxState,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
        policyMetaPatch: nextPolicyMetaPatch,
        requestMessage: nextRequestMessage,
      };
    }

    return {
      handled: false,
      envelope: null,
      profile: nextProfile,
      ingredientRecoContext: nextIngredientRecoContext,
      pendingSafetyAdvisory: nextPendingSafetyAdvisory,
      nextStateOverride: nextState,
      nextCtxState,
      pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
      policyMetaPatch: nextPolicyMetaPatch,
      requestMessage: nextRequestMessage,
    };
  }

  return {
    resolveIngredientRouteFlow,
  };
}

module.exports = {
  createChatIngredientRouteRuntime,
};
