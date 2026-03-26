function createChatUpstreamEnvelopeRuntime(options = {}) {
  const {
    logger = null,
    getUpstreamStructuredOrJson,
    structuredContainsCommerceLikeFields,
    mergeExternalVerificationIntoStructured,
    isRenderableCardForChatboxUi,
    sanitizeUpstreamAnswer,
    inferRouteFromCards,
    inferRouteFromMessageIntent,
    resolveRouteHint,
    looksLikeGenericStructuredNotice,
    isRouteStructuredAnswer,
    buildRouteAwareAssistantText,
    addEmotionalPreambleToAssistantText,
    stripInternalRefsDeep,
    finalizeProductAnalysisRecoContract,
    stateChangeAllowed,
    recordSessionPatchProfileEmitted,
    emitPendingClarificationPatch,
    isSkincareCatalogCard,
    recordCatalogPoisonBlock = () => {},
    looksLikeRoutineRequest,
    hasRoutineSosSignal,
    findRoutineExpertNodeFromEnvelope,
    hasRoutineExpertRequiredModules,
    buildRoutineRulesOnlyFallbackCardsForChat,
    suppressAnalysisCardsForTravelEnvTurn,
    selectTemplate,
    renderAssistantMessage,
    recordTemplateApplied,
    recordTemplateFallback,
    adaptChips,
    looksLikeStallPhrase,
    buildEnvelope,
    makeEvent,
    AURORA_CATALOG_DOMAIN_GUARD_V1_ENABLED = false,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat upstream envelope runtime missing dependency: ${name}`);
  }

  function buildUpstreamEnvelope(args = {}) {
    const {
      ctx,
      upstream,
      allowRecs = false,
      debugUpstream = false,
      answer = '',
      derivedCards = [],
      cards = [],
      fieldMissing = [],
      contextRaw = null,
      contextCard = [],
      clarification = null,
      responseIntentMessage = '',
      message = '',
      normalizedActionPayload = null,
      profile = null,
      recentLogs = [],
      profileSummary = null,
      appliedProfilePatch = null,
      profilePatchFromSession = null,
      nextStateOverride = null,
      pendingClarificationPatchOverride,
      pendingClarificationFromUpstream = null,
      hasLlmRouteMeta = false,
      llmRouteMeta = null,
      canonicalIntent = null,
      heatmapImpressionEvent = null,
      suggestedChips = [],
      makeChatAssistantMessage,
    } = args;

    const getStructured = requireFunction('getUpstreamStructuredOrJson', getUpstreamStructuredOrJson);
    const containsCommerceFields = requireFunction(
      'structuredContainsCommerceLikeFields',
      structuredContainsCommerceLikeFields,
    );
    const mergeExternalVerification = requireFunction(
      'mergeExternalVerificationIntoStructured',
      mergeExternalVerificationIntoStructured,
    );
    const isRenderableCard = requireFunction('isRenderableCardForChatboxUi', isRenderableCardForChatboxUi);
    const sanitizeAnswer = requireFunction('sanitizeUpstreamAnswer', sanitizeUpstreamAnswer);
    const inferRouteCards = requireFunction('inferRouteFromCards', inferRouteFromCards);
    const inferRouteMessage = requireFunction('inferRouteFromMessageIntent', inferRouteFromMessageIntent);
    const resolveHint = requireFunction('resolveRouteHint', resolveRouteHint);
    const looksGenericNotice = requireFunction('looksLikeGenericStructuredNotice', looksLikeGenericStructuredNotice);
    const isStructuredAnswer = requireFunction('isRouteStructuredAnswer', isRouteStructuredAnswer);
    const buildRouteAwareText = requireFunction('buildRouteAwareAssistantText', buildRouteAwareAssistantText);
    const addEmotionalPreamble = requireFunction(
      'addEmotionalPreambleToAssistantText',
      addEmotionalPreambleToAssistantText,
    );
    const stripInternalRefs = requireFunction('stripInternalRefsDeep', stripInternalRefsDeep);
    const finalizeProductAnalysis = requireFunction(
      'finalizeProductAnalysisRecoContract',
      finalizeProductAnalysisRecoContract,
    );
    const isStateChangeAllowed = requireFunction('stateChangeAllowed', stateChangeAllowed);
    const recordProfileEcho = requireFunction(
      'recordSessionPatchProfileEmitted',
      recordSessionPatchProfileEmitted,
    );
    const emitPendingClarification = requireFunction(
      'emitPendingClarificationPatch',
      emitPendingClarificationPatch,
    );
    const isSkincareCard = requireFunction('isSkincareCatalogCard', isSkincareCatalogCard);
    const looksRoutine = requireFunction('looksLikeRoutineRequest', looksLikeRoutineRequest);
    const hasRoutineSignal = requireFunction('hasRoutineSosSignal', hasRoutineSosSignal);
    const findRoutineExpert = requireFunction('findRoutineExpertNodeFromEnvelope', findRoutineExpertNodeFromEnvelope);
    const hasRoutineModules = requireFunction(
      'hasRoutineExpertRequiredModules',
      hasRoutineExpertRequiredModules,
    );
    const buildRoutineFallbackCards = requireFunction(
      'buildRoutineRulesOnlyFallbackCardsForChat',
      buildRoutineRulesOnlyFallbackCardsForChat,
    );
    const suppressTravelCards = requireFunction(
      'suppressAnalysisCardsForTravelEnvTurn',
      suppressAnalysisCardsForTravelEnvTurn,
    );
    const selectAssistantTemplate = requireFunction('selectTemplate', selectTemplate);
    const renderAssistantTemplate = requireFunction('renderAssistantMessage', renderAssistantMessage);
    const recordAppliedTemplate = requireFunction('recordTemplateApplied', recordTemplateApplied);
    const recordFallbackTemplate = requireFunction('recordTemplateFallback', recordTemplateFallback);
    const adaptSuggestedChips = requireFunction('adaptChips', adaptChips);
    const looksStall = requireFunction('looksLikeStallPhrase', looksLikeStallPhrase);
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const makeAssistantMessage = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);

    let nextFieldMissing = Array.isArray(fieldMissing) ? fieldMissing.slice() : [];
    const structured = getStructured(upstream);
    const structuredBlocked = Boolean(structured) && !allowRecs && containsCommerceFields(structured);
    if (structuredBlocked) {
      nextFieldMissing.push({ field: 'aurora_structured', reason: 'recommendations_not_requested' });
    }

    const structuredWithExternalVerification = mergeExternalVerification(structured, contextRaw);
    const structuredForEnvelope =
      structuredWithExternalVerification && !debugUpstream
        ? stripInternalRefs(structuredWithExternalVerification)
        : structuredWithExternalVerification;
    const structuredCitations = Array.isArray(structuredForEnvelope?.external_verification?.citations)
      ? structuredForEnvelope.external_verification.citations
      : [];
    const structuredIsRenderable = Boolean(structuredForEnvelope && !structuredBlocked && structuredCitations.length > 0);

    const uiDebug = Boolean(debugUpstream);
    const nextDerivedCards = Array.isArray(derivedCards) ? derivedCards.slice() : [];
    const nextCards = Array.isArray(cards) ? cards.slice() : [];
    const hasRenderableCards =
      structuredIsRenderable ||
      nextDerivedCards.some((card) => isRenderableCard(card, { debug: uiDebug })) ||
      nextCards.some((card) => isRenderableCard(card, { debug: uiDebug }));

    let safeAnswer = sanitizeAnswer(answer, {
      language: ctx && ctx.lang,
      hasRenderableCards,
      stripInternalRefs: true,
    });

    const routeCards = [...nextDerivedCards, ...nextCards];
    const routeHintFromCards = inferRouteCards(routeCards);
    const routeHintFromMessage = routeHintFromCards
      ? null
      : inferRouteMessage(responseIntentMessage, { allowRecoCards: allowRecs });
    const routeHint = resolveHint(routeHintFromCards, routeHintFromMessage);
    if (routeHint && routeHint.route) {
      const routeStructured = buildRouteAwareText({
        route: routeHint.route,
        payload: routeHint.payload,
        language: ctx && ctx.lang,
        profile,
      });
      const shouldUpgrade =
        looksGenericNotice(safeAnswer) ||
        !isStructuredAnswer(safeAnswer, routeHint.route);
      if (shouldUpgrade && routeStructured) safeAnswer = routeStructured;
    }

    safeAnswer = addEmotionalPreamble(safeAnswer, {
      language: ctx && ctx.lang,
      profile,
      seed: ctx && ctx.request_id,
    });

    const cardsForEnvelopeRaw = !debugUpstream ? stripInternalRefs(nextCards) : nextCards;
    const cardsForEnvelope = Array.isArray(cardsForEnvelopeRaw)
      ? cardsForEnvelopeRaw.map((card) => {
        if (!card || typeof card !== 'object' || Array.isArray(card)) return card;
        const type = String(card.type || '').trim().toLowerCase();
        if (type !== 'product_analysis') return card;
        const payload = finalizeProductAnalysis(card.payload, {
          logger,
          requestId: ctx && ctx.request_id,
          mode: 'main_path',
        });
        return { ...card, payload };
      })
      : cardsForEnvelopeRaw;

    const shouldEchoProfile = Boolean(profileSummary) && (Boolean(appliedProfilePatch) || !profilePatchFromSession);
    const sessionPatch = {};
    if (nextStateOverride && isStateChangeAllowed(ctx && ctx.trigger_source)) {
      sessionPatch.next_state = nextStateOverride;
    }
    if (shouldEchoProfile) {
      sessionPatch.profile = profileSummary;
      recordProfileEcho({ changed: Boolean(appliedProfilePatch) });
    }
    if (pendingClarificationPatchOverride !== undefined) {
      emitPendingClarification(sessionPatch, pendingClarificationPatchOverride);
    } else if (pendingClarificationFromUpstream) {
      emitPendingClarification(sessionPatch, pendingClarificationFromUpstream);
    }
    if (hasLlmRouteMeta) {
      sessionPatch.llm = llmRouteMeta;
    }

    const mappedContextCard = Array.isArray(contextCard)
      ? contextCard.map((card) =>
        card && card.type === 'aurora_context_raw'
          ? {
              ...card,
              payload: {
                ...(card.payload && typeof card.payload === 'object' ? card.payload : {}),
                clarification,
              },
            }
          : card,
      )
      : [];

    const assembledCards = [
      ...(structuredForEnvelope && !structuredBlocked
        ? [
            {
              card_id: `structured_${ctx.request_id}`,
              type: 'aurora_structured',
              payload: structuredForEnvelope,
            },
          ]
        : []),
      ...nextDerivedCards,
      ...(Array.isArray(cardsForEnvelope)
        ? cardsForEnvelope.map((card, idx) => ({
            card_id: card.card_id || `aurora_${ctx.request_id}_${idx}`,
            type: card.type || 'aurora_card',
            title: card.title,
            payload: card.payload || card,
            ...(Array.isArray(card.field_missing) ? { field_missing: card.field_missing } : {}),
          }))
        : []),
      ...mappedContextCard,
      ...(nextFieldMissing.length
        ? [{ card_id: `gate_${ctx.request_id}`, type: 'gate_notice', payload: {}, field_missing: nextFieldMissing }]
        : []),
    ];

    const routineLikeContext =
      String(canonicalIntent && canonicalIntent.intent ? canonicalIntent.intent : '').trim().toLowerCase() === 'routine' ||
      looksRoutine(message, normalizedActionPayload) ||
      hasRoutineSignal(message);

    let catalogPoisonBlockedByGuard = 0;
    if (AURORA_CATALOG_DOMAIN_GUARD_V1_ENABLED && routineLikeContext) {
      const filteredCards = [];
      let blockedCount = 0;
      for (const card of assembledCards) {
        if (isSkincareCard(card)) {
          filteredCards.push(card);
          continue;
        }
        blockedCount += 1;
      }
      if (blockedCount > 0) {
        catalogPoisonBlockedByGuard = blockedCount;
        recordCatalogPoisonBlock(blockedCount);
        assembledCards.length = 0;
        assembledCards.push(...filteredCards);
      }
    }

    const assembledRenderable = assembledCards.some((card) => isRenderableCard(card, { debug: uiDebug }));
    const existingRoutineExpert = findRoutineExpert({ cards: assembledCards });
    const needsRoutineFallbackModules = !hasRoutineModules(existingRoutineExpert);
    const stallLikeResponse = looksStall(safeAnswer) || looksGenericNotice(safeAnswer);
    if (routineLikeContext && needsRoutineFallbackModules && (!assembledRenderable || stallLikeResponse)) {
      const fallbackCards = buildRoutineFallbackCards({
        ctx,
        message,
        profile,
        recentLogs,
        language: ctx && ctx.lang,
        reason: stallLikeResponse ? 'default' : 'timeout_degraded',
      });
      assembledCards.unshift(...fallbackCards);
      safeAnswer =
        ctx && ctx.lang === 'CN'
          ? '我已切换到规则兜底并给出可执行的结构化 routine（见下方）。你可以继续补充信息，我会逐轮优化。'
          : 'I switched to a rules-based fallback and produced an actionable structured routine below. You can add details and I will iteratively optimize.';
    }

    const travelSuppressedCards = suppressTravelCards(assembledCards, {
      canonicalIntent: canonicalIntent && canonicalIntent.intent,
    });
    if (travelSuppressedCards.length !== assembledCards.length) {
      assembledCards.length = 0;
      assembledCards.push(...travelSuppressedCards);
    }

    const pendingForTemplate =
      pendingClarificationPatchOverride !== undefined
        ? pendingClarificationPatchOverride
        : pendingClarificationFromUpstream || null;
    const pendingCurrentNormId =
      pendingForTemplate &&
      typeof pendingForTemplate === 'object' &&
      pendingForTemplate.current &&
      typeof pendingForTemplate.current === 'object'
        ? String(
            pendingForTemplate.current.norm_id ||
              pendingForTemplate.current.normId ||
              pendingForTemplate.current.id ||
              '',
          ).trim()
        : '';

    const templateDecision = selectAssistantTemplate({
      language: ctx && ctx.lang,
      intent: routeHint && routeHint.route === 'env' ? 'weather_env' : null,
      cards: assembledCards,
      session_patch: sessionPatch,
      pending_clarification: pendingForTemplate,
    });
    const templateRendered = renderAssistantTemplate(templateDecision, {
      language: ctx && ctx.lang,
      assistant_message: { role: 'assistant', content: safeAnswer, format: 'markdown' },
      cards: assembledCards,
      session_patch: sessionPatch,
      pending_clarification: pendingForTemplate,
    });
    if (templateRendered && templateRendered.applied) {
      recordAppliedTemplate({
        templateId: templateDecision && templateDecision.id,
        moduleName: templateDecision && templateDecision.module,
        variant: templateDecision && templateDecision.variant,
        source: 'chat',
      });
    } else {
      recordFallbackTemplate({
        reason: templateRendered && templateRendered.reason ? templateRendered.reason : 'keep_existing',
        moduleName: templateDecision && templateDecision.module,
      });
    }

    const adaptedChips = adaptSuggestedChips({
      existingChips: suggestedChips,
      maxChips: 10,
      currentNormId: pendingCurrentNormId || null,
    });
    const finalAssistantText =
      templateRendered && typeof templateRendered.content === 'string' && templateRendered.content.trim()
        ? templateRendered.content
        : safeAnswer;
    const finalAssistantFormat = templateRendered && templateRendered.format === 'text' ? 'text' : 'markdown';

    return buildEnvelopeFn(ctx, {
      assistant_message: makeAssistantMessage(finalAssistantText, finalAssistantFormat),
      suggested_chips: adaptedChips.chips,
      cards: assembledCards,
      session_patch: sessionPatch,
      events: [
        makeEventFn(ctx, 'value_moment', { kind: 'chat_reply' }),
        ...(hasLlmRouteMeta ? [makeEventFn(ctx, 'llm_route', llmRouteMeta)] : []),
        ...(allowRecs ? [makeEventFn(ctx, 'recos_requested', { explicit: true })] : []),
        ...(heatmapImpressionEvent ? [heatmapImpressionEvent] : []),
        ...(catalogPoisonBlockedByGuard > 0
          ? [makeEventFn(ctx, 'catalog_poison_block', { blocked_count: catalogPoisonBlockedByGuard })]
          : []),
      ],
    });
  }

  return {
    buildUpstreamEnvelope,
  };
}

module.exports = {
  createChatUpstreamEnvelopeRuntime,
};
