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

async function handleLegacyChatRecoRequest({
  ctx,
  message,
  profile,
  session,
  recentLogs,
  logger,
  identity,
  attachAnalysisContextUsageToSessionPatch,
  canonicalIntent,
  safetyDecision,
  buildSafetyNoticeText,
  includeAlternatives,
  actionId,
  debugUpstream,
  requestScopedProfileOverride,
  ingredientRecoContext,
  ingredientRecoOptInRequested,
  ingredientActionData,
  ingredientDrivenRecommendationRequested,
  latestRecoContextFromSession,
  recoEntrySourceDetail,
  recoRequestMessage,
  shouldAutoRerunRecommendationsFromProfilePatch,
  travelSkillsContracts,
  looksLikeLowRiskSkincareTask,
  runAuroraTimedOperation,
  ensureLatestArtifactForConversation,
  ensureAnalysisContextSnapshotForConversation,
  ensureTaskAnalysisContextForConversation,
  getIngredientPlanByArtifactIdForRoute,
  getAuroraStorageReadTimeoutMs,
  saveIngredientPlanForRoute,
  getAuroraStorageWriteTimeoutMs,
  prepareLegacyChatRecoContext,
  buildLegacyRecoSafetyGateEnvelope,
  maybeBuildLegacyTravelRecoEnvelope,
  prepareLegacyChatRecoAnalysisContext,
  prepareLegacyChatRecoTargeting,
  postProcessLegacyChatRecoResult,
  normalizeLegacyChatRecoPayload,
  finalizeLegacyChatRecoEnvelope,
  resolveSafetyGateActionV2,
  mergePendingSafetyAdvisory,
  persistSafetyPromptAskedOnce,
  profileCompleteness,
  buildPendingClarificationForGate,
  emitPendingClarificationPatch,
  buildDiagnosisChips,
  evaluateSafetyBoundary,
  buildConfidenceNoticeCardPayload,
  buildIngredientPlan,
  buildProductRecommendationsBundle,
  toLegacyRecommendationsPayload,
  shouldUseLegacyVerifiedContextRestore,
  restoreRecoRecommendationsFromVerifiedContextCandidates,
  applyVerifiedCandidateRestoreToRecoPayload,
  summarizeProfileForContext,
  normalizeRecoSourceDetail,
  generateProductRecommendations,
  extractRecoContextProductCandidatesFromCandidatePoolState,
  buildIngredientRecoContextTargetBundle,
  normalizeRecoTargetStep,
  mergeIngredientRecoContextValue,
  classifyRecoUpstreamFailureCode,
  isTransientRecoUpstreamFailureCode,
  recordAuroraRecoLlmCall,
  normalizeRecoFailureClass,
  recordAuroraSkinFlowMetric,
  recordAuroraRecoEntrySource,
  AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED,
  AURORA_INGREDIENT_PLAN_ENABLED,
  AURORA_PRODUCT_MATCHER_ENABLED,
  AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED,
  MINIMUM_RECOMMENDATION_CONTEXT_RULE_VERSION,
  AURORA_PRODUCT_MATCHER_BUNDLED_SEED_FALLBACK_ENABLED,
  DIAG_PRODUCT_CATALOG_PATH,
  AURORA_BFF_CHAT_RECO_BUDGET_MS,
} = {}) {
  let pendingClarificationPatchOverride = undefined;
  let analysisContextSnapshotForConversation = null;
  let chatAnalysisTaskContext = null;

  const preparedLegacyRecoContext = await prepareLegacyChatRecoContext({
    ingredientRecoContext,
    ingredientRecoOptInRequested,
    ingredientActionData,
    message,
    language: ctx.lang,
    recoEntrySourceDetail,
    latestRecoContextFromSession,
    profile,
    session,
    recoRequestMessage,
  });
  let recoIngredientContext = preparedLegacyRecoContext.recoIngredientContext;
  let recoContextIngredientQuery = preparedLegacyRecoContext.recoContextIngredientQuery;
  let recoContextGoal = preparedLegacyRecoContext.recoContextGoal;
  let recoContextSensitivity = preparedLegacyRecoContext.recoContextSensitivity;
  let recoIngredientCandidates = preparedLegacyRecoContext.recoIngredientCandidates;
  const recoProductCandidates = preparedLegacyRecoContext.recoProductCandidates;
  const travelRecoContext = preparedLegacyRecoContext.travelRecoContext;
  const travelRecoHandoff = preparedLegacyRecoContext.travelRecoHandoff;
  const latestRecoContextSeed = preparedLegacyRecoContext.latestRecoContextSeed;
  const rawMessageRecoTargetContext = preparedLegacyRecoContext.rawMessageRecoTargetContext;
  const shouldApplySessionRecoContext = preparedLegacyRecoContext.shouldApplySessionRecoContext;
  const effectiveRecoEntrySourceDetail = preparedLegacyRecoContext.effectiveRecoEntrySourceDetail;
  const recoTaskMode = preparedLegacyRecoContext.recoTaskMode;

  recordAuroraSkinFlowMetric({ stage: 'reco_request', hit: true });
  recordAuroraRecoEntrySource({ source: effectiveRecoEntrySourceDetail });

  const recoSafetyGate = resolveSafetyGateActionV2({
    safety: safetyDecision,
    profileValue: profile,
    conflictIntent: false,
  });
  if (recoSafetyGate.mode === 'inline' && recoSafetyGate.advisory) {
    mergePendingSafetyAdvisory(recoSafetyGate.advisory);
    await persistSafetyPromptAskedOnce(recoSafetyGate.ask_once_fields);
  }
  if (recoSafetyGate.mode === 'block') {
    const safetyText = buildSafetyNoticeText(safetyDecision);
    return buildLegacyRecoSafetyGateEnvelope({
      ctx,
      assistantText:
        safetyText ||
        (ctx.lang === 'CN'
          ? '当前存在安全风险，先不输出激进推荐。'
          : 'Current safety risk detected, so I will not output aggressive recommendations.'),
      cardId: `safety_${ctx.request_id}`,
      payload: {
        severity: 'block',
        message:
          ctx.lang === 'CN'
            ? '检测到安全风险，已切换保守路径。'
            : 'Safety risk detected; switched to conservative path.',
        details: [
          ...(Array.isArray(safetyDecision.reasons) ? safetyDecision.reasons.slice(0, 3) : []),
          ...(Array.isArray(safetyDecision.safe_alternatives)
            ? safetyDecision.safe_alternatives.slice(0, 3)
            : []),
        ],
        actions: ['safe_alternatives', 'profile_update'],
      },
      eventName: 'safety_gate_block',
      eventData: { intent: canonicalIntent.intent, block_level: safetyDecision.block_level },
      suggestedChips: [
        {
          chip_id: 'chip.start.ingredients',
          label: ctx.lang === 'CN' ? '成分科学（更安全替代）' : 'Ingredient science (safe alternatives)',
          kind: 'quick_reply',
          data: {
            reply_text:
              ctx.lang === 'CN'
                ? '我想看更安全替代方案（成分机制）'
                : 'Show me safer alternatives with ingredient mechanism',
          },
        },
        {
          chip_id: 'chip.start.routine',
          label: ctx.lang === 'CN' ? '先做温和routine' : 'Build gentle routine first',
          kind: 'quick_reply',
          data: {
            reply_text:
              ctx.lang === 'CN'
                ? '先给我一套温和修护routine'
                : 'Build a gentle barrier-first routine for me',
          },
        },
      ],
    });
  }

  const { score: profileScore, missing: profileMissing } = profileCompleteness(profile);
  const hardRequiredFields = ['skinType', 'sensitivity', 'barrierStatus', 'goals'];
  const hardRequiredMissing = hardRequiredFields.filter((field) =>
    Array.isArray(profileMissing) ? profileMissing.includes(field) : false,
  );
  if (hardRequiredMissing.length > 0 && AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED) {
    const pendingFromGate = buildPendingClarificationForGate({
      language: ctx.lang,
      missing: hardRequiredMissing,
      message,
      wants: 'recommendation',
    });
    if (pendingFromGate) {
      const sessionPatch = {};
      emitPendingClarificationPatch(sessionPatch, pendingFromGate);
      pendingClarificationPatchOverride = sessionPatch.pending_clarification || pendingClarificationPatchOverride;
    }
  }

  const refinementMissing = (Array.isArray(profileMissing) ? profileMissing : []).filter(
    (f) => f === 'skinType' || f === 'sensitivity',
  );
  const refinementChips = refinementMissing.length ? buildDiagnosisChips(ctx.lang, refinementMissing) : [];

  const safety = evaluateSafetyBoundary({
    message,
    profile,
    language: ctx.lang,
  });
  if (safety.block) {
    logger?.info({ kind: 'metric', name: 'aurora.skin.safety_block_rate', value: 1 }, 'metric');
    recordAuroraSkinFlowMetric({ stage: 'reco_safety_block', hit: true });
    return buildLegacyRecoSafetyGateEnvelope({
      ctx,
      assistantText: safety.assistant_message,
      cardId: `conf_${ctx.request_id}`,
      payload: buildConfidenceNoticeCardPayload({
        language: ctx.lang,
        reason: 'safety_block',
        confidence: { score: 0, level: 'low', rationale: ['medical_boundary'] },
        severity: 'block',
        actions: ['seek_medical_care', 'pause_strong_actives', 'return_after_stabilization'],
        details: safety.notice_bullets,
      }),
      eventName: 'recos_requested',
      eventData: { explicit: true, blocked: true, reason: 'safety_boundary' },
      suggestedChips: [],
    });
  }

  const travelRecoEnvelope = maybeBuildLegacyTravelRecoEnvelope({
    ctx,
    travelRecoHandoff,
    travelSkillsContracts,
    travelRecoContext,
    profile,
    recoTaskMode,
    recentLogs,
    recoEntrySourceDetail,
    actionId,
    recoRequestMessage,
    includeAlternatives,
    refinementChips,
  });
  if (travelRecoEnvelope) {
    return travelRecoEnvelope;
  }

  const preparedLegacyRecoAnalysisContext = await prepareLegacyChatRecoAnalysisContext({
    ctx,
    logger,
    message,
    profile,
    identity,
    ingredientPlanEnabled: AURORA_INGREDIENT_PLAN_ENABLED,
    productMatcherEnabled: AURORA_PRODUCT_MATCHER_ENABLED,
    nonblockingGateEnabled: AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED,
    ensureLatestArtifactForConversation,
    ensureAnalysisContextSnapshotForConversation,
    ensureTaskAnalysisContextForConversation,
    looksLikeLowRiskSkincareTask,
    recordAuroraSkinFlowMetric,
    runAuroraTimedOperation,
    getIngredientPlanByArtifactIdForRoute,
    getAuroraStorageReadTimeoutMs,
    saveIngredientPlanForRoute,
    getAuroraStorageWriteTimeoutMs,
  });
  const latestArtifact = preparedLegacyRecoAnalysisContext.latestArtifact;
  const artifactGate = preparedLegacyRecoAnalysisContext.artifactGate;
  analysisContextSnapshotForConversation =
    preparedLegacyRecoAnalysisContext.analysisContextSnapshotForConversation;
  chatAnalysisTaskContext = preparedLegacyRecoAnalysisContext.chatAnalysisTaskContext;
  let mappedIngredientPlan = preparedLegacyRecoAnalysisContext.mappedIngredientPlan;

  const preparedLegacyRecoTargeting = prepareLegacyChatRecoTargeting({
    profile,
    mappedIngredientPlan,
    latestArtifact,
    latestRecoContextSeed,
    ingredientDrivenRecommendationRequested,
    travelRecoHandoff,
    recoIngredientContext,
    recoContextIngredientQuery,
    recoContextGoal,
    recoContextSensitivity,
    recoIngredientCandidates,
    ingredientRecoOptInRequested,
    recoRequestMessage,
    message,
    language: ctx.lang,
    effectiveRecoEntrySourceDetail,
    triggerSource: ctx.trigger_source,
    actionId,
    includeAlternatives,
    rawMessageRecoTargetContext,
    minimumRecommendationContextRuleVersion: MINIMUM_RECOMMENDATION_CONTEXT_RULE_VERSION,
  });
  recoIngredientContext = preparedLegacyRecoTargeting.recoIngredientContext;
  recoContextIngredientQuery = preparedLegacyRecoTargeting.recoContextIngredientQuery;
  recoContextGoal = preparedLegacyRecoTargeting.recoContextGoal;
  recoContextSensitivity = preparedLegacyRecoTargeting.recoContextSensitivity;
  recoIngredientCandidates = preparedLegacyRecoTargeting.recoIngredientCandidates;
  const recoAutoAnchoredByAnalysis = preparedLegacyRecoTargeting.recoAutoAnchoredByAnalysis;
  const recoIngredientContextForMainline = preparedLegacyRecoTargeting.recoIngredientContextForMainline;
  const catalogExternalSeedStrategyForMainline = preparedLegacyRecoTargeting.catalogExternalSeedStrategyForMainline;
  const recoRequestMessageForMainline = preparedLegacyRecoTargeting.recoRequestMessageForMainline;
  const recoFocusForMainline = preparedLegacyRecoTargeting.recoFocusForMainline;
  const chatRecoTargetContext = preparedLegacyRecoTargeting.chatRecoTargetContext;
  let latestRecoContextPatch = preparedLegacyRecoTargeting.latestRecoContextPatch;
  const hasDeterministicRecoTarget = preparedLegacyRecoTargeting.hasDeterministicRecoTarget;
  const hasStableRecoTarget = preparedLegacyRecoTargeting.hasStableRecoTarget;
  const genericConcernRecoMainline = preparedLegacyRecoTargeting.genericConcernRecoMainline;
  const genericGoalDrivenNeedsMoreContextWarning =
    preparedLegacyRecoTargeting.genericGoalDrivenNeedsMoreContextWarning;

  let matcherBundle = null;
  let matcherPayload = null;
  let matcherComputed = false;
  let verifiedCandidateRestoreApplied = false;
  let verifiedCandidateRestoreCount = 0;
  const hasRecoArtifact = Boolean(latestArtifact && typeof latestArtifact === 'object' && !Array.isArray(latestArtifact));
  const artifactConfidenceLevel =
    hasRecoArtifact && artifactGate && artifactGate.confidence_level
      ? artifactGate.confidence_level
      : 'unknown';
  const lowConfidenceArtifact = hasRecoArtifact && artifactConfidenceLevel === 'low';
  const artifactConfidenceScoreRaw = Number(
    latestArtifact &&
    latestArtifact.overall_confidence &&
    latestArtifact.overall_confidence.score,
  );
  const artifactConfidenceScore = Number.isFinite(artifactConfidenceScoreRaw) ? artifactConfidenceScoreRaw : null;

  const computeMatcherIfNeeded = () => {
    if (matcherComputed) {
      return { matcherBundle, matcherPayload };
    }
    matcherComputed = true;
    if (!(AURORA_PRODUCT_MATCHER_ENABLED && latestArtifact)) {
      return { matcherBundle, matcherPayload };
    }
    try {
      const artifactPayload = latestArtifact;
      const planForMatcher =
        mappedIngredientPlan ||
        buildIngredientPlan({ artifact: artifactPayload, profile: profile || {} });
      const allowBundledSeedCatalog =
        AURORA_PRODUCT_MATCHER_BUNDLED_SEED_FALLBACK_ENABLED
        && !DIAG_PRODUCT_CATALOG_PATH;
      if (!mappedIngredientPlan) mappedIngredientPlan = planForMatcher;

      matcherBundle = buildProductRecommendationsBundle({
        ingredientPlan: planForMatcher,
        artifact: artifactPayload,
        profile,
        language: ctx.lang,
        disallowTreatment: false,
        catalogPath: DIAG_PRODUCT_CATALOG_PATH,
        allowDefaultSeedCatalog: allowBundledSeedCatalog,
      });
      matcherPayload = toLegacyRecommendationsPayload(matcherBundle, { language: ctx.lang });
    } catch (err) {
      logger?.warn(
        { err: err && err.message ? err.message : String(err), request_id: ctx.request_id },
        'aurora bff: product matcher failed',
      );
    }
    return { matcherBundle, matcherPayload };
  };

  let norm = null;
  let upstreamDebug = null;
  let alternativesDebug = null;
  const matcherFallbackUsed = false;
  let recoTimeoutDegraded = false;
  let recoTimeoutDegradedWarning = null;
  let upstreamFailureCode = '';
  let llmFailureClass = '';
  let recoLlmTrace = null;
  let recoContract = null;
  let recoMainlineStatus = '';
  let recoCatalogSkipReason = '';
  let recoTelemetryFailureReason = '';
  let recoMetaPromptTemplateId = '';
  let recoSource = '';
  let upstreamReco = null;

  const shouldShortCircuitVerifiedContextRestore = shouldUseLegacyVerifiedContextRestore({
    ingredientRecoOptInRequested,
    travelRecoHandoff,
    shouldApplySessionRecoContext,
    recoAutoAnchoredByAnalysis,
    effectiveRecoEntrySourceDetail,
    hasStableRecoTarget,
    recoContext: recoIngredientContext || latestRecoContextPatch,
  });
  if (shouldShortCircuitVerifiedContextRestore) {
    const restoredFromVerifiedCandidates = restoreRecoRecommendationsFromVerifiedContextCandidates({
      recoContext: recoIngredientContext || latestRecoContextPatch,
      targetContext: chatRecoTargetContext,
      language: ctx.lang,
    });
    const restoredRecommendations = Array.isArray(restoredFromVerifiedCandidates?.recommendations)
      ? restoredFromVerifiedCandidates.recommendations
      : [];
    if (restoredRecommendations.length > 0) {
      verifiedCandidateRestoreApplied = true;
      verifiedCandidateRestoreCount = restoredRecommendations.length;
      const restoredPayload = applyVerifiedCandidateRestoreToRecoPayload({
        intent: 'reco_products',
        profile: summarizeProfileForContext(profile),
        recommendations: [],
        source: 'catalog_grounded_v1',
        task_mode: recoTaskMode,
        recommendation_confidence_score: artifactConfidenceScore != null ? artifactConfidenceScore : 0.61,
        recommendation_confidence_level:
          artifactConfidenceLevel && artifactConfidenceLevel !== 'unknown'
            ? artifactConfidenceLevel
            : 'medium',
        recommendation_meta: {
          task_mode: recoTaskMode,
          trigger_source: normalizeRecoSourceDetail(effectiveRecoEntrySourceDetail),
          used_recent_logs: Array.isArray(recentLogs) && recentLogs.length > 0,
          used_itinerary: Boolean(profile && (profile.itinerary || profile.travel_plan || profile.travel_plans)),
          used_safety_flags: lowConfidenceArtifact,
        },
      }, restoredRecommendations);
      norm = {
        payload: restoredPayload.payload,
        field_missing: [],
      };
      recoSource = 'catalog_grounded_v1';
      recoMainlineStatus = 'grounded_success';
      recoTelemetryFailureReason = '';
    }
  }

  const normHasRecommendations = Array.isArray(norm?.payload?.recommendations) && norm.payload.recommendations.length > 0;
  const shouldAttemptIngredientOptInCatalogRecovery =
    ingredientRecoOptInRequested
    && !travelRecoHandoff
    && Boolean(pickFirstTrimmed(recoContextIngredientQuery, recoContextGoal) || recoIngredientCandidates.length > 0)
    && !normHasRecommendations;
  if (
    (!norm || shouldAttemptIngredientOptInCatalogRecovery)
    && (!matcherPayload || !Array.isArray(matcherPayload.recommendations) || matcherPayload.recommendations.length === 0)
  ) {
    try {
      upstreamReco = await generateProductRecommendations({
        ctx,
        profile,
        recentLogs,
        message: recoRequestMessageForMainline || message,
        focus: recoFocusForMainline,
        ingredientContext: recoIngredientContextForMainline,
        analysisContextSnapshot: analysisContextSnapshotForConversation,
        requestOverride: requestScopedProfileOverride,
        includeAlternatives,
        debug: debugUpstream,
        logger,
        budgetMs: AURORA_BFF_CHAT_RECO_BUDGET_MS,
        entryType: 'chat',
        catalogExternalSeedStrategy: catalogExternalSeedStrategyForMainline,
      });
      norm = upstreamReco.norm;
      upstreamDebug = upstreamReco.upstreamDebug;
      alternativesDebug = upstreamReco.alternativesDebug;
      upstreamFailureCode = String(upstreamReco.upstreamFailureCode || '').trim().toUpperCase();
      llmFailureClass = normalizeRecoFailureClass(upstreamReco.llmFailureClass || '');
      recoLlmTrace = isPlainObject(upstreamReco.llmTrace) ? upstreamReco.llmTrace : null;
      recoContract = isPlainObject(upstreamReco.contract) ? upstreamReco.contract : null;
      recoMainlineStatus = String(upstreamReco.mainlineStatus || '').trim();
      recoCatalogSkipReason = String(upstreamReco.catalogSkipReason || '').trim();
      recoTelemetryFailureReason = String(upstreamReco.telemetryFailureReason || '').trim();
      const selectedIngredientCandidates =
        ingredientRecoOptInRequested
          ? extractRecoContextProductCandidatesFromCandidatePoolState(upstreamReco.candidatePoolState, { max: 12 })
          : [];
      if (
        ingredientRecoOptInRequested
        && selectedIngredientCandidates.length > 0
        && (!Array.isArray(recoIngredientContext?.product_candidates) || recoIngredientContext.product_candidates.length === 0)
      ) {
        const ingredientContextOrigin = pickFirstTrimmed(
          recoIngredientContext && recoIngredientContext.context_origin,
          latestRecoContextPatch && latestRecoContextPatch.context_origin,
          effectiveRecoEntrySourceDetail,
          'ingredient_goal_match',
        ) || 'ingredient_goal_match';
        const inferredIngredientStep = normalizeRecoTargetStep(
          pickFirstTrimmed(
            chatRecoTargetContext && chatRecoTargetContext.resolved_target_step,
            recoIngredientContext && recoIngredientContext.resolved_target_step,
            recoIngredientContext && recoIngredientContext.target_step,
            recoIngredientContext && recoIngredientContext.step,
            selectedIngredientCandidates[0] && (selectedIngredientCandidates[0].product_type || selectedIngredientCandidates[0].category),
          ),
        ) || '';
        const inferredTargetBundle = buildIngredientRecoContextTargetBundle({
          ingredientQuery: recoContextIngredientQuery,
          candidates: recoIngredientCandidates,
          goal: recoContextGoal,
          resolvedTargetStep: inferredIngredientStep,
          source: ingredientContextOrigin,
        });
        const effectiveStepConfidence = (() => {
          const raw = String(pickFirstTrimmed(
            recoIngredientContext && recoIngredientContext.resolved_target_step_confidence,
            latestRecoContextPatch && latestRecoContextPatch.resolved_target_step_confidence,
          ) || '').trim().toLowerCase();
          return raw && raw !== 'none' ? raw : 'medium';
        })();
        const effectiveStepSource = (() => {
          const raw = String(pickFirstTrimmed(
            recoIngredientContext && recoIngredientContext.resolved_target_step_source,
            latestRecoContextPatch && latestRecoContextPatch.resolved_target_step_source,
          ) || '').trim().toLowerCase();
          return raw && raw !== 'none' ? raw : 'catalog_candidate_state';
        })();
        recoIngredientContext = mergeIngredientRecoContextValue(recoIngredientContext, {
          product_candidates: selectedIngredientCandidates,
          context_origin: ingredientContextOrigin,
          ...inferredTargetBundle,
          ...(inferredIngredientStep
            ? {
                resolved_target_step: inferredIngredientStep,
                target_step: inferredIngredientStep,
                step: inferredIngredientStep,
                resolved_target_step_confidence: effectiveStepConfidence,
                resolved_target_step_source: effectiveStepSource,
              }
            : {}),
          updated_at_ms: Date.now(),
        });
        latestRecoContextPatch = mergeIngredientRecoContextValue(latestRecoContextPatch, {
          product_candidates: selectedIngredientCandidates,
          context_origin: ingredientContextOrigin,
          ...inferredTargetBundle,
          ...(inferredIngredientStep
            ? {
                resolved_target_step: inferredIngredientStep,
                target_step: inferredIngredientStep,
                step: inferredIngredientStep,
                resolved_target_step_confidence: effectiveStepConfidence,
                resolved_target_step_source: effectiveStepSource,
              }
            : {}),
          updated_at_ms: Date.now(),
        });
      }
    } catch (err) {
      const transientCode = classifyRecoUpstreamFailureCode(err);
      if (!isTransientRecoUpstreamFailureCode(transientCode)) {
        throw err;
      }
      recoTimeoutDegraded = true;
      llmFailureClass = 'timeout';
      upstreamFailureCode = transientCode || '';
      recoMainlineStatus = 'upstream_timeout';
      recoTelemetryFailureReason = 'timeout_degraded';
      recordAuroraRecoLlmCall({ stage: 'main', outcome: 'timeout' });
      logger?.warn(
        {
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          budget_ms: AURORA_BFF_CHAT_RECO_BUDGET_MS,
          transient_code: transientCode || null,
        },
        'aurora bff: reco upstream timeout/transient failure, degraded to confidence_notice',
      );
    }
  }

  const postProcessedLegacyReco = postProcessLegacyChatRecoResult({
    ctx,
    norm,
    upstreamReco,
    upstreamDebug,
    recoLlmTrace,
    recoContract,
    llmFailureClass,
    upstreamFailureCode,
    recoCatalogSkipReason,
    recoTelemetryFailureReason,
    recoMetaPromptTemplateId,
    recoMainlineStatus,
    recoTimeoutDegraded,
    recoTimeoutDegradedWarning,
    recoSource,
    llmPrimaryUsed: false,
    genericConcernRecoMainline,
    hasDeterministicRecoTarget,
    ingredientRecoOptInRequested,
    travelRecoHandoff,
    latestRecoContextPatch,
    recoContextIngredientQuery,
    recoIngredientCandidates,
    recoIngredientContext,
    recoProductCandidates,
    chatRecoTargetContext,
    profile,
    recentLogs,
    latestArtifact,
    logger,
    productMatcherEnabled: AURORA_PRODUCT_MATCHER_ENABLED,
    computeMatcherIfNeeded,
    recoTaskMode,
    verifiedCandidateRestoreApplied,
    verifiedCandidateRestoreCount,
  });
  norm = postProcessedLegacyReco.norm;
  recoLlmTrace = postProcessedLegacyReco.recoLlmTrace;
  recoContract = postProcessedLegacyReco.recoContract;
  recoCatalogSkipReason = postProcessedLegacyReco.recoCatalogSkipReason;
  recoTelemetryFailureReason = postProcessedLegacyReco.recoTelemetryFailureReason;
  recoMetaPromptTemplateId = postProcessedLegacyReco.recoMetaPromptTemplateId;
  recoMainlineStatus = postProcessedLegacyReco.recoMainlineStatus;
  recoTimeoutDegraded = postProcessedLegacyReco.recoTimeoutDegraded;
  recoTimeoutDegradedWarning = postProcessedLegacyReco.recoTimeoutDegradedWarning;
  recoSource = postProcessedLegacyReco.recoSource;
  const llmPrimaryUsed = postProcessedLegacyReco.llmPrimaryUsed;
  const generatedPrimaryUsed = postProcessedLegacyReco.generatedPrimaryUsed;
  const generatedSourceMode = postProcessedLegacyReco.generatedSourceMode;
  matcherBundle = postProcessedLegacyReco.matcherBundle;
  matcherPayload = postProcessedLegacyReco.matcherPayload;
  latestRecoContextPatch = postProcessedLegacyReco.latestRecoContextPatch;
  recoIngredientContext = postProcessedLegacyReco.recoIngredientContext;
  verifiedCandidateRestoreApplied = postProcessedLegacyReco.verifiedCandidateRestoreApplied;
  verifiedCandidateRestoreCount = postProcessedLegacyReco.verifiedCandidateRestoreCount;
  const initialHasRecs = postProcessedLegacyReco.initialHasRecs;

  const normalizedLegacyRecoPayload = normalizeLegacyChatRecoPayload({
    norm,
    debugUpstream,
    recoLlmTrace,
    recoTaskMode,
    artifactConfidenceLevel,
    artifactConfidenceScore,
    lowConfidenceArtifact,
    recoSource,
    recoContract,
    matcherFallbackUsed,
    generatedPrimaryUsed,
    generatedSourceMode,
    llmPrimaryUsed,
    genericConcernRecoMainline,
    hasDeterministicRecoTarget,
    normalizedRecoTriggerSource: normalizeRecoSourceDetail(effectiveRecoEntrySourceDetail),
    shouldAutoRerunRecommendationsFromProfilePatch,
    recentLogs,
    profile,
    recoTelemetryFailureReason,
    llmFailureClass,
    recoCatalogSkipReason,
    upstreamFailureCode,
    recoMainlineStatus,
    initialHasRecs,
    latestRecoContextPatch,
    verifiedCandidateRestoreApplied,
    verifiedCandidateRestoreCount,
    recoMetaPromptTemplateId,
    genericGoalDrivenNeedsMoreContextWarning,
    recoTimeoutDegradedWarning,
    recoIngredientContext,
  });
  const payload = normalizedLegacyRecoPayload.payload;
  recoContract = normalizedLegacyRecoPayload.recoContract;
  recoMainlineStatus = normalizedLegacyRecoPayload.recoMainlineStatus;
  latestRecoContextPatch = normalizedLegacyRecoPayload.latestRecoContextPatch;
  const llmTraceRef = normalizedLegacyRecoPayload.llmTraceRef;

  return finalizeLegacyChatRecoEnvelope({
    ctx,
    payload,
    profile,
    profileScore,
    message,
    recoRequestMessage,
    safetyDecision,
    buildSafetyNoticeText,
    effectiveRecoEntrySourceDetail,
    recoTaskMode,
    recoContextIngredientQuery,
    recoIngredientCandidates,
    recoIngredientContext,
    latestRecoContextPatch,
    recoProductCandidates,
    normFieldMissing: norm.field_missing,
    mappedIngredientPlan,
    debugUpstream,
    upstreamDebug,
    alternativesDebug,
    chatAnalysisTaskContext,
    attachAnalysisContextUsageToSessionPatch,
    lowConfidenceArtifact,
    identity,
    llmPrimaryUsed,
    matcherFallbackUsed,
    generatedPrimaryUsed,
    generatedSourceMode,
    genericConcernRecoMainline,
    hasDeterministicRecoTarget,
    productMatcherEnabled: AURORA_PRODUCT_MATCHER_ENABLED,
    matcherBundle,
    refinementChips,
    recoContract,
    recoSource,
    shouldAutoRerunRecommendationsFromProfilePatch,
    artifactConfidenceLevel,
    artifactConfidenceScore,
    llmTraceRef,
    llmFailureClass,
    latestArtifact,
    logger,
    wantsProductRecommendations: true,
  });
}

module.exports = {
  handleLegacyChatRecoRequest,
};
