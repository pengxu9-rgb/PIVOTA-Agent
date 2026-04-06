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

function createLegacyChatRecoPostProcessingRuntime(deps = {}) {
  const {
    buildRecoMainlineContract,
    extractRecoOutcomeContractArgsFromPayload,
    applyIngredientRecoConstraint,
    mergeFieldMissing,
    restoreRecoRecommendationsFromVerifiedContextCandidates,
    applyVerifiedCandidateRestoreToRecoPayload,
    normalizeRecoProductsEmptyReason,
    ingredient_query_normalize,
    inferRecoSourceMode,
    sanitizeRecoClientVisibleToken,
    applyRecoWarningVisibilityContract,
    isTransientRecoUpstreamFailureCode,
    recordAuroraSkinFlowMetric,
  } = deps;

  function postProcessLegacyChatRecoResult({
    ctx,
    norm,
    upstreamReco = null,
    upstreamDebug = null,
    recoLlmTrace = null,
    recoContract = null,
    llmFailureClass = '',
    upstreamFailureCode = '',
    recoCatalogSkipReason = '',
    recoTelemetryFailureReason = '',
    recoMetaPromptTemplateId = '',
    recoMainlineStatus = '',
    recoTimeoutDegraded = false,
    recoTimeoutDegradedWarning = null,
    recoSource = '',
    llmPrimaryUsed = false,
    genericConcernRecoMainline = false,
    hasDeterministicRecoTarget = false,
    ingredientRecoOptInRequested = false,
    travelRecoHandoff = false,
    latestRecoContextPatch = null,
    recoContextIngredientQuery = '',
    recoIngredientCandidates = [],
    recoIngredientContext = null,
    recoProductCandidates = [],
    chatRecoTargetContext = null,
    profile = null,
    recentLogs = [],
    latestArtifact = null,
    logger = null,
    productMatcherEnabled = false,
    computeMatcherIfNeeded = null,
    recoTaskMode = '',
    verifiedCandidateRestoreApplied = false,
    verifiedCandidateRestoreCount = 0,
  } = {}) {
    if (!recoLlmTrace && isPlainObject(norm?.payload?.recommendation_meta?.llm_trace)) {
      recoLlmTrace = norm.payload.recommendation_meta.llm_trace;
    }
    if (!recoContract) {
      recoContract = buildRecoMainlineContract({
        recommendations: norm?.payload?.recommendations,
        sourceMode: norm?.payload?.recommendation_meta?.source_mode,
        source: norm?.payload?.source,
        llmFailureClass,
        upstreamFailureCode,
        promptContractOk: norm?.payload?.prompt_contract_ok !== false,
        fieldMissing: norm?.field_missing,
        structuredSource: norm?.payload?.recommendation_meta?.source_mode,
        catalogSkipReason: pickFirstTrimmed(norm?.payload?.recommendation_meta?.catalog_skip_reason, recoCatalogSkipReason),
        productsEmptyReason: norm?.payload?.products_empty_reason,
        groundingStatus: norm?.payload?.grounding_status || norm?.payload?.recommendation_meta?.grounding_status,
        groundedCount: norm?.payload?.grounded_count || norm?.payload?.recommendation_meta?.grounded_count,
        ungroundedCount: norm?.payload?.ungrounded_count || norm?.payload?.recommendation_meta?.ungrounded_count,
        mainlineStatusOverride: norm?.payload?.mainline_status || norm?.payload?.recommendation_meta?.mainline_status,
        promptTemplateId: norm?.payload?.recommendation_meta?.prompt_template_id,
        entryType: 'chat',
        ...extractRecoOutcomeContractArgsFromPayload(norm?.payload, upstreamReco?.contract),
      });
    }
    if (!recoMainlineStatus && isPlainObject(norm?.payload?.recommendation_meta)) {
      recoMainlineStatus = String(norm.payload.recommendation_meta.mainline_status || '').trim();
      recoCatalogSkipReason = String(norm.payload.recommendation_meta.catalog_skip_reason || '').trim();
      recoTelemetryFailureReason = String(norm.payload.recommendation_meta.telemetry_failure_reason || '').trim();
      recoMetaPromptTemplateId = String(norm.payload.recommendation_meta.prompt_template_id || '').trim();
    }
    if (!recoMainlineStatus && recoContract && recoContract.mainline_status) {
      recoMainlineStatus = String(recoContract.mainline_status || '').trim();
    }
    if (!recoCatalogSkipReason && recoContract && recoContract.catalog_skip_reason) {
      recoCatalogSkipReason = String(recoContract.catalog_skip_reason || '').trim();
    }
    if (!recoTelemetryFailureReason && recoContract && recoContract.telemetry_failure_reason) {
      recoTelemetryFailureReason = String(recoContract.telemetry_failure_reason || '').trim();
    }
    if (!recoMetaPromptTemplateId && recoContract && recoContract.prompt_template_id) {
      recoMetaPromptTemplateId = String(recoContract.prompt_template_id || '').trim();
    }

    const generatedRecoCount = Array.isArray(norm?.payload?.recommendations) ? norm.payload.recommendations.length : 0;
    const generatedPayloadSource = String(norm?.payload?.source || '').trim().toLowerCase();
    const generatedSourceMode = String(norm?.payload?.recommendation_meta?.source_mode || '').trim().toLowerCase();
    const generatedPrimaryUsed =
      generatedRecoCount > 0 &&
      ['llm_primary', 'catalog_grounded', 'catalog_transient_fallback'].includes(generatedSourceMode);
    llmPrimaryUsed =
      generatedPrimaryUsed &&
      (generatedSourceMode === 'llm_primary' || generatedPayloadSource.includes('llm_primary'));
    if (llmPrimaryUsed) {
      recoSource = 'llm_primary_v1';
    } else if (generatedPrimaryUsed) {
      recoSource = generatedPayloadSource || generatedSourceMode || 'catalog_grounded_v1';
    } else if (generatedRecoCount > 0) {
      recoSource = generatedPayloadSource
        || generatedSourceMode
        || (
          genericConcernRecoMainline
            ? 'framework_mainline_v1'
            : hasDeterministicRecoTarget
              ? 'step_aware_mainline_v1'
              : 'legacy_notice'
        );
    }
    if (!generatedRecoCount && String(recoContract?.telemetry_failure_reason || '').trim().toLowerCase() === 'timeout_degraded') {
      recoTimeoutDegraded = true;
    }

    let matcherBundle = null;
    let matcherPayload = null;
    if (!generatedPrimaryUsed && !ingredientRecoOptInRequested && typeof computeMatcherIfNeeded === 'function') {
      ({ matcherBundle, matcherPayload } = computeMatcherIfNeeded());
    }

    const shouldApplyPhotoIngredientConstraint =
      !ingredientRecoOptInRequested
      && !travelRecoHandoff
      && isPlainObject(norm?.payload)
      && String(latestRecoContextPatch?.context_origin || '').trim().toLowerCase() === 'photo_modules_v1'
      && Boolean(pickFirstTrimmed(recoContextIngredientQuery));
    if ((ingredientRecoOptInRequested || shouldApplyPhotoIngredientConstraint) && isPlainObject(norm?.payload)) {
      const constrained = applyIngredientRecoConstraint(norm.payload, recoIngredientContext);
      if (constrained.constrained) {
        norm.payload = constrained.payload;
      }
      norm.payload = {
        ...norm.payload,
        constraint_match_summary: {
          total: Number(constrained.totalCount || 0),
          matched: Number(constrained.keptCount || 0),
          dropped: Number(constrained.droppedCount || 0),
        },
      };
      if (constrained.droppedCount > 0) {
        norm.field_missing = mergeFieldMissing(norm.field_missing, [
          { field: 'payload.recommendations', reason: 'ingredient_constraint_filtered' },
        ]);
      }
      if (constrained.keptCount === 0) {
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
          const restoredPayload = applyVerifiedCandidateRestoreToRecoPayload(norm.payload, restoredRecommendations);
          norm.payload = restoredPayload.payload;
          norm.field_missing = (Array.isArray(norm.field_missing) ? norm.field_missing : []).filter((row) => {
            const reason = String(row && row.reason ? row.reason : '').trim().toLowerCase();
            return reason !== 'ingredient_constraint_filtered' && reason !== 'ingredient_constraint_no_match';
          });
          recoSource = 'catalog_grounded_v1';
          recoMainlineStatus = 'grounded_success';
          recoTelemetryFailureReason = '';
        } else {
          norm.payload = {
            ...norm.payload,
            failure_reason: 'ingredient_constraint_no_match',
            products_empty_reason: 'ingredient_constraint_no_match',
          };
          norm.field_missing = mergeFieldMissing(norm.field_missing, [
            { field: 'payload.recommendations', reason: 'ingredient_constraint_no_match' },
          ]);
          recoMainlineStatus = 'needs_more_context';
          recoTelemetryFailureReason = '';
        }
      }
    }

    const genericVerifiedRestoreReason = normalizeRecoProductsEmptyReason(
      pickFirstTrimmed(
        norm?.payload?.products_empty_reason,
        norm?.payload?.failure_reason,
        recoContract?.primary_failure_reason,
        recoContract?.surface_reason,
        recoContract?.effective_failure_class,
      ),
    );
    const shouldAttemptGenericVerifiedRestore =
      !verifiedCandidateRestoreApplied
      && !travelRecoHandoff
      && isPlainObject(norm?.payload)
      && (!Array.isArray(norm.payload.recommendations) || norm.payload.recommendations.length === 0)
      && Array.isArray((recoIngredientContext || latestRecoContextPatch)?.product_candidates)
      && (recoIngredientContext || latestRecoContextPatch).product_candidates.length > 0
      && (
        !genericVerifiedRestoreReason
        || genericVerifiedRestoreReason === 'no_viable_candidates_for_target'
        || genericVerifiedRestoreReason === 'weak_viable_pool'
        || genericVerifiedRestoreReason === 'reco_mainline_empty'
        || genericVerifiedRestoreReason === 'post_processing_eliminated_candidates'
        || genericVerifiedRestoreReason === 'ingredient_constraint_no_match'
      );
    if (shouldAttemptGenericVerifiedRestore) {
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
        const restoredPayload = applyVerifiedCandidateRestoreToRecoPayload(norm.payload, restoredRecommendations);
        norm.payload = restoredPayload.payload;
        norm.field_missing = (Array.isArray(norm.field_missing) ? norm.field_missing : []).filter((row) => {
          const reason = String(row && row.reason ? row.reason : '').trim().toLowerCase();
          return reason !== 'ingredient_constraint_filtered' && reason !== 'ingredient_constraint_no_match';
        });
        recoSource = 'catalog_grounded_v1';
        recoMainlineStatus = 'grounded_success';
        recoTelemetryFailureReason = '';
      }
    }

    if (recoTaskMode === 'ingredient_lookup_no_candidates' && isPlainObject(norm?.payload)) {
      norm.payload = {
        ...norm.payload,
        recommendations: [],
        products_empty_reason: norm.payload.products_empty_reason || 'ingredient_no_verified_candidates',
        recommendation_confidence_score: 0,
        recommendation_confidence_level: 'low',
        task_mode: recoTaskMode,
        empty_match_actions: [
          {
            action_id: 'broaden_to_goal',
            label: ctx.lang === 'CN' ? '扩展到目标推荐' : 'Broaden to goal-based products',
          },
          {
            action_id: 'check_product_inci',
            label: ctx.lang === 'CN' ? '查看某产品INCI表' : 'Check a product INCI',
          },
          {
            action_id: 'search_category',
            label: ctx.lang === 'CN' ? '按品类搜索' : 'Search within a category',
          },
        ],
      };
      norm.field_missing = mergeFieldMissing(norm.field_missing, [
        { field: 'payload.recommendations', reason: 'ingredient_no_verified_candidates' },
      ]);
    }

    if (recoTaskMode.startsWith('ingredient_') && isPlainObject(norm?.payload)) {
      const ingredientQueryForFilter = ingredient_query_normalize(recoContextIngredientQuery || '');
      if (ingredientQueryForFilter && isPlainObject(norm.payload.evidence) && isPlainObject(norm.payload.evidence.science)) {
        const rawKeyIngredients = Array.isArray(norm.payload.evidence.science.key_ingredients)
          ? norm.payload.evidence.science.key_ingredients
          : [];
        const filteredKeyIngredients = rawKeyIngredients.filter((item) => {
          const lower = String(item || '').trim().toLowerCase();
          return lower.includes(ingredientQueryForFilter) || ingredientQueryForFilter.includes(lower);
        });
        norm.payload.evidence.science.key_ingredients = filteredKeyIngredients;
      }
      norm.payload.ingredient_evidence = {
        query: recoContextIngredientQuery || '',
        task_mode: recoTaskMode,
        ingredient_candidates: recoIngredientCandidates,
        product_candidates_count: Array.isArray((recoIngredientContext || latestRecoContextPatch)?.product_candidates)
          ? (recoIngredientContext || latestRecoContextPatch).product_candidates.length
          : recoProductCandidates.length,
      };
    }

    if (llmPrimaryUsed && isPlainObject(norm?.payload)) {
      norm.payload = {
        ...norm.payload,
        metadata: {
          ...(isPlainObject(norm.payload.metadata) ? norm.payload.metadata : {}),
          matcher_check_result: {
            source: 'artifact_matcher_v1',
            pending: true,
            available: false,
            recommendation_count: 0,
            confidence: null,
          },
        },
      };
      if (productMatcherEnabled && latestArtifact && typeof computeMatcherIfNeeded === 'function') {
        const matcherHandle = setImmediate(() => {
          const { matcherBundle: asyncMatcherBundle, matcherPayload: asyncMatcherPayload } = computeMatcherIfNeeded();
          const asyncRecoCount = Array.isArray(asyncMatcherPayload?.recommendations)
            ? asyncMatcherPayload.recommendations.length
            : 0;
          const asyncMatcherConfidence =
            asyncMatcherBundle &&
            asyncMatcherBundle.confidence &&
            Number.isFinite(Number(asyncMatcherBundle.confidence.score))
              ? Number(asyncMatcherBundle.confidence.score)
              : null;
          logger?.info(
            {
              request_id: ctx.request_id,
              trace_id: ctx.trace_id,
              recommendation_count: asyncRecoCount,
              confidence: asyncMatcherConfidence,
            },
            'aurora bff: matcher check finished asynchronously',
          );
        });
        if (matcherHandle && typeof matcherHandle.unref === 'function') matcherHandle.unref();
      }
    }

    const initialHasRecs = Array.isArray(norm?.payload?.recommendations)
      ? norm.payload.recommendations.length > 0
      : false;
    if (!initialHasRecs && isTransientRecoUpstreamFailureCode(upstreamFailureCode)) {
      recoTimeoutDegraded = true;
    }
    if (recoTimeoutDegraded) {
      logger?.info({ kind: 'metric', name: 'aurora.skin.reco.timeout_degraded_rate', value: 1 }, 'metric');
      recordAuroraSkinFlowMetric({ stage: 'reco_timeout_degraded', hit: true });
      const timeoutDegradedSourceMode = inferRecoSourceMode(
        recoContract?.source_mode,
        recoContract?.source,
        {
          defaultValue:
            genericConcernRecoMainline
              ? 'framework_mainline'
              : hasDeterministicRecoTarget
                ? 'step_aware_mainline'
                : 'legacy_notice',
        },
      );
      const timeoutDegradedReason = sanitizeRecoClientVisibleToken(
        pickFirstTrimmed(
          recoContract?.products_empty_reason,
          recoContract?.surface_reason,
          recoContract?.primary_failure_reason,
        ),
      ) || (
        genericConcernRecoMainline || hasDeterministicRecoTarget
          ? 'upstream_timeout_primary_role'
          : 'needs_more_context'
      );
      recoTimeoutDegradedWarning = {
        reco_timeout_degraded_warning: true,
        reco_timeout_degraded_reason: timeoutDegradedReason,
        reco_timeout_degraded_source_mode: timeoutDegradedSourceMode,
        ...(upstreamFailureCode ? { reco_timeout_degraded_upstream_failure_code: upstreamFailureCode } : {}),
      };
    }

    const promptContractOkFromTrace =
      isPlainObject(upstreamDebug?.llm_prompt_trace)
        ? upstreamDebug.llm_prompt_trace.prompt_contract_ok !== false
        : true;
    if (isPlainObject(norm?.payload)) {
      const warningContract = applyRecoWarningVisibilityContract(norm.payload);
      norm.payload = {
        ...warningContract.payload,
        prompt_contract_ok:
          norm.payload.prompt_contract_ok === false
            ? false
            : promptContractOkFromTrace,
      };
    }

    return {
      norm,
      recoLlmTrace,
      recoContract,
      recoCatalogSkipReason,
      recoTelemetryFailureReason,
      recoMetaPromptTemplateId,
      recoMainlineStatus,
      recoTimeoutDegraded,
      recoTimeoutDegradedWarning,
      recoSource,
      llmPrimaryUsed,
      generatedPrimaryUsed,
      generatedSourceMode,
      matcherBundle,
      matcherPayload,
      latestRecoContextPatch,
      recoIngredientContext,
      verifiedCandidateRestoreApplied,
      verifiedCandidateRestoreCount,
      initialHasRecs,
    };
  }

  return {
    postProcessLegacyChatRecoResult,
  };
}

module.exports = {
  createLegacyChatRecoPostProcessingRuntime,
};
