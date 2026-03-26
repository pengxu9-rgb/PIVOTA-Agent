function defaultIsPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function createChatDerivedCardsRuntime(options = {}) {
  const {
    isPlainObject = defaultIsPlainObject,
    chatFitCheckRuntime,
    buildEnvStressUiModelFromUpstream,
    buildEnvStressUiModelFromLocal,
    looksLikeWeatherOrEnvironmentQuestion = () => false,
    looksLikeCompatibilityOrConflictQuestion = () => false,
    extractHeatmapStepsFromConflictDetector,
    buildConflictHeatmapV1,
    CONFLICT_HEATMAP_V1_ENABLED = false,
    INCLUDE_RAW_AURORA_CONTEXT = false,
    makeEvent,
    INTENT_ENUM = {},
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat derived cards runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  function isEnvStressCard(card) {
    if (!card || typeof card !== 'object') return false;
    const type = typeof card.type === 'string' ? card.type.trim().toLowerCase() : '';
    if (/^(env_stress|environment_stress|envstress|environmentstress)$/.test(type)) return true;
    if (type.includes('env') && type.includes('stress')) return true;
    const payload = isPlainObject(card.payload) ? card.payload : null;
    const schema = payload && typeof payload.schema_version === 'string' ? payload.schema_version.trim() : '';
    return schema === 'aurora.ui.env_stress.v1' || schema === 'aurora.env_stress.v1';
  }

  function extractContextRaw(upstream) {
    return upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context : null;
  }

  function extractAnchorFromContext(contextRaw) {
    if (!contextRaw) return null;
    if (isPlainObject(contextRaw.anchor)) return contextRaw.anchor;
    if (isPlainObject(contextRaw.anchor_product)) return contextRaw.anchor_product;
    if (isPlainObject(contextRaw.anchorProduct)) return contextRaw.anchorProduct;
    return null;
  }

  async function prepareUpstreamDerivedCards(args = {}) {
    const {
      upstream,
      cards = [],
      fieldMissing = [],
      ctx,
      message = '',
      upstreamMessage = '',
      actionId = '',
      canonicalIntent = null,
      debugUpstream = false,
      profile = null,
      profileSummary = null,
      recentLogs = [],
      req,
      anchorProductUrl = '',
      anchorProductId = '',
      llmProvider = '',
      llmModel = '',
    } = args;

    const buildEnvStressUiModelFromUpstreamFn = requireFunction(
      'buildEnvStressUiModelFromUpstream',
      buildEnvStressUiModelFromUpstream,
    );
    const buildEnvStressUiModelFromLocalFn = requireFunction(
      'buildEnvStressUiModelFromLocal',
      buildEnvStressUiModelFromLocal,
    );
    const buildFitCheckCards = requireMethod(chatFitCheckRuntime, 'chatFitCheckRuntime', 'buildFitCheckCards');

    const nextFieldMissing = Array.isArray(fieldMissing) ? fieldMissing.slice() : [];
    let nextCards = Array.isArray(cards) ? cards.slice() : [];
    const derivedCards = [];
    let heatmapImpressionEvent = null;
    const responseIntentMessage = upstreamMessage || message;
    const contextRaw = extractContextRaw(upstream);

    const envStressActionRequested =
      typeof actionId === 'string' && /env[_-]?stress|environment[_-]?stress|weather|itinerary/i.test(actionId);
    const looksEnv = looksLikeWeatherOrEnvironmentQuestion(responseIntentMessage);
    const wantsEnvStressCard = Boolean(debugUpstream) || envStressActionRequested || looksEnv;

    if (!wantsEnvStressCard && nextCards.length) {
      const before = nextCards.length;
      nextCards = nextCards.filter((card) => !isEnvStressCard(card));
      if (before !== nextCards.length) {
        nextFieldMissing.push({ field: 'cards.env_stress', reason: 'not_requested' });
      }
    }

    let envStressUi = null;
    if (contextRaw) {
      const envStressRaw = isPlainObject(contextRaw.env_stress)
        ? contextRaw.env_stress
        : isPlainObject(contextRaw.envStress)
          ? contextRaw.envStress
          : null;
      envStressUi = buildEnvStressUiModelFromUpstreamFn(envStressRaw, { language: ctx && ctx.lang });
    }
    if (!envStressUi && (envStressActionRequested || looksEnv)) {
      envStressUi = buildEnvStressUiModelFromLocalFn({
        profile,
        recentLogs,
        message: responseIntentMessage,
        language: ctx && ctx.lang,
      });
    }
    if (envStressUi && wantsEnvStressCard) {
      derivedCards.push({
        card_id: `env_${ctx.request_id}`,
        type: 'env_stress',
        payload: envStressUi,
      });
    }

    if (contextRaw) {
      const conflictDetector = isPlainObject(contextRaw.conflict_detector)
        ? contextRaw.conflict_detector
        : isPlainObject(contextRaw.conflictDetector)
          ? contextRaw.conflictDetector
          : null;
      const wantsConflictCards =
        Boolean(debugUpstream) ||
        (canonicalIntent && canonicalIntent.intent === INTENT_ENUM.CONFLICT_CHECK) ||
        looksLikeCompatibilityOrConflictQuestion(responseIntentMessage) ||
        (typeof actionId === 'string' && /(routine|compat|conflict|heatmap)/i.test(actionId));

      if (wantsConflictCards && conflictDetector && typeof conflictDetector.safe === 'boolean') {
        derivedCards.push({
          card_id: `conflicts_${ctx.request_id}`,
          type: 'routine_simulation',
          payload: conflictDetector,
        });
        const heatmapPayload = CONFLICT_HEATMAP_V1_ENABLED
          ? requireFunction('buildConflictHeatmapV1', buildConflictHeatmapV1)({
            routineSimulation: conflictDetector,
            routineSteps: requireFunction(
              'extractHeatmapStepsFromConflictDetector',
              extractHeatmapStepsFromConflictDetector,
            )({
              conflictDetector,
              contextRaw,
            }),
          })
          : { schema_version: 'aurora.ui.conflict_heatmap.v1' };
        derivedCards.push({
          card_id: `heatmap_${ctx.request_id}`,
          type: 'conflict_heatmap',
          payload: heatmapPayload,
        });
        if (CONFLICT_HEATMAP_V1_ENABLED) {
          heatmapImpressionEvent = requireFunction('makeEvent', makeEvent)(ctx, 'aurora_conflict_heatmap_impression', {
            schema_version: heatmapPayload.schema_version,
            state: heatmapPayload.state,
            num_steps: Array.isArray(heatmapPayload.axes?.rows?.items) ? heatmapPayload.axes.rows.items.length : 0,
            num_cells_nonzero: Array.isArray(heatmapPayload.cells?.items) ? heatmapPayload.cells.items.length : 0,
            num_unmapped_conflicts: Array.isArray(heatmapPayload.unmapped_conflicts)
              ? heatmapPayload.unmapped_conflicts.length
              : 0,
            max_severity: Math.max(
              0,
              ...((Array.isArray(heatmapPayload.cells?.items) ? heatmapPayload.cells.items : []).map(
                (cell) => Number(cell?.severity) || 0,
              )),
              ...((Array.isArray(heatmapPayload.unmapped_conflicts) ? heatmapPayload.unmapped_conflicts : []).map(
                (conflict) => Number(conflict?.severity) || 0,
              )),
            ),
            routine_simulation_safe: Boolean(conflictDetector.safe),
            routine_conflict_count: Array.isArray(conflictDetector.conflicts) ? conflictDetector.conflicts.length : 0,
            trigger_source: ctx && ctx.trigger_source,
          });
        }
      }
    }

    const fitCheckCards = await buildFitCheckCards({
      ctx,
      req,
      cards: nextCards,
      derivedCards,
      anchorFromContext: extractAnchorFromContext(contextRaw),
      responseIntentMessage,
      profileSummary,
      profile,
      recentLogs,
      anchorProductUrl,
      anchorProductId,
      llmProvider,
      llmModel,
      debugUpstream,
    });
    if (Array.isArray(fitCheckCards) && fitCheckCards.length) {
      derivedCards.push(...fitCheckCards);
    }

    const contextCard = INCLUDE_RAW_AURORA_CONTEXT && contextRaw
      ? [{
        card_id: `aurora_ctx_${ctx.request_id}`,
        type: 'aurora_context_raw',
        payload: {
          intent: upstream && typeof upstream.intent === 'string' ? upstream.intent : null,
          clarification: null,
          context: contextRaw,
        },
      }]
      : [];

    return {
      cards: nextCards,
      fieldMissing: nextFieldMissing,
      contextRaw,
      derivedCards,
      heatmapImpressionEvent,
      contextCard,
    };
  }

  return {
    prepareUpstreamDerivedCards,
  };
}

module.exports = {
  createChatDerivedCardsRuntime,
};
