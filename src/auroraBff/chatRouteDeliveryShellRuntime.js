function createChatRouteDeliveryShellRuntime(options = {}) {
  const {
    chatDeliveryRuntime = null,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat route delivery shell runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  function createRouteState({ defaultAgentState = null, unknownIntent = 'unknown' } = {}) {
    return {
      plannerSessionStatePatch: null,
      latestClarificationId: null,
      profile: null,
      recentLogs: [],
      chatContext: null,
      resolvedIdentity: { auroraUid: null, userId: null },
      canonicalIntentForResponse: { intent: unknownIntent, confidence: 0, entities: {} },
      safetyDecision: null,
      pendingSafetyAdvisory: null,
      pendingGateAdvisories: [],
      pendingPregnancyPolicyEvents: [],
      requestMessage: '',
      recoContextMetricsEmitted: false,
      actionIdForReplay: null,
      clientStateForReplay: defaultAgentState,
      agentStateForReplay: defaultAgentState,
      ingredientReplayContext: {
        intent_requested: false,
        starter_action: false,
        diagnosis_optin: false,
        reco_optin: false,
        entry: null,
      },
      skipRoutineRulesFallback: false,
      llmRouteMetaForResponse: null,
    };
  }

  function applyTurnPipelineResult({ routeState, turnPipelineResult, policyMeta } = {}) {
    if (!routeState || typeof routeState !== 'object') {
      throw new Error('aurora chat route delivery shell runtime missing routeState');
    }
    if (!turnPipelineResult || typeof turnPipelineResult !== 'object') {
      throw new Error('aurora chat route delivery shell runtime missing turnPipelineResult');
    }

    if ('clientStateForReplay' in turnPipelineResult) {
      routeState.clientStateForReplay = turnPipelineResult.clientStateForReplay;
    }
    if ('agentStateForReplay' in turnPipelineResult) {
      routeState.agentStateForReplay = turnPipelineResult.agentStateForReplay;
    }
    if ('plannerSessionStatePatch' in turnPipelineResult) {
      routeState.plannerSessionStatePatch = turnPipelineResult.plannerSessionStatePatch;
    }
    if ('safetyDecision' in turnPipelineResult) {
      routeState.safetyDecision = turnPipelineResult.safetyDecision;
    }
    if ('profile' in turnPipelineResult) {
      routeState.profile = turnPipelineResult.profile;
    }
    if ('pendingSafetyAdvisory' in turnPipelineResult) {
      routeState.pendingSafetyAdvisory = turnPipelineResult.pendingSafetyAdvisory;
    }
    if ('requestMessage' in turnPipelineResult) {
      routeState.requestMessage = turnPipelineResult.requestMessage;
    }
    if ('ingredientReplayContext' in turnPipelineResult) {
      routeState.ingredientReplayContext = turnPipelineResult.ingredientReplayContext;
    }
    if ('skipRoutineRulesFallback' in turnPipelineResult) {
      routeState.skipRoutineRulesFallback = turnPipelineResult.skipRoutineRulesFallback;
    }
    if (turnPipelineResult.policyMetaPatch && policyMeta && typeof policyMeta === 'object') {
      Object.assign(policyMeta, turnPipelineResult.policyMetaPatch);
    }
    if (turnPipelineResult.llmRouteMetaForResponse) {
      routeState.llmRouteMetaForResponse = turnPipelineResult.llmRouteMetaForResponse;
    }
    return routeState;
  }

  async function sendChatEnvelope(args = {}) {
    const deliverChatEnvelope = requireMethod(
      chatDeliveryRuntime,
      'chatDeliveryRuntime',
      'deliverChatEnvelope',
    );

    const {
      routeState,
      envelope,
      statusCode = 200,
      res,
      req,
      ctx,
      templateCtx,
      chatSessionId,
      policyMeta,
      rolloutContext,
      shouldAttachPolicyMeta,
    } = args;

    if (!routeState || typeof routeState !== 'object') {
      throw new Error('aurora chat route delivery shell runtime missing routeState');
    }

    const delivery = await deliverChatEnvelope({
      envelope,
      statusCode,
      res,
      req,
      ctx,
      templateCtx,
      chatSessionId,
      requestMessage: routeState.requestMessage,
      profile: routeState.profile,
      recentLogs: routeState.recentLogs,
      policyMeta,
      canonicalIntentForResponse: routeState.canonicalIntentForResponse,
      skipRoutineRulesFallback: routeState.skipRoutineRulesFallback,
      rolloutContext,
      shouldAttachPolicyMeta,
      plannerSessionStatePatch: routeState.plannerSessionStatePatch,
      latestClarificationId: routeState.latestClarificationId,
      llmRouteMetaForResponse: routeState.llmRouteMetaForResponse,
      pendingSafetyAdvisory: routeState.pendingSafetyAdvisory,
      pendingGateAdvisories: routeState.pendingGateAdvisories,
      pendingPregnancyPolicyEvents: routeState.pendingPregnancyPolicyEvents,
      recoContextMetricsEmitted: routeState.recoContextMetricsEmitted,
      safetyDecision: routeState.safetyDecision,
      chatContext: routeState.chatContext,
      resolvedIdentity: routeState.resolvedIdentity,
      ingredientReplayContext: routeState.ingredientReplayContext,
      actionIdForReplay: routeState.actionIdForReplay,
      clientStateForReplay: routeState.clientStateForReplay,
      agentStateForReplay: routeState.agentStateForReplay,
    });

    routeState.recoContextMetricsEmitted = delivery.recoContextMetricsEmitted;
    routeState.chatContext = delivery.chatContext;
    routeState.ingredientReplayContext = delivery.ingredientReplayContext;
    return delivery.result;
  }

  return {
    createRouteState,
    applyTurnPipelineResult,
    sendChatEnvelope,
  };
}

module.exports = {
  createChatRouteDeliveryShellRuntime,
};
