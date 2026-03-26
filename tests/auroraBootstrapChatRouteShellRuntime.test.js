const {
  createChatRouteShellRuntimeBundle,
} = require('../src/auroraBff/bootstrapChatRouteShellRuntime');

describe('createChatRouteShellRuntimeBundle', () => {
  test('assembles route turn setup, request shell, and delivery shell behind one owner', () => {
    const bundle = createChatRouteShellRuntimeBundle({
      chatProfileRuntime: {
        loadIdentityContext: jest.fn(),
      },
      chatTurnSetupRuntime: {
        prepareChatTurnSetup: jest.fn(),
      },
      chatDeliveryRuntime: {
        deliverChatEnvelope: jest.fn(),
      },
      getRecoDogfoodSessionId: jest.fn(),
      computeAuroraChatRolloutContext: jest.fn(),
      pickFirstTrimmed: jest.fn(),
      addEmotionalPreambleToAssistantText: jest.fn(),
      buildRequestContext: jest.fn(),
      AURORA_CHAT_GLOBAL_FLAGS: { chat_response_meta: true },
      AURORA_CHAT_POLICY_VERSION: 'policy-v1',
      DEFAULT_AGENT_STATE: { mode: 'idle' },
      INTENT_ENUM: { UNKNOWN: 'unknown' },
      chatAdvisoryRuntime: {
        enqueueGateAdvisory: jest.fn(),
      },
      chatEnvelopeMetaRuntime: {
        summarizeChatProfileForContext: jest.fn(),
      },
      chatPolicyRuntime: {
        createPolicyState: jest.fn(),
      },
      buildEnvelope: jest.fn(),
      makeAssistantMessage: jest.fn(),
      makeEvent: jest.fn(),
    });

    expect(typeof bundle.chatRouteTurnSetupRuntime.prepareChatRouteTurn).toBe('function');
    expect(typeof bundle.chatRouteDeliveryShellRuntime.sendChatEnvelope).toBe('function');
    expect(typeof bundle.chatRouteRequestShellRuntime.createChatRouteRequestShell).toBe('function');
  });
});
