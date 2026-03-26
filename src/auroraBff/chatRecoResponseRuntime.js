function defaultIsPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function defaultPickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function createChatRecoResponseRuntime(options = {}) {
  const {
    logger = null,
    isPlainObject = defaultIsPlainObject,
    pickFirstTrimmed = defaultPickFirstTrimmed,
    stateChangeAllowed = () => false,
    applyRecoWarningVisibilityContract = (payload) => ({ payload }),
    RECO_MAIN_PROMPT_TEMPLATE_ID = '',
    buildRecoLlmTraceRef,
    buildRouteAwareAssistantText,
    addEmotionalPreambleToAssistantText,
    stripInternalRefsDeep,
    buildIngredientPlanCard,
    appendLatestArtifactToSessionPatch,
    appendLatestRecoContextToSessionPatch,
    deriveRecoEmptyReason,
    recordAuroraRecoKbWrite = () => {},
    saveRecoRun = () => Promise.resolve(),
    recordAuroraSkinFlowMetric = () => {},
    normalizeRecoSourceDetail = (value) => value,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat reco response runtime missing dependency: ${name}`);
  }

  function finalizeRecoSuccess({
    ctx,
    norm,
    debugUpstream = false,
    upstreamDebug = null,
    alternativesDebug = null,
    recoLlmTrace = null,
    llmFailureClass = '',
    llmPrimaryUsed = false,
    matcherFallbackUsed = false,
    generatedPrimaryUsed = false,
    generatedSourceMode = '',
    generatedPayloadSource = '',
    recoSource = '',
    recoTaskMode = '',
    profile = null,
    recentLogs = [],
    latestArtifact = null,
    mappedIngredientPlan = null,
    matcherBundle = null,
    identity = {},
    artifactConfidenceLevel = 'unknown',
    artifactConfidenceScore = null,
    artifactGateOk = true,
    recoEntrySourceDetail = '',
    actionId = '',
    recoRequestMessage = '',
    includeAlternatives = false,
    recoContextIngredientQuery = '',
    recoContextGoal = '',
    recoIngredientCandidates = [],
    recoProductCandidates = [],
    recoIngredientContext = null,
    lowConfidenceArtifact = false,
    refinementChips = [],
    profileScore = 0,
    shouldAutoRerunRecommendationsFromProfilePatch = false,
    safetyWarnText = '',
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
  } = {}) {
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const buildRecoLlmTraceRefFn = requireFunction('buildRecoLlmTraceRef', buildRecoLlmTraceRef);
    const buildRouteAwareAssistantTextFn = requireFunction('buildRouteAwareAssistantText', buildRouteAwareAssistantText);
    const addEmotionalPreambleToAssistantTextFn = requireFunction(
      'addEmotionalPreambleToAssistantText',
      addEmotionalPreambleToAssistantText,
    );
    const stripInternalRefsDeepFn = requireFunction('stripInternalRefsDeep', stripInternalRefsDeep);
    const buildIngredientPlanCardFn = requireFunction('buildIngredientPlanCard', buildIngredientPlanCard);
    const appendLatestArtifactToSessionPatchFn = requireFunction(
      'appendLatestArtifactToSessionPatch',
      appendLatestArtifactToSessionPatch,
    );
    const appendLatestRecoContextToSessionPatchFn = requireFunction(
      'appendLatestRecoContextToSessionPatch',
      appendLatestRecoContextToSessionPatch,
    );
    const deriveRecoEmptyReasonFn = requireFunction('deriveRecoEmptyReason', deriveRecoEmptyReason);

    const promptContractOkFromTrace =
      isPlainObject(upstreamDebug && upstreamDebug.llm_prompt_trace)
        ? upstreamDebug.llm_prompt_trace.prompt_contract_ok !== false
        : true;

    let payload = isPlainObject(norm && norm.payload) ? norm.payload : {};
    const fieldMissing = Array.isArray(norm && norm.field_missing) ? norm.field_missing : [];

    let hasRecs = Array.isArray(payload.recommendations) ? payload.recommendations.length > 0 : false;
    if (
      !hasRecs &&
      isPlainObject(payload) &&
      Array.isArray(payload.plan_only_recommendations) &&
      payload.plan_only_recommendations.length > 0 &&
      String(payload.products_empty_reason || '').trim() === 'strict_filter_fallback_only'
    ) {
      payload = {
        ...payload,
        recommendations: payload.plan_only_recommendations,
        grounding_status: 'plan_only',
        mainline_status: 'plan_only_fallback',
      };
      hasRecs = true;
      recordAuroraSkinFlowMetric({ stage: 'reco_plan_only_fallback', hit: true });
      logger?.info?.(
        { request_id: ctx && ctx.request_id, plan_count: payload.recommendations.length },
        'aurora bff: strict filter cleared grounded recs, falling back to plan_only recommendations',
      );
    }

    recordAuroraSkinFlowMetric({ stage: 'reco_generated', hit: Boolean(hasRecs) });
    if (hasRecs) {
      logger?.info?.({ kind: 'metric', name: 'aurora.skin.reco_generated_rate', value: 1 }, 'metric');
    }

    const nextState = hasRecs && stateChangeAllowed(ctx && ctx.trigger_source) ? 'S7_PRODUCT_RECO' : undefined;
    if (isPlainObject(payload)) {
      const warningContract = applyRecoWarningVisibilityContract(payload);
      payload = {
        ...warningContract.payload,
        prompt_contract_ok:
          payload.prompt_contract_ok === false
            ? false
            : promptContractOkFromTrace,
      };
    }

    payload = !debugUpstream ? stripInternalRefsDeepFn(payload) : payload;
    const llmTraceRef = buildRecoLlmTraceRefFn(recoLlmTrace);

    let kbWriteStatus = 'skipped';
    let kbQuarantineReasons = [];
    if (isPlainObject(payload)) {
      const noCandidatesMode =
        recoTaskMode === 'ingredient_lookup_no_candidates'
        || String(payload.products_empty_reason || '').trim() === 'ingredient_no_verified_candidates';
      payload.recommendation_confidence_level = noCandidatesMode ? 'low' : artifactConfidenceLevel;
      if (noCandidatesMode) {
        payload.recommendation_confidence_score = 0;
      } else if (artifactConfidenceScore != null) {
        payload.recommendation_confidence_score = artifactConfidenceScore;
      }
      payload.source = String(payload.source || '').trim() || recoSource;
      const metaExisting = isPlainObject(payload.recommendation_meta) ? payload.recommendation_meta : {};
      const derivedSourceMode = pickFirstTrimmed(
        metaExisting.source_mode,
        matcherFallbackUsed
          ? 'artifact_matcher'
          : generatedPrimaryUsed
            ? (generatedSourceMode || 'catalog_grounded')
            : llmPrimaryUsed
              ? 'llm_primary'
              : 'rules_only',
      );
      payload.recommendation_meta = {
        ...metaExisting,
        task_mode: recoTaskMode,
        source_mode: derivedSourceMode,
        trigger_source: normalizeRecoSourceDetail(recoEntrySourceDetail),
        recompute_from_profile_update: shouldAutoRerunRecommendationsFromProfilePatch === true,
        used_recent_logs: Array.isArray(recentLogs) && recentLogs.length > 0,
        used_itinerary: Boolean(profile && (profile.itinerary || profile.travel_plan || profile.travel_plans)),
        used_safety_flags: lowConfidenceArtifact,
        grounding_status: pickFirstTrimmed(payload.grounding_status, metaExisting.grounding_status) || null,
        grounded_count: Number.isFinite(Number(payload.grounded_count)) ? Number(payload.grounded_count) : Number(metaExisting.grounded_count || 0) || 0,
        ungrounded_count: Number.isFinite(Number(payload.ungrounded_count)) ? Number(payload.ungrounded_count) : Number(metaExisting.ungrounded_count || 0) || 0,
        mainline_status: pickFirstTrimmed(payload.mainline_status, metaExisting.mainline_status) || null,
        catalog_skip_reason: pickFirstTrimmed(payload.catalog_skip_reason, metaExisting.catalog_skip_reason) || null,
        telemetry_failure_reason: pickFirstTrimmed(payload.telemetry_reason, metaExisting.telemetry_failure_reason) || null,
        prompt_template_id: RECO_MAIN_PROMPT_TEMPLATE_ID,
        ...(recoLlmTrace ? { llm_trace: recoLlmTrace } : {}),
      };
      payload.metadata = {
        ...(isPlainObject(payload.metadata) ? payload.metadata : {}),
        llm_trace_ref: llmTraceRef,
        llm_failure_class: llmFailureClass || null,
      };
    }

    const recoAssistantBase = buildRouteAwareAssistantTextFn({
      route: 'reco',
      payload,
      language: ctx && ctx.lang,
      profile,
    });
    const recoUnavailableLead = ctx && ctx.lang === 'CN'
      ? '我还没能从上游拿到完整的可购清单，先给你一版稳妥可执行方案。'
      : "I couldn't fetch a complete purchasable shortlist from upstream, so here's a safe and actionable plan first.";

    const assistantTextRaw = hasRecs
      ? (recoAssistantBase ||
        (ctx && ctx.lang === 'CN'
          ? profileScore >= 3
            ? '我已经把核心结果整理成结构化卡片（见下方）。'
            : '我先按“温和/低刺激”给你整理了几款通用选择（见下方卡片）。如果你愿意点选一下肤质/敏感程度，我可以更精准。'
          : 'I summarized the key results into structured cards below.'))
      : (recoAssistantBase
        ? `${recoUnavailableLead}\n\n${recoAssistantBase}`
        : (ctx && ctx.lang === 'CN'
          ? '我还没能从上游拿到可结构化的产品推荐结果。你可以先告诉我你想要的品类（例如：洁面/精华/面霜/防晒），我再继续。'
          : "I couldn't get a structured product recommendation from upstream yet. Tell me what category you want (cleanser / serum / moisturizer / sunscreen), and I’ll continue."));
    const refinementTail =
      hasRecs
        ? (ctx && ctx.lang === 'CN'
          ? '如你愿意，可继续补充肤质/敏感度/当前 routine；我会基于本次上下文自动重算并优化推荐。'
          : 'If you want, add skin type/sensitivity/current routine and I will automatically re-run recommendations with your latest context.')
        : '';
    const assistantText = addEmotionalPreambleToAssistantTextFn(assistantTextRaw, {
      language: ctx && ctx.lang,
      profile,
      seed: ctx && ctx.request_id,
    });
    const finalAssistantText = [safetyWarnText, assistantText, refinementTail].filter(Boolean).join('\n\n');

    if (String(recoTaskMode || '').startsWith('ingredient_')) {
      logger?.info?.(
        {
          kind: 'metric',
          name: 'aurora.ingredient_reco.flow_summary',
          request_id: ctx && ctx.request_id,
          trace_id: ctx && ctx.trace_id,
          task_mode: recoTaskMode,
          ingredient_query: recoContextIngredientQuery || null,
          ingredient_candidates_count: Array.isArray(recoIngredientCandidates) ? recoIngredientCandidates.length : 0,
          product_candidates_count: Array.isArray(recoProductCandidates) ? recoProductCandidates.length : 0,
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

    const cards = [
      {
        card_id: `reco_${ctx.request_id}`,
        type: 'recommendations',
        payload,
        ...(fieldMissing.length ? { field_missing: fieldMissing.slice(0, 8) } : {}),
      },
    ];
    if (mappedIngredientPlan) {
      cards.push(buildIngredientPlanCardFn(mappedIngredientPlan, ctx.request_id));
    }
    if (debugUpstream && upstreamDebug) {
      cards.push({
        card_id: `aurora_debug_${ctx.request_id}`,
        type: 'aurora_debug',
        payload: upstreamDebug,
      });
      if (alternativesDebug) {
        cards.push({
          card_id: `aurora_alt_debug_${ctx.request_id}`,
          type: 'aurora_alt_debug',
          payload: { items: alternativesDebug },
        });
      }
    }

    const sessionPatch = nextState ? { next_state: nextState } : {};
    if (recoIngredientContext) {
      sessionPatch.meta = {
        ...(isPlainObject(sessionPatch.meta) ? sessionPatch.meta : {}),
        ingredient_context: recoIngredientContext,
      };
    }
    appendLatestArtifactToSessionPatchFn(sessionPatch, latestArtifact && latestArtifact.artifact_id);
    appendLatestRecoContextToSessionPatchFn(sessionPatch, {
      intent: 'reco_products',
      source_detail: recoEntrySourceDetail,
      trigger_source: ctx && ctx.trigger_source,
      action_id: actionId || '',
      message: recoRequestMessage,
      include_alternatives: includeAlternatives === true,
      ingredient_query: recoContextIngredientQuery || '',
      goal: recoContextGoal || '',
    });

    const baseRecoRunContext = {
      request_id: ctx && ctx.request_id,
      trace_id: ctx && ctx.trace_id,
      trigger_source: ctx && ctx.trigger_source,
      low_confidence: lowConfidenceArtifact,
    };

    if (llmPrimaryUsed && isPlainObject(payload)) {
      const recoItems = Array.isArray(payload.recommendations) ? payload.recommendations : [];
      const hasUsableReco = recoItems.some((row) => {
        if (!isPlainObject(row)) return false;
        const sku = isPlainObject(row.sku) ? row.sku : {};
        const brand = pickFirstTrimmed(row.brand, sku.brand);
        const name = pickFirstTrimmed(
          row.name,
          row.display_name,
          row.displayName,
          sku.name,
          sku.display_name,
          sku.displayName,
        );
        const externalUrl = pickFirstTrimmed(row?.pdp_open?.external?.url, row?.url, row?.pdp_url, sku?.url, sku?.pdp_url);
        return Boolean((brand && name) || externalUrl);
      });
      kbQuarantineReasons = hasUsableReco ? [] : ['llm_reco_quality_gate_failed'];
      kbWriteStatus = 'attempted';
      recordAuroraRecoKbWrite({ source: 'llm_primary', outcome: 'attempted' });
      saveRecoRun({
        artifactId: latestArtifact ? latestArtifact.artifact_id : null,
        planId: mappedIngredientPlan && mappedIngredientPlan.plan_id ? mappedIngredientPlan.plan_id : null,
        auroraUid: identity && identity.auroraUid,
        userId: identity && identity.userId,
        requestContext: {
          ...baseRecoRunContext,
          source: 'llm_primary_v1',
          kb_backfill_attempted: true,
          kb_quarantined: kbQuarantineReasons.length > 0,
          ...(kbQuarantineReasons.length ? { kb_quarantine_reasons: kbQuarantineReasons } : {}),
        },
        reco: {
          source: 'llm_primary_v1',
          recommendation_meta: payload.recommendation_meta || null,
          recommendations: recoItems.slice(0, 16),
        },
        overallConfidence:
          Number.isFinite(Number(payload.recommendation_confidence_score))
            ? Number(payload.recommendation_confidence_score)
            : null,
      })
        .then(() => {
          recordAuroraRecoKbWrite({
            source: 'llm_primary',
            outcome: kbQuarantineReasons.length ? 'quarantined' : 'persisted',
          });
        })
        .catch((err) => {
          recordAuroraRecoKbWrite({ source: 'llm_primary', outcome: 'error' });
          logger?.warn?.(
            { err: err && err.message ? err.message : String(err), request_id: ctx && ctx.request_id },
            'aurora bff: failed to persist llm-primary reco run',
          );
        });
    } else {
      const skippedSource = matcherFallbackUsed
        ? 'artifact_matcher'
        : generatedPrimaryUsed
          ? generatedSourceMode || 'catalog_grounded'
          : llmPrimaryUsed
            ? 'llm_primary'
            : 'rules_only';
      recordAuroraRecoKbWrite({ source: skippedSource, outcome: 'skipped' });
    }

    if (matcherFallbackUsed) {
      recordAuroraRecoKbWrite({ source: 'artifact_matcher', outcome: 'attempted' });
      saveRecoRun({
        artifactId: latestArtifact ? latestArtifact.artifact_id : null,
        planId: mappedIngredientPlan && mappedIngredientPlan.plan_id ? mappedIngredientPlan.plan_id : null,
        auroraUid: identity && identity.auroraUid,
        userId: identity && identity.userId,
        requestContext: {
          ...baseRecoRunContext,
          source: 'artifact_matcher_v1',
        },
        reco: matcherBundle || {
          source: 'artifact_matcher_v1',
          recommendation_meta: isPlainObject(payload) ? payload.recommendation_meta || null : null,
          recommendations: isPlainObject(payload) && Array.isArray(payload.recommendations) ? payload.recommendations.slice(0, 16) : [],
        },
        overallConfidence: matcherBundle && matcherBundle.confidence && Number.isFinite(Number(matcherBundle.confidence.score))
          ? Number(matcherBundle.confidence.score)
          : isPlainObject(payload) && Number.isFinite(Number(payload.recommendation_confidence_score))
            ? Number(payload.recommendation_confidence_score)
            : null,
      })
        .then(() => {
          recordAuroraRecoKbWrite({ source: 'artifact_matcher', outcome: 'persisted' });
        })
        .catch((err) => {
          recordAuroraRecoKbWrite({ source: 'artifact_matcher', outcome: 'error' });
          logger?.warn?.(
            { err: err && err.message ? err.message : String(err), request_id: ctx && ctx.request_id },
            'aurora bff: failed to persist matcher fallback reco run',
          );
        });
    }

    if (isPlainObject(payload)) {
      payload.metadata = {
        ...(isPlainObject(payload.metadata) ? payload.metadata : {}),
        kb_write_status: kbWriteStatus,
        kb_quarantine_reasons: kbQuarantineReasons,
      };
    }

    const envelope = buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(finalAssistantText),
      suggested_chips: refinementChips,
      cards,
      session_patch: sessionPatch,
      events: [
        ...(hasRecs ? [makeEventFn(ctx, 'value_moment', { kind: 'product_reco' })] : []),
        makeEventFn(ctx, 'recos_requested', {
          explicit: true,
          source: recoSource,
          source_mode: String(payload?.recommendation_meta?.source_mode || ''),
          source_detail: normalizeRecoSourceDetail(recoEntrySourceDetail),
          recompute_from_profile_update: shouldAutoRerunRecommendationsFromProfilePatch === true,
          low_confidence: lowConfidenceArtifact,
          confidence_level: artifactConfidenceLevel,
          grounding_status: String(payload?.grounding_status || payload?.recommendation_meta?.grounding_status || ''),
          grounded_count: Number.isFinite(Number(payload?.grounded_count)) ? Number(payload.grounded_count) : 0,
          ungrounded_count: Number.isFinite(Number(payload?.ungrounded_count)) ? Number(payload.ungrounded_count) : 0,
          mainline_status: String(payload?.mainline_status || payload?.recommendation_meta?.mainline_status || ''),
          catalog_skip_reason: String(payload?.catalog_skip_reason || payload?.recommendation_meta?.catalog_skip_reason || ''),
          telemetry_reason: String(payload?.telemetry_reason || payload?.recommendation_meta?.telemetry_failure_reason || ''),
          ...(payload?.recommendation_meta?.prompt_template_id ? { prompt_template_id: payload.recommendation_meta.prompt_template_id } : {}),
          ...(llmTraceRef ? { llm_trace_ref: llmTraceRef } : {}),
          ...(llmFailureClass ? { failure_class: llmFailureClass } : {}),
          kb_write_status: kbWriteStatus,
          ...(kbQuarantineReasons.length ? { kb_quarantine_reasons: kbQuarantineReasons } : {}),
          ...(artifactConfidenceScore != null ? { confidence_score: artifactConfidenceScore } : {}),
          ...(() => {
            const emptyReason = deriveRecoEmptyReasonFn({
              hasRecs,
              productsEmptyReason: payload?.products_empty_reason,
              groundedCount: Number.isFinite(Number(payload?.grounded_count)) ? Number(payload.grounded_count) : 0,
              artifactGateOk,
            });
            return emptyReason ? { reason: emptyReason } : {};
          })(),
        }),
      ],
    });

    return {
      envelope,
      payload,
      hasRecs,
      kbWriteStatus,
      kbQuarantineReasons,
      llmTraceRef,
    };
  }

  return {
    finalizeRecoSuccess,
  };
}

module.exports = {
  createChatRecoResponseRuntime,
};
