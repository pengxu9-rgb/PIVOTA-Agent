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

function createLegacyChatRecoFinalizeRuntime(deps = {}) {
  const {
    recordAuroraSkinFlowMetric,
    stateChangeAllowed,
    buildRouteAwareAssistantText,
    humanizeRecoProductType,
    shouldSurfaceRecoWarnSafetyText,
    maybeRewriteRecoAssistantTextWithLlm,
    extractRecoFinalSelectionContract,
    assistantTextMatchesRecoSelectionContract,
    buildLegacyChatRecoEnvelope,
  } = deps;

  async function finalizeLegacyChatRecoEnvelope({
    ctx,
    payload,
    profile,
    profileScore = 0,
    message = '',
    recoRequestMessage = '',
    safetyDecision = null,
    buildSafetyNoticeText = null,
    effectiveRecoEntrySourceDetail = '',
    recoTaskMode = '',
    recoContextIngredientQuery = '',
    recoIngredientCandidates = [],
    recoIngredientContext = null,
    latestRecoContextPatch = null,
    recoProductCandidates = [],
    normFieldMissing = [],
    mappedIngredientPlan = null,
    debugUpstream = false,
    upstreamDebug = null,
    alternativesDebug = null,
    chatAnalysisTaskContext = null,
    attachAnalysisContextUsageToSessionPatch = null,
    lowConfidenceArtifact = false,
    identity = null,
    llmPrimaryUsed = false,
    matcherFallbackUsed = false,
    generatedPrimaryUsed = false,
    generatedSourceMode = '',
    genericConcernRecoMainline = false,
    hasDeterministicRecoTarget = false,
    productMatcherEnabled = false,
    matcherBundle = null,
    refinementChips = [],
    recoContract = null,
    recoSource = '',
    shouldAutoRerunRecommendationsFromProfilePatch = false,
    artifactConfidenceLevel = '',
    artifactConfidenceScore = null,
    llmTraceRef = null,
    llmFailureClass = '',
    latestArtifact = null,
    logger = null,
    wantsProductRecommendations = false,
  } = {}) {
    const finalHasRecs = Array.isArray(payload && payload.recommendations)
      ? payload.recommendations.length > 0
      : false;
    recordAuroraSkinFlowMetric({ stage: 'reco_generated', hit: Boolean(finalHasRecs) });
    if (finalHasRecs) {
      logger?.info({ kind: 'metric', name: 'aurora.skin.reco_generated_rate', value: 1 }, 'metric');
    }
    const nextState = stateChangeAllowed(ctx.trigger_source) && (finalHasRecs || wantsProductRecommendations)
      ? 'S7_PRODUCT_RECO'
      : undefined;

    const recoAssistantBase = buildRouteAwareAssistantText({
      route: 'reco',
      payload,
      language: ctx.lang,
      profile,
    });
    const stepAwareNeedsMoreContext =
      !finalHasRecs
      && pickFirstTrimmed(payload?.recommendation_meta?.resolved_target_step)
      && pickFirstTrimmed(payload?.mainline_status, payload?.recommendation_meta?.mainline_status) === 'needs_more_context';
    const requestedStepLabel = humanizeRecoProductType(
      pickFirstTrimmed(payload?.recommendation_meta?.resolved_target_step),
      ctx.lang,
    );
    const recoUnavailableLead = ctx.lang === 'CN'
      ? '我还没能从上游拿到完整的可购清单，先给你一版稳妥可执行方案。'
      : "I couldn't fetch a complete purchasable shortlist from upstream, so here's a safe and actionable plan first.";

    const assistantTextRaw = finalHasRecs
      ? (recoAssistantBase ||
        (ctx.lang === 'CN'
          ? profileScore >= 3
            ? '我已经把核心结果整理成结构化卡片（见下方）。'
            : '我先按“温和/低刺激”给你整理了几款通用选择（见下方卡片）。如果你愿意点选一下肤质/敏感程度，我可以更精准。'
          : 'I summarized the key results into structured cards below.'))
      : stepAwareNeedsMoreContext
        ? (ctx.lang === 'CN'
          ? `我还不能稳定地锁定适合你的${requestedStepLabel || '这一步'}候选。告诉我你更偏向轻薄、屏障修护、无香，或你想避开的成分，我再继续缩窄。`
          : `I can't confidently lock a ${requestedStepLabel || 'step-specific'} shortlist yet. Tell me whether you want lightweight texture, barrier support, fragrance-free options, or ingredients to avoid, and I'll narrow it down.`)
        : (recoAssistantBase
          ? `${recoUnavailableLead}\n\n${recoAssistantBase}`
          : (ctx.lang === 'CN'
            ? '我还没能从上游拿到可结构化的产品推荐结果。你可以先告诉我你想要的品类（例如：洁面/精华/面霜/防晒），我再继续。'
            : "I couldn't get a structured product recommendation from upstream yet. Tell me what category you want (cleanser / serum / moisturizer / sunscreen), and I’ll continue."));
    const safetyWarnText = shouldSurfaceRecoWarnSafetyText({
      safetyDecision,
      recoEntrySourceDetail: effectiveRecoEntrySourceDetail,
      message: recoRequestMessage || message,
    })
      ? (typeof buildSafetyNoticeText === 'function' ? buildSafetyNoticeText(safetyDecision) : '')
      : '';
    const recoAssistantRewrite = finalHasRecs
      ? await maybeRewriteRecoAssistantTextWithLlm({
        payload,
        language: ctx.lang,
        profile,
        baseText: assistantTextRaw,
        userRequestText: pickFirstTrimmed(recoRequestMessage, message),
      })
      : { text: assistantTextRaw, llm_used: false, reason: 'no_recommendations' };
    if (
      finalHasRecs &&
      isPlainObject(payload?.recommendation_meta) &&
      isPlainObject(recoAssistantRewrite?.refinement_question)
    ) {
      payload.recommendation_meta.assistant_refinement_question = recoAssistantRewrite.refinement_question;
    }
    const recoSelectionContract = extractRecoFinalSelectionContract(payload);
    const assistantText = finalHasRecs
      ? String(
        assistantTextMatchesRecoSelectionContract(
          recoAssistantRewrite && recoAssistantRewrite.text,
          recoSelectionContract,
        )
          ? (recoAssistantRewrite && recoAssistantRewrite.text || assistantTextRaw)
          : recoAssistantBase,
      ).trim()
      : String(assistantTextRaw || '').trim();
    const finalAssistantText = [safetyWarnText, assistantText].filter(Boolean).join('\n\n');

    if (String(recoTaskMode || '').startsWith('ingredient_')) {
      logger?.info(
        {
          kind: 'metric',
          name: 'aurora.ingredient_reco.flow_summary',
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          task_mode: recoTaskMode,
          ingredient_query: recoContextIngredientQuery || null,
          ingredient_candidates_count: Array.isArray(recoIngredientCandidates) ? recoIngredientCandidates.length : 0,
          product_candidates_count: Array.isArray((recoIngredientContext || latestRecoContextPatch)?.product_candidates)
            ? (recoIngredientContext || latestRecoContextPatch).product_candidates.length
            : Array.isArray(recoProductCandidates)
              ? recoProductCandidates.length
              : 0,
          constraint_match_summary: isPlainObject(payload) ? payload.constraint_match_summary : null,
          products_empty_reason: isPlainObject(payload) ? payload.products_empty_reason : null,
          recommendations_count: isPlainObject(payload) && Array.isArray(payload.recommendations) ? payload.recommendations.length : 0,
          matcher_pending: isPlainObject(payload) && isPlainObject(payload.metadata) ? payload.metadata.matcher_check_result?.pending : null,
          confidence_score: isPlainObject(payload) ? payload.recommendation_confidence_score : null,
          confidence_level: isPlainObject(payload) ? payload.recommendation_confidence_level : null,
        },
        'aurora bff: ingredient reco flow summary',
      );
    }

    return buildLegacyChatRecoEnvelope({
      ctx,
      payload,
      normFieldMissing,
      mappedIngredientPlan,
      debugUpstream,
      upstreamDebug,
      alternativesDebug,
      nextState,
      recoIngredientContext,
      latestArtifact,
      latestRecoContextPatch,
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
      productMatcherEnabled,
      matcherBundle,
      finalHasRecs,
      finalAssistantText,
      refinementChips,
      recoContract,
      recoSource,
      effectiveRecoEntrySourceDetail,
      shouldAutoRerunRecommendationsFromProfilePatch,
      artifactConfidenceLevel,
      artifactConfidenceScore,
      llmTraceRef,
      llmFailureClass,
      logger,
    });
  }

  return {
    finalizeLegacyChatRecoEnvelope,
  };
}

module.exports = {
  createLegacyChatRecoFinalizeRuntime,
};
