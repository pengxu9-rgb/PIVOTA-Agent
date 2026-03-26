function createChatPreUpstreamRuntime(options = {}) {
  const {
    chatBoundaryPreludeRuntime = null,
    chatIngredientEntryRuntime = null,
    chatLoopBreakerRuntime = null,
    chatCatalogAvailabilityRuntime = null,
    chatTravelEnvRuntime = null,
    chatConflictRuntime = null,
    chatDiagnosisGateRuntime = null,
    chatIngredientRouteRuntime = null,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat pre-upstream runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function resolvePreUpstreamFlow(args = {}) {
    const prepareBoundaryPrelude = requireMethod(
      chatBoundaryPreludeRuntime,
      'chatBoundaryPreludeRuntime',
      'prepareBoundaryPrelude',
    );
    const resolveIngredientEntryEnvelope = requireMethod(
      chatIngredientEntryRuntime,
      'chatIngredientEntryRuntime',
      'resolveIngredientEntryEnvelope',
    );
    const maybeBuildLoopBreakerEnvelope = requireMethod(
      chatLoopBreakerRuntime,
      'chatLoopBreakerRuntime',
      'maybeBuildLoopBreakerEnvelope',
    );
    const maybeBuildCatalogAvailabilityEnvelope = requireMethod(
      chatCatalogAvailabilityRuntime,
      'chatCatalogAvailabilityRuntime',
      'maybeBuildCatalogAvailabilityEnvelope',
    );
    const maybeBuildTravelEnvEnvelope = requireMethod(
      chatTravelEnvRuntime,
      'chatTravelEnvRuntime',
      'maybeBuildTravelEnvEnvelope',
    );
    const maybeBuildConflictEnvelope = requireMethod(
      chatConflictRuntime,
      'chatConflictRuntime',
      'maybeBuildConflictEnvelope',
    );
    const resolveDiagnosisEntryEnvelope = requireMethod(
      chatDiagnosisGateRuntime,
      'chatDiagnosisGateRuntime',
      'resolveDiagnosisEntryEnvelope',
    );
    const resolveIngredientRouteFlow = requireMethod(
      chatIngredientRouteRuntime,
      'chatIngredientRouteRuntime',
      'resolveIngredientRouteFlow',
    );

    const {
      effectiveChatFlags = {},
      message = '',
      actionId = null,
      ctx = {},
      canonicalIntent = {},
      profile = null,
      hasPlannerAnchor = false,
      debugUpstream = false,
      appliedProfilePatch = null,
      anchorProductId = '',
      anchorProductUrl = '',
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
      identity = null,
      session = null,
      req = null,
      ingredientRecoContext = null,
      ingredientGoalRequest = null,
      nextStateOverride = null,
      ingredientEntryRequested = false,
      ingredientByGoalRequested = false,
      ingredientLookupRequested = false,
      ingredientResearchPollRequested = false,
      ingredientRouteDecisionReasons = [],
      ingredientLookupQuery = '',
      ingredientActionData = null,
      INGREDIENT_ROUTE_RULE_VERSION = '',
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED = false,
      summarizeChatProfileForContext,
      recentLogs = [],
      chatContext = null,
      templateAcceptLanguage = '',
      agentState = null,
      ingredientDiagnosisOptInRequested = false,
      ingredientTextTrigger = false,
      buildDiagnosisPrompt,
      buildDiagnosisChips,
      profileCompleteness,
      stateChangeAllowed,
      normalizeIngredientActionId,
      attachIngredientRouteMetaToSessionPatch,
      ingredientLookupTargetFromText = '',
      ingredientEntityMatch = null,
      buildSafetyNoticeText,
      recommendationFlowArgs = null,
      requestMessage = '',
    } = args;

    let nextProfile = profile;
    let nextSafetyDecision = null;
    let nextPendingSafetyAdvisory = pendingSafetyAdvisory;
    let nextState = nextStateOverride;
    let nextCtxState = ctx && Object.prototype.hasOwnProperty.call(ctx, 'state') ? ctx.state : undefined;
    let nextIngredientRecoContext = ingredientRecoContext;
    let nextPendingClarificationPatchOverride =
      recommendationFlowArgs && Object.prototype.hasOwnProperty.call(recommendationFlowArgs, 'pendingClarificationPatchOverride')
        ? recommendationFlowArgs.pendingClarificationPatchOverride
        : undefined;
    let nextRequestMessage = requestMessage;
    let nextPlannerSessionStatePatch = null;
    const nextPolicyMetaPatch = {};
    let hasPolicyMetaPatch = false;

    const boundaryPrelude = await prepareBoundaryPrelude({
      effectiveChatFlags,
      message,
      actionId,
      ctx,
      canonicalIntent,
      profile: nextProfile,
      hasPlannerAnchor,
      debugUpstream,
      appliedProfilePatch,
      anchorProductId,
      anchorProductUrl,
      allowRecoCards,
      evaluateIntent,
      ingredientScienceIntentEffective,
      conflictIntentRequested,
      recommendationEntryRequested,
      diagnosisEntryRequested,
      normalizedActionPayload,
      pendingSafetyAdvisory: nextPendingSafetyAdvisory,
      pushGateDecision,
      enqueueGateAdvisory,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      identity,
      session,
    });
    const plannerDecision = boundaryPrelude.plannerDecision;
    if (boundaryPrelude.plannerPolicyMetaPatch) {
      Object.assign(nextPolicyMetaPatch, {
        gate_type: boundaryPrelude.plannerPolicyMetaPatch.gate_type,
        loop_count: boundaryPrelude.plannerPolicyMetaPatch.loop_count,
        break_applied: boundaryPrelude.plannerPolicyMetaPatch.break_applied,
      });
      hasPolicyMetaPatch = true;
    }
    nextPlannerSessionStatePatch = boundaryPrelude.plannerSessionStatePatch;
    const diagnosisFlowContinuationAllowed = boundaryPrelude.diagnosisFlowContinuationAllowed;
    nextSafetyDecision = boundaryPrelude.safetyDecision;
    nextProfile = boundaryPrelude.profile;
    nextPendingSafetyAdvisory = boundaryPrelude.pendingSafetyAdvisory;
    nextState = boundaryPrelude.nextStateOverride;
    nextCtxState = boundaryPrelude.nextCtxState;
    if (ctx && typeof ctx === 'object') {
      ctx.state = nextCtxState;
    }
    const shouldBypassAvailabilityShortCircuit = boundaryPrelude.shouldBypassAvailabilityShortCircuit;
    if (boundaryPrelude.fitCheckAnchorGateType) {
      nextPolicyMetaPatch.gate_type = boundaryPrelude.fitCheckAnchorGateType;
      hasPolicyMetaPatch = true;
    }
    if (boundaryPrelude.safetyPolicyMetaPatch) {
      Object.assign(nextPolicyMetaPatch, {
        safety_gate_mode: boundaryPrelude.safetyPolicyMetaPatch.safety_gate_mode,
        safety_advisory_emitted: boundaryPrelude.safetyPolicyMetaPatch.safety_advisory_emitted,
      });
      hasPolicyMetaPatch = true;
    }
    if (boundaryPrelude.blockedEnvelope) {
      return {
        handled: true,
        envelope: boundaryPrelude.blockedEnvelope,
        plannerSessionStatePatch: nextPlannerSessionStatePatch,
        safetyDecision: nextSafetyDecision,
        profile: nextProfile,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        nextStateOverride: nextState,
        nextCtxState,
        ingredientRecoContext: nextIngredientRecoContext,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
        requestMessage: nextRequestMessage,
        policyMetaPatch: hasPolicyMetaPatch ? nextPolicyMetaPatch : null,
      };
    }

    const ingredientEntryResult = await resolveIngredientEntryEnvelope({
      ctx,
      req,
      identity,
      profile: nextProfile,
      ingredientRecoContext: nextIngredientRecoContext,
      ingredientGoalRequest,
      nextStateOverride: nextState,
      message,
      ingredientEntryRequested,
      ingredientByGoalRequested,
      ingredientLookupRequested,
      ingredientResearchPollRequested,
      ingredientRouteDecisionReasons,
      ingredientLookupQuery,
      ingredientActionData,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      INGREDIENT_ROUTE_RULE_VERSION,
    });
    nextIngredientRecoContext = ingredientEntryResult.ingredientRecoContext;
    if (ingredientEntryResult.requestMessage) {
      nextRequestMessage = ingredientEntryResult.requestMessage;
    }
    if (ingredientEntryResult.handled) {
      return {
        handled: true,
        envelope: ingredientEntryResult.envelope,
        plannerSessionStatePatch: nextPlannerSessionStatePatch,
        safetyDecision: nextSafetyDecision,
        profile: nextProfile,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        nextStateOverride: nextState,
        nextCtxState,
        ingredientRecoContext: nextIngredientRecoContext,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
        requestMessage: nextRequestMessage,
        policyMetaPatch: hasPolicyMetaPatch ? nextPolicyMetaPatch : null,
      };
    }

    const loopBreakerResult = maybeBuildLoopBreakerEnvelope({
      effectiveChatFlags,
      conflictIntentRequested,
      plannerDecision,
      ctx,
      canonicalIntent,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });
    if (loopBreakerResult.handled) {
      return {
        handled: true,
        envelope: loopBreakerResult.envelope,
        plannerSessionStatePatch: nextPlannerSessionStatePatch,
        safetyDecision: nextSafetyDecision,
        profile: nextProfile,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        nextStateOverride: nextState,
        nextCtxState,
        ingredientRecoContext: nextIngredientRecoContext,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
        requestMessage: nextRequestMessage,
        policyMetaPatch: hasPolicyMetaPatch ? nextPolicyMetaPatch : null,
      };
    }

    if (
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED &&
      message &&
      (ctx.trigger_source === 'text' || ctx.trigger_source === 'text_explicit')
    ) {
      const availabilityEnvelope = await maybeBuildCatalogAvailabilityEnvelope({
        ctx,
        message,
        shouldBypassAvailabilityShortCircuit,
        nextStateOverride: nextState,
        profile: nextProfile,
        appliedProfilePatch,
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
        summarizeChatProfileForContext,
      });
      if (availabilityEnvelope) {
        return {
          handled: true,
          envelope: availabilityEnvelope,
          plannerSessionStatePatch: nextPlannerSessionStatePatch,
          safetyDecision: nextSafetyDecision,
          profile: nextProfile,
          pendingSafetyAdvisory: nextPendingSafetyAdvisory,
          nextStateOverride: nextState,
          nextCtxState,
          ingredientRecoContext: nextIngredientRecoContext,
          pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
          requestMessage: nextRequestMessage,
          policyMetaPatch: hasPolicyMetaPatch ? nextPolicyMetaPatch : null,
        };
      }
    }

    const travelEnvResult = await maybeBuildTravelEnvEnvelope({
      ctx,
      message,
      canonicalIntent,
      plannerDecision,
      profile: nextProfile,
      recentLogs,
      chatContext,
      effectiveChatFlags,
      templateAcceptLanguage,
      safetyDecision: nextSafetyDecision,
      nextStateOverride: nextState,
      buildSafetyNoticeText,
      pushGateDecision,
      enqueueGateAdvisory,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });
    if (travelEnvResult.policyMetaPatch) {
      if (travelEnvResult.policyMetaPatch.gate_type != null) {
        nextPolicyMetaPatch.gate_type = travelEnvResult.policyMetaPatch.gate_type;
        hasPolicyMetaPatch = true;
      }
      if (travelEnvResult.policyMetaPatch.env_source != null) {
        nextPolicyMetaPatch.env_source = travelEnvResult.policyMetaPatch.env_source;
        hasPolicyMetaPatch = true;
      }
      if (travelEnvResult.policyMetaPatch.degraded != null) {
        nextPolicyMetaPatch.degraded = travelEnvResult.policyMetaPatch.degraded;
        hasPolicyMetaPatch = true;
      }
    }
    if (travelEnvResult.handled) {
      return {
        handled: true,
        envelope: travelEnvResult.envelope,
        plannerSessionStatePatch: nextPlannerSessionStatePatch,
        safetyDecision: nextSafetyDecision,
        profile: nextProfile,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        nextStateOverride: nextState,
        nextCtxState,
        ingredientRecoContext: nextIngredientRecoContext,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
        requestMessage: nextRequestMessage,
        policyMetaPatch: hasPolicyMetaPatch ? nextPolicyMetaPatch : null,
      };
    }

    const conflictResult = await maybeBuildConflictEnvelope({
      ctx,
      message,
      profile: nextProfile,
      nextStateOverride: nextState,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });
    if (conflictResult.handled) {
      return {
        handled: true,
        envelope: conflictResult.envelope,
        plannerSessionStatePatch: nextPlannerSessionStatePatch,
        safetyDecision: nextSafetyDecision,
        profile: nextProfile,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        nextStateOverride: nextState,
        nextCtxState,
        ingredientRecoContext: nextIngredientRecoContext,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
        requestMessage: nextRequestMessage,
        policyMetaPatch: hasPolicyMetaPatch ? nextPolicyMetaPatch : null,
      };
    }

    const diagnosisEntryResult = resolveDiagnosisEntryEnvelope({
      ctx,
      agentState,
      diagnosisFlowContinuationAllowed,
      diagnosisEntryRequested,
      ingredientScienceIntentEffective,
      ingredientDiagnosisOptInRequested,
      actionId,
      ingredientEntryRequested,
      ingredientLookupRequested,
      ingredientByGoalRequested,
      ingredientResearchPollRequested,
      ingredientTextTrigger,
      profile: nextProfile,
      recentLogs,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      summarizeChatProfileForContext,
      buildDiagnosisPrompt,
      buildDiagnosisChips,
      profileCompleteness,
      stateChangeAllowed,
      normalizeIngredientActionId,
    });
    if (diagnosisEntryResult.handled) {
      return {
        handled: true,
        envelope: diagnosisEntryResult.envelope,
        plannerSessionStatePatch: nextPlannerSessionStatePatch,
        safetyDecision: nextSafetyDecision,
        profile: nextProfile,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        nextStateOverride: nextState,
        nextCtxState,
        ingredientRecoContext: nextIngredientRecoContext,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
        requestMessage: nextRequestMessage,
        policyMetaPatch: hasPolicyMetaPatch ? nextPolicyMetaPatch : null,
      };
    }

    const ingredientRouteResult = await resolveIngredientRouteFlow({
      ingredientScienceIntentEffective,
      safetyDecision: nextSafetyDecision,
      profile: nextProfile,
      identity,
      pendingSafetyAdvisory: nextPendingSafetyAdvisory,
      pushGateDecision,
      ctx,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      attachIngredientRouteMetaToSessionPatch,
      ingredientRouteDecisionReasons,
      INGREDIENT_ROUTE_RULE_VERSION,
      req,
      ingredientRecoContext: nextIngredientRecoContext,
      ingredientGoalRequest,
      nextStateOverride: nextState,
      message,
      ingredientTextTrigger,
      ingredientEntryRequested,
      ingredientByGoalRequested,
      ingredientLookupRequested,
      ingredientResearchPollRequested,
      ingredientDiagnosisOptInRequested,
      ingredientLookupQuery,
      ingredientLookupTargetFromText,
      ingredientEntityMatch,
      buildSafetyNoticeText,
      normalizedActionPayload,
      recommendationFlowArgs,
    });
    nextIngredientRecoContext = ingredientRouteResult.ingredientRecoContext;
    nextProfile = ingredientRouteResult.profile;
    nextState = ingredientRouteResult.nextStateOverride;
    nextCtxState = ingredientRouteResult.nextCtxState;
    if (ctx && typeof ctx === 'object') {
      ctx.state = nextCtxState;
    }
    nextPendingSafetyAdvisory = ingredientRouteResult.pendingSafetyAdvisory;
    nextPendingClarificationPatchOverride = ingredientRouteResult.pendingClarificationPatchOverride;
    nextRequestMessage = ingredientRouteResult.requestMessage || nextRequestMessage;
    if (ingredientRouteResult.policyMetaPatch) {
      Object.assign(nextPolicyMetaPatch, ingredientRouteResult.policyMetaPatch);
      hasPolicyMetaPatch = true;
    }
    if (ingredientRouteResult.handled) {
      return {
        handled: true,
        envelope: ingredientRouteResult.envelope,
        plannerSessionStatePatch: nextPlannerSessionStatePatch,
        safetyDecision: nextSafetyDecision,
        profile: nextProfile,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        nextStateOverride: nextState,
        nextCtxState,
        ingredientRecoContext: nextIngredientRecoContext,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
        requestMessage: nextRequestMessage,
        policyMetaPatch: hasPolicyMetaPatch ? nextPolicyMetaPatch : null,
      };
    }

    return {
      handled: false,
      envelope: null,
      plannerSessionStatePatch: nextPlannerSessionStatePatch,
      safetyDecision: nextSafetyDecision,
      profile: nextProfile,
      pendingSafetyAdvisory: nextPendingSafetyAdvisory,
      nextStateOverride: nextState,
      nextCtxState,
      ingredientRecoContext: nextIngredientRecoContext,
      pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
      requestMessage: nextRequestMessage,
      policyMetaPatch: hasPolicyMetaPatch ? nextPolicyMetaPatch : null,
    };
  }

  return {
    resolvePreUpstreamFlow,
  };
}

module.exports = {
  createChatPreUpstreamRuntime,
};
