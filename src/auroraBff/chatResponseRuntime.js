function defaultIsPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function createChatResponseRuntime(options = {}) {
  const {
    logger = null,
    makeEvent,
    applyReplyTemplates = ({ envelope }) => envelope,
    augmentEnvelopeProductAnalysisCardsForDogfood = ({ envelope }) => envelope,
    shouldApplyRecoOutputGuard = () => false,
    applyLowOrMediumRecoGuardToEnvelope = ({ envelope }) => ({
      envelope,
      applied: false,
      filteredCount: 0,
      totalCount: 0,
      fallbackApplied: false,
    }),
    recordAuroraSkinFlowMetric = () => {},
    ensureNonEmptyChatCardsEnvelope = ({ envelope }) => ({
      envelope,
      applied: false,
      reason: null,
    }),
    isRoutineContractIntent = () => false,
    hasRoutineSosSignal = () => false,
    looksLikeCompatibilityOrConflictQuestion = () => false,
    looksLikeWeatherOrEnvironmentQuestion = () => false,
    looksLikeRoutineRequest = () => false,
    looksLikeIngredientScienceIntent = () => false,
    findRoutineExpertNodeFromEnvelope = () => null,
    hasRoutineExpertRequiredModules = () => true,
    buildRoutineRulesOnlyFallbackCardsForChat = () => [],
    AURORA_MULTITURN_CONTRACT_GATE_V1_ENABLED = false,
    evaluateQualityContractForEnvelope = () => null,
    recordChatStallPhrase = () => {},
    recordContractFail = () => {},
    recordRecommendationUrlInvariantFail = () => {},
    recordKnownFieldReask = () => {},
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat response runtime missing dependency: ${name}`);
  }

  function buildBaseEnvelope(envelope) {
    return envelope && typeof envelope === 'object' && !Array.isArray(envelope)
      ? { ...envelope }
      : envelope;
  }

  function applyPolicyMetaToEnvelope({
    envelope,
    shouldAttachPolicyMeta = false,
    policyMeta = {},
    plannerSessionStatePatch = null,
    latestClarificationId = null,
    ctx,
  } = {}) {
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    if (!shouldAttachPolicyMeta) return envelope;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return envelope;

    const out = { ...envelope };
    const baseSessionPatch = defaultIsPlainObject(out.session_patch) ? { ...out.session_patch } : {};
    const baseMeta = defaultIsPlainObject(baseSessionPatch.meta) ? { ...baseSessionPatch.meta } : {};
    baseSessionPatch.meta = { ...baseMeta, ...policyMeta };
    if (defaultIsPlainObject(plannerSessionStatePatch)) {
      const baseState = defaultIsPlainObject(baseSessionPatch.state) ? { ...baseSessionPatch.state } : {};
      baseSessionPatch.state = { ...baseState, ...plannerSessionStatePatch };
    }
    out.session_patch = baseSessionPatch;

    const topMeta = defaultIsPlainObject(out.meta) ? { ...out.meta } : {};
    out.meta = { ...topMeta, ...policyMeta };

    const events = Array.isArray(out.events) ? out.events.slice() : [];
    const hasPolicyEvent = events.some((evt) => evt && typeof evt === 'object' && evt.event_name === 'aurora_policy_meta');
    if (!hasPolicyEvent) {
      events.push(
        makeEventFn(ctx, 'aurora_policy_meta', {
          intent_source: policyMeta.intent_source,
          intent_resolved: policyMeta.intent_canonical,
          loop_breaker_triggered:
            policyMeta.break_applied === 'chips_single_question' ||
            policyMeta.break_applied === 'conservative_defaults' ||
            policyMeta.break_applied === 'stop_asking',
          gate_applied: policyMeta.gate_type,
          clarification_id: latestClarificationId || null,
        }),
      );
    }
    out.events = events;
    return out;
  }

  function applyRolloutHeaders({ res, rolloutContext, policyMeta = {} } = {}) {
    if (!res || !rolloutContext || typeof rolloutContext !== 'object') return;
    const setter =
      typeof res.set === 'function'
        ? (name, value) => res.set(name, value)
        : typeof res.setHeader === 'function'
          ? (name, value) => res.setHeader(name, value)
          : null;
    if (!setter) return;
    setter('x-aurora-bucket', String(Number.isFinite(Number(rolloutContext.bucket)) ? Number(rolloutContext.bucket) : 0));
    setter('x-aurora-variant', String(rolloutContext.variant || 'legacy'));
    setter('x-aurora-policy-version', String(rolloutContext.policy_version || policyMeta.policy_version || 'legacy'));
  }

  function applyRoutineRulesFallback({
    envelope,
    statusCode = 200,
    skipRoutineRulesFallback = false,
    policyMeta = {},
    canonicalIntent = null,
    requestMessage = '',
    profile = null,
    recentLogs = [],
    ctx,
  } = {}) {
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const baseEnvelope = buildBaseEnvelope(envelope);
    if (!baseEnvelope || typeof baseEnvelope !== 'object' || Array.isArray(baseEnvelope)) return baseEnvelope;
    if (statusCode >= 400 || skipRoutineRulesFallback) return baseEnvelope;

    const currentCards = Array.isArray(baseEnvelope.cards) ? baseEnvelope.cards : [];
    const hasIngredientEntryCards = currentCards.some((card) => {
      const type = String(card && card.type ? card.type : '').trim().toLowerCase();
      return type === 'ingredient_hub' || type === 'ingredient_goal_match';
    });
    if (hasIngredientEntryCards) return baseEnvelope;

    const intentCanonical = String(policyMeta && policyMeta.intent_canonical ? policyMeta.intent_canonical : canonicalIntent || '')
      .trim()
      .toLowerCase();
    const routineContext =
      isRoutineContractIntent(intentCanonical) ||
      hasRoutineSosSignal(requestMessage) ||
      looksLikeCompatibilityOrConflictQuestion(requestMessage) ||
      looksLikeWeatherOrEnvironmentQuestion(requestMessage) ||
      looksLikeRoutineRequest(requestMessage, null) ||
      looksLikeIngredientScienceIntent(requestMessage, null);
    if (!routineContext) return baseEnvelope;

    const existingExpert = findRoutineExpertNodeFromEnvelope(baseEnvelope);
    if (hasRoutineExpertRequiredModules(existingExpert)) return baseEnvelope;

    const existingCards = Array.isArray(baseEnvelope.cards) ? baseEnvelope.cards.slice() : [];
    const existingEvents = Array.isArray(baseEnvelope.events) ? baseEnvelope.events.slice() : [];
    const fallbackCards = buildRoutineRulesOnlyFallbackCardsForChat({
      ctx,
      message: requestMessage,
      profile,
      recentLogs,
      language: ctx && ctx.lang,
      reason: 'default',
    });
    const fallbackAnalysisCard = fallbackCards.find((card) => card && card.type === 'analysis_summary');
    const fallbackConfidenceCard = fallbackCards.find((card) => card && card.type === 'confidence_notice');
    if (fallbackAnalysisCard) {
      existingCards.push(fallbackAnalysisCard);
    }
    if (
      fallbackConfidenceCard &&
      !existingCards.some((card) => card && typeof card === 'object' && String(card.type || '').trim() === 'confidence_notice')
    ) {
      existingCards.push(fallbackConfidenceCard);
    }
    existingEvents.push(
      makeEventFn(ctx, 'routine_rules_fallback', {
        reason: 'contract_module_missing',
        intent_canonical: intentCanonical || null,
      }),
    );
    return {
      ...baseEnvelope,
      cards: existingCards,
      events: existingEvents,
    };
  }

  function applyQualityContract({
    envelope,
    policyMeta = {},
    profile = null,
    assistantText = '',
  } = {}) {
    const baseEnvelope = buildBaseEnvelope(envelope);
    if (!AURORA_MULTITURN_CONTRACT_GATE_V1_ENABLED) return baseEnvelope;
    if (!baseEnvelope || typeof baseEnvelope !== 'object' || Array.isArray(baseEnvelope)) return baseEnvelope;

    const qualityContract = evaluateQualityContractForEnvelope({
      envelope: baseEnvelope,
      policyMeta,
      assistantText,
      profile,
    });
    if (qualityContract && qualityContract.stall_hit) {
      recordChatStallPhrase(1);
    }
    if (Array.isArray(qualityContract && qualityContract.critical_fail_reasons)) {
      for (const reason of qualityContract.critical_fail_reasons) {
        recordContractFail(reason, 1);
      }
    }
    if (qualityContract && qualityContract.strict_fail_flags && qualityContract.strict_fail_flags.missing_product_urls_in_recommendations) {
      recordRecommendationUrlInvariantFail(1);
    }
    if (qualityContract && qualityContract.strict_fail_flags && qualityContract.strict_fail_flags.entity_miss_fail_seed_profile) {
      recordKnownFieldReask(1);
    }
    const topMeta = defaultIsPlainObject(baseEnvelope.meta) ? { ...baseEnvelope.meta } : {};
    return {
      ...baseEnvelope,
      meta: {
        ...topMeta,
        quality_contract: qualityContract,
      },
    };
  }

  function prepareEnvelopeForDelivery({
    envelope,
    statusCode = 200,
    req,
    ctx,
    templateCtx,
    chatSessionId = '',
    requestMessage = '',
    profile = null,
    recentLogs = [],
    policyMeta = {},
    canonicalIntent = null,
    skipRoutineRulesFallback = false,
  } = {}) {
    const dogfoodAugmented = augmentEnvelopeProductAnalysisCardsForDogfood({
      envelope,
      req,
      ctx,
      mode: 'main_path',
      sessionId: chatSessionId,
      logger,
    });
    const normalized = applyReplyTemplates({ envelope: dogfoodAugmented, ctx: templateCtx });
    const guardEligible = statusCode < 400 && shouldApplyRecoOutputGuard({ envelope: normalized, ctx });
    const lowMediumFiltered = guardEligible
      ? applyLowOrMediumRecoGuardToEnvelope({ envelope: normalized, ctx, language: ctx && ctx.lang })
      : { envelope: normalized, applied: false, filteredCount: 0, totalCount: 0, fallbackApplied: false };

    if (lowMediumFiltered.applied) {
      logger?.info?.(
        {
          request_id: ctx && ctx.request_id,
          trace_id: ctx && ctx.trace_id,
          filtered_count: lowMediumFiltered.filteredCount,
          total_count: lowMediumFiltered.totalCount,
          fallback_applied: lowMediumFiltered.fallbackApplied,
        },
        'aurora bff: low/medium confidence reco treatment filter applied',
      );
      logger?.info?.(
        {
          kind: 'metric',
          name: 'aurora.skin.reco.low_medium_treatment_filtered',
          value: lowMediumFiltered.filteredCount,
        },
        'metric',
      );
      recordAuroraSkinFlowMetric({ stage: 'reco_low_medium_treatment_filtered', hit: true });
      if (lowMediumFiltered.fallbackApplied) {
        recordAuroraSkinFlowMetric({ stage: 'reco_low_medium_notice_fallback', hit: true });
      }
    }

    const guarded = guardEligible
      ? ensureNonEmptyChatCardsEnvelope({ envelope: lowMediumFiltered.envelope, ctx, language: ctx && ctx.lang })
      : { envelope: lowMediumFiltered.envelope, applied: false, reason: null };
    if (guarded.applied) {
      logger?.warn?.(
        {
          request_id: ctx && ctx.request_id,
          trace_id: ctx && ctx.trace_id,
          reason: guarded.reason,
        },
        'aurora bff: reco output guard applied due to empty/unrenderable cards',
      );
      logger?.info?.({ kind: 'metric', name: 'aurora.skin.reco.output_guard_fallback_rate', value: 1 }, 'metric');
      recordAuroraSkinFlowMetric({ stage: 'reco_output_guard_fallback', hit: true });
    }

    const envelopeAfterRoutineFallback = applyRoutineRulesFallback({
      envelope: guarded.envelope,
      statusCode,
      skipRoutineRulesFallback,
      policyMeta,
      canonicalIntent,
      requestMessage,
      profile,
      recentLogs,
      ctx,
    });
    const assistantText =
      envelopeAfterRoutineFallback &&
      envelopeAfterRoutineFallback.assistant_message &&
      typeof envelopeAfterRoutineFallback.assistant_message === 'object' &&
      typeof envelopeAfterRoutineFallback.assistant_message.content === 'string'
        ? envelopeAfterRoutineFallback.assistant_message.content
        : '';
    return applyQualityContract({
      envelope: envelopeAfterRoutineFallback,
      policyMeta,
      profile,
      assistantText,
    });
  }

  return {
    applyPolicyMetaToEnvelope,
    applyRolloutHeaders,
    prepareEnvelopeForDelivery,
  };
}

module.exports = {
  createChatResponseRuntime,
};
