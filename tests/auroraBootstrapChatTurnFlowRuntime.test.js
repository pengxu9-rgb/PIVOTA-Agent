const {
  createChatTurnFlowRuntimeBundle,
} = require('../src/auroraBff/bootstrapChatTurnFlowRuntime');

describe('createChatTurnFlowRuntimeBundle', () => {
  test('assembles recommendation, pre-upstream, and turn-pipeline runtimes behind one owner', () => {
    const bundle = createChatTurnFlowRuntimeBundle({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      chatProfileContinuationRuntime: {
        maybeBuildProfileContinuationEnvelope: jest.fn(),
      },
      chatTurnStateRuntime: {
        prepareChatTurnPrelude: jest.fn(),
      },
      chatIngredientPreludeRuntime: {
        prepareIngredientPrelude: jest.fn(),
      },
      chatIngredientLookupRuntime: {
        attachIngredientRouteMetaToSessionPatch: jest.fn(),
      },
      chatBoundaryPreludeRuntime: {
        prepareBoundaryPrelude: jest.fn(),
      },
      chatIngredientEntryRuntime: {
        resolveIngredientEntryEnvelope: jest.fn(),
      },
      chatLoopBreakerRuntime: {
        maybeBuildLoopBreakerEnvelope: jest.fn(),
      },
      chatCatalogAvailabilityRuntime: {
        maybeBuildCatalogAvailabilityEnvelope: jest.fn(),
      },
      chatTravelEnvRuntime: {
        maybeBuildTravelEnvEnvelope: jest.fn(),
      },
      chatConflictRuntime: {
        maybeBuildConflictEnvelope: jest.fn(),
      },
      chatDiagnosisGateRuntime: {
        resolveDiagnosisEntryEnvelope: jest.fn(),
      },
      chatSafetyRuntime: {
        resolveSafetyGate: jest.fn(),
        buildSafetyNoticeText: jest.fn(),
      },
    });

    expect(typeof bundle.chatRecoHandoffRuntime.buildRoutineRecoEnvelope).toBe('function');
    expect(typeof bundle.chatRecommendationFlowRuntime.resolveRecommendationFlow).toBe('function');
    expect(typeof bundle.chatIngredientRouteRuntime.resolveIngredientRouteFlow).toBe('function');
    expect(typeof bundle.chatPreUpstreamRuntime.resolvePreUpstreamFlow).toBe('function');
    expect(typeof bundle.chatPreludeCoordinatorRuntime.resolveChatPreludeFlow).toBe('function');
    expect(typeof bundle.chatTurnPipelineRuntime.resolveChatTurnPipeline).toBe('function');
  });
});
