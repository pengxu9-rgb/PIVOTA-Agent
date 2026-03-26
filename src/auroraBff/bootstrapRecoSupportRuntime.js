const {
  createAuroraRouteSupportRuntime: createAuroraRouteSupportRuntimeDefault,
} = require('./routeSupportRuntime');
const {
  createRecoDogfoodEnvelopeRuntime: createRecoDogfoodEnvelopeRuntimeDefault,
} = require('./recoDogfoodEnvelopeRuntime');
const {
  createRecoPrelabelSupportRuntime: createRecoPrelabelSupportRuntimeDefault,
} = require('./recoPrelabelSupportRuntime');

function createRecoSupportRuntimeBundle(options = {}) {
  const {
    createRecoPrelabelSupportRuntime = createRecoPrelabelSupportRuntimeDefault,
    createRecoDogfoodEnvelopeRuntime = createRecoDogfoodEnvelopeRuntimeDefault,
    createAuroraRouteSupportRuntime = createAuroraRouteSupportRuntimeDefault,
    applyProductAnalysisGapContract,
    isPlainObject,
    pickFirstTrimmed,
    RECO_DOGFOOD_CONFIG,
    social_enrich_async,
    applyAsyncBlockPatch,
    recordRecoAsyncUpdate,
    registerRecoTrackingSnapshot,
    createAsyncTicket,
    recordRecoExplorationSlot,
    loadSuggestionsForAnchor,
    normalizeProductIntelKbKey,
    getAuroraKbFailMode,
    getAuroraKbV0,
    requiredRouteContracts = [],
    assertRequiredRouteContracts,
    requiredRouteScope = 'travel_plans',
  } = options;

  const recoPrelabelSupportRuntime = createRecoPrelabelSupportRuntime({
    applyProductAnalysisGapContract,
    isPlainObject,
  });

  const recoDogfoodEnvelopeRuntime = createRecoDogfoodEnvelopeRuntime({
    pickFirstTrimmed,
    isPlainObject,
    RECO_DOGFOOD_CONFIG,
    social_enrich_async,
    applyAsyncBlockPatch,
    recordRecoAsyncUpdate,
    registerRecoTrackingSnapshot,
    createAsyncTicket,
    recordRecoExplorationSlot,
    loadSuggestionsForAnchor,
    attachPrelabelSuggestionsToPayload:
      recoPrelabelSupportRuntime.attachPrelabelSuggestionsToPayload,
  });

  const auroraRouteSupportRuntime = createAuroraRouteSupportRuntime({
    normalizeProductIntelKbKey,
    sanitizeSuggestionForPublic:
      recoPrelabelSupportRuntime.sanitizeSuggestionForPublic,
    normalizeBlockToken: recoPrelabelSupportRuntime.normalizeBlockToken,
    getAuroraKbFailMode,
    getAuroraKbV0,
    requiredRouteContracts,
    assertRequiredRouteContracts,
    requiredRouteScope,
  });

  return {
    ...recoPrelabelSupportRuntime,
    ...recoDogfoodEnvelopeRuntime,
    ...auroraRouteSupportRuntime,
  };
}

module.exports = {
  createRecoSupportRuntimeBundle,
};
