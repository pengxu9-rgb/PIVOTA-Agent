const { createChatRouteDeliveryShellRuntime } = require('../src/auroraBff/chatRouteDeliveryShellRuntime');

function buildRuntime() {
  const chatDeliveryRuntime = {
    deliverChatEnvelope: jest.fn(async () => ({
      recoContextMetricsEmitted: true,
      chatContext: { active_thread_summary: 'updated thread' },
      ingredientReplayContext: { delivered: true },
      result: { ok: true },
    })),
  };

  return {
    chatDeliveryRuntime,
    runtime: createChatRouteDeliveryShellRuntime({ chatDeliveryRuntime }),
  };
}

describe('aurora chat route delivery shell runtime', () => {
  test('creates route state with stable defaults', () => {
    const { runtime } = buildRuntime();

    expect(
      runtime.createRouteState({
        defaultAgentState: 'IDLE_CHAT',
        unknownIntent: 'unknown',
      }),
    ).toEqual({
      plannerSessionStatePatch: null,
      latestClarificationId: null,
      profile: null,
      recentLogs: [],
      chatContext: null,
      resolvedIdentity: { auroraUid: null, userId: null },
      canonicalIntentForResponse: { intent: 'unknown', confidence: 0, entities: {} },
      safetyDecision: null,
      pendingSafetyAdvisory: null,
      pendingGateAdvisories: [],
      pendingPregnancyPolicyEvents: [],
      requestMessage: '',
      recoContextMetricsEmitted: false,
      actionIdForReplay: null,
      clientStateForReplay: 'IDLE_CHAT',
      agentStateForReplay: 'IDLE_CHAT',
      ingredientReplayContext: {
        intent_requested: false,
        starter_action: false,
        diagnosis_optin: false,
        reco_optin: false,
        entry: null,
      },
      skipRoutineRulesFallback: false,
      llmRouteMetaForResponse: null,
    });
  });

  test('applies turn pipeline state and policy patches', () => {
    const { runtime } = buildRuntime();
    const routeState = runtime.createRouteState({
      defaultAgentState: 'IDLE_CHAT',
      unknownIntent: 'unknown',
    });
    const policyMeta = { existing: true };

    runtime.applyTurnPipelineResult({
      routeState,
      turnPipelineResult: {
        clientStateForReplay: 'CLIENT_REPLAY',
        agentStateForReplay: 'AGENT_REPLAY',
        plannerSessionStatePatch: { stage: 'after_prelude' },
        safetyDecision: { block_level: 'warn' },
        profile: { skin_type: 'dry' },
        pendingSafetyAdvisory: { gate_id: 'optional_safety' },
        requestMessage: 'recommend something',
        ingredientReplayContext: { replay: true },
        skipRoutineRulesFallback: true,
        policyMetaPatch: { flow: 'reco' },
        llmRouteMetaForResponse: { llm_provider_effective: 'gemini' },
      },
      policyMeta,
    });

    expect(routeState).toEqual(
      expect.objectContaining({
        clientStateForReplay: 'CLIENT_REPLAY',
        agentStateForReplay: 'AGENT_REPLAY',
        plannerSessionStatePatch: { stage: 'after_prelude' },
        safetyDecision: { block_level: 'warn' },
        profile: { skin_type: 'dry' },
        pendingSafetyAdvisory: { gate_id: 'optional_safety' },
        requestMessage: 'recommend something',
        ingredientReplayContext: { replay: true },
        skipRoutineRulesFallback: true,
        llmRouteMetaForResponse: { llm_provider_effective: 'gemini' },
      }),
    );
    expect(policyMeta).toEqual({ existing: true, flow: 'reco' });
  });

  test('delegates envelope delivery and updates mutable route state', async () => {
    const { runtime, chatDeliveryRuntime } = buildRuntime();
    const routeState = runtime.createRouteState({
      defaultAgentState: 'IDLE_CHAT',
      unknownIntent: 'unknown',
    });
    routeState.requestMessage = 'what should I buy';
    routeState.profile = { skin_type: 'dry' };
    routeState.recentLogs = [{ id: 'log_1' }];
    routeState.canonicalIntentForResponse = { intent: 'reco_products', confidence: 0.9, entities: {} };
    routeState.skipRoutineRulesFallback = true;
    routeState.plannerSessionStatePatch = { planner: 'patched' };
    routeState.latestClarificationId = 'clarify_1';
    routeState.llmRouteMetaForResponse = { llm_provider_effective: 'gemini' };
    routeState.pendingSafetyAdvisory = { gate_id: 'optional_safety' };
    routeState.pendingGateAdvisories = [{ gate_id: 'diag_gate' }];
    routeState.pendingPregnancyPolicyEvents = [{ event_name: 'pregnancy_defaulted' }];
    routeState.recoContextMetricsEmitted = false;
    routeState.safetyDecision = { block_level: 'warn' };
    routeState.chatContext = { active_thread_summary: 'old thread' };
    routeState.resolvedIdentity = { auroraUid: 'uid_1', userId: null };
    routeState.ingredientReplayContext = { replay: false };
    routeState.actionIdForReplay = 'chip.start.reco_products';
    routeState.clientStateForReplay = 'CLIENT_REPLAY';
    routeState.agentStateForReplay = 'AGENT_REPLAY';

    const result = await runtime.sendChatEnvelope({
      routeState,
      envelope: { assistant_message: { content: 'hello' }, cards: [], events: [], session_patch: {} },
      statusCode: 200,
      res: {},
      req: {},
      ctx: { request_id: 'req_1' },
      templateCtx: {},
      chatSessionId: 'session_1',
      policyMeta: { intent_canonical: 'reco_products' },
      rolloutContext: { variant: 'beta' },
      shouldAttachPolicyMeta: true,
    });

    expect(chatDeliveryRuntime.deliverChatEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        requestMessage: 'what should I buy',
        profile: { skin_type: 'dry' },
        recentLogs: [{ id: 'log_1' }],
        canonicalIntentForResponse: { intent: 'reco_products', confidence: 0.9, entities: {} },
        skipRoutineRulesFallback: true,
        plannerSessionStatePatch: { planner: 'patched' },
        latestClarificationId: 'clarify_1',
        llmRouteMetaForResponse: { llm_provider_effective: 'gemini' },
        pendingSafetyAdvisory: { gate_id: 'optional_safety' },
        pendingGateAdvisories: [{ gate_id: 'diag_gate' }],
        pendingPregnancyPolicyEvents: [{ event_name: 'pregnancy_defaulted' }],
        safetyDecision: { block_level: 'warn' },
        chatContext: { active_thread_summary: 'old thread' },
        resolvedIdentity: { auroraUid: 'uid_1', userId: null },
        ingredientReplayContext: { replay: false },
        actionIdForReplay: 'chip.start.reco_products',
        clientStateForReplay: 'CLIENT_REPLAY',
        agentStateForReplay: 'AGENT_REPLAY',
      }),
    );
    expect(routeState.recoContextMetricsEmitted).toBe(true);
    expect(routeState.chatContext).toEqual({ active_thread_summary: 'updated thread' });
    expect(routeState.ingredientReplayContext).toEqual({ delivered: true });
    expect(result).toEqual({ ok: true });
  });
});
