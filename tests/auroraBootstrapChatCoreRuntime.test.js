const {
  createChatCoreRuntimeBundle,
} = require('../src/auroraBff/bootstrapChatCoreRuntime');

describe('createChatCoreRuntimeBundle', () => {
  test('assembles core chat policy, context, response, and delivery runtimes behind one owner', () => {
    const bundle = createChatCoreRuntimeBundle({
      resolveGateDecision: () => ({ gate_id: 'gate.test', mode: 'bypass', reason_codes: [] }),
      GATE_MODE: { ADVISORY: 'advisory', BYPASS: 'bypass' },
      AURORA_CHAT_POLICY_VERSION: 'policy-v1',
      AURORA_GATE_POLICY_META_VERSION: 'gate-v1',
      INTENT_ENUM: { UNKNOWN: 'unknown' },
      BLOCK_LEVEL: { BLOCK: 'block' },
      chatAdvisoryRuntime: {
        enqueueGateAdvisory: jest.fn(),
      },
    });

    expect(typeof bundle.chatProfileRuntime.loadIdentityContext).toBe('function');
    expect(typeof bundle.chatTurnSetupRuntime.prepareChatTurnSetup).toBe('function');
    expect(typeof bundle.chatEnvelopeMetaRuntime.summarizeChatProfileForContext).toBe('function');
    expect(typeof bundle.chatIngredientReplayRuntime.processIngredientReplay).toBe('function');
    expect(typeof bundle.chatContextRuntime.collectLegacyCardTypes).toBe('function');
    expect(typeof bundle.chatPolicyRuntime.createPolicyState).toBe('function');
    expect(typeof bundle.chatResponseRuntime.prepareEnvelopeForDelivery).toBe('function');
    expect(typeof bundle.chatDeliveryRuntime.deliverChatEnvelope).toBe('function');
  });
});
