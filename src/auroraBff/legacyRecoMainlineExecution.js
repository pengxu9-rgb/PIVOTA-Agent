function createLegacyRecoMainlineExecutionRuntime(deps = {}) {
  const {
    pickFirstTrimmed,
    isPlainObject,
    finalizeConcernFrameworkCandidatePools,
    finalizeRecommendationCandidatePools,
    buildRecoGenerateFromCatalog,
    deriveRecoPdpFastFallbackReasonCode,
    buildRecoLlmPromptState,
    runRecoLlmPrimary,
    resolveConcernMainlineFailure,
    resolveRecoEffectiveFailure,
    normalizeRecoFailureClass,
    hasEmptyStructuredRecommendations,
    shouldUseRecoCatalogTransientFallback,
    buildRecoCatalogTransientFallbackStructured,
    recordAuroraRecoLlmCall,
  } = deps;

  async function runLegacyRecoMainlineExecution({
    concernSemanticPlanBlockedReason = '',
    concernSemanticPlanBlockedTelemetryReason = '',
    concernSemanticPlanBlockedFailureClass = '',
    concernSemanticPlanBlockedFailureOrigin = 'none',
    frameworkCatalogFirstEnabled = false,
    deterministicCatalogFirstEnabled = false,
    targetContext = null,
    recommendationTaskContext = null,
    profileSummary = null,
    normalizedIngredientContext = null,
    catalogExternalSeedStrategy = '',
    debug = false,
    logger,
    ctx,
    entryType = 'chat',
    userAsk = '',
    prefix = '',
    recentLogs = [],
    globalStatus = {},
    mainlineStageTimingsMs = {},
    RECO_MAIN_PROMPT_TEMPLATE_ID = 'reco_main_v1_2',
    RECO_PDP_FAST_EXTERNAL_FALLBACK_ENABLED = false,
  } = {}) {
    let upstream = null;
    let contextMeta = {};
    let upstreamFailureCode = '';
    let llmFailureClass = '';
    let llmLatencyMs = null;
    let catalogStructured = null;
    let catalogCandidatePool = [];
    let catalogCandidateState = null;
    let catalogDebug = null;
    let pdpFastFallbackReasonCode = null;
    let pdpFastExternalFallbackReasonCode = null;
    let catalogTransientFallbackStructured = null;

    let answerJson = null;
    let structured = null;
    let structuredSource = null;
    let llmStructured = null;
    let llmStructuredSource = null;
    let promptBundle = {
      prompt_spec: {
        template_id: RECO_MAIN_PROMPT_TEMPLATE_ID,
        llm_mode: null,
      },
      schema_chars: 0,
    };
    let query = '';
    let promptContract = { ok: true, issues: [] };
    let llmTrace = null;
    let llmInvoked = false;
    let initialLlmOutcome = 'not_invoked';
    let presentationMode = 'full_llm';
    let nonBlockingLlmIssue = 'none';
    let successMode = 'full_success';
    let effectiveFailureClass = 'none';
    let failureOrigin = 'none';
    let preLlmSelectedCandidateCount = null;
    let finalSelectedCandidateCount = null;

    if (concernSemanticPlanBlockedReason) {
      structured = {
        recommendations: [],
        products_empty_reason: concernSemanticPlanBlockedReason,
        telemetry_reason: concernSemanticPlanBlockedTelemetryReason || null,
        mainline_status: 'severe_parse_or_prompt_failure',
      };
      structuredSource = null;
      llmFailureClass = 'planner_untrusted';
      initialLlmOutcome = concernSemanticPlanBlockedReason;
      presentationMode = '';
      successMode = '';
      effectiveFailureClass =
        concernSemanticPlanBlockedFailureClass || 'planner_untrusted';
      failureOrigin =
        concernSemanticPlanBlockedFailureOrigin || 'internal_contract';
      catalogCandidateState = frameworkCatalogFirstEnabled
        ? finalizeConcernFrameworkCandidatePools([], { targetContext })
        : finalizeRecommendationCandidatePools([], {
            targetContext,
            recoContext: recommendationTaskContext,
          });
      catalogDebug = {
        recall_plan_version:
          pickFirstTrimmed(
            targetContext?.semantic_plan_version,
            null,
          ) || null,
        executed_query_count: 0,
        executed_upstream_attempt_count: 0,
        actual_http_attempt_count: 0,
        stage_timeout_counts: {},
        primary_stage_timeout_class:
          concernSemanticPlanBlockedTelemetryReason === 'planner_timeout'
            ? 'planner_timeout'
            : 'planner_untrusted',
        transport_policy_mode: null,
        candidate_drop_stage: concernSemanticPlanBlockedReason,
        selected_source_counts: {},
        external_seed_used_count: 0,
      };
    } else if (deterministicCatalogFirstEnabled) {
      const catalogRecallStartedAt = Date.now();
      const catalogOut = await buildRecoGenerateFromCatalog({
        ctx,
        profileSummary,
        ingredientContext: normalizedIngredientContext,
        recommendationTaskContext,
        targetContext,
        externalSeedStrategyOverride: catalogExternalSeedStrategy,
        allowStepAwareAdjacentFamilyFallback: String(entryType || '').trim().toLowerCase() === 'chat',
        debug,
        logger,
      });
      mainlineStageTimingsMs.catalog_recall = Math.max(
        0,
        Date.now() - catalogRecallStartedAt,
      );
      catalogStructured =
        catalogOut &&
        typeof catalogOut === 'object' &&
        catalogOut.structured &&
        typeof catalogOut.structured === 'object'
          ? catalogOut.structured
          : null;
      catalogCandidatePool =
        catalogOut &&
        typeof catalogOut === 'object' &&
        Array.isArray(catalogOut.candidate_pool)
          ? catalogOut.candidate_pool
          : [];
      catalogCandidateState =
        catalogOut &&
        typeof catalogOut === 'object' &&
        catalogOut.candidate_pool_state &&
        typeof catalogOut.candidate_pool_state === 'object'
          ? catalogOut.candidate_pool_state
          : finalizeRecommendationCandidatePools([], {
              targetContext,
              recoContext: recommendationTaskContext,
            });
      catalogDebug =
        catalogOut &&
        typeof catalogOut === 'object' &&
        catalogOut.debug &&
        typeof catalogOut.debug === 'object'
          ? catalogOut.debug
          : null;
      pdpFastFallbackReasonCode =
        deriveRecoPdpFastFallbackReasonCode(catalogDebug);
      pdpFastExternalFallbackReasonCode =
        RECO_PDP_FAST_EXTERNAL_FALLBACK_ENABLED
          ? pdpFastFallbackReasonCode
          : null;

      const promptState = buildRecoLlmPromptState({
        prefix,
        profileSummary,
        recentLogs,
        requestText: userAsk,
        lang: ctx.lang,
        globalStatus,
        ingredientContext: normalizedIngredientContext,
        candidates: catalogCandidatePool,
      });
      promptBundle = promptState.promptBundle;
      query = promptState.query;
      promptContract = promptState.promptContract;
      llmTrace = {
        ...promptState.llmTraceSeed,
        latency_ms: null,
        cache_hit: false,
        prompt_contract_ok: promptState.promptContract.ok,
        ...(promptState.promptContract.ok
          ? {}
          : {
              prompt_contract_issues:
                promptState.promptContract.issues.slice(0, 6),
            }),
      };

      preLlmSelectedCandidateCount = Number.isFinite(
        Number(catalogCandidateState?.pre_llm_selected_candidate_count),
      )
        ? Math.max(
            0,
            Math.trunc(
              Number(catalogCandidateState.pre_llm_selected_candidate_count),
            ),
          )
        : Number.isFinite(Number(catalogCandidateState?.selected_candidate_count))
          ? Math.max(
              0,
              Math.trunc(Number(catalogCandidateState.selected_candidate_count)),
            )
          : 0;
      finalSelectedCandidateCount = preLlmSelectedCandidateCount;
      structured = catalogStructured;
      structuredSource = catalogStructured ? 'catalog_grounded' : null;

      if (
        preLlmSelectedCandidateCount > 0 &&
        catalogCandidateState?.terminal_success === true &&
        !frameworkCatalogFirstEnabled
      ) {
        const llmPrimary = await runRecoLlmPrimary({
          ctx,
          logger,
          promptState,
          profileSummary,
        });
        upstream = llmPrimary.upstream;
        contextMeta = llmPrimary.contextMeta;
        upstreamFailureCode = llmPrimary.upstreamFailureCode;
        llmFailureClass = llmPrimary.llmFailureClass;
        llmLatencyMs = llmPrimary.llmLatencyMs;
        answerJson = llmPrimary.answerJson;
        llmStructured = llmPrimary.llmStructured;
        llmStructuredSource = llmPrimary.llmStructuredSource;
        llmTrace = llmPrimary.llmTrace;
        llmInvoked = llmPrimary.llmInvoked;
        initialLlmOutcome = llmPrimary.initialLlmOutcome;
        if (initialLlmOutcome === 'success') {
          presentationMode = 'full_llm';
          successMode = 'full_success';
        } else {
          presentationMode = 'deterministic_degraded';
          successMode = 'degraded_success';
          nonBlockingLlmIssue =
            String(initialLlmOutcome || '').trim().toLowerCase() ||
            'empty_structured';
          llmFailureClass = '';
        }
      } else {
        presentationMode = '';
        successMode = '';
      }
      const failureSignals = frameworkCatalogFirstEnabled
        ? resolveConcernMainlineFailure({
            plannerBlocked: false,
            viablePoolState: catalogCandidateState,
            catalogDebug,
          })
        : resolveRecoEffectiveFailure({
            targetContext,
            viablePoolState: catalogCandidateState,
            catalogDebug,
          });
      effectiveFailureClass =
        failureSignals.effective_failure_class || 'none';
      failureOrigin = failureSignals.failure_origin || 'none';
    } else {
      const promptState = buildRecoLlmPromptState({
        prefix,
        profileSummary,
        recentLogs,
        requestText: userAsk,
        lang: ctx.lang,
        globalStatus,
        ingredientContext: normalizedIngredientContext,
        candidates: catalogCandidatePool,
      });
      promptBundle = promptState.promptBundle;
      query = promptState.query;
      promptContract = promptState.promptContract;
      const llmPrimary = await runRecoLlmPrimary({
        ctx,
        logger,
        promptState,
        profileSummary,
      });
      upstream = llmPrimary.upstream;
      contextMeta = llmPrimary.contextMeta;
      upstreamFailureCode = llmPrimary.upstreamFailureCode;
      llmFailureClass = llmPrimary.llmFailureClass;
      llmLatencyMs = llmPrimary.llmLatencyMs;
      answerJson = llmPrimary.answerJson;
      llmStructured = llmPrimary.llmStructured;
      llmStructuredSource = llmPrimary.llmStructuredSource;
      llmTrace = llmPrimary.llmTrace;
      llmInvoked = llmPrimary.llmInvoked;
      initialLlmOutcome = llmPrimary.initialLlmOutcome;
      const normalizedNonStepAwareLlmFailure = normalizeRecoFailureClass(
        llmFailureClass || '',
      );
      const llmStructuredRecoEmpty =
        hasEmptyStructuredRecommendations(llmStructured);
      const shouldAttemptCatalogRecovery =
        !llmStructured ||
        normalizedNonStepAwareLlmFailure === 'schema_invalid' ||
        llmStructuredRecoEmpty;
      const shouldAllowCatalogTransientFallback =
        !llmStructured || llmStructuredRecoEmpty;
      if (shouldAttemptCatalogRecovery) {
        const catalogRecoveryStartedAt = Date.now();
        const catalogOut = await buildRecoGenerateFromCatalog({
          ctx,
          profileSummary,
          ingredientContext: normalizedIngredientContext,
          recommendationTaskContext,
          targetContext,
          externalSeedStrategyOverride: catalogExternalSeedStrategy,
          allowStepAwareAdjacentFamilyFallback: String(entryType || '').trim().toLowerCase() === 'chat',
          debug,
          logger,
        });
        mainlineStageTimingsMs.catalog_recall = Math.max(
          Number(mainlineStageTimingsMs.catalog_recall || 0),
          Math.max(0, Date.now() - catalogRecoveryStartedAt),
        );
        catalogStructured =
          catalogOut &&
          typeof catalogOut === 'object' &&
          catalogOut.structured &&
          typeof catalogOut.structured === 'object'
            ? catalogOut.structured
            : null;
        catalogCandidatePool =
          catalogOut &&
          typeof catalogOut === 'object' &&
          Array.isArray(catalogOut.candidate_pool)
            ? catalogOut.candidate_pool
            : [];
        catalogCandidateState =
          catalogOut &&
          typeof catalogOut === 'object' &&
          catalogOut.candidate_pool_state &&
          typeof catalogOut.candidate_pool_state === 'object'
            ? catalogOut.candidate_pool_state
            : null;
        catalogDebug =
          catalogOut &&
          typeof catalogOut === 'object' &&
          catalogOut.debug &&
          typeof catalogOut.debug === 'object'
            ? catalogOut.debug
            : null;
        pdpFastFallbackReasonCode =
          deriveRecoPdpFastFallbackReasonCode(catalogDebug);
        pdpFastExternalFallbackReasonCode =
          RECO_PDP_FAST_EXTERNAL_FALLBACK_ENABLED
            ? pdpFastFallbackReasonCode
            : null;
        const useCatalogTransientFallback =
          shouldAllowCatalogTransientFallback &&
          shouldUseRecoCatalogTransientFallback(catalogDebug);
        catalogTransientFallbackStructured =
          useCatalogTransientFallback &&
          !(targetContext && targetContext.step_aware_intent)
            ? buildRecoCatalogTransientFallbackStructured({ ctx })
            : null;
      }
      const catalogRecoveredFromLlmGap =
        (normalizedNonStepAwareLlmFailure === 'schema_invalid' ||
          llmStructuredRecoEmpty) &&
        catalogStructured &&
        Array.isArray(catalogStructured.recommendations) &&
        catalogStructured.recommendations.length > 0;
      structured = catalogRecoveredFromLlmGap
        ? catalogStructured
        : llmStructuredRecoEmpty
          ? (
              catalogStructured ||
              catalogTransientFallbackStructured ||
              llmStructured
            )
          : llmStructured ||
            catalogStructured ||
            catalogTransientFallbackStructured;
      structuredSource = catalogRecoveredFromLlmGap
        ? 'catalog_grounded'
        : llmStructuredRecoEmpty
          ? (
              catalogStructured
                ? 'catalog_grounded'
                : catalogTransientFallbackStructured
                  ? 'catalog_transient_fallback'
                  : llmStructured
                    ? 'llm_primary'
                    : null
            )
          : llmStructured
            ? 'llm_primary'
            : catalogStructured
              ? 'catalog_grounded'
              : catalogTransientFallbackStructured
                ? 'catalog_transient_fallback'
                : null;
      if (
        !deterministicCatalogFirstEnabled &&
        promptContract.ok &&
        catalogStructured &&
        Array.isArray(catalogStructured.recommendations) &&
        catalogStructured.recommendations.length > 0 &&
        (!llmStructured ||
          normalizedNonStepAwareLlmFailure === 'schema_invalid' ||
          llmStructuredRecoEmpty)
      ) {
        if (
          (llmFailureClass === 'empty_structured' ||
            llmFailureClass === 'schema_invalid') &&
          isPlainObject(llmTrace)
        ) {
          const { error_class: _ignoredErrorClass, ...nextTrace } = llmTrace;
          llmTrace = nextTrace;
        }
        if (normalizedNonStepAwareLlmFailure === 'schema_invalid') {
          initialLlmOutcome = 'catalog_recovered_schema_invalid';
        } else if (llmStructuredRecoEmpty) {
          initialLlmOutcome = 'catalog_recovered_empty_structured';
        }
        llmFailureClass = '';
        recordAuroraRecoLlmCall({
          stage: 'main',
          outcome: 'catalog_grounded_primary',
        });
      }
    }

    return {
      upstream,
      contextMeta,
      upstreamFailureCode,
      llmFailureClass,
      llmLatencyMs,
      catalogStructured,
      catalogCandidatePool,
      catalogCandidateState,
      catalogDebug,
      pdpFastFallbackReasonCode,
      pdpFastExternalFallbackReasonCode,
      catalogTransientFallbackStructured,
      answerJson,
      structured,
      structuredSource,
      llmStructured,
      llmStructuredSource,
      promptBundle,
      query,
      promptContract,
      llmTrace,
      llmInvoked,
      initialLlmOutcome,
      presentationMode,
      nonBlockingLlmIssue,
      successMode,
      effectiveFailureClass,
      failureOrigin,
      preLlmSelectedCandidateCount,
      finalSelectedCandidateCount,
      mainlineStageTimingsMs,
    };
  }

  return {
    runLegacyRecoMainlineExecution,
  };
}

module.exports = {
  createLegacyRecoMainlineExecutionRuntime,
};
