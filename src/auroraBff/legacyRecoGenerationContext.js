function createLegacyRecoGenerationContextRuntime(deps = {}) {
  const {
    summarizeProfileForContext,
    normalizeIngredientRecoContextValue,
    buildAnalysisContextSnapshotForRoute,
    buildTaskAnalysisContextForPrefix,
    buildAnalysisContextPromptBlock,
    buildContextPrefix,
    pickFirstTrimmed,
    resolveRecommendationTargetContext,
    runConcernSemanticPlanner,
    buildConcernTargetContextFromSemanticPlan,
    buyerRegionFromContext,
  } = deps;

  async function buildLegacyRecoGenerationContext({
    ctx,
    profile,
    recentLogs,
    message,
    focus = '',
    ingredientContext,
    analysisContextSnapshot = null,
    requestOverride = null,
    entryType = 'chat',
    logger,
  } = {}) {
    const profileSummary = summarizeProfileForContext(profile);
    const normalizedIngredientContext = normalizeIngredientRecoContextValue(ingredientContext);
    const analysisSummary =
      profile && profile.lastAnalysis ? profile.lastAnalysis : null;
    const analysisSummaryAt =
      profile && profile.lastAnalysisAt ? profile.lastAnalysisAt : null;
    const effectiveAnalysisContextSnapshot =
      analysisContextSnapshot ||
      buildAnalysisContextSnapshotForRoute({ profile, recentLogs });
    const recommendationTaskContext = buildTaskAnalysisContextForPrefix({
      task: 'recommendation',
      snapshot: effectiveAnalysisContextSnapshot,
      profile,
      requestOverride,
      recentLogs,
    });
    const analysisContextBlock = buildAnalysisContextPromptBlock({
      taskLabel: 'recommendation',
      taskContext: recommendationTaskContext,
    });
    const prefix = buildContextPrefix({
      profile: profileSummary || null,
      recentLogs: Array.isArray(recentLogs) ? recentLogs : [],
      lang: ctx.lang,
      state: ctx.state,
      trigger_source: ctx.trigger_source,
      action_id: 'chip.start.reco_products',
      intent: 'reco_products',
      ...(ingredientContext && typeof ingredientContext === 'object'
        ? { ingredient_context: ingredientContext }
        : {}),
      ...(analysisSummary ? { analysis_summary: analysisSummary } : {}),
      ...(analysisSummaryAt ? { analysis_summary_at: analysisSummaryAt } : {}),
      ...(analysisContextBlock
        ? { skin_analysis_context: analysisContextBlock }
        : {}),
    });
    const userAsk =
      String(message || '').trim() ||
      (ctx.lang === 'CN'
        ? '给我推荐几款护肤产品（按我的肤况与目标）'
        : 'Recommend a few skincare products for my profile and goals.');
    let targetContext = resolveRecommendationTargetContext({
      explicitStep: pickFirstTrimmed(
        normalizedIngredientContext && normalizedIngredientContext.target_step,
        normalizedIngredientContext && normalizedIngredientContext.step,
      ),
      focus,
      text: userAsk,
      entryType,
    });
    let concernSemanticPlanTrace = null;
    let concernSemanticPlanBlockedReason = '';
    let concernSemanticPlanBlockedFailureClass = '';
    let concernSemanticPlanBlockedFailureOrigin = 'none';
    let concernSemanticPlanBlockedTelemetryReason = '';
    const mainlineStageTimingsMs = {};

    if (
      targetContext &&
      Array.isArray(targetContext.framework_roles) &&
      targetContext.framework_roles.length > 0 &&
      String(targetContext.intent_mode || '').trim() === 'generic_concern'
    ) {
      const plannerStartedAt = Date.now();
      const concernPlanOut = await runConcernSemanticPlanner({
        ctx,
        logger,
        requestText: userAsk,
        focus,
        profileSummary,
        recommendationTaskContext,
      });
      mainlineStageTimingsMs.semantic_planner = Math.max(
        0,
        Date.now() - plannerStartedAt,
      );
      concernSemanticPlanTrace = concernPlanOut.trace || null;
      targetContext = buildConcernTargetContextFromSemanticPlan(
        concernPlanOut.semanticPlan,
        {
          text: userAsk,
          focus,
          entryType,
        },
      );
      if (
        String(
          targetContext?.selection_owner_state ||
            targetContext?.framework_owner_state ||
            '',
        )
          .trim()
          .toLowerCase() !== 'trusted'
      ) {
        const plannerFailureClass = String(
          concernSemanticPlanTrace?.planner_failure_class || '',
        )
          .trim()
          .toLowerCase();
        concernSemanticPlanBlockedReason = 'planner_untrusted';
        concernSemanticPlanBlockedFailureClass = 'planner_untrusted';
        concernSemanticPlanBlockedFailureOrigin =
          plannerFailureClass === 'timeout'
            ? 'upstream_dependency'
            : 'internal_contract';
        concernSemanticPlanBlockedTelemetryReason =
          plannerFailureClass === 'timeout'
            ? 'planner_timeout'
            : 'planner_untrusted';
      }
    }

    // ADR-024 Phase 1. Stamp the request's resolved region onto the target context LAST -- after the
    // concern semantic planner, because that branch REPLACES targetContext wholesale via
    // buildConcernTargetContextFromSemanticPlan, so stamping earlier would silently lose the region on
    // exactly the generic-concern lane where the budget ceiling is read.
    //
    // The budget ceiling is resolved from targetContext alone (finalizeConcernFrameworkCandidatePools
    // has no ctx in scope), so this is the wire that carries region to it. A path that never stamps
    // reads `undefined` and falls back to US/USD -- today's behavior, unchanged.
    if (targetContext && typeof targetContext === 'object') {
      targetContext = {
        ...targetContext,
        buyer_region: buyerRegionFromContext(ctx),
        buyer_region_source: pickFirstTrimmed(ctx && ctx.buyer_region_source) || 'defaulted',
      };
    }

    return {
      profileSummary,
      normalizedIngredientContext,
      analysisSummary,
      analysisSummaryAt,
      effectiveAnalysisContextSnapshot,
      recommendationTaskContext,
      analysisContextBlock,
      prefix,
      userAsk,
      targetContext,
      concernSemanticPlanTrace,
      concernSemanticPlanBlockedReason,
      concernSemanticPlanBlockedFailureClass,
      concernSemanticPlanBlockedFailureOrigin,
      concernSemanticPlanBlockedTelemetryReason,
      mainlineStageTimingsMs,
    };
  }

  return {
    buildLegacyRecoGenerationContext,
  };
}

module.exports = {
  createLegacyRecoGenerationContextRuntime,
};
