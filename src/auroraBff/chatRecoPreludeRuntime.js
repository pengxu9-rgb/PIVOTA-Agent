function createChatRecoPreludeRuntime(options = {}) {
  const {
    logger,
    mergeIngredientRecoContextValue = null,
    pickFirstTrimmed = null,
    normalizeIngredientCandidateList = null,
    extractIngredientLookupTargetFromText = null,
    profileCompleteness = null,
    evaluateSafetyBoundary = null,
    buildConfidenceNoticeCardPayload = null,
    recordAuroraSkinFlowMetric = () => {},
    recordAuroraRecoEntrySource = () => {},
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat reco prelude runtime missing dependency: ${name}`);
  }

  async function prepareRecoRequestPrelude({
    ingredientRecoContext,
    ingredientRecoOptInRequested = false,
    ingredientActionData = null,
    message = '',
    ctx = {},
    recoEntrySourceDetail = '',
    safetyDecision,
    profile,
    identity,
    pendingSafetyAdvisory = null,
    pushGateDecision,
    enqueueGateAdvisory,
    pendingClarificationPatchOverride = undefined,
    buildDiagnosisChips,
    chatSafetyRuntime,
    chatDiagnosisGateRuntime,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
    canonicalIntent,
  } = {}) {
    const mergeIngredientRecoContextValueFn = requireFunction(
      'mergeIngredientRecoContextValue',
      mergeIngredientRecoContextValue,
    );
    const pickFirstTrimmedFn = requireFunction('pickFirstTrimmed', pickFirstTrimmed);
    const normalizeIngredientCandidateListFn = requireFunction(
      'normalizeIngredientCandidateList',
      normalizeIngredientCandidateList,
    );
    const extractIngredientLookupTargetFromTextFn = requireFunction(
      'extractIngredientLookupTargetFromText',
      extractIngredientLookupTargetFromText,
    );
    const profileCompletenessFn = requireFunction('profileCompleteness', profileCompleteness);
    const evaluateSafetyBoundaryFn = requireFunction('evaluateSafetyBoundary', evaluateSafetyBoundary);
    const buildConfidenceNoticeCardPayloadFn = requireFunction(
      'buildConfidenceNoticeCardPayload',
      buildConfidenceNoticeCardPayload,
    );
    const buildDiagnosisChipsFn = requireFunction('buildDiagnosisChips', buildDiagnosisChips);
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const resolveSafetyGateFn = requireFunction(
      'chatSafetyRuntime.resolveSafetyGate',
      chatSafetyRuntime && chatSafetyRuntime.resolveSafetyGate,
    );
    const applyDiagnosisFirstProfileGateFn = requireFunction(
      'chatDiagnosisGateRuntime.applyDiagnosisFirstProfileGate',
      chatDiagnosisGateRuntime && chatDiagnosisGateRuntime.applyDiagnosisFirstProfileGate,
    );

    let nextRecoIngredientContext = mergeIngredientRecoContextValueFn(
      ingredientRecoContext,
      ingredientRecoOptInRequested
        ? {
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
            product_candidates: Array.isArray(
              ingredientActionData && (ingredientActionData.product_candidates || ingredientActionData.productCandidates),
            )
              ? (ingredientActionData.product_candidates || ingredientActionData.productCandidates).slice(0, 12)
              : [],
            sensitivity: pickFirstTrimmedFn(
              ingredientActionData && ingredientActionData.ingredient_sensitivity,
              ingredientActionData && ingredientActionData.ingredientSensitivity,
              ingredientActionData && ingredientActionData.sensitivity,
            ),
            source: pickFirstTrimmedFn(
              ingredientActionData && ingredientActionData.entry_source,
              ingredientActionData && ingredientActionData.trigger_source,
              'ingredient_reco_optin',
            ),
            updated_at_ms: Date.now(),
          }
        : null,
    );
    if (!nextRecoIngredientContext) {
      const lookupTargetFromRecoText = await extractIngredientLookupTargetFromTextFn(message, ctx.lang);
      nextRecoIngredientContext = mergeIngredientRecoContextValueFn(nextRecoIngredientContext, {
        query: lookupTargetFromRecoText,
        source: lookupTargetFromRecoText ? 'text_reco' : '',
        updated_at_ms: lookupTargetFromRecoText ? Date.now() : 0,
      });
    }

    const recoContextIngredientQuery = pickFirstTrimmedFn(
      nextRecoIngredientContext && (nextRecoIngredientContext.query || nextRecoIngredientContext.ingredient_query),
    );
    const recoContextGoal = pickFirstTrimmedFn(
      nextRecoIngredientContext && (nextRecoIngredientContext.goal || nextRecoIngredientContext.ingredient_goal),
    );
    const recoContextSensitivity = pickFirstTrimmedFn(
      nextRecoIngredientContext && (nextRecoIngredientContext.sensitivity || nextRecoIngredientContext.ingredient_sensitivity),
    );
    const recoIngredientCandidates = Array.isArray(nextRecoIngredientContext?.candidates)
      ? nextRecoIngredientContext.candidates
      : [];
    const recoProductCandidates = Array.isArray(
      ingredientActionData?.product_candidates || ingredientActionData?.productCandidates,
    )
      ? (ingredientActionData.product_candidates || ingredientActionData.productCandidates)
      : [];
    const recoTaskMode = ingredientRecoOptInRequested
      ? (recoProductCandidates.length > 0
          ? 'ingredient_filtered_products'
          : recoIngredientCandidates.length > 0
            ? 'ingredient_filtered_products'
            : 'ingredient_lookup_no_candidates')
      : 'goal_based_products';

    recordAuroraSkinFlowMetric({ stage: 'reco_request', hit: true });
    recordAuroraRecoEntrySource({ source: recoEntrySourceDetail });

    const recoSafetyGate = await resolveSafetyGateFn({
      safety: safetyDecision,
      profile,
      identity,
      conflictIntent: false,
      pendingSafetyAdvisory,
      pushGateDecision,
      language: ctx.lang,
      variant: 'reco',
      ctx,
      buildEnvelope: buildEnvelopeFn,
      makeChatAssistantMessage: makeChatAssistantMessageFn,
      makeEvent: makeEventFn,
      intent: canonicalIntent && canonicalIntent.intent,
    });

    let nextProfile = recoSafetyGate.profile;
    let nextPendingSafetyAdvisory = recoSafetyGate.pendingSafetyAdvisory;
    if (recoSafetyGate.blockedEnvelope) {
      return {
        profile: nextProfile,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        pendingClarificationPatchOverride,
        recoIngredientContext: nextRecoIngredientContext,
        recoContextIngredientQuery,
        recoContextGoal,
        recoContextSensitivity,
        recoIngredientCandidates,
        recoProductCandidates,
        recoTaskMode,
        profileScore: 0,
        profileMissing: [],
        refinementChips: [],
        blockedEnvelope: recoSafetyGate.blockedEnvelope,
      };
    }

    const { score: profileScore, missing: profileMissing } = profileCompletenessFn(nextProfile);
    const hardRequiredFields = ['skinType', 'sensitivity', 'barrierStatus', 'goals'];
    const hardRequiredMissing = hardRequiredFields.filter((field) =>
      Array.isArray(profileMissing) ? profileMissing.includes(field) : false,
    );

    let nextPendingClarificationPatchOverride = pendingClarificationPatchOverride;
    if (hardRequiredMissing.length > 0) {
      const diagnosisFirstGate = applyDiagnosisFirstProfileGateFn({
        ctx,
        requiredMissing: hardRequiredMissing,
        message,
        pushGateDecision,
        enqueueGateAdvisory,
        pendingClarificationPatchOverride,
        buildDiagnosisChips: buildDiagnosisChipsFn,
      });
      nextPendingClarificationPatchOverride = diagnosisFirstGate.pendingClarificationPatchOverride;
    }

    const refinementMissing = (Array.isArray(profileMissing) ? profileMissing : []).filter(
      (field) => field === 'skinType' || field === 'sensitivity',
    );
    const refinementChips = refinementMissing.length ? buildDiagnosisChipsFn(ctx.lang, refinementMissing) : [];

    const safety = evaluateSafetyBoundaryFn({
      message,
      profile: nextProfile,
      language: ctx.lang,
    });
    if (safety.block) {
      logger?.info({ kind: 'metric', name: 'aurora.skin.safety_block_rate', value: 1 }, 'metric');
      recordAuroraSkinFlowMetric({ stage: 'reco_safety_block', hit: true });
      const blockedEnvelope = buildEnvelopeFn(ctx, {
        assistant_message: makeChatAssistantMessageFn(safety.assistant_message),
        suggested_chips: [],
        cards: [
          {
            card_id: `conf_${ctx.request_id}`,
            type: 'confidence_notice',
            payload: buildConfidenceNoticeCardPayloadFn({
              language: ctx.lang,
              reason: 'safety_block',
              confidence: { score: 0, level: 'low', rationale: ['medical_boundary'] },
              severity: 'block',
              actions: ['seek_medical_care', 'pause_strong_actives', 'return_after_stabilization'],
              details: safety.notice_bullets,
            }),
          },
        ],
        session_patch: {},
        events: [
          makeEventFn(ctx, 'recos_requested', { explicit: true, blocked: true, reason: 'safety_boundary' }),
        ],
      });

      return {
        profile: nextProfile,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
        recoIngredientContext: nextRecoIngredientContext,
        recoContextIngredientQuery,
        recoContextGoal,
        recoContextSensitivity,
        recoIngredientCandidates,
        recoProductCandidates,
        recoTaskMode,
        profileScore,
        profileMissing,
        refinementChips,
        blockedEnvelope,
      };
    }

    return {
      profile: nextProfile,
      pendingSafetyAdvisory: nextPendingSafetyAdvisory,
      pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
      recoIngredientContext: nextRecoIngredientContext,
      recoContextIngredientQuery,
      recoContextGoal,
      recoContextSensitivity,
      recoIngredientCandidates,
      recoProductCandidates,
      recoTaskMode,
      profileScore,
      profileMissing,
      refinementChips,
      blockedEnvelope: null,
    };
  }

  return {
    prepareRecoRequestPrelude,
  };
}

module.exports = {
  createChatRecoPreludeRuntime,
};
