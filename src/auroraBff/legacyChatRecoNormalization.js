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

function createLegacyChatRecoNormalizationRuntime(deps = {}) {
  const {
    stripInternalRefsDeep,
    buildRecoLlmTraceRef,
    extractRecoOutcomeContractArgsFromPayload,
    buildRecoMainlineContract,
    normalizeRecoGroundingStatus,
    attachRecoContractMeta,
    restorePlanOnlyRecommendations,
    applyRecoContentSpineToPayload,
    shouldApplyRecoFinalSelectionContract,
    buildRecoFinalSelectionContract,
    applyRecoFinalSelectionContractToPayload,
    applyRecoAssistantSelectionSignature,
    extractRecoContextProductCandidatesFromRecommendations,
    mergeIngredientRecoContextValue,
    normalizeRecoCatalogProduct,
    joinBrandAndName,
    BEAUTY_DISCOVERY_MAINLINE_OWNER = 'shopping_agent_beauty_mainline',
    RECO_MAIN_PROMPT_TEMPLATE_ID = 'aurora_reco_main_v1',
  } = deps;

  function normalizeLegacyChatRecoPayload({
    norm,
    debugUpstream = false,
    recoLlmTrace = null,
    recoTaskMode = '',
    artifactConfidenceLevel = '',
    artifactConfidenceScore = null,
    lowConfidenceArtifact = false,
    recoSource = '',
    recoContract = null,
    matcherFallbackUsed = false,
    generatedPrimaryUsed = false,
    generatedSourceMode = '',
    llmPrimaryUsed = false,
    genericConcernRecoMainline = false,
    hasDeterministicRecoTarget = false,
    normalizedRecoTriggerSource = '',
    shouldAutoRerunRecommendationsFromProfilePatch = false,
    recentLogs = [],
    profile = null,
    recoTelemetryFailureReason = '',
    llmFailureClass = '',
    recoCatalogSkipReason = '',
    upstreamFailureCode = '',
    recoMainlineStatus = '',
    initialHasRecs = false,
    latestRecoContextPatch = null,
    verifiedCandidateRestoreApplied = false,
    verifiedCandidateRestoreCount = 0,
    recoMetaPromptTemplateId = '',
    genericGoalDrivenNeedsMoreContextWarning = null,
    recoTimeoutDegradedWarning = null,
    recoIngredientContext = null,
  } = {}) {
    const payload = !debugUpstream ? stripInternalRefsDeep(norm.payload) : norm.payload;
    const llmTraceRef = buildRecoLlmTraceRef(recoLlmTrace);
    if (!isPlainObject(payload)) {
      return {
        payload,
        recoContract,
        recoMainlineStatus,
        latestRecoContextPatch,
        llmTraceRef,
      };
    }

    const noCandidatesMode =
      recoTaskMode === 'ingredient_lookup_no_candidates'
      || String(payload.products_empty_reason || '').trim() === 'ingredient_no_verified_candidates';
    const payloadHasRecs = Array.isArray(payload.recommendations) && payload.recommendations.length > 0;
    payload.recommendation_confidence_level = noCandidatesMode ? 'low' : artifactConfidenceLevel;
    if (noCandidatesMode) {
      payload.recommendation_confidence_score = 0;
    } else if (artifactConfidenceScore != null) {
      payload.recommendation_confidence_score = artifactConfidenceScore;
    }
    if (!payloadHasRecs && !noCandidatesMode && lowConfidenceArtifact) {
      payload.failure_reason = String(payload.failure_reason || '').trim() || 'low_confidence';
    }
    payload.source = String(payload.source || '').trim() || recoSource;
    const metaExisting = isPlainObject(payload.recommendation_meta) ? payload.recommendation_meta : {};
    const derivedSourceMode = pickFirstTrimmed(
      metaExisting.source_mode,
      recoContract?.source_mode,
      matcherFallbackUsed
        ? 'artifact_matcher'
        : generatedPrimaryUsed
          ? (generatedSourceMode || 'catalog_grounded')
          : llmPrimaryUsed
            ? 'llm_primary'
            : genericConcernRecoMainline
              ? 'framework_mainline'
              : hasDeterministicRecoTarget
                ? 'step_aware_mainline'
                : 'legacy_notice',
    );
    const payloadOutcomeArgs = extractRecoOutcomeContractArgsFromPayload(payload, recoContract);
    payload.recommendation_meta = {
      ...metaExisting,
      task_mode: recoTaskMode,
      source_mode: derivedSourceMode,
      trigger_source: normalizedRecoTriggerSource,
      recompute_from_profile_update: shouldAutoRerunRecommendationsFromProfilePatch === true,
      used_recent_logs: Array.isArray(recentLogs) && recentLogs.length > 0,
      used_itinerary: Boolean(profile && (profile.itinerary || profile.travel_plan || profile.travel_plans)),
      used_safety_flags: lowConfidenceArtifact,
      primary_failure_reason: payloadHasRecs
        ? null
        : pickFirstTrimmed(
          recoContract?.primary_failure_reason,
          payload.failure_reason,
          payload.products_empty_reason,
          genericConcernRecoMainline || hasDeterministicRecoTarget
            ? 'no_recall_from_planned_sources'
            : 'needs_more_context',
        ),
      telemetry_failure_reason: recoTelemetryFailureReason || null,
      failure_class: llmFailureClass || metaExisting.failure_class || recoContract?.failure_class || null,
      effective_failure_class: payloadOutcomeArgs.effectiveFailureClass || metaExisting.effective_failure_class || 'none',
      failure_origin: payloadOutcomeArgs.failureOrigin || metaExisting.failure_origin || 'none',
      catalog_skip_reason: recoCatalogSkipReason || null,
      upstream_failure_code: upstreamFailureCode || null,
      mainline_status: recoMainlineStatus || (initialHasRecs ? 'grounded_success' : 'empty_structured'),
      grounding_status: pickFirstTrimmed(payload.grounding_status, metaExisting.grounding_status) || null,
      grounded_count: Number.isFinite(Number(payload.grounded_count)) ? Number(payload.grounded_count) : Number(metaExisting.grounded_count || 0) || 0,
      ungrounded_count: Number.isFinite(Number(payload.ungrounded_count)) ? Number(payload.ungrounded_count) : Number(metaExisting.ungrounded_count || 0) || 0,
      ...(latestRecoContextPatch?.resolved_target_step ? { resolved_target_step: latestRecoContextPatch.resolved_target_step } : {}),
      ...(latestRecoContextPatch?.resolved_target_step_confidence ? { resolved_target_step_confidence: latestRecoContextPatch.resolved_target_step_confidence } : {}),
      ...(latestRecoContextPatch?.resolved_target_step_source ? { resolved_target_step_source: latestRecoContextPatch.resolved_target_step_source } : {}),
      ...(verifiedCandidateRestoreApplied ? { verified_candidate_restore_applied: true, verified_candidate_restore_count: verifiedCandidateRestoreCount } : {}),
      ...(payloadOutcomeArgs.viablePoolStrength ? { viable_pool_strength: payloadOutcomeArgs.viablePoolStrength } : {}),
      ...(payloadOutcomeArgs.targetFidelityLevel ? { target_fidelity_level: payloadOutcomeArgs.targetFidelityLevel } : {}),
      ...(typeof payloadOutcomeArgs.terminalSuccess === 'boolean' ? { terminal_success: payloadOutcomeArgs.terminalSuccess } : {}),
      ...(payloadOutcomeArgs.presentationMode ? { presentation_mode: payloadOutcomeArgs.presentationMode } : {}),
      ...(payloadOutcomeArgs.successMode ? { success_mode: payloadOutcomeArgs.successMode } : {}),
      ...(Number.isFinite(Number(payloadOutcomeArgs.preLlmSelectedCandidateCount)) ? { pre_llm_selected_candidate_count: Number(payloadOutcomeArgs.preLlmSelectedCandidateCount) } : {}),
      ...(Number.isFinite(Number(payloadOutcomeArgs.finalSelectedCandidateCount)) ? { final_selected_candidate_count: Number(payloadOutcomeArgs.finalSelectedCandidateCount) } : {}),
      ...(Number.isFinite(Number(payloadOutcomeArgs.postGuardrailCount)) ? { post_guardrail_count: Number(payloadOutcomeArgs.postGuardrailCount) } : {}),
      prompt_template_id: pickFirstTrimmed(
        payload.prompt_template_id,
        recoMetaPromptTemplateId,
        RECO_MAIN_PROMPT_TEMPLATE_ID,
      ),
      ...(recoLlmTrace ? { llm_trace: recoLlmTrace } : {}),
      ...(genericGoalDrivenNeedsMoreContextWarning || {}),
      ...(recoTimeoutDegradedWarning || {}),
    };
    payload.metadata = {
      ...(isPlainObject(payload.metadata) ? payload.metadata : {}),
      llm_trace_ref: llmTraceRef,
      llm_failure_class: llmFailureClass || null,
      mainline_status: recoMainlineStatus || (initialHasRecs ? 'grounded_success' : 'empty_structured'),
      catalog_skip_reason: recoCatalogSkipReason || null,
      ...(genericGoalDrivenNeedsMoreContextWarning || {}),
      ...(recoTimeoutDegradedWarning || {}),
      ...(verifiedCandidateRestoreApplied ? { verified_candidate_restore_applied: true, verified_candidate_restore_count: verifiedCandidateRestoreCount } : {}),
    };

    const finalRecoContract = buildRecoMainlineContract({
      recommendations: payload.recommendations,
      sourceMode: payload.recommendation_meta && payload.recommendation_meta.source_mode,
      source: payload.source,
      llmFailureClass: llmFailureClass || recoContract?.failure_class,
      upstreamFailureCode,
      promptContractOk: payload.prompt_contract_ok !== false,
      fieldMissing: norm?.field_missing,
      structuredSource: payload.recommendation_meta && payload.recommendation_meta.source_mode,
      catalogSkipReason: payload.recommendation_meta && payload.recommendation_meta.catalog_skip_reason,
      productsEmptyReason: payload.products_empty_reason,
      groundingStatus: payload.recommendation_meta && payload.recommendation_meta.grounding_status,
      groundedCount: payload.recommendation_meta && payload.recommendation_meta.grounded_count,
      ungroundedCount: payload.recommendation_meta && payload.recommendation_meta.ungrounded_count,
      mainlineStatusOverride: payload.recommendation_meta && payload.recommendation_meta.mainline_status,
      promptTemplateId: payload.recommendation_meta && payload.recommendation_meta.prompt_template_id,
      entryType: 'chat',
      ...extractRecoOutcomeContractArgsFromPayload(payload, recoContract),
    });
    finalRecoContract.mainline_status = pickFirstTrimmed(
      payload.mainline_status,
      payload.recommendation_meta && payload.recommendation_meta.mainline_status,
      finalRecoContract.mainline_status,
    ) || finalRecoContract.mainline_status;
    finalRecoContract.grounding_status = normalizeRecoGroundingStatus(
      payload.grounding_status || (payload.recommendation_meta && payload.recommendation_meta.grounding_status),
    ) || finalRecoContract.grounding_status || null;
    finalRecoContract.grounded_count = Number.isFinite(Number(payload.grounded_count))
      ? Number(payload.grounded_count)
      : Number.isFinite(Number(payload.recommendation_meta?.grounded_count))
        ? Number(payload.recommendation_meta.grounded_count)
        : finalRecoContract.grounded_count;
    finalRecoContract.ungrounded_count = Number.isFinite(Number(payload.ungrounded_count))
      ? Number(payload.ungrounded_count)
      : Number.isFinite(Number(payload.recommendation_meta?.ungrounded_count))
        ? Number(payload.recommendation_meta.ungrounded_count)
        : finalRecoContract.ungrounded_count;
    finalRecoContract.prompt_template_id = pickFirstTrimmed(
      payload.recommendation_meta && payload.recommendation_meta.prompt_template_id,
      finalRecoContract.prompt_template_id,
    ) || finalRecoContract.prompt_template_id;
    recoContract = finalRecoContract;

    const nextPayload = attachRecoContractMeta(
      restorePlanOnlyRecommendations(payload, {
        sourceMode: finalRecoContract.source_mode,
      }),
      finalRecoContract,
    );
    Object.assign(payload, nextPayload);
    recoContract = buildRecoMainlineContract({
      recommendations: payload.recommendations,
      sourceMode: payload.recommendation_meta && payload.recommendation_meta.source_mode,
      source: payload.source,
      llmFailureClass: llmFailureClass || recoContract?.failure_class,
      upstreamFailureCode,
      promptContractOk: payload.prompt_contract_ok !== false,
      fieldMissing: norm?.field_missing,
      structuredSource: payload.recommendation_meta && payload.recommendation_meta.source_mode,
      catalogSkipReason: payload.recommendation_meta && payload.recommendation_meta.catalog_skip_reason,
      productsEmptyReason: payload.products_empty_reason,
      groundingStatus: payload.recommendation_meta && payload.recommendation_meta.grounding_status,
      groundedCount: payload.recommendation_meta && payload.recommendation_meta.grounded_count,
      ungroundedCount: payload.recommendation_meta && payload.recommendation_meta.ungrounded_count,
      mainlineStatusOverride: payload.recommendation_meta && payload.recommendation_meta.mainline_status,
      promptTemplateId: payload.recommendation_meta && payload.recommendation_meta.prompt_template_id,
      entryType: 'chat',
      ...extractRecoOutcomeContractArgsFromPayload(payload, recoContract),
    });
    Object.assign(payload, attachRecoContractMeta(payload, recoContract));
    Object.assign(
      payload,
      applyRecoContentSpineToPayload(payload, recoIngredientContext || latestRecoContextPatch),
    );
    if (shouldApplyRecoFinalSelectionContract(payload, null)) {
      const finalSelectionContract = buildRecoFinalSelectionContract({
        payload,
        fallbackSelection: null,
        selectionOwner: BEAUTY_DISCOVERY_MAINLINE_OWNER,
      });
      Object.assign(payload, applyRecoFinalSelectionContractToPayload(payload, finalSelectionContract));
      Object.assign(payload, applyRecoAssistantSelectionSignature(payload));
      recoMainlineStatus = pickFirstTrimmed(
        finalSelectionContract.mainline_status,
        recoMainlineStatus,
      ) || recoMainlineStatus;
      if (isPlainObject(recoContract)) {
        recoContract.mainline_status = pickFirstTrimmed(
          finalSelectionContract.mainline_status,
          recoContract.mainline_status,
        ) || recoContract.mainline_status;
      }
    }
    if (genericGoalDrivenNeedsMoreContextWarning || recoTimeoutDegradedWarning) {
      payload.metadata = {
        ...(isPlainObject(payload.metadata) ? payload.metadata : {}),
        ...(genericGoalDrivenNeedsMoreContextWarning || {}),
        ...(recoTimeoutDegradedWarning || {}),
      };
    }
    const finalSelectedProductCandidates = extractRecoContextProductCandidatesFromRecommendations(
      Array.isArray(payload?.recommendations) ? payload.recommendations : [],
      {
        max: 12,
        normalizeRecoCatalogProduct,
        pickFirstTrimmed,
        joinBrandAndName,
        isPlainObject,
      },
    );
    latestRecoContextPatch = mergeIngredientRecoContextValue(latestRecoContextPatch, {
      primary_focus: payload?.recommendation_meta?.primary_focus,
      confidence_policy: payload?.recommendation_meta?.confidence_policy,
      ranked_targets: Array.isArray(payload?.recommendation_meta?.ranked_targets)
        ? payload.recommendation_meta.ranked_targets
        : [],
      primary_target_id: pickFirstTrimmed(payload?.recommendation_meta?.primary_target_id),
      selected_target_ids: Array.isArray(payload?.recommendation_meta?.selected_target_ids)
        ? payload.recommendation_meta.selected_target_ids
        : [],
      ...(finalSelectedProductCandidates.length ? { product_candidates: finalSelectedProductCandidates } : {}),
    });

    return {
      payload,
      recoContract,
      recoMainlineStatus,
      latestRecoContextPatch,
      llmTraceRef,
    };
  }

  return {
    normalizeLegacyChatRecoPayload,
  };
}

module.exports = {
  createLegacyChatRecoNormalizationRuntime,
};
