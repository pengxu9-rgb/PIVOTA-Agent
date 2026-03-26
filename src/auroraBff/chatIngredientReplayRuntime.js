function createChatIngredientReplayRuntime(deps = {}) {
  const {
    logger,
    pickFirstTrimmed = (...values) => {
      for (const raw of values) {
        const value = String(raw || '').trim();
        if (value) return value;
      }
      return '';
    },
    recordAuroraIngredientsFlowMetric = () => {},
    INGREDIENT_ROUTE_RULE_VERSION = null,
  } = deps;

  const isPlainObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

  const isIngredientAnswerCardType = (type) => {
    const token = String(type || '').trim().toLowerCase();
    return (
      token === 'ingredient_hub' ||
      token === 'ingredient_goal_match' ||
      token === 'ingredient_plan' ||
      token === 'ingredient_plan_v2' ||
      token === 'aurora_ingredient_report'
    );
  };

  const sanitizeProviderAttempts = (rows) =>
    Array.isArray(rows)
      ? rows
        .map((row) => (isPlainObject(row) ? row : null))
        .filter(Boolean)
        .map((row) => ({
          provider: String(row.provider || '').slice(0, 32),
          outcome: String(row.outcome || '').slice(0, 48),
          reason_code: row.reason_code ? String(row.reason_code).slice(0, 64) : null,
        }))
        .slice(0, 3)
      : [];

  const processIngredientReplay = ({
    envelope,
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
  } = {}) => {
    const sessionPatchForReplay = isPlainObject(envelope && envelope.session_patch) ? envelope.session_patch : {};
    const sessionMetaForReplay = isPlainObject(sessionPatchForReplay.meta) ? sessionPatchForReplay.meta : {};
    const ingredientQueryFirstApplied = sessionMetaForReplay.ingredient_query_first_applied === true;
    const ingredientRouteSource = pickFirstTrimmed(
      sessionMetaForReplay.ingredient_route_source,
      ingredientReplayContext && ingredientReplayContext.route_source,
    );
    const ingredientNormalizedQuery = pickFirstTrimmed(
      sessionMetaForReplay.normalized_query,
      sessionMetaForReplay.ingredient_normalized_query,
    );
    const ingredientRouteDecisionReasons = Array.isArray(sessionMetaForReplay.route_decision_reasons)
      ? sessionMetaForReplay.route_decision_reasons.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 12)
      : [];
    const ingredientRouteRuleVersion = pickFirstTrimmed(
      sessionMetaForReplay.route_rule_version,
      INGREDIENT_ROUTE_RULE_VERSION,
    );

    const ingredientReportPayloadForReplay = Array.isArray(envelope && envelope.cards)
      ? (() => {
        const row = envelope.cards.find(
          (card) => card && String(card.type || '').trim().toLowerCase() === 'aurora_ingredient_report',
        );
        return isPlainObject(row && row.payload) ? row.payload : null;
      })()
      : null;

    const ingredientProviderFinal = pickFirstTrimmed(
      ingredientReportPayloadForReplay && ingredientReportPayloadForReplay.research_provider,
      ingredientReportPayloadForReplay && ingredientReportPayloadForReplay.provider,
    );
    const ingredientProviderAttempts = sanitizeProviderAttempts(
      ingredientReportPayloadForReplay && ingredientReportPayloadForReplay.research_attempts,
    );
    const ingredientProviderCircuitState = pickFirstTrimmed(
      ingredientReportPayloadForReplay && ingredientReportPayloadForReplay.provider_circuit_state,
      sessionMetaForReplay.provider_circuit_state,
    );
    const ingredientFallbackReason = pickFirstTrimmed(
      ingredientReportPayloadForReplay && ingredientReportPayloadForReplay.research_error_code,
      sessionMetaForReplay.fallback_reason,
    );

    const hasIngredientAnswerCard = (Array.isArray(legacyCardTypes) ? legacyCardTypes : []).some(isIngredientAnswerCardType);
    const chatCardsTypes = Array.isArray(chatCardsResponse && chatCardsResponse.cards)
      ? chatCardsResponse.cards
        .map((card) => String(card && card.type ? card.type : '').trim().toLowerCase())
        .filter(Boolean)
      : [];
    const hasIngredientRenderableCard = chatCardsTypes.some(isIngredientAnswerCardType);

    const nextIngredientReplayContext = ingredientRouteSource
      ? { ...(ingredientReplayContext || {}), route_source: ingredientRouteSource }
      : ingredientReplayContext || {};

    const ingredientReplayRelevant = Boolean(
      nextIngredientReplayContext.intent_requested ||
      nextIngredientReplayContext.starter_action ||
      nextIngredientReplayContext.reco_optin ||
      ingredientQueryFirstApplied ||
      hasIngredientAnswerCard
    );

    if (ingredientReplayRelevant && hasIngredientAnswerCard) {
      recordAuroraIngredientsFlowMetric({ stage: 'answer_served', hit: true });
    }

    const unwantedDiagnosis = Boolean(
      ingredientReplayRelevant &&
      gateType === 'diagnosis_gate' &&
      !nextIngredientReplayContext.diagnosis_optin
    );
    if (unwantedDiagnosis) {
      recordAuroraIngredientsFlowMetric({ stage: 'unwanted_diagnosis', hit: true });
    }

    const ingredientCardRenderDrop = Boolean(
      ingredientReplayRelevant &&
      hasIngredientAnswerCard &&
      !hasIngredientRenderableCard
    );
    if (ingredientCardRenderDrop) {
      recordAuroraIngredientsFlowMetric({ stage: 'card_render_drop', hit: true });
    }

    const ingredientSafetyBlocked = Boolean(
      Array.isArray(envelope && envelope.events) &&
      envelope.events.some((evt) => String(evt && evt.event_name ? evt.event_name : '').trim() === 'safety_gate_block')
    );
    const ingredientTextRouteDrift = Boolean(
      ingredientQueryFirstApplied &&
      String(ingredientRouteSource || '').toLowerCase() === 'text' &&
      !nextIngredientReplayContext.diagnosis_optin &&
      !hasIngredientAnswerCard &&
      !ingredientSafetyBlocked
    );
    if (ingredientTextRouteDrift) {
      recordAuroraIngredientsFlowMetric({ stage: 'text_route_drift', hit: true });
    }

    const ingredientReplayLogNeeded = Boolean(
      ingredientReplayRelevant ||
      ingredientTextRouteDrift ||
      gateType === 'diagnosis_gate' ||
      gateType === 'budget_gate' ||
      String(actionIdForReplay || '').toLowerCase().includes('ingredient')
    );

    if (ingredientReplayLogNeeded) {
      logger?.info?.(
        {
          request_id: ctx && ctx.request_id ? ctx.request_id : null,
          trace_id: ctx && ctx.trace_id ? ctx.trace_id : null,
          entry: nextIngredientReplayContext.entry || null,
          action_id: actionIdForReplay || null,
          trigger_source: ctx && ctx.trigger_source ? ctx.trigger_source : null,
          intent_canonical:
            (policyMeta && policyMeta.intent_canonical) ||
            (canonicalIntentForResponse && canonicalIntentForResponse.intent) ||
            'unknown',
          gate: gateType,
          card_types: Array.isArray(legacyCardTypes) ? legacyCardTypes.slice(0, 12) : [],
          next_state: nextState,
          route_source: ingredientRouteSource || null,
          ingredient_query_first_applied: ingredientQueryFirstApplied,
          normalized_query: ingredientNormalizedQuery || null,
          route_rule_version: ingredientRouteRuleVersion || null,
          route_decision_reasons: ingredientRouteDecisionReasons,
          text_route_drift: ingredientTextRouteDrift,
          ingredient_card_render_drop: ingredientCardRenderDrop,
          provider_attempt: ingredientProviderAttempts,
          provider_final: ingredientProviderFinal || null,
          provider_circuit_state: ingredientProviderCircuitState || null,
          fallback_reason: ingredientFallbackReason || null,
          client_state: clientStateForReplay || null,
          agent_state: agentStateForReplay || null,
        },
        'aurora bff: ingredient replay route',
      );
    }

    return {
      ingredientReplayContext: nextIngredientReplayContext,
      ingredientReplayRelevant,
      ingredientQueryFirstApplied,
      ingredientRouteSource,
      ingredientTextRouteDrift,
      ingredientCardRenderDrop,
      unwantedDiagnosis,
      ingredientProviderFinal,
      ingredientProviderAttempts,
    };
  };

  return {
    isIngredientAnswerCardType,
    processIngredientReplay,
  };
}

module.exports = {
  createChatIngredientReplayRuntime,
};
