const { createChatContextRuntime } = require('./chatContextRuntime');
const { createChatEnvelopeMetaRuntime } = require('./chatEnvelopeMetaRuntime');
const { createChatProfileRuntime } = require('./chatProfileRuntime');
const { createChatTurnSetupRuntime } = require('./chatTurnSetupRuntime');
const { createChatIngredientReplayRuntime } = require('./chatIngredientReplayRuntime');
const { createChatResponseRuntime } = require('./chatResponseRuntime');
const { createChatPolicyRuntime } = require('./chatPolicyRuntime');
const { createChatDeliveryRuntime } = require('./chatDeliveryRuntime');

function createChatCoreRuntimeBundle(deps = {}) {
  const {
    logger,
    resolveGateDecision,
    GATE_MODE,
    AURORA_CHAT_POLICY_VERSION,
    AURORA_GATE_POLICY_META_VERSION,
    INTENT_ENUM,
    BLOCK_LEVEL,
    resolveIdentity,
    getProfileForIdentity,
    getRecentSkinLogsForIdentity,
    getChatContextForIdentity,
    recordProfileContextMissing,
    extractProfilePatchFromSession,
    parseProfilePatchFromAction,
    UserProfilePatchSchema,
    upsertProfileForIdentity,
    derivePregnancyPolicyPatch,
    utcTodayIsoDate,
    makeEvent,
    extractProfilePatchFromFreeText,
    recordAuroraProfileAutoPatch,
    shouldPersistProfilePatch,
    extractTrackerLogFromFreeText,
    upsertSkinLogForIdentity,
    extractLatestRecoContextFromSession,
    extractReplyTextFromAction,
    extractIncludeAlternativesFromAction,
    coerceBoolean,
    normalizeChatLlmProvider,
    normalizeChatLlmModel,
    inferCanonicalIntent,
    hasRoutineSosSignal,
    resolvePreferredLegacyTravelPlan,
    hasMeaningfulFitCheckAnchor,
    AURORA_DIAG_FORCE_GEMINI,
    AURORA_DIAG_FORCE_GEMINI_MODEL,
    AURORA_ROUTER_DST_PATCH_V1_ENABLED,
    isPlainObject,
    summarizeProfileForContext,
    normalizeRecoSourceDetail,
    pickFirstTrimmed,
    recordAuroraRecoContextUsed,
    chatAdvisoryRuntime,
    applyReplyTemplates,
    augmentEnvelopeProductAnalysisCardsForDogfood,
    shouldApplyRecoOutputGuard,
    applyLowOrMediumRecoGuardToEnvelope,
    recordAuroraSkinFlowMetric,
    ensureNonEmptyChatCardsEnvelope,
    isRoutineContractIntent,
    looksLikeCompatibilityOrConflictQuestion,
    looksLikeWeatherOrEnvironmentQuestion,
    looksLikeRoutineRequest,
    looksLikeIngredientScienceIntent,
    findRoutineExpertNodeFromEnvelope,
    hasRoutineExpertRequiredModules,
    buildRoutineRulesOnlyFallbackCardsForChat,
    AURORA_MULTITURN_CONTRACT_GATE_V1_ENABLED,
    evaluateQualityContractForEnvelope,
    recordChatStallPhrase,
    recordContractFail,
    recordRecommendationUrlInvariantFail,
    recordKnownFieldReask,
    safelyApplyProductIntelGuardrailsToEnvelope,
    persistRejectedCatalogCandidates,
    suppressAnalysisCardsForTravelEnvTurn,
    executeAuroraOptionalStep,
    upsertChatContextForIdentity,
    enrichIngredientReportCardsInEnvelope,
    buildChatCardsResponse,
    appendExperimentEventForIdentity,
    emitAudit,
    AURORA_CHAT_LEGACY_ENVELOPE_RESPONSE,
  } = deps;

  const chatProfileRuntime = createChatProfileRuntime({
    logger,
    isPlainObject,
    resolveIdentity,
    getProfileForIdentity,
    getRecentSkinLogsForIdentity,
    getChatContextForIdentity,
    recordProfileContextMissing,
    extractProfilePatchFromSession,
    parseProfilePatchFromAction,
    UserProfilePatchSchema,
    upsertProfileForIdentity,
    derivePregnancyPolicyPatch,
    utcTodayIsoDate,
    makeEvent,
    extractProfilePatchFromFreeText,
    recordAuroraProfileAutoPatch,
    shouldPersistProfilePatch,
    extractTrackerLogFromFreeText,
    upsertSkinLogForIdentity,
  });

  const chatTurnSetupRuntime = createChatTurnSetupRuntime({
    chatProfileRuntime,
    extractLatestRecoContextFromSession,
    extractReplyTextFromAction,
    extractIncludeAlternativesFromAction,
    coerceBoolean,
    normalizeChatLlmProvider,
    normalizeChatLlmModel,
    inferCanonicalIntent,
    hasRoutineSosSignal,
    resolvePreferredLegacyTravelPlan,
    hasMeaningfulFitCheckAnchor,
    AURORA_DIAG_FORCE_GEMINI,
    AURORA_DIAG_FORCE_GEMINI_MODEL,
    AURORA_ROUTER_DST_PATCH_V1_ENABLED,
    INTENT_ENUM,
  });

  const chatEnvelopeMetaRuntime = createChatEnvelopeMetaRuntime({
    summarizeProfileForContext,
    resolvePreferredLegacyTravelPlan,
    BLOCK_LEVEL,
    isPlainObject,
    normalizeRecoSourceDetail,
    pickFirstTrimmed,
    recordAuroraRecoContextUsed,
    makeEvent,
  });

  const chatIngredientReplayRuntime = createChatIngredientReplayRuntime({
    logger,
    pickFirstTrimmed,
    recordAuroraSkinFlowMetric,
    INGREDIENT_ROUTE_RULE_VERSION: deps.INGREDIENT_ROUTE_RULE_VERSION,
  });

  const chatContextRuntime = createChatContextRuntime({
    INTENT_ENUM,
    isPlainObject,
  });

  const chatPolicyRuntime = createChatPolicyRuntime({
    resolveGateDecision,
    GATE_MODE,
    AURORA_CHAT_POLICY_VERSION,
    AURORA_GATE_POLICY_META_VERSION,
  });

  const chatResponseRuntime = createChatResponseRuntime({
    logger,
    makeEvent,
    applyReplyTemplates,
    augmentEnvelopeProductAnalysisCardsForDogfood,
    shouldApplyRecoOutputGuard,
    applyLowOrMediumRecoGuardToEnvelope,
    recordAuroraSkinFlowMetric,
    ensureNonEmptyChatCardsEnvelope,
    isRoutineContractIntent,
    hasRoutineSosSignal,
    looksLikeCompatibilityOrConflictQuestion,
    looksLikeWeatherOrEnvironmentQuestion,
    looksLikeRoutineRequest,
    looksLikeIngredientScienceIntent,
    findRoutineExpertNodeFromEnvelope,
    hasRoutineExpertRequiredModules,
    buildRoutineRulesOnlyFallbackCardsForChat,
    AURORA_MULTITURN_CONTRACT_GATE_V1_ENABLED,
    evaluateQualityContractForEnvelope,
    recordChatStallPhrase,
    recordContractFail,
    recordRecommendationUrlInvariantFail,
    recordKnownFieldReask,
  });

  const chatDeliveryRuntime = createChatDeliveryRuntime({
    logger,
    chatAdvisoryRuntime,
    chatEnvelopeMetaRuntime,
    chatResponseRuntime,
    chatContextRuntime,
    chatIngredientReplayRuntime,
    safelyApplyProductIntelGuardrailsToEnvelope,
    persistRejectedCatalogCandidates,
    suppressAnalysisCardsForTravelEnvTurn,
    executeAuroraOptionalStep,
    upsertChatContextForIdentity,
    enrichIngredientReportCardsInEnvelope,
    buildChatCardsResponse,
    appendExperimentEventForIdentity,
    emitAudit,
    makeEvent,
    AURORA_CHAT_LEGACY_ENVELOPE_RESPONSE,
    INTENT_ENUM,
  });

  return {
    chatContextRuntime,
    chatDeliveryRuntime,
    chatEnvelopeMetaRuntime,
    chatIngredientReplayRuntime,
    chatPolicyRuntime,
    chatProfileRuntime,
    chatResponseRuntime,
    chatTurnSetupRuntime,
  };
}

module.exports = {
  createChatCoreRuntimeBundle,
};
