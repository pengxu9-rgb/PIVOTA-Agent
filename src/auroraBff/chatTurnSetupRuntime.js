function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function createChatTurnSetupRuntime(options = {}) {
  const {
    chatProfileRuntime = null,
    extractLatestRecoContextFromSession = () => null,
    extractReplyTextFromAction = () => '',
    extractIncludeAlternativesFromAction = () => false,
    coerceBoolean = () => undefined,
    normalizeChatLlmProvider = () => '',
    normalizeChatLlmModel = () => '',
    inferCanonicalIntent = () => ({ intent: '', confidence: 0, entities: {} }),
    hasRoutineSosSignal = () => false,
    resolvePreferredLegacyTravelPlan = () => null,
    hasMeaningfulFitCheckAnchor = () => false,
    AURORA_DIAG_FORCE_GEMINI = false,
    AURORA_DIAG_FORCE_GEMINI_MODEL = '',
    AURORA_ROUTER_DST_PATCH_V1_ENABLED = false,
    INTENT_ENUM = {},
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat turn setup runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  function buildNormalizedActionPayload(parsedData = {}) {
    if (parsedData.action) return parsedData.action;
    if (typeof parsedData.action_id === 'string' && parsedData.action_id.trim()) {
      return {
        action_id: parsedData.action_id.trim(),
        kind: 'action',
        ...(parsedData.action_data && typeof parsedData.action_data === 'object' && !Array.isArray(parsedData.action_data)
          ? { data: parsedData.action_data }
          : {}),
      };
    }
    if (typeof parsedData.action_label === 'string' && parsedData.action_label.trim()) {
      return parsedData.action_label.trim();
    }
    return null;
  }

  async function prepareChatTurnSetup(args = {}) {
    const applyProfilePatchFromAction = requireMethod(
      chatProfileRuntime,
      'chatProfileRuntime',
      'applyProfilePatchFromAction',
    );
    const applyPregnancyPolicy = requireMethod(
      chatProfileRuntime,
      'chatProfileRuntime',
      'applyPregnancyPolicy',
    );
    const applyTextDerivedProfilePatch = requireMethod(
      chatProfileRuntime,
      'chatProfileRuntime',
      'applyTextDerivedProfilePatch',
    );
    const applyTextDerivedSkinLog = requireMethod(
      chatProfileRuntime,
      'chatProfileRuntime',
      'applyTextDerivedSkinLog',
    );
    const extractLatestRecoContextFromSessionFn = requireFunction(
      'extractLatestRecoContextFromSession',
      extractLatestRecoContextFromSession,
    );
    const extractReplyTextFromActionFn = requireFunction(
      'extractReplyTextFromAction',
      extractReplyTextFromAction,
    );
    const extractIncludeAlternativesFromActionFn = requireFunction(
      'extractIncludeAlternativesFromAction',
      extractIncludeAlternativesFromAction,
    );
    const coerceBooleanFn = requireFunction('coerceBoolean', coerceBoolean);
    const normalizeChatLlmProviderFn = requireFunction(
      'normalizeChatLlmProvider',
      normalizeChatLlmProvider,
    );
    const normalizeChatLlmModelFn = requireFunction('normalizeChatLlmModel', normalizeChatLlmModel);
    const inferCanonicalIntentFn = requireFunction('inferCanonicalIntent', inferCanonicalIntent);
    const hasRoutineSosSignalFn = requireFunction('hasRoutineSosSignal', hasRoutineSosSignal);
    const resolvePreferredLegacyTravelPlanFn = requireFunction(
      'resolvePreferredLegacyTravelPlan',
      resolvePreferredLegacyTravelPlan,
    );
    const hasMeaningfulFitCheckAnchorFn = requireFunction(
      'hasMeaningfulFitCheckAnchor',
      hasMeaningfulFitCheckAnchor,
    );

    const {
      parsedData = {},
      req = {},
      ctx = {},
      profile = null,
      recentLogs = [],
      identity = {},
      effectiveChatFlags = {},
    } = args;

    const normalizedActionPayload = buildNormalizedActionPayload(parsedData);
    const latestRecoContextFromSession = extractLatestRecoContextFromSessionFn(parsedData.session);

    let nextProfile = profile;
    let nextRecentLogs = Array.isArray(recentLogs) ? recentLogs : [];
    let appliedProfilePatch = null;
    let textDerivedProfilePatch = null;
    let textDerivedSkinLog = null;

    ({
      profile: nextProfile,
      appliedProfilePatch,
    } = await applyProfilePatchFromAction({
      identity,
      normalizedActionPayload,
      profile: nextProfile,
    }));

    const actionReplyText = extractReplyTextFromActionFn(normalizedActionPayload);
    const actionLabel =
      typeof parsedData.action_label === 'string' && parsedData.action_label.trim()
        ? parsedData.action_label.trim()
        : normalizedActionPayload && typeof normalizedActionPayload === 'string' && normalizedActionPayload.trim()
          ? normalizedActionPayload.trim()
          : null;
    const message =
      String(parsedData.message || parsedData.query || '').trim() ||
      actionReplyText ||
      actionLabel ||
      '';
    const requestMessage = message;

    const pregnancyOut = await applyPregnancyPolicy({
      ctx,
      identity,
      profile: nextProfile,
      message,
      appliedProfilePatch,
    });
    nextProfile = pregnancyOut.profile;
    appliedProfilePatch = pregnancyOut.appliedProfilePatch;
    const pendingPregnancyPolicyEvents = Array.isArray(pregnancyOut.pendingPregnancyPolicyEvents)
      ? pregnancyOut.pendingPregnancyPolicyEvents
      : [];

    const actionId =
      (normalizedActionPayload && typeof normalizedActionPayload === 'object'
        ? normalizedActionPayload.action_id
        : typeof normalizedActionPayload === 'string'
          ? normalizedActionPayload
          : null) ||
      parsedData.action_id ||
      null;
    const clarificationId =
      normalizedActionPayload &&
      typeof normalizedActionPayload === 'object' &&
      normalizedActionPayload.data &&
      typeof normalizedActionPayload.data === 'object'
        ? normalizedActionPayload.data.clarification_id || normalizedActionPayload.data.clarificationId || null
        : parsedData.clarification_id || null;
    const includeAlternatives = extractIncludeAlternativesFromActionFn(normalizedActionPayload);
    const debugHeader =
      typeof req.get === 'function'
        ? req.get('X-Debug') ?? req.get('X-Aurora-Debug')
        : undefined;
    const debugFromHeader = debugHeader == null ? undefined : coerceBooleanFn(debugHeader);
    const debugFromBody = typeof parsedData.debug === 'boolean' ? parsedData.debug : undefined;
    const debugUpstream = debugFromHeader ?? debugFromBody;
    const llmProvider = AURORA_DIAG_FORCE_GEMINI
      ? 'gemini'
      : normalizeChatLlmProviderFn(parsedData.llm_provider) ||
        normalizeChatLlmProviderFn(
          typeof req.get === 'function'
            ? req.get('X-LLM-Provider') ?? req.get('X-Aurora-LLM-Provider')
            : undefined,
        );
    const llmModel = AURORA_DIAG_FORCE_GEMINI
      ? AURORA_DIAG_FORCE_GEMINI_MODEL
      : normalizeChatLlmModelFn(parsedData.llm_model) ||
        normalizeChatLlmModelFn(
          typeof req.get === 'function'
            ? req.get('X-LLM-Model') ?? req.get('X-Aurora-LLM-Model')
            : undefined,
        );
    const llmRouteMetaForResponse =
      llmProvider || llmModel
        ? {
            llm_provider_requested: llmProvider || null,
            llm_model_requested: llmModel || null,
            llm_provider_effective: null,
            llm_model_effective: null,
          }
        : null;
    const anchorProductId =
      typeof parsedData.anchor_product_id === 'string' && parsedData.anchor_product_id.trim()
        ? parsedData.anchor_product_id.trim()
        : '';
    const anchorProductUrl =
      typeof parsedData.anchor_product_url === 'string' && parsedData.anchor_product_url.trim()
        ? parsedData.anchor_product_url.trim()
        : '';
    const upstreamMessages = Array.isArray(parsedData.messages) ? parsedData.messages : null;

    let canonicalIntent = inferCanonicalIntentFn({
      message,
      actionId,
      actionLabel,
      language: ctx.match_lang || ctx.lang,
    });
    if (
      AURORA_ROUTER_DST_PATCH_V1_ENABLED &&
      hasRoutineSosSignalFn(message) &&
      (
        canonicalIntent.intent === INTENT_ENUM.EVALUATE_PRODUCT ||
        canonicalIntent.intent === INTENT_ENUM.DUPE_COMPARE ||
        canonicalIntent.intent === INTENT_ENUM.INGREDIENT_SCIENCE
      )
    ) {
      canonicalIntent = {
        ...canonicalIntent,
        intent: INTENT_ENUM.ROUTINE,
        source: 'sos_override',
        confidence: 0.99,
      };
    }
    const canonicalIntentForResponse = {
      intent: canonicalIntent.intent || INTENT_ENUM.UNKNOWN,
      confidence: Number.isFinite(Number(canonicalIntent.confidence)) ? Number(canonicalIntent.confidence) : 0,
      entities:
        canonicalIntent && canonicalIntent.entities && typeof canonicalIntent.entities === 'object'
          ? canonicalIntent.entities
          : {},
    };

    ({
      profile: nextProfile,
      appliedProfilePatch,
      textDerivedProfilePatch,
    } = await applyTextDerivedProfilePatch({
      ctx,
      identity,
      profile: nextProfile,
      message,
      canonicalIntent,
      appliedProfilePatch,
    }));

    ({
      recentLogs: nextRecentLogs,
      textDerivedSkinLog,
    } = await applyTextDerivedSkinLog({
      identity,
      recentLogs: nextRecentLogs,
      message,
    }));

    if (
      effectiveChatFlags.profile_v2 &&
      canonicalIntent &&
      canonicalIntent.entities &&
      typeof canonicalIntent.entities === 'object' &&
      (
        canonicalIntent.intent === INTENT_ENUM.TRAVEL_PLANNING ||
        canonicalIntent.intent === INTENT_ENUM.WEATHER_ENV
      )
    ) {
      const baseTravel = resolvePreferredLegacyTravelPlanFn(nextProfile) || {};
      const nextTravel = {
        ...baseTravel,
        ...(canonicalIntent.entities.destination
          ? { destination: String(canonicalIntent.entities.destination).trim().slice(0, 100) }
          : {}),
        ...(canonicalIntent.entities.date_range && typeof canonicalIntent.entities.date_range === 'object'
          ? {
              ...(canonicalIntent.entities.date_range.start
                ? { start_date: String(canonicalIntent.entities.date_range.start).trim().slice(0, 20) }
                : {}),
              ...(canonicalIntent.entities.date_range.end
                ? { end_date: String(canonicalIntent.entities.date_range.end).trim().slice(0, 20) }
                : {}),
            }
          : {}),
        ...(canonicalIntent.entities.time_window
          ? { time_window: String(canonicalIntent.entities.time_window).trim().slice(0, 20) }
          : {}),
      };
      if (Object.keys(nextTravel).length) {
        const travelPatch = { travel_plan: nextTravel };
        nextProfile = { ...(nextProfile || {}), ...travelPatch };
        appliedProfilePatch = {
          ...(appliedProfilePatch && typeof appliedProfilePatch === 'object' ? appliedProfilePatch : {}),
          ...travelPatch,
        };
      }
    }

    const hasPlannerAnchor = hasMeaningfulFitCheckAnchorFn({
      message,
      anchorProductId,
      anchorProductUrl,
    });

    return {
      normalizedActionPayload,
      latestRecoContextFromSession,
      profile: nextProfile,
      recentLogs: nextRecentLogs,
      appliedProfilePatch,
      textDerivedProfilePatch,
      textDerivedSkinLog,
      actionReplyText,
      message,
      requestMessage,
      actionId,
      actionLabel,
      clarificationId: clarificationId || null,
      includeAlternatives,
      debugUpstream,
      llmProvider,
      llmModel,
      llmRouteMetaForResponse,
      anchorProductId,
      anchorProductUrl,
      upstreamMessages,
      canonicalIntent,
      canonicalIntentForResponse,
      hasPlannerAnchor,
      pendingPregnancyPolicyEvents,
    };
  }

  return {
    prepareChatTurnSetup,
  };
}

module.exports = {
  createChatTurnSetupRuntime,
};
