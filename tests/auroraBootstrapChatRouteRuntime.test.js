const {
  createChatRouteRuntimeBundle,
} = require('../src/auroraBff/bootstrapChatRouteRuntime');

describe('createChatRouteRuntimeBundle', () => {
  test('assembles top-level chat route runtimes behind one owner', () => {
    const bundle = createChatRouteRuntimeBundle({
      resolveGateDecision: () => ({ gate_id: 'gate.test', mode: 'bypass', reason_codes: [] }),
      GATE_MODE: { ADVISORY: 'advisory', BYPASS: 'bypass' },
      AURORA_CHAT_POLICY_VERSION: 'policy-v1',
      AURORA_GATE_POLICY_META_VERSION: 'gate-v1',
      DEFAULT_AGENT_STATE: { mode: 'idle' },
      INTENT_ENUM: { UNKNOWN: 'unknown' },
      AURORA_CHAT_GLOBAL_FLAGS: { chat_response_meta: true },
    });

    expect(typeof bundle.chatAdvisoryRuntime.enqueueGateAdvisory).toBe('function');
    expect(typeof bundle.chatDiagnosisGateRuntime.resolveDiagnosisEntryEnvelope).toBe('function');
    expect(typeof bundle.chatEnvelopeMetaRuntime.summarizeChatProfileForContext).toBe('function');
    expect(typeof bundle.chatPolicyRuntime.createPolicyState).toBe('function');
    expect(typeof bundle.chatRouteRequestShellRuntime.createChatRouteRequestShell).toBe('function');
    expect(typeof bundle.chatRouteTurnSetupRuntime.prepareChatRouteTurn).toBe('function');
    expect(typeof bundle.chatSafetyRuntime.resolveSafetyGate).toBe('function');
    expect(typeof bundle.chatTurnPipelineRuntime.resolveChatTurnPipeline).toBe('function');
    expect(typeof bundle.chatRouteDeliveryShellRuntime.sendChatEnvelope).toBe('function');

    const routeState = bundle.chatRouteDeliveryShellRuntime.createRouteState({
      defaultAgentState: { mode: 'idle' },
      unknownIntent: 'unknown',
    });
    expect(routeState.clientStateForReplay).toEqual({ mode: 'idle' });
    expect(routeState.canonicalIntentForResponse).toEqual({
      intent: 'unknown',
      confidence: 0,
      entities: {},
    });

    const policyState = bundle.chatPolicyRuntime.createPolicyState({
      rolloutContext: {},
      effectiveChatFlags: { chat_response_meta: true },
      INTENT_ENUM: { UNKNOWN: 'unknown' },
    });
    expect(policyState.policyMeta.policy_version).toBe('policy-v1');
    expect(policyState.policyMeta.gate_policy_version).toBe('gate-v1');
    expect(policyState.policyMeta.flags_effective.chat_response_meta).toBe(true);
  });
});
