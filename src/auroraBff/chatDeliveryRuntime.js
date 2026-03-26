function createChatDeliveryRuntime(options = {}) {
  const {
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
    AURORA_CHAT_LEGACY_ENVELOPE_RESPONSE = false,
    INTENT_ENUM = {
      UNKNOWN: 'unknown',
    },
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat delivery runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function deliverChatEnvelope(args = {}) {
    const {
      envelope,
      statusCode = 200,
      res,
      req,
      ctx,
      templateCtx,
      chatSessionId,
      requestMessage,
      profile,
      recentLogs = [],
      policyMeta,
      canonicalIntentForResponse = { intent: INTENT_ENUM.UNKNOWN, confidence: 0, entities: {} },
      skipRoutineRulesFallback = false,
      rolloutContext,
      shouldAttachPolicyMeta,
      plannerSessionStatePatch,
      latestClarificationId,
      llmRouteMetaForResponse,
      pendingSafetyAdvisory,
      pendingGateAdvisories = [],
      pendingPregnancyPolicyEvents = [],
      recoContextMetricsEmitted = false,
      safetyDecision = null,
      chatContext = null,
      resolvedIdentity = { auroraUid: null, userId: null },
      ingredientReplayContext = {},
      actionIdForReplay = null,
      clientStateForReplay = null,
      agentStateForReplay = null,
    } = args;

    const applyPendingSafetyAdvisoryToEnvelope = requireMethod(
      chatAdvisoryRuntime,
      'chatAdvisoryRuntime',
      'applyPendingSafetyAdvisoryToEnvelope',
    );
    const applyPendingGateAdvisoriesToEnvelope = requireMethod(
      chatAdvisoryRuntime,
      'chatAdvisoryRuntime',
      'applyPendingGateAdvisoriesToEnvelope',
    );
    const applyLlmMetaToEnvelope = requireMethod(
      chatEnvelopeMetaRuntime,
      'chatEnvelopeMetaRuntime',
      'applyLlmMetaToEnvelope',
    );
    const applyPendingPregnancyPolicyEventsToEnvelope = requireMethod(
      chatEnvelopeMetaRuntime,
      'chatEnvelopeMetaRuntime',
      'applyPendingPregnancyPolicyEventsToEnvelope',
    );
    const applyRecommendationMetaToEnvelope = requireMethod(
      chatEnvelopeMetaRuntime,
      'chatEnvelopeMetaRuntime',
      'applyRecommendationMetaToEnvelope',
    );
    const applyPolicyMetaToEnvelope = requireMethod(
      chatResponseRuntime,
      'chatResponseRuntime',
      'applyPolicyMetaToEnvelope',
    );
    const applyRolloutHeaders = requireMethod(
      chatResponseRuntime,
      'chatResponseRuntime',
      'applyRolloutHeaders',
    );
    const prepareEnvelopeForDelivery = requireMethod(
      chatResponseRuntime,
      'chatResponseRuntime',
      'prepareEnvelopeForDelivery',
    );
    const updateChatContextFromEnvelope = requireMethod(
      chatContextRuntime,
      'chatContextRuntime',
      'updateChatContextFromEnvelope',
    );
    const collectTelemetryEntities = requireMethod(
      chatContextRuntime,
      'chatContextRuntime',
      'collectTelemetryEntities',
    );
    const collectLegacyCardTypes = requireMethod(
      chatContextRuntime,
      'chatContextRuntime',
      'collectLegacyCardTypes',
    );
    const inferGateFromLegacyCardTypes = requireMethod(
      chatContextRuntime,
      'chatContextRuntime',
      'inferGateFromLegacyCardTypes',
    );
    const extractNextStateFromEnvelope = requireMethod(
      chatContextRuntime,
      'chatContextRuntime',
      'extractNextStateFromEnvelope',
    );
    const processIngredientReplay = requireMethod(
      chatIngredientReplayRuntime,
      'chatIngredientReplayRuntime',
      'processIngredientReplay',
    );
    const safelyApplyProductIntelGuardrailsToEnvelopeFn = requireFunction(
      'safelyApplyProductIntelGuardrailsToEnvelope',
      safelyApplyProductIntelGuardrailsToEnvelope,
    );
    const persistRejectedCatalogCandidatesFn = requireFunction(
      'persistRejectedCatalogCandidates',
      persistRejectedCatalogCandidates,
    );
    const suppressAnalysisCardsForTravelEnvTurnFn = requireFunction(
      'suppressAnalysisCardsForTravelEnvTurn',
      suppressAnalysisCardsForTravelEnvTurn,
    );
    const executeAuroraOptionalStepFn = requireFunction(
      'executeAuroraOptionalStep',
      executeAuroraOptionalStep,
    );
    const upsertChatContextForIdentityFn = requireFunction(
      'upsertChatContextForIdentity',
      upsertChatContextForIdentity,
    );
    const enrichIngredientReportCardsInEnvelopeFn = requireFunction(
      'enrichIngredientReportCardsInEnvelope',
      enrichIngredientReportCardsInEnvelope,
    );
    const buildChatCardsResponseFn = requireFunction(
      'buildChatCardsResponse',
      buildChatCardsResponse,
    );
    const appendExperimentEventForIdentityFn = requireFunction(
      'appendExperimentEventForIdentity',
      appendExperimentEventForIdentity,
    );
    const emitAuditFn = requireFunction('emitAudit', emitAudit);
    const makeEventFn = requireFunction('makeEvent', makeEvent);

    const withSafetyAdvisory = applyPendingSafetyAdvisoryToEnvelope({
      envelope,
      pendingSafetyAdvisory,
      ctx,
    });
    const withGateAdvisory = applyPendingGateAdvisoriesToEnvelope({
      envelope: withSafetyAdvisory,
      pendingGateAdvisories,
      ctx,
    });
    const withLlmMeta = applyLlmMetaToEnvelope({
      envelope: withGateAdvisory,
      llmRouteMetaForResponse,
      ctx,
    });
    const withPolicyMeta = applyPolicyMetaToEnvelope({
      envelope: withLlmMeta,
      shouldAttachPolicyMeta,
      policyMeta,
      plannerSessionStatePatch,
      latestClarificationId,
      ctx,
    });
    const withPregnancyPolicyEvents = applyPendingPregnancyPolicyEventsToEnvelope({
      envelope: withPolicyMeta,
      pendingPregnancyPolicyEvents,
    });
    const recommendationMetaResult = applyRecommendationMetaToEnvelope({
      envelope: withPregnancyPolicyEvents,
      recentLogs,
      profile,
      safetyDecision,
      recoContextMetricsEmitted,
    });
    let nextRecoContextMetricsEmitted = recommendationMetaResult.recoContextMetricsEmitted;
    const withRecoMeta = recommendationMetaResult.envelope;

    applyRolloutHeaders({
      res,
      rolloutContext,
      policyMeta,
    });

    const canonicalIntent = canonicalIntentForResponse && canonicalIntentForResponse.intent
      ? canonicalIntentForResponse.intent
      : INTENT_ENUM.UNKNOWN;
    const envelopeWithContract = prepareEnvelopeForDelivery({
      envelope: withRecoMeta,
      statusCode,
      req,
      ctx,
      templateCtx,
      chatSessionId,
      requestMessage,
      profile,
      recentLogs,
      policyMeta,
      canonicalIntent,
      skipRoutineRulesFallback,
    });

    const guardrailResult = await safelyApplyProductIntelGuardrailsToEnvelopeFn({
      envelope: envelopeWithContract,
      ctx,
      profile,
      language: ctx && ctx.lang,
    });
    if (guardrailResult && guardrailResult.failed) {
      logger?.warn(
        {
          request_id: ctx && ctx.request_id,
          trace_id: ctx && ctx.trace_id,
          error_code: guardrailResult.error_code || null,
        },
        'aurora bff: product-intel guardrail failed, fallback envelope used',
      );
    }
    if (guardrailResult && Array.isArray(guardrailResult.rejected) && guardrailResult.rejected.length > 0) {
      persistRejectedCatalogCandidatesFn(ctx, guardrailResult.rejected);
    }

    const envelopeWithGuardrails =
      guardrailResult && guardrailResult.envelope && typeof guardrailResult.envelope === 'object'
        ? { ...guardrailResult.envelope }
        : envelopeWithContract;
    if (envelopeWithGuardrails && typeof envelopeWithGuardrails === 'object' && !Array.isArray(envelopeWithGuardrails)) {
      const currentCards = Array.isArray(envelopeWithGuardrails.cards) ? envelopeWithGuardrails.cards : [];
      const suppressedCards = suppressAnalysisCardsForTravelEnvTurnFn(currentCards, {
        canonicalIntent: (policyMeta && policyMeta.intent_canonical) || canonicalIntent,
      });
      if (suppressedCards.length !== currentCards.length) {
        envelopeWithGuardrails.cards = suppressedCards;
      }
    }

    if (guardrailResult && (guardrailResult.dropped > 0 || guardrailResult.externalized > 0)) {
      const events = Array.isArray(envelopeWithGuardrails.events) ? envelopeWithGuardrails.events.slice(0, 96) : [];
      events.push(
        makeEventFn(ctx, 'product_intel_guardrail_applied', {
          dropped_count: Number(guardrailResult.dropped || 0),
          externalized_count: Number(guardrailResult.externalized || 0),
        }),
      );
      envelopeWithGuardrails.events = events;
      logger?.info(
        {
          request_id: ctx && ctx.request_id,
          trace_id: ctx && ctx.trace_id,
          dropped_count: Number(guardrailResult.dropped || 0),
          externalized_count: Number(guardrailResult.externalized || 0),
        },
        'aurora bff: product-intel guardrail applied',
      );
    }

    const chatContextUpdate = updateChatContextFromEnvelope({
      chatContext,
      envelope: envelopeWithGuardrails,
      policyIntent: policyMeta && policyMeta.intent_canonical,
      canonicalIntent,
      requestMessage,
    });
    let nextChatContext = chatContextUpdate.chatContext;
    const threadOps = chatContextUpdate.threadOps;

    if (
      resolvedIdentity &&
      (resolvedIdentity.auroraUid || resolvedIdentity.userId) &&
      nextChatContext &&
      typeof nextChatContext === 'object'
    ) {
      await executeAuroraOptionalStepFn({
        logger,
        route: '/v1/chat',
        stepId: 'chat.persist_context',
        criticality: 'optional',
        fn: async () =>
          upsertChatContextForIdentityFn(
            { auroraUid: resolvedIdentity.auroraUid, userId: resolvedIdentity.userId },
            nextChatContext,
          ),
      });
    }

    const telemetryEntities = collectTelemetryEntities(canonicalIntentForResponse);
    const enrichedEnvelope = enrichIngredientReportCardsInEnvelopeFn(envelopeWithGuardrails, {
      language: ctx && ctx.lang,
      logger,
    });
    if (enrichedEnvelope !== envelopeWithGuardrails && enrichedEnvelope && enrichedEnvelope.cards) {
      envelopeWithGuardrails.cards = enrichedEnvelope.cards;
    }

    const chatCardsResponse = buildChatCardsResponseFn({
      envelope: envelopeWithGuardrails,
      ctx,
      intent: (policyMeta && policyMeta.intent_canonical) || canonicalIntent || INTENT_ENUM.UNKNOWN,
      intentConfidence:
        Number.isFinite(Number(canonicalIntentForResponse && canonicalIntentForResponse.confidence))
          ? Number(canonicalIntentForResponse.confidence)
          : 0,
      entities: telemetryEntities,
      safetyDecision,
      threadOps,
    });

    const legacyCardTypes = collectLegacyCardTypes(envelopeWithGuardrails);
    const gateType = inferGateFromLegacyCardTypes(legacyCardTypes);
    const nextState = extractNextStateFromEnvelope(envelopeWithGuardrails);
    const ingredientReplayResult = processIngredientReplay({
      envelope: envelopeWithGuardrails,
      chatCardsResponse,
      ingredientReplayContext,
      legacyCardTypes,
      gateType,
      nextState,
      actionIdForReplay,
      clientStateForReplay,
      agentStateForReplay,
      ctx,
      policyMeta,
      canonicalIntentForResponse,
    });
    const nextIngredientReplayContext = ingredientReplayResult.ingredientReplayContext;

    if (
      resolvedIdentity &&
      (resolvedIdentity.auroraUid || resolvedIdentity.userId) &&
      chatCardsResponse &&
      chatCardsResponse.ops &&
      Array.isArray(chatCardsResponse.ops.experiment_events)
    ) {
      for (const evt of chatCardsResponse.ops.experiment_events.slice(0, 8)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await appendExperimentEventForIdentityFn(
            { auroraUid: resolvedIdentity.auroraUid, userId: resolvedIdentity.userId },
            evt,
          );
        } catch (err) {
          logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to append experiment event');
        }
      }
    }

    emitAuditFn(envelopeWithGuardrails, templateCtx, { logger });
    const responsePayload = AURORA_CHAT_LEGACY_ENVELOPE_RESPONSE
      ? envelopeWithGuardrails
      : chatCardsResponse;
    const result = statusCode >= 400
      ? res.status(statusCode).json(responsePayload)
      : res.json(responsePayload);

    return {
      result,
      chatContext: nextChatContext,
      ingredientReplayContext: nextIngredientReplayContext,
      recoContextMetricsEmitted: nextRecoContextMetricsEmitted,
    };
  }

  return {
    deliverChatEnvelope,
  };
}

module.exports = {
  createChatDeliveryRuntime,
};
