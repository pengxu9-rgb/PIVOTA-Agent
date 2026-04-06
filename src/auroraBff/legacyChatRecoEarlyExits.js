function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function createLegacyChatRecoEarlyExitsRuntime(deps = {}) {
  const {
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
    buildConfidenceNoticeCardPayload,
    summarizeProfileForContext,
    appendLatestRecoContextToSessionPatch,
  } = deps;

  function buildLegacyRecoSafetyGateEnvelope({
    ctx,
    assistantText = '',
    cardId = '',
    payload = null,
    eventName = '',
    eventData = null,
    suggestedChips = [],
  } = {}) {
    return buildEnvelope(ctx, {
      assistant_message: makeAssistantMessage(assistantText),
      suggested_chips: Array.isArray(suggestedChips) ? suggestedChips : [],
      cards: cardId && payload ? [{ card_id: cardId, type: 'confidence_notice', payload }] : [],
      session_patch: {},
      events: eventName ? [makeEvent(ctx, eventName, eventData || {})] : [],
    });
  }

  function maybeBuildLegacyTravelRecoEnvelope({
    ctx,
    travelRecoHandoff = false,
    travelSkillsContracts = null,
    travelRecoContext = null,
    profile = null,
    recoTaskMode = 'goal_based_products',
    recentLogs = [],
    recoEntrySourceDetail = '',
    actionId = '',
    recoRequestMessage = '',
    includeAlternatives = false,
    refinementChips = [],
  } = {}) {
    if (!travelRecoHandoff) return null;
    const buildTravelRecoPreview =
      travelSkillsContracts &&
      travelSkillsContracts.__internal &&
      typeof travelSkillsContracts.__internal.buildRecoPreview === 'function'
        ? travelSkillsContracts.__internal.buildRecoPreview
        : null;
    const travelReadiness = isPlainObject(travelRecoContext?.travel_readiness)
      ? { ...travelRecoContext.travel_readiness }
      : null;
    const sessionPatch = {};
    appendLatestRecoContextToSessionPatch(sessionPatch, {
      intent: 'reco_products',
      source_detail: recoEntrySourceDetail,
      trigger_source: 'travel_handoff',
      action_id: actionId || '',
      message: recoRequestMessage,
      include_alternatives: includeAlternatives === true,
      goal: 'travel_protective_products',
    });
    if (!travelReadiness || !buildTravelRecoPreview) {
      const destinationText = travelRecoContext?.destination || null;
      return buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          ctx.lang === 'CN'
            ? (destinationText
              ? `我还缺少 ${destinationText} 这次行程的旅行护肤准备上下文，请先回到旅行建议卡片再点一次“查看完整推荐”。`
              : '我还缺少这次行程的旅行护肤准备上下文，请先回到旅行建议卡片再点一次“查看完整推荐”。')
            : (destinationText
              ? `I still need the travel-readiness context for ${destinationText}. Return to the travel card and open full recommendations again.`
              : 'I still need the travel-readiness context for this trip. Return to the travel card and open full recommendations again.'),
        ),
        suggested_chips: refinementChips,
        cards: [
          {
            card_id: `conf_${ctx.request_id}`,
            type: 'confidence_notice',
            payload: buildConfidenceNoticeCardPayload({
              language: ctx.lang,
              reason: 'travel_context_missing',
              confidence: { score: 0.2, level: 'low', rationale: ['travel_reco_context_missing'] },
              actions: ['return_to_travel_card', 'retry_recommendations'],
              details: ['travel_handoff_requires_last_travel_readiness'],
            }),
          },
        ],
        session_patch: sessionPatch,
        events: [
          makeEvent(ctx, 'recos_requested', {
            explicit: true,
            gated: true,
            reason: 'travel_context_missing',
            source: 'travel_handoff',
            source_detail: 'travel_handoff',
          }),
        ],
      });
    }

    const travelPreview = buildTravelRecoPreview({
      travelReadiness,
      profile,
      language: ctx.lang,
    });
    const travelRecommendations = Array.isArray(travelPreview?.recommendations)
      ? travelPreview.recommendations.slice(0, 8)
      : [];
    if (!travelRecommendations.length) {
      return buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          ctx.lang === 'CN'
            ? '我拿到了旅行上下文，但这轮没有形成可展示的旅行护肤候选。请回到旅行卡片补充目的地条件，或稍后重试。'
            : 'I have the trip context, but this round did not yield a displayable travel-skincare shortlist. Add more trip conditions in the travel card or retry shortly.',
        ),
        suggested_chips: refinementChips,
        cards: [
          {
            card_id: `conf_${ctx.request_id}`,
            type: 'confidence_notice',
            payload: buildConfidenceNoticeCardPayload({
              language: ctx.lang,
              reason: 'travel_reco_empty',
              confidence: { score: 0.28, level: 'low', rationale: ['travel_reco_preview_empty'] },
              actions: ['retry_recommendations', 'return_to_travel_card'],
              details: ['travel_handoff_no_supported_products'],
            }),
          },
        ],
        session_patch: sessionPatch,
        events: [
          makeEvent(ctx, 'recos_requested', {
            explicit: true,
            gated: true,
            reason: 'travel_reco_empty',
            source: 'travel_handoff',
            source_detail: 'travel_handoff',
          }),
        ],
      });
    }

    const travelConfidenceScore = Number(travelPreview?.confidence?.score);
    const travelConfidenceLevel = pickFirstTrimmed(
      travelPreview?.confidence?.level,
      travelReadiness?.confidence?.level,
      'medium',
    );
    const payload = {
      intent: 'reco_products',
      profile: summarizeProfileForContext(profile),
      recommendations: travelRecommendations,
      source: 'travel_reco_preview_v1',
      recommendation_confidence_score: Number.isFinite(travelConfidenceScore) ? travelConfidenceScore : 0.62,
      recommendation_confidence_level: travelConfidenceLevel || 'medium',
      task_mode: recoTaskMode,
      recommendation_meta: {
        task_mode: recoTaskMode,
        source_mode: 'travel_handoff',
        trigger_source: 'travel_handoff',
        handoff_source: 'travel_readiness',
        used_recent_logs: Array.isArray(recentLogs) && recentLogs.length > 0,
        used_itinerary: true,
        used_safety_flags: false,
        env_source: pickFirstTrimmed(
          travelReadiness.env_source,
          travelRecoContext?.travel_readiness?.env_source,
        ) || null,
        destination: travelRecoContext?.destination || null,
        start_date: travelRecoContext?.start_date || null,
        end_date: travelRecoContext?.end_date || null,
      },
      metadata: {
        travel_handoff: true,
      },
    };
    return buildEnvelope(ctx, {
      assistant_message: makeAssistantMessage(
        ctx.lang === 'CN'
          ? '我按这次旅行环境把候选收紧到防晒、清洁和修护保湿这条主线，优先给你可随行、低跑偏的护肤推荐。'
          : 'I narrowed this shortlist to travel-relevant sunscreen, cleansing, and barrier-repair products for this trip.',
      ),
      suggested_chips: refinementChips,
      cards: [
        {
          card_id: `reco_${ctx.request_id}`,
          type: 'recommendations',
          payload,
        },
      ],
      session_patch: sessionPatch,
      events: [
        makeEvent(ctx, 'recos_requested', {
          explicit: true,
          source: 'travel_handoff',
          source_detail: 'travel_handoff',
        }),
      ],
    });
  }

  return {
    buildLegacyRecoSafetyGateEnvelope,
    maybeBuildLegacyTravelRecoEnvelope,
  };
}

module.exports = {
  createLegacyChatRecoEarlyExitsRuntime,
};
