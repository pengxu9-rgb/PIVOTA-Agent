function createChatIngredientPreludeRuntime(options = {}) {
  const {
    isIngredientEntryAction,
    isIngredientLookupAction,
    isIngredientByGoalAction,
    isIngredientDiagnosisOptInAction,
    isIngredientResearchPollAction,
    isIngredientRecoOptInAction,
    extractIngredientLookupQuery,
    extractIngredientLookupTargetFromText,
    ingredientEntityMatchFromText,
    looksLikeProductEvaluationIntentV2,
    looksLikeRecommendationRequest,
    looksLikeSuitabilityRequest,
    extractIngredientGoalRequest,
    extractActionDataObject,
    normalizeIngredientRecoContextValue,
    mergeIngredientRecoContextValue,
    extractIngredientRecoContext,
    normalizeIngredientCandidateList,
    pickFirstTrimmed,
    normalizeIngredientActionId,
    recordAuroraIngredientsFlowMetric = () => {},
    buildIngredientLookupUpstreamPrompt,
    buildIngredientRecoUpstreamPrompt,
    looksLikeCompatibilityOrConflictQuestion,
    looksLikeRoutineRequest,
    normalizeAgentState,
    looksLikeDiagnosisStart,
    now = () => Date.now(),
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat ingredient prelude runtime missing dependency: ${name}`);
  }

  function pushUniqueReason(reasons, reason) {
    const token = String(reason || '').trim();
    if (!token) return;
    if (reasons.includes(token)) return;
    reasons.push(token);
  }

  async function prepareIngredientPrelude(args = {}) {
    const isIngredientEntryActionFn = requireFunction('isIngredientEntryAction', isIngredientEntryAction);
    const isIngredientLookupActionFn = requireFunction('isIngredientLookupAction', isIngredientLookupAction);
    const isIngredientByGoalActionFn = requireFunction('isIngredientByGoalAction', isIngredientByGoalAction);
    const isIngredientDiagnosisOptInActionFn = requireFunction(
      'isIngredientDiagnosisOptInAction',
      isIngredientDiagnosisOptInAction,
    );
    const isIngredientResearchPollActionFn = requireFunction(
      'isIngredientResearchPollAction',
      isIngredientResearchPollAction,
    );
    const isIngredientRecoOptInActionFn = requireFunction('isIngredientRecoOptInAction', isIngredientRecoOptInAction);
    const extractIngredientLookupQueryFn = requireFunction('extractIngredientLookupQuery', extractIngredientLookupQuery);
    const extractIngredientLookupTargetFromTextFn = requireFunction(
      'extractIngredientLookupTargetFromText',
      extractIngredientLookupTargetFromText,
    );
    const ingredientEntityMatchFromTextFn = requireFunction(
      'ingredientEntityMatchFromText',
      ingredientEntityMatchFromText,
    );
    const looksLikeProductEvaluationIntentV2Fn = requireFunction(
      'looksLikeProductEvaluationIntentV2',
      looksLikeProductEvaluationIntentV2,
    );
    const looksLikeRecommendationRequestFn = requireFunction(
      'looksLikeRecommendationRequest',
      looksLikeRecommendationRequest,
    );
    const looksLikeSuitabilityRequestFn = requireFunction('looksLikeSuitabilityRequest', looksLikeSuitabilityRequest);
    const extractIngredientGoalRequestFn = requireFunction('extractIngredientGoalRequest', extractIngredientGoalRequest);
    const extractActionDataObjectFn = requireFunction('extractActionDataObject', extractActionDataObject);
    const normalizeIngredientRecoContextValueFn = requireFunction(
      'normalizeIngredientRecoContextValue',
      normalizeIngredientRecoContextValue,
    );
    const mergeIngredientRecoContextValueFn = requireFunction(
      'mergeIngredientRecoContextValue',
      mergeIngredientRecoContextValue,
    );
    const extractIngredientRecoContextFn = requireFunction('extractIngredientRecoContext', extractIngredientRecoContext);
    const normalizeIngredientCandidateListFn = requireFunction(
      'normalizeIngredientCandidateList',
      normalizeIngredientCandidateList,
    );
    const pickFirstTrimmedFn = requireFunction('pickFirstTrimmed', pickFirstTrimmed);
    const normalizeIngredientActionIdFn = requireFunction('normalizeIngredientActionId', normalizeIngredientActionId);
    const buildIngredientLookupUpstreamPromptFn = requireFunction(
      'buildIngredientLookupUpstreamPrompt',
      buildIngredientLookupUpstreamPrompt,
    );
    const buildIngredientRecoUpstreamPromptFn = requireFunction(
      'buildIngredientRecoUpstreamPrompt',
      buildIngredientRecoUpstreamPrompt,
    );
    const looksLikeCompatibilityOrConflictQuestionFn = requireFunction(
      'looksLikeCompatibilityOrConflictQuestion',
      looksLikeCompatibilityOrConflictQuestion,
    );
    const looksLikeRoutineRequestFn = requireFunction('looksLikeRoutineRequest', looksLikeRoutineRequest);
    const normalizeAgentStateFn = requireFunction('normalizeAgentState', normalizeAgentState);
    const looksLikeDiagnosisStartFn = requireFunction('looksLikeDiagnosisStart', looksLikeDiagnosisStart);
    const nowFn = requireFunction('now', now);

    const {
      actionId = '',
      normalizedActionPayload = null,
      parsedData = {},
      message = '',
      ctx = {},
      canonicalIntent = {},
      INTENT_ENUM = {},
      requestedTransition = null,
      ingredientScienceIntent = false,
      upstreamMessage = '',
    } = args;

    const ingredientEntryRequested = isIngredientEntryActionFn(actionId);
    const ingredientLookupRequested = isIngredientLookupActionFn(actionId);
    const ingredientByGoalRequested = isIngredientByGoalActionFn(actionId);
    const ingredientDiagnosisOptInRequested = isIngredientDiagnosisOptInActionFn(actionId);
    const ingredientResearchPollRequested = isIngredientResearchPollActionFn(actionId);
    const ingredientRecoOptInRequested = isIngredientRecoOptInActionFn(actionId, normalizedActionPayload);

    const ingredientRouteDecisionReasons = [];
    if (ingredientEntryRequested) pushUniqueReason(ingredientRouteDecisionReasons, 'chip_entry_hit');
    if (ingredientLookupRequested) pushUniqueReason(ingredientRouteDecisionReasons, 'action_lookup');
    if (ingredientByGoalRequested) pushUniqueReason(ingredientRouteDecisionReasons, 'action_by_goal');
    if (ingredientDiagnosisOptInRequested) pushUniqueReason(ingredientRouteDecisionReasons, 'action_optin_diagnosis');
    if (ingredientResearchPollRequested) pushUniqueReason(ingredientRouteDecisionReasons, 'action_research_poll');

    const ingredientTextTrigger = ctx.trigger_source === 'text' || ctx.trigger_source === 'text_explicit';
    const ingredientLookupQuery = ingredientLookupRequested ? extractIngredientLookupQueryFn(normalizedActionPayload) : '';
    const ingredientTextMessage = String(message || '').trim();
    const ingredientLookupTargetFromText = ingredientTextTrigger
      ? await extractIngredientLookupTargetFromTextFn(message, ctx.lang)
      : '';
    const ingredientEntityMatch = ingredientTextTrigger
      ? ingredientEntityMatchFromTextFn(message, ctx.lang)
      : { normalized_query: '', entity_key: '', entity_match_type: 'none', entity_confidence: 0 };
    if (ingredientTextTrigger && ingredientEntityMatch.entity_match_type !== 'none') {
      pushUniqueReason(ingredientRouteDecisionReasons, `entity_${ingredientEntityMatch.entity_match_type}_match`);
    }

    const ingredientFallbackSuppressed = Boolean(
      looksLikeProductEvaluationIntentV2Fn(message, actionId) ||
        looksLikeRecommendationRequestFn(message) ||
        looksLikeSuitabilityRequestFn(message),
    );
    const ingredientQueryCue = Boolean(
      ingredientTextTrigger &&
        (
          /(成分(机理|机制|科学|证据|原理)?|证据链|循证|临床证据|论文证据|问成分|lookup|ingredient|ingredients|active|actives|inci|evidence|mechanism)/i.test(
            ingredientTextMessage,
          ) ||
          /(查|查询|了解|讲讲|科普).{0,12}(成分|ingredient|ingredients|active|inci)/i.test(ingredientTextMessage)
        ),
    );
    const ingredientKeywordSignal =
      ingredientTextTrigger &&
      ingredientQueryCue &&
      !ingredientFallbackSuppressed;
    const ingredientScienceIntentEffective =
      ingredientScienceIntent ||
      ingredientKeywordSignal ||
      (
        ingredientTextTrigger &&
        !ingredientFallbackSuppressed &&
        Boolean(ingredientLookupTargetFromText) &&
        ingredientTextMessage.length <= 48
      );

    const ingredientGoalRequest = ingredientByGoalRequested
      ? extractIngredientGoalRequestFn(normalizedActionPayload)
      : { goal: '', sensitivity: 'unknown' };
    const ingredientActionData = extractActionDataObjectFn(normalizedActionPayload);

    const sessionMetaInput =
      parsedData &&
      parsedData.session &&
      typeof parsedData.session === 'object' &&
      !Array.isArray(parsedData.session) &&
      parsedData.session.meta &&
      typeof parsedData.session.meta === 'object' &&
      !Array.isArray(parsedData.session.meta)
        ? parsedData.session.meta
        : null;
    let ingredientRecoContext = normalizeIngredientRecoContextValueFn(sessionMetaInput && sessionMetaInput.ingredient_context);
    ingredientRecoContext = mergeIngredientRecoContextValueFn(
      ingredientRecoContext,
      extractIngredientRecoContextFn(normalizedActionPayload),
    );
    ingredientRecoContext = mergeIngredientRecoContextValueFn(ingredientRecoContext, {
      query: pickFirstTrimmedFn(
        ingredientActionData && ingredientActionData.ingredient_query,
        ingredientActionData && ingredientActionData.ingredientQuery,
        ingredientActionData && ingredientActionData.inci,
        ingredientActionData && ingredientActionData.ingredient_name,
      ),
      goal: pickFirstTrimmedFn(
        ingredientActionData && ingredientActionData.ingredient_goal,
        ingredientActionData && ingredientActionData.ingredientGoal,
        ingredientActionData && ingredientActionData.goal,
      ),
      candidates: normalizeIngredientCandidateListFn(
        (ingredientActionData &&
          (
            ingredientActionData.ingredient_candidates ||
            ingredientActionData.ingredientCandidates ||
            ingredientActionData.candidates
          )) || [],
        8,
      ),
      sensitivity: pickFirstTrimmedFn(
        ingredientActionData && ingredientActionData.ingredient_sensitivity,
        ingredientActionData && ingredientActionData.ingredientSensitivity,
        ingredientActionData && ingredientActionData.sensitivity,
      ),
      source: pickFirstTrimmedFn(
        ingredientActionData && ingredientActionData.entry_source,
        ingredientActionData && ingredientActionData.trigger_source,
        'action',
      ),
      updated_at_ms: nowFn(),
    });

    const ingredientReplayContext = {
      intent_requested: Boolean(ingredientScienceIntentEffective),
      starter_action: Boolean(
        ingredientEntryRequested ||
          ingredientLookupRequested ||
          ingredientByGoalRequested ||
          ingredientResearchPollRequested
      ),
      diagnosis_optin: Boolean(
        ingredientDiagnosisOptInRequested ||
          normalizeIngredientActionIdFn(actionId) === 'chip.start.diagnosis' ||
          normalizeIngredientActionIdFn(actionId) === 'chip_start_diagnosis',
      ),
      reco_optin: Boolean(ingredientRecoOptInRequested),
      route_source:
        ingredientTextTrigger && ingredientScienceIntentEffective
          ? 'text'
          : ingredientEntryRequested ||
              ingredientLookupRequested ||
              ingredientByGoalRequested ||
              ingredientDiagnosisOptInRequested ||
              ingredientResearchPollRequested
            ? 'chip'
            : null,
      entry:
        pickFirstTrimmedFn(
          ingredientActionData && ingredientActionData.entry_source,
          ingredientActionData && ingredientActionData.trigger_source,
        ) || (ingredientEntryRequested ? 'ingredients_entry' : ingredientScienceIntentEffective ? 'ingredient_intent' : null),
    };

    if (ingredientEntryRequested) {
      recordAuroraIngredientsFlowMetric({ stage: 'entry_opened', hit: true });
    }
    if (ingredientLookupRequested || ingredientByGoalRequested) {
      recordAuroraIngredientsFlowMetric({ stage: 'mode_selected', hit: true });
    }
    if (ingredientDiagnosisOptInRequested) {
      recordAuroraIngredientsFlowMetric({ stage: 'optin_diagnosis', hit: true });
    }
    if (ingredientRecoOptInRequested) {
      recordAuroraIngredientsFlowMetric({ stage: 'reco_optin', hit: true });
    }

    const skipRoutineRulesFallback = Boolean(
      ingredientEntryRequested ||
        ingredientByGoalRequested ||
        ingredientLookupRequested ||
        ingredientResearchPollRequested
    );

    let nextUpstreamMessage = upstreamMessage;
    if (ingredientLookupRequested && !message && ingredientLookupQuery) {
      nextUpstreamMessage = buildIngredientLookupUpstreamPromptFn({ query: ingredientLookupQuery, language: ctx.lang });
    }
    if (ingredientRecoOptInRequested && ingredientRecoContext) {
      nextUpstreamMessage = buildIngredientRecoUpstreamPromptFn({
        language: ctx.lang,
        context: ingredientRecoContext,
      });
    }

    const conflictIntentRequested = looksLikeCompatibilityOrConflictQuestionFn(message);
    const evaluateIntent =
      (canonicalIntent.intent === INTENT_ENUM.EVALUATE_PRODUCT || looksLikeProductEvaluationIntentV2Fn(message, actionId)) &&
      !looksLikeRoutineRequestFn(message, normalizedActionPayload) &&
      !ingredientScienceIntentEffective;
    const recommendationEntryRequested = Boolean(
      actionId === 'chip.start.reco_products' ||
        actionId === 'chip_get_recos' ||
        actionId === 'chip.action.reco_routine' ||
        actionId === 'chip.start.routine' ||
        looksLikeRecommendationRequestFn(message),
    );
    const diagnosisEntryRequested = Boolean(
      actionId === 'chip.start.diagnosis' ||
        actionId === 'chip_start_diagnosis' ||
        ingredientDiagnosisOptInRequested ||
        (
          requestedTransition &&
          typeof requestedTransition === 'object' &&
          normalizeAgentStateFn(requestedTransition.requested_next_state) === 'DIAG_PROFILE'
        ) ||
        looksLikeDiagnosisStartFn(message),
    );

    return {
      ingredientEntryRequested,
      ingredientLookupRequested,
      ingredientByGoalRequested,
      ingredientDiagnosisOptInRequested,
      ingredientResearchPollRequested,
      ingredientRecoOptInRequested,
      ingredientRouteDecisionReasons,
      ingredientTextTrigger,
      ingredientLookupQuery,
      ingredientLookupTargetFromText,
      ingredientEntityMatch,
      ingredientScienceIntentEffective,
      ingredientGoalRequest,
      ingredientActionData,
      ingredientRecoContext,
      ingredientReplayContext,
      skipRoutineRulesFallback,
      upstreamMessage: nextUpstreamMessage,
      conflictIntentRequested,
      evaluateIntent,
      recommendationEntryRequested,
      diagnosisEntryRequested,
    };
  }

  return {
    prepareIngredientPrelude,
  };
}

module.exports = {
  createChatIngredientPreludeRuntime,
};
