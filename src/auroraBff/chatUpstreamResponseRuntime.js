function defaultMergeFieldMissing(existing, incoming) {
  const base = Array.isArray(existing) ? existing.slice() : [];
  const next = Array.isArray(incoming) ? incoming : [];
  if (next.length === 0) return base;

  const seen = new Set(
    base.map((item) => {
      const field = item && typeof item === 'object' ? String(item.field || '') : '';
      const reason = item && typeof item === 'object' ? String(item.reason || '') : '';
      return `${field}::${reason}`;
    }),
  );

  for (const item of next) {
    const field = item && typeof item === 'object' ? String(item.field || '') : '';
    const reason = item && typeof item === 'object' ? String(item.reason || '') : '';
    const key = `${field}::${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    base.push(item);
  }
  return base;
}

function createChatUpstreamResponseRuntime(options = {}) {
  const {
    logger = null,
    stripRecommendationCards = (cards) => cards,
    enrichRecommendationsWithAlternatives,
    mergeFieldMissing = defaultMergeFieldMissing,
    chatClarificationRuntime,
    chatDerivedCardsRuntime,
    chatUpstreamEnvelopeRuntime,
    AURORA_CHAT_CLARIFICATION_FILTER_KNOWN_ENABLED = false,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat upstream response runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function buildUpstreamResponseEnvelope(args = {}) {
    const {
      upstream = null,
      allowRecs = false,
      includeAlternatives = false,
      debugUpstream = false,
      ctx,
      profileSummary = null,
      recentLogs = [],
      answer = '',
      message = '',
      upstreamMessage = '',
      actionId = '',
      canonicalIntent = null,
      profile = null,
      req,
      anchorProductUrl = '',
      anchorProductId = '',
      llmProvider = '',
      llmModel = '',
      normalizedActionPayload = null,
      appliedProfilePatch = null,
      profilePatchFromSession = null,
      nextStateOverride = null,
      pendingClarificationPatchOverride,
      hasLlmRouteMeta = false,
      llmRouteMeta = null,
      heatmapImpressionEvent = null,
      makeChatAssistantMessage,
    } = args;

    const stripRecommendationCardsFn = requireFunction('stripRecommendationCards', stripRecommendationCards);
    const enrichRecommendationsWithAlternativesFn = requireFunction(
      'enrichRecommendationsWithAlternatives',
      enrichRecommendationsWithAlternatives,
    );
    const mergeFieldMissingFn = requireFunction('mergeFieldMissing', mergeFieldMissing);
    const deriveUpstreamClarification = requireMethod(
      chatClarificationRuntime,
      'chatClarificationRuntime',
      'deriveUpstreamClarification',
    );
    const prepareUpstreamDerivedCards = requireMethod(
      chatDerivedCardsRuntime,
      'chatDerivedCardsRuntime',
      'prepareUpstreamDerivedCards',
    );
    const buildUpstreamEnvelope = requireMethod(
      chatUpstreamEnvelopeRuntime,
      'chatUpstreamEnvelopeRuntime',
      'buildUpstreamEnvelope',
    );

    const rawCards = upstream && Array.isArray(upstream.cards) ? upstream.cards : [];
    let cards = allowRecs ? rawCards : stripRecommendationCardsFn(rawCards);
    let fieldMissing = [];

    if (!allowRecs && rawCards.length !== cards.length) {
      fieldMissing.push({ field: 'cards', reason: 'recommendations_not_requested' });
    }

    if (allowRecs && includeAlternatives && Array.isArray(cards) && cards.length) {
      const recoIdx = cards.findIndex((card) => {
        if (!card || typeof card !== 'object') return false;
        const type = typeof card.type === 'string' ? card.type.trim().toLowerCase() : '';
        if (type !== 'recommendations') return false;
        const payload = card.payload && typeof card.payload === 'object' ? card.payload : null;
        return Boolean(payload && Array.isArray(payload.recommendations));
      });

      if (recoIdx !== -1) {
        const card = cards[recoIdx];
        const basePayload = card.payload && typeof card.payload === 'object' ? card.payload : {};
        const alt = await enrichRecommendationsWithAlternativesFn({
          ctx,
          profileSummary,
          recentLogs,
          recommendations: basePayload.recommendations,
          logger,
        });
        const nextCard = {
          ...card,
          payload: { ...basePayload, recommendations: alt.recommendations },
          field_missing: mergeFieldMissingFn(card.field_missing, alt.field_missing),
        };
        cards = cards.map((entry, index) => (index === recoIdx ? nextCard : entry));
      }
    }

    const {
      clarification,
      pendingClarificationFromUpstream,
      suggestedChips,
    } = deriveUpstreamClarification({
      upstream,
      profileSummary,
      filterKnown: AURORA_CHAT_CLARIFICATION_FILTER_KNOWN_ENABLED,
      upstreamMessage,
      message,
    });

    const derivedCardResult = await prepareUpstreamDerivedCards({
      upstream,
      cards,
      fieldMissing,
      ctx,
      message,
      upstreamMessage,
      actionId,
      canonicalIntent,
      debugUpstream,
      profile,
      profileSummary,
      recentLogs,
      req,
      anchorProductUrl,
      anchorProductId,
      llmProvider,
      llmModel,
    });

    return buildUpstreamEnvelope({
      ctx,
      upstream,
      allowRecs,
      debugUpstream,
      answer,
      derivedCards: derivedCardResult.derivedCards,
      cards: derivedCardResult.cards,
      fieldMissing: derivedCardResult.fieldMissing,
      contextRaw: derivedCardResult.contextRaw,
      contextCard: derivedCardResult.contextCard,
      clarification,
      responseIntentMessage: upstreamMessage || message,
      message,
      normalizedActionPayload,
      profile,
      recentLogs,
      profileSummary,
      appliedProfilePatch,
      profilePatchFromSession,
      nextStateOverride,
      pendingClarificationPatchOverride,
      pendingClarificationFromUpstream,
      hasLlmRouteMeta,
      llmRouteMeta,
      canonicalIntent,
      heatmapImpressionEvent: derivedCardResult.heatmapImpressionEvent,
      suggestedChips,
      makeChatAssistantMessage,
    });
  }

  return {
    buildUpstreamResponseEnvelope,
  };
}

module.exports = {
  createChatUpstreamResponseRuntime,
};
