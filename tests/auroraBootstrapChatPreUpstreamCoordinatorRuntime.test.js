const {
  createChatPreUpstreamCoordinatorRuntimeBundle,
} = require('../src/auroraBff/bootstrapChatPreUpstreamCoordinatorRuntime');

describe('createChatPreUpstreamCoordinatorRuntimeBundle', () => {
  test('assembles ingredient-route and pre-upstream coordinator runtimes behind one owner', () => {
    const bundle = createChatPreUpstreamCoordinatorRuntimeBundle({
      looksLikeRoutineRequest: () => false,
      looksLikeSuitabilityRequest: () => false,
      looksLikeCompatibilityOrConflictQuestion: () => false,
      looksLikeWeatherOrEnvironmentQuestion: () => false,
      messageContainsSpecificIngredientScienceTarget: () => false,
      looksLikeIngredientScienceIntent: () => false,
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
      chatRecommendationFlowRuntime: {
        resolveRecommendationFlow: jest.fn(),
      },
    });

    expect(typeof bundle.chatIngredientRouteRuntime.resolveIngredientRouteFlow).toBe('function');
    expect(typeof bundle.chatPreUpstreamRuntime.resolvePreUpstreamFlow).toBe('function');
    expect(typeof bundle.chatPreludeCoordinatorRuntime.resolveChatPreludeFlow).toBe('function');
  });
});
