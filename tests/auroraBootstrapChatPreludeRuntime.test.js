const {
  createChatPreludeRuntimeBundle,
} = require('../src/auroraBff/bootstrapChatPreludeRuntime');

describe('createChatPreludeRuntimeBundle', () => {
  test('assembles pre-upstream chat runtimes behind one owner', () => {
    const bundle = createChatPreludeRuntimeBundle({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      DEFAULT_AGENT_STATE: { mode: 'idle' },
      INTENT_ENUM: { UNKNOWN: 'unknown' },
      BLOCK_LEVEL: { BLOCK: 'block' },
      GATE_MODE: { ADVISORY: 'advisory', BYPASS: 'bypass' },
    });

    expect(typeof bundle.chatTurnStateRuntime.prepareChatTurnPrelude).toBe('function');
    expect(typeof bundle.chatAdvisoryRuntime.enqueueGateAdvisory).toBe('function');
    expect(typeof bundle.chatSafetyRuntime.resolveSafetyGate).toBe('function');
    expect(typeof bundle.chatBoundaryPreludeRuntime.prepareBoundaryPrelude).toBe('function');
    expect(typeof bundle.chatLoopBreakerRuntime.maybeBuildLoopBreakerEnvelope).toBe('function');
    expect(typeof bundle.chatTravelEnvRuntime.maybeBuildTravelEnvEnvelope).toBe('function');
    expect(typeof bundle.chatDiagnosisGateRuntime.resolveDiagnosisEntryEnvelope).toBe('function');
    expect(typeof bundle.chatProfileContinuationRuntime.maybeBuildProfileContinuationEnvelope).toBe('function');
    expect(typeof bundle.chatIngredientLookupRuntime.buildIngredientLookupEnvelope).toBe('function');
    expect(typeof bundle.chatIngredientEntryRuntime.resolveIngredientEntryEnvelope).toBe('function');
    expect(typeof bundle.chatIngredientPreludeRuntime.prepareIngredientPrelude).toBe('function');
    expect(typeof bundle.chatConflictRuntime.maybeBuildConflictEnvelope).toBe('function');
    expect(typeof bundle.chatCatalogAvailabilityRuntime.maybeBuildCatalogAvailabilityEnvelope).toBe('function');
  });
});
