// The direct lane = consumer POST /v1/reco/generate and the agent-door tool `recommend_products`.
// Both reach generateProductRecommendations with entryType 'direct'; the chat lane uses 'chat' and is
// deliberately untouched by the pre-LLM recall below.
function isDirectRecoEntryType(entryType) {
  const token = String(entryType || '').trim().toLowerCase();
  return token === 'direct' || token === 'agent_tool';
}

// Should a fluent LLM answer that grounded to ZERO products be replaced by the catalog answer?
//
// The mainline's own recovery gate fires only on a missing / schema_invalid / empty answer, so an
// invented-but-well-formed list of archetypes counts as success today. This is the missing trigger.
//
// It is deliberately a pure predicate: the caller performs at most ONE swap and re-derives the tail
// with structuredSource 'catalog_grounded', which the grounding pass ignores — so it cannot loop.
function shouldRecoverFullyUngroundedDirectAnswer({
  enabled = true,
  entryType = 'chat',
  structuredSource = null,
  groundingApplied = false,
  groundedCount = 0,
  answerRecommendationCount = 0,
  catalogRecommendationCount = 0,
} = {}) {
  if (enabled !== true) return false;
  if (!isDirectRecoEntryType(entryType)) return false;
  // Only an LLM-primary answer can be ungrounded in this sense; a catalog answer is grounded by
  // construction and swapping it for itself would be a no-op at best.
  if (structuredSource !== 'llm_primary') return false;
  if (groundingApplied !== true) return false;
  if (Number(groundedCount || 0) !== 0) return false;
  // An EMPTY answer is already handled by the mainline recovery gate; this trigger is specifically the
  // "non-empty but 100% ungrounded" case.
  if (Number(answerRecommendationCount || 0) <= 0) return false;
  // Nothing to swap in: keep the ungrounded answer rather than emptying the response.
  if (Number(catalogRecommendationCount || 0) <= 0) return false;
  return true;
}

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
    RECO_DIRECT_RECALL_BEFORE_LLM_ENABLED = true,
    RECO_DIRECT_RECALL_BEFORE_LLM_MAX_QUERIES = 3,
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
    // Branch-B pre-LLM recall result, kept separate from `catalogStructured` so the LLM-success path
    // keeps reporting exactly what it reports today. It is the recovery source when the LLM answer is
    // missing/schema-invalid/empty, AND the recovery source for a fluent-but-fully-ungrounded answer
    // (see legacyRecoGenerationEngine).
    let preLlmCatalogStructured = null;
    let preLlmCatalogCandidateState = null;
    let preLlmCatalogDebug = null;
    let directRecallBeforeLlmApplied = false;

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
      // Recall BEFORE the LLM on the direct lane.
      //
      // Without this the LLM is asked to recommend products with `candidates: []` (catalogCandidatePool
      // is still the initial empty array here), and catalog recovery below only runs when the answer is
      // missing/schema-invalid/empty — so a fluent, entirely invented answer SUPPRESSES recall and the
      // caller gets archetypes with no product_id and no price. Bounded: one call, need-seeded queries,
      // the existing per-query timeouts, and the fail-fast circuit still short-circuits inside
      // buildRecoGenerateFromCatalog. The chat lane is untouched.
      const directRecallBeforeLlm =
        RECO_DIRECT_RECALL_BEFORE_LLM_ENABLED === true && isDirectRecoEntryType(entryType);
      if (directRecallBeforeLlm) {
        const preLlmRecallStartedAt = Date.now();
        const preLlmCatalogOut = await buildRecoGenerateFromCatalog({
          ctx,
          profileSummary,
          ingredientContext: normalizedIngredientContext,
          recommendationTaskContext,
          targetContext,
          externalSeedStrategyOverride: catalogExternalSeedStrategy,
          allowStepAwareAdjacentFamilyFallback: false,
          needSeedText: userAsk,
          maxGenericQueries: RECO_DIRECT_RECALL_BEFORE_LLM_MAX_QUERIES,
          debug,
          logger,
        });
        mainlineStageTimingsMs.catalog_recall = Math.max(
          Number(mainlineStageTimingsMs.catalog_recall || 0),
          Math.max(0, Date.now() - preLlmRecallStartedAt),
        );
        directRecallBeforeLlmApplied = true;
        preLlmCatalogStructured =
          preLlmCatalogOut &&
          typeof preLlmCatalogOut === 'object' &&
          preLlmCatalogOut.structured &&
          typeof preLlmCatalogOut.structured === 'object'
            ? preLlmCatalogOut.structured
            : null;
        preLlmCatalogCandidateState =
          preLlmCatalogOut &&
          typeof preLlmCatalogOut === 'object' &&
          preLlmCatalogOut.candidate_pool_state &&
          typeof preLlmCatalogOut.candidate_pool_state === 'object'
            ? preLlmCatalogOut.candidate_pool_state
            : null;
        preLlmCatalogDebug =
          preLlmCatalogOut &&
          typeof preLlmCatalogOut === 'object' &&
          preLlmCatalogOut.debug &&
          typeof preLlmCatalogOut.debug === 'object'
            ? preLlmCatalogOut.debug
            : null;
        catalogCandidatePool =
          preLlmCatalogOut &&
          typeof preLlmCatalogOut === 'object' &&
          Array.isArray(preLlmCatalogOut.candidate_pool)
            ? preLlmCatalogOut.candidate_pool
            : [];
      }
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
        // When the direct lane already ran recall before the LLM, that call used the same arguments
        // (plus the need seed) — re-running it would double the upstream cost for the same answer.
        const catalogOut = directRecallBeforeLlmApplied
          ? {
              structured: preLlmCatalogStructured,
              candidate_pool: catalogCandidatePool,
              candidate_pool_state: preLlmCatalogCandidateState,
              debug: preLlmCatalogDebug,
            }
          : await buildRecoGenerateFromCatalog({
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
      preLlmCatalogStructured,
      preLlmCatalogCandidateState,
      preLlmCatalogDebug,
      directRecallBeforeLlmApplied,
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
  isDirectRecoEntryType,
  shouldRecoverFullyUngroundedDirectAnswer,
};
