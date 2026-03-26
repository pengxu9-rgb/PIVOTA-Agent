const {
  createChatRouteRequestRuntimeBundle,
} = require('../src/auroraBff/bootstrapChatRouteRequestRuntime');

describe('createChatRouteRequestRuntimeBundle', () => {
  test('assembles core and route-shell chat runtimes behind one owner', () => {
    const bundle = createChatRouteRequestRuntimeBundle({
      resolveGateDecision: () => ({ gate_id: 'gate.test', mode: 'bypass', reason_codes: [] }),
      GATE_MODE: { ADVISORY: 'advisory', BYPASS: 'bypass' },
      AURORA_CHAT_POLICY_VERSION: 'policy-v1',
      AURORA_GATE_POLICY_META_VERSION: 'gate-v1',
      DEFAULT_AGENT_STATE: { mode: 'idle' },
      INTENT_ENUM: { UNKNOWN: 'unknown' },
      AURORA_CHAT_GLOBAL_FLAGS: { chat_response_meta: true },
      chatAdvisoryRuntime: {
        enqueueGateAdvisory: jest.fn(),
      },
    });

    expect(typeof bundle.chatEnvelopeMetaRuntime.summarizeChatProfileForContext).toBe('function');
    expect(typeof bundle.chatPolicyRuntime.createPolicyState).toBe('function');
    expect(typeof bundle.chatRouteRequestShellRuntime.createChatRouteRequestShell).toBe('function');
    expect(typeof bundle.chatRouteTurnSetupRuntime.prepareChatRouteTurn).toBe('function');
    expect(typeof bundle.chatRouteDeliveryShellRuntime.sendChatEnvelope).toBe('function');
  });
});
