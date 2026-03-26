function createChatBoundaryPreludeRuntime(options = {}) {
  const {
    resolveQaPlan = () => null,
    stateChangeAllowed = () => false,
    looksLikeSuitabilityRequest = () => false,
    looksLikeCompatibilityOrConflictQuestion = () => false,
    looksLikeRoutineRequest = () => false,
    looksLikeRecommendationRequest = () => false,
    looksLikeWeatherOrEnvironmentQuestion = () => false,
    chatBoundaryRuntime = null,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat boundary prelude runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function prepareBoundaryPrelude(args = {}) {
    const {
      effectiveChatFlags = {},
      message = '',
      actionId = '',
      ctx = {},
      canonicalIntent = {},
      profile = null,
      hasPlannerAnchor = false,
      debugUpstream = false,
      appliedProfilePatch = null,
      anchorProductId = null,
      anchorProductUrl = null,
      allowRecoCards = false,
      evaluateIntent = false,
      ingredientScienceIntentEffective = false,
      conflictIntentRequested = false,
      recommendationEntryRequested = false,
      diagnosisEntryRequested = false,
      normalizedActionPayload = null,
      pendingSafetyAdvisory = null,
      pushGateDecision,
      enqueueGateAdvisory,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    } = args;

    const computeSafetyDecision = requireMethod(
      chatBoundaryRuntime,
      'chatBoundaryRuntime',
      'computeSafetyDecision',
    );
    const analyzeBoundaryState = requireMethod(
      chatBoundaryRuntime,
      'chatBoundaryRuntime',
      'analyzeBoundaryState',
    );
    const maybeBuildFitCheckAnchorEnvelope = requireMethod(
      chatBoundaryRuntime,
      'chatBoundaryRuntime',
      'maybeBuildFitCheckAnchorEnvelope',
    );
    const runSafetyPreGate = requireMethod(
      chatBoundaryRuntime,
      'chatBoundaryRuntime',
      'runSafetyPreGate',
    );

    const initialBoundaryState = computeSafetyDecision({
      effectiveChatFlags,
      message,
      actionId,
      ctx,
      canonicalIntent,
      profile,
      hasPlannerAnchor,
      debugUpstream,
    });
    let safetyDecision = initialBoundaryState.safetyDecision;

    const plannerDecision =
      effectiveChatFlags.qa_planner_v1 || effectiveChatFlags.loop_breaker_v2
        ? resolveQaPlan({
          intent: canonicalIntent.intent,
          profile,
          message,
          language: ctx.match_lang || ctx.lang,
          hasAnchor: hasPlannerAnchor,
          session: args.session,
          safetyDecision,
          profileDelta: Boolean(appliedProfilePatch && Object.keys(appliedProfilePatch).length),
          anchorDelta: Boolean(anchorProductId || anchorProductUrl),
        })
        : null;

    const plannerPolicyMetaPatch = plannerDecision
      ? {
        gate_type: plannerDecision.gate_type || 'none',
        loop_count: Number(plannerDecision.loop_count) || 0,
        break_applied: plannerDecision.break_applied || 'none',
      }
      : null;

    const diagnosisFlowContinuationAllowed = Boolean(
      !diagnosisEntryRequested &&
        !recommendationEntryRequested &&
        !evaluateIntent &&
        !ingredientScienceIntentEffective &&
        !conflictIntentRequested &&
        !looksLikeWeatherOrEnvironmentQuestion(message)
    );

    const boundaryStateWithIntent = analyzeBoundaryState({
      message,
      actionId,
      canonicalIntent,
      evaluateIntent,
      ingredientScienceIntentEffective,
      conflictIntentRequested,
      safetyDecision,
      anchorCollectionSignal: initialBoundaryState.anchorCollectionSignal,
    });
    const anchorCollectionSignal = boundaryStateWithIntent.anchorCollectionSignal;
    safetyDecision = boundaryStateWithIntent.safetyDecision;
    const shouldBypassAvailabilityShortCircuit = boundaryStateWithIntent.shouldBypassAvailabilityShortCircuit;

    let nextStateOverride = null;
    let nextCtxState = ctx.state;
    if (nextCtxState === 'S6_BUDGET') {
      const wantsFitCheck = looksLikeSuitabilityRequest(message);
      const wantsCompat = looksLikeCompatibilityOrConflictQuestion(message);
      const wantsScience = ingredientScienceIntentEffective;
      const wantsRecoNoRoutine =
        looksLikeRecommendationRequest(message) &&
        !looksLikeRoutineRequest(message, normalizedActionPayload);
      const wantsEnvStress =
        looksLikeWeatherOrEnvironmentQuestion(message) &&
        (ctx.trigger_source === 'text' || ctx.trigger_source === 'text_explicit');
      if (wantsFitCheck || wantsCompat || wantsScience || wantsEnvStress || wantsRecoNoRoutine) {
        if (stateChangeAllowed(ctx.trigger_source)) {
          nextStateOverride = allowRecoCards ? 'S7_PRODUCT_RECO' : 'idle';
        }
        nextCtxState = nextStateOverride || 'idle';
      }
    }

    const fitCheckAnchorGate = maybeBuildFitCheckAnchorEnvelope({
      evaluateIntent,
      hasFitCheckAnchor: hasPlannerAnchor,
      anchorCollectionSignal,
      ctx,
      pushGateDecision,
      enqueueGateAdvisory,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });
    if (fitCheckAnchorGate) {
      return {
        plannerDecision,
        plannerPolicyMetaPatch,
        plannerSessionStatePatch: plannerDecision && plannerDecision.session_state_patch
          ? plannerDecision.session_state_patch
          : null,
        diagnosisFlowContinuationAllowed,
        safetyDecision,
        profile,
        pendingSafetyAdvisory,
        anchorCollectionSignal,
        shouldBypassAvailabilityShortCircuit,
        nextStateOverride,
        nextCtxState,
        blockedEnvelope: fitCheckAnchorGate.envelope,
        fitCheckAnchorGateType: fitCheckAnchorGate.gateType || null,
        safetyPolicyMetaPatch: null,
      };
    }

    const safetyGateResult = await runSafetyPreGate({
      shouldRunSafetyPreGate: boundaryStateWithIntent.shouldRunSafetyPreGate,
      safetyDecision,
      profile,
      identity: args.identity,
      conflictIntentRequested,
      pendingSafetyAdvisory,
      pushGateDecision,
      ctx,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      intent: canonicalIntent.intent,
    });

    return {
      plannerDecision,
      plannerPolicyMetaPatch,
      plannerSessionStatePatch: plannerDecision && plannerDecision.session_state_patch
        ? plannerDecision.session_state_patch
        : null,
      diagnosisFlowContinuationAllowed,
      safetyDecision,
      profile: safetyGateResult.profile,
      pendingSafetyAdvisory: safetyGateResult.pendingSafetyAdvisory,
      anchorCollectionSignal,
      shouldBypassAvailabilityShortCircuit,
      nextStateOverride,
      nextCtxState,
      blockedEnvelope: safetyGateResult.blockedEnvelope || null,
      fitCheckAnchorGateType: null,
      safetyPolicyMetaPatch: safetyGateResult.blockedEnvelope
        ? {
          safety_gate_mode: 'advisory_only_v1',
          safety_advisory_emitted: false,
        }
        : null,
    };
  }

  return {
    prepareBoundaryPrelude,
  };
}

module.exports = {
  createChatBoundaryPreludeRuntime,
};
