const { createChatIngredientRouteRuntime } = require('./chatIngredientRouteRuntime');
const { createChatPreUpstreamRuntime } = require('./chatPreUpstreamRuntime');
const { createChatPreludeCoordinatorRuntime } = require('./chatPreludeCoordinatorRuntime');

function createChatPreUpstreamCoordinatorRuntimeBundle(deps = {}) {
  const {
    looksLikeRoutineRequest,
    looksLikeSuitabilityRequest,
    looksLikeCompatibilityOrConflictQuestion,
    looksLikeWeatherOrEnvironmentQuestion,
    messageContainsSpecificIngredientScienceTarget,
    looksLikeIngredientScienceIntent,
    chatTurnStateRuntime,
    chatIngredientPreludeRuntime,
    chatIngredientLookupRuntime,
    chatBoundaryPreludeRuntime,
    chatIngredientEntryRuntime,
    chatLoopBreakerRuntime,
    chatCatalogAvailabilityRuntime,
    chatTravelEnvRuntime,
    chatConflictRuntime,
    chatDiagnosisGateRuntime,
    chatSafetyRuntime,
    chatRecommendationFlowRuntime,
  } = deps;

  const chatIngredientRouteRuntime = createChatIngredientRouteRuntime({
    looksLikeRoutineRequest,
    looksLikeSuitabilityRequest,
    looksLikeCompatibilityOrConflictQuestion,
    looksLikeWeatherOrEnvironmentQuestion,
    messageContainsSpecificIngredientScienceTarget,
    chatSafetyRuntime,
    chatIngredientEntryRuntime,
    chatRecommendationFlowRuntime,
  });
  const chatPreUpstreamRuntime = createChatPreUpstreamRuntime({
    chatBoundaryPreludeRuntime,
    chatIngredientEntryRuntime,
    chatLoopBreakerRuntime,
    chatCatalogAvailabilityRuntime,
    chatTravelEnvRuntime,
    chatConflictRuntime,
    chatDiagnosisGateRuntime,
    chatIngredientRouteRuntime,
  });
  const chatPreludeCoordinatorRuntime = createChatPreludeCoordinatorRuntime({
    chatTurnStateRuntime,
    chatIngredientPreludeRuntime,
    chatIngredientLookupRuntime,
    chatPreUpstreamRuntime,
    chatSafetyRuntime,
    looksLikeIngredientScienceIntent,
  });

  return {
    chatIngredientRouteRuntime,
    chatPreUpstreamRuntime,
    chatPreludeCoordinatorRuntime,
  };
}

module.exports = {
  createChatPreUpstreamCoordinatorRuntimeBundle,
};
