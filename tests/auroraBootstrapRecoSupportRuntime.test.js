const {
  createRecoSupportRuntimeBundle,
} = require('../src/auroraBff/bootstrapRecoSupportRuntime');

describe('createRecoSupportRuntimeBundle', () => {
  test('assembles prelabel, dogfood, and route support runtimes behind one owner', () => {
    const prelabelRuntime = {
      parseBoolQueryValue: jest.fn(),
      parseIntQueryValue: jest.fn(),
      normalizeBlockToken: jest.fn(),
      sanitizeSuggestionForPublic: jest.fn(),
      attachPrelabelSuggestionsToPayload: jest.fn(),
      sanitizeProductAnalysisPayloadForPrelabel: jest.fn(),
    };
    const dogfoodRuntime = {
      getRecoDogfoodSessionId: jest.fn(),
      augmentProductAnalysisPayloadForDogfood: jest.fn(),
      augmentEnvelopeProductAnalysisCardsForDogfood: jest.fn(),
      augmentEnvelopeProductAnalysisCardsWithPrelabelSuggestions: jest.fn(),
    };
    const routeSupportRuntime = {
      buildPrelabelKbKey: jest.fn(),
      buildPrelabelKbReadCandidates: jest.fn(),
      mapSuggestionForResponse: jest.fn(),
      preflightAuroraKbV0ForStartup: jest.fn(),
      getRequiredRouteContractsHealth: jest.fn(),
      checkRequiredRouteContracts: jest.fn(),
    };
    const createRecoPrelabelSupportRuntime = jest.fn(() => prelabelRuntime);
    const createRecoDogfoodEnvelopeRuntime = jest.fn(() => dogfoodRuntime);
    const createAuroraRouteSupportRuntime = jest.fn(() => routeSupportRuntime);
    const applyProductAnalysisGapContract = jest.fn();
    const isPlainObject = jest.fn();
    const pickFirstTrimmed = jest.fn();
    const loadSuggestionsForAnchor = jest.fn();
    const requiredRouteContracts = [{ method: 'POST', path: '/v1/travel/plans' }];
    const assertRequiredRouteContracts = jest.fn();

    const bundle = createRecoSupportRuntimeBundle({
      createRecoPrelabelSupportRuntime,
      createRecoDogfoodEnvelopeRuntime,
      createAuroraRouteSupportRuntime,
      applyProductAnalysisGapContract,
      isPlainObject,
      pickFirstTrimmed,
      RECO_DOGFOOD_CONFIG: { dogfood_mode: true },
      social_enrich_async: jest.fn(),
      applyAsyncBlockPatch: jest.fn(),
      recordRecoAsyncUpdate: jest.fn(),
      registerRecoTrackingSnapshot: jest.fn(),
      createAsyncTicket: jest.fn(),
      recordRecoExplorationSlot: jest.fn(),
      loadSuggestionsForAnchor,
      normalizeProductIntelKbKey: jest.fn(),
      getAuroraKbFailMode: jest.fn(),
      getAuroraKbV0: jest.fn(),
      requiredRouteContracts,
      assertRequiredRouteContracts,
      requiredRouteScope: 'travel_plans',
    });

    expect(createRecoPrelabelSupportRuntime).toHaveBeenCalledWith({
      applyProductAnalysisGapContract,
      isPlainObject,
    });
    expect(createRecoDogfoodEnvelopeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        pickFirstTrimmed,
        isPlainObject,
        loadSuggestionsForAnchor,
        attachPrelabelSuggestionsToPayload:
          prelabelRuntime.attachPrelabelSuggestionsToPayload,
      }),
    );
    expect(createAuroraRouteSupportRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        sanitizeSuggestionForPublic:
          prelabelRuntime.sanitizeSuggestionForPublic,
        normalizeBlockToken: prelabelRuntime.normalizeBlockToken,
        requiredRouteContracts,
        assertRequiredRouteContracts,
        requiredRouteScope: 'travel_plans',
      }),
    );

    expect(bundle.attachPrelabelSuggestionsToPayload).toBe(
      prelabelRuntime.attachPrelabelSuggestionsToPayload,
    );
    expect(bundle.augmentEnvelopeProductAnalysisCardsForDogfood).toBe(
      dogfoodRuntime.augmentEnvelopeProductAnalysisCardsForDogfood,
    );
    expect(bundle.buildPrelabelKbReadCandidates).toBe(
      routeSupportRuntime.buildPrelabelKbReadCandidates,
    );
  });
});
