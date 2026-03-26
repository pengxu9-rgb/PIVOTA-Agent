function defaultIsPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function createChatEnvelopeMetaRuntime(options = {}) {
  const {
    summarizeProfileForContext,
    resolvePreferredLegacyTravelPlan,
    BLOCK_LEVEL = { INFO: 'info' },
    isPlainObject = defaultIsPlainObject,
    normalizeRecoSourceDetail = (value) => value,
    pickFirstTrimmed = (...values) => values.find((value) => String(value || '').trim()) || null,
    recordAuroraRecoContextUsed = () => {},
    makeEvent,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat envelope meta runtime missing dependency: ${name}`);
  }

  function summarizeChatProfileForContext({ profileValue, effectiveChatFlags } = {}) {
    const summarizeProfileForContextFn = requireFunction('summarizeProfileForContext', summarizeProfileForContext);
    return summarizeProfileForContextFn(profileValue, {
      profileV2Enabled: Boolean(effectiveChatFlags && effectiveChatFlags.profile_v2),
    });
  }

  function hasAnyLlmRouteMeta(meta) {
    return Boolean(
      meta &&
        typeof meta === 'object' &&
        (
          meta.llm_provider_requested ||
          meta.llm_model_requested ||
          meta.llm_provider_effective ||
          meta.llm_model_effective
        ),
    );
  }

  function hasRecommendationCards(cards) {
    return Array.isArray(cards) &&
      cards.some((card) => String(card && card.type ? card.type : '').trim().toLowerCase() === 'recommendations');
  }

  function hasRecosRequestedEvent(events) {
    return Array.isArray(events) &&
      events.some((evt) => evt && typeof evt === 'object' && String(evt.event_name || '').trim() === 'recos_requested');
  }

  function inferRecommendationSourceMode(envelope) {
    if (!envelope || typeof envelope !== 'object') return null;
    const cards = Array.isArray(envelope.cards) ? envelope.cards : [];
    for (const card of cards) {
      if (!card || typeof card !== 'object') continue;
      if (String(card.type || '').trim().toLowerCase() !== 'recommendations') continue;
      const payload = isPlainObject(card.payload) ? card.payload : {};
      const source = String(payload.source || '').trim().toLowerCase();
      if (source.includes('llm_primary')) return 'llm_primary';
      if (source === 'llm' || source.startsWith('llm_')) return 'llm_primary';
      if (source.includes('catalog_grounded')) return 'catalog_grounded';
      if (source.includes('catalog_transient_fallback')) return 'catalog_transient_fallback';
      if (source.includes('artifact_matcher')) return 'artifact_matcher';
      if (source.includes('upstream')) return 'upstream_fallback';
    }

    const events = Array.isArray(envelope.events) ? envelope.events : [];
    for (const evt of events) {
      if (!evt || typeof evt !== 'object') continue;
      if (String(evt.event_name || '').trim() !== 'recos_requested') continue;
      const data = isPlainObject(evt.data) ? evt.data : {};
      const source = String(data.source || '').trim().toLowerCase();
      if (source.includes('llm_primary')) return 'llm_primary';
      if (source === 'llm' || source.startsWith('llm_')) return 'llm_primary';
      if (source.includes('catalog_grounded')) return 'catalog_grounded';
      if (source.includes('catalog_transient_fallback')) return 'catalog_transient_fallback';
      if (source.includes('artifact_matcher')) return 'artifact_matcher';
      if (source.includes('upstream')) return 'upstream_fallback';
    }

    if (hasRecommendationCards(cards)) return 'catalog_grounded';
    if (hasRecosRequestedEvent(events)) return 'rules_only';
    return null;
  }

  function hasItineraryContext(profileValue) {
    if (!isPlainObject(profileValue)) return false;
    const itinerary = String(profileValue.itinerary || '').trim();
    if (itinerary) return true;
    const resolvePreferredLegacyTravelPlanFn = requireFunction(
      'resolvePreferredLegacyTravelPlan',
      resolvePreferredLegacyTravelPlan,
    );
    const travelPlan = resolvePreferredLegacyTravelPlanFn(profileValue);
    if (!travelPlan) return false;
    return Boolean(
      String(travelPlan.destination || '').trim() ||
      String(travelPlan.start_date || '').trim() ||
      String(travelPlan.end_date || '').trim(),
    );
  }

  function hasSafetyFlags(safetyValue) {
    if (!isPlainObject(safetyValue)) return false;
    if (safetyValue.block_level && safetyValue.block_level !== BLOCK_LEVEL.INFO) return true;
    if (Array.isArray(safetyValue.reasons) && safetyValue.reasons.length > 0) return true;
    return false;
  }

  function applyRecommendationMetaToEnvelope({
    envelope,
    recentLogs,
    profile,
    safetyDecision,
    recoContextMetricsEmitted = false,
  } = {}) {
    if (!envelope || typeof envelope !== 'object') {
      return { envelope, recoContextMetricsEmitted };
    }

    const sourceMode = inferRecommendationSourceMode(envelope);
    if (!sourceMode) {
      return { envelope, recoContextMetricsEmitted };
    }

    const existingCardMeta = (() => {
      const cards = Array.isArray(envelope.cards) ? envelope.cards : [];
      for (const card of cards) {
        if (!card || typeof card !== 'object') continue;
        if (String(card.type || '').trim().toLowerCase() !== 'recommendations') continue;
        const payload = isPlainObject(card.payload) ? card.payload : {};
        return isPlainObject(payload.recommendation_meta) ? payload.recommendation_meta : null;
      }
      return null;
    })();

    const recommendationMeta = {
      ...(isPlainObject(existingCardMeta) ? existingCardMeta : {}),
      source_mode: sourceMode,
      trigger_source: normalizeRecoSourceDetail(
        pickFirstTrimmed(
          existingCardMeta && existingCardMeta.trigger_source,
          existingCardMeta && existingCardMeta.triggerSource,
        ),
      ),
      recompute_from_profile_update:
        existingCardMeta && (existingCardMeta.recompute_from_profile_update === true || existingCardMeta.recomputeFromProfileUpdate === true),
      used_recent_logs: Array.isArray(recentLogs) && recentLogs.length > 0,
      used_itinerary: hasItineraryContext(profile),
      used_safety_flags: hasSafetyFlags(safetyDecision),
    };

    let nextRecoContextMetricsEmitted = Boolean(recoContextMetricsEmitted);
    if (!nextRecoContextMetricsEmitted) {
      if (recommendationMeta.used_recent_logs) recordAuroraRecoContextUsed({ signal: 'recent_logs' });
      if (recommendationMeta.used_itinerary) recordAuroraRecoContextUsed({ signal: 'itinerary' });
      if (recommendationMeta.used_safety_flags) recordAuroraRecoContextUsed({ signal: 'safety' });
      nextRecoContextMetricsEmitted = true;
    }

    const out = { ...envelope, recommendation_meta: recommendationMeta };
    if (Array.isArray(envelope.cards)) {
      out.cards = envelope.cards.map((card) => {
        if (!card || typeof card !== 'object') return card;
        if (String(card.type || '').trim().toLowerCase() !== 'recommendations') return card;
        const payload = isPlainObject(card.payload) ? card.payload : {};
        return {
          ...card,
          payload: { ...payload, recommendation_meta: recommendationMeta },
        };
      });
    }

    return {
      envelope: out,
      recoContextMetricsEmitted: nextRecoContextMetricsEmitted,
    };
  }

  function applyLlmMetaToEnvelope({ envelope, llmRouteMetaForResponse, ctx } = {}) {
    if (!hasAnyLlmRouteMeta(llmRouteMetaForResponse)) return envelope;
    if (!envelope || typeof envelope !== 'object') return envelope;

    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const out = { ...envelope };
    const baseSessionPatch = isPlainObject(out.session_patch) ? { ...out.session_patch } : {};
    if (!isPlainObject(baseSessionPatch.llm)) {
      baseSessionPatch.llm = llmRouteMetaForResponse;
    }
    out.session_patch = baseSessionPatch;

    const events = Array.isArray(out.events) ? out.events.slice() : [];
    const hasRouteEvent = events.some((evt) => evt && typeof evt === 'object' && evt.event_name === 'llm_route');
    if (!hasRouteEvent) {
      events.push(makeEventFn(ctx, 'llm_route', llmRouteMetaForResponse));
    }
    out.events = events;
    return out;
  }

  function applyPendingPregnancyPolicyEventsToEnvelope({ envelope, pendingPregnancyPolicyEvents } = {}) {
    const base = envelope && typeof envelope === 'object' && !Array.isArray(envelope)
      ? { ...envelope }
      : { assistant_message: null, suggested_chips: [], cards: [], session_patch: {}, events: [] };
    if (!Array.isArray(pendingPregnancyPolicyEvents) || pendingPregnancyPolicyEvents.length === 0) return base;

    const events = Array.isArray(base.events) ? base.events.slice(0, 96) : [];
    const existing = new Set(
      events
        .map((evt) => String(evt && evt.event_name ? evt.event_name : '').trim())
        .filter(Boolean),
    );
    let hasDefaulted = false;
    let hasAutoReset = false;
    for (const evt of pendingPregnancyPolicyEvents) {
      if (!evt || typeof evt !== 'object') continue;
      const name = String(evt.event_name || '').trim();
      if (!name || existing.has(name)) continue;
      existing.add(name);
      events.push(evt);
      if (name === 'pregnancy_status_defaulted') hasDefaulted = true;
      if (name === 'pregnancy_status_auto_reset') hasAutoReset = true;
    }
    base.events = events.slice(0, 96);

    if (hasDefaulted || hasAutoReset) {
      const sessionPatch = isPlainObject(base.session_patch) ? { ...base.session_patch } : {};
      const meta = isPlainObject(sessionPatch.meta) ? { ...sessionPatch.meta } : {};
      if (hasDefaulted) meta.pregnancy_status_defaulted = true;
      if (hasAutoReset) meta.pregnancy_status_auto_reset = true;
      sessionPatch.meta = meta;
      base.session_patch = sessionPatch;
    }

    return base;
  }

  return {
    summarizeChatProfileForContext,
    applyRecommendationMetaToEnvelope,
    applyLlmMetaToEnvelope,
    applyPendingPregnancyPolicyEventsToEnvelope,
  };
}

module.exports = {
  createChatEnvelopeMetaRuntime,
};
